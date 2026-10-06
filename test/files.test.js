import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadTool, EditTool, WriteTool } from '../src/tools/files.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-files-'));
const ctxFor = (dir) => ({ cwd: dir, projectRoot: dir, fileState: new Map() });
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

async function edit(dir, name, content, oldString, newString) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  const ctx = ctxFor(dir);
  await ReadTool.call({ file_path: file }, ctx);
  const r = await EditTool.call({ file_path: file, old_string: oldString, new_string: newString }, ctx);
  assert.ok(!r.isError, r.content);
  return fs.readFileSync(file, 'utf8');
}

test('editing keeps the file\'s main line ending instead of converting everything', async () => {
  const dir = tmp();
  // one stray CRLF in an LF file: the file stays LF
  assert.equal(await edit(dir, 'mostly-lf.txt', 'a\r\nb\nc\nd\ne\nf\n', 'e', 'E'), 'a\nb\nc\nd\nE\nf\n');
  // one stray LF in a CRLF file: the file stays CRLF
  assert.equal(await edit(dir, 'mostly-crlf.txt', 'a\nb\r\nc\r\nd\r\ne\r\nf\r\n', 'e', 'E'), 'a\r\nb\r\nc\r\nd\r\nE\r\nf\r\n');
  // an even split keeps the old behaviour: CRLF wins when there is any
  assert.equal(await edit(dir, 'tie.txt', 'a\r\nb\n', 'b', 'B'), 'a\r\nB\r\n');
  // plain files are untouched by all of this
  assert.equal(await edit(dir, 'lf.txt', 'a\nb\n', 'b', 'B'), 'a\nB\n');
  assert.equal(await edit(dir, 'crlf.txt', 'a\r\nb\r\n', 'b', 'B'), 'a\r\nB\r\n');
  assert.equal(await edit(dir, 'bom.txt', '\ufeffa\r\nb\r\n', 'b', 'B'), '\ufeffa\r\nB\r\n');
});

test('Write refuses to overwrite a file that was only partly read', async () => {
  const dir = tmp();
  const file = path.join(dir, 'six.txt');
  const original = lines(6);
  fs.writeFileSync(file, original);
  const ctx = ctxFor(dir);

  await ReadTool.call({ file_path: file, offset: 1, limit: 2 }, ctx);
  let r = await WriteTool.call({ file_path: file, content: 'replacement\n' }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /only partly read/);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'the file must be left alone');

  await ReadTool.call({ file_path: file, offset: 3 }, ctx); // the end of the file, but not the start
  assert.equal((await WriteTool.call({ file_path: file, content: 'x\n' }, ctx)).isError, true);

  // a limit that happens to cover the whole file is a full read
  await ReadTool.call({ file_path: file, offset: 1, limit: 100 }, ctx);
  r = await WriteTool.call({ file_path: file, content: 'replacement\n' }, ctx);
  assert.ok(!r.isError, r.content);
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement\n');
});

test('Edit works after a partial read, and the file stays partly read for Write', async () => {
  const dir = tmp();
  const file = path.join(dir, 'six.txt');
  fs.writeFileSync(file, lines(6));
  const ctx = ctxFor(dir);
  await ReadTool.call({ file_path: file, offset: 1, limit: 3 }, ctx);

  const edited = await EditTool.call({ file_path: file, old_string: 'line 2', new_string: 'LINE 2' }, ctx);
  assert.ok(!edited.isError, edited.content);

  const overwrite = await WriteTool.call({ file_path: file, content: 'x\n' }, ctx);
  assert.equal(overwrite.isError, true, 'an Edit must not turn a partial read into a full one');
  assert.match(overwrite.content, /only partly read/);

  await ReadTool.call({ file_path: file }, ctx);
  assert.ok(!(await WriteTool.call({ file_path: file, content: 'x\n' }, ctx)).isError);
});

test('Write can create a new file and then overwrite it without reading it again', async () => {
  const dir = tmp();
  const file = path.join(dir, 'new.txt');
  const ctx = ctxFor(dir);
  assert.ok(!(await WriteTool.call({ file_path: file, content: 'one\n' }, ctx)).isError);
  assert.ok(!(await WriteTool.call({ file_path: file, content: 'two\n' }, ctx)).isError);
  assert.equal(fs.readFileSync(file, 'utf8'), 'two\n');
});

test('a Read that is refused as too large does not count as having read the file', async () => {
  const dir = tmp();
  const file = path.join(dir, 'huge.txt');
  fs.writeFileSync(file, `${'x'.repeat(60)}\n`.repeat(10_000)); // numbered, this is more than the 400,000 character limit
  const ctx = ctxFor(dir);
  const read = await ReadTool.call({ file_path: file }, ctx);
  assert.equal(read.isError, true);
  assert.match(read.content, /exceeds the maximum allowed size/);
  assert.equal(ctx.fileState.has(file), false);
  const write = await WriteTool.call({ file_path: file, content: 'x\n' }, ctx);
  assert.match(write.content, /has not been read yet/);
});

test('Read loads the file once and Edit computes its plan once per call', async () => {
  const dir = tmp();
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, lines(50));
  const ctx = ctxFor(dir);

  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p, ...rest) { if (String(p) === file) reads++; return original.call(this, p, ...rest); };
  try { await ReadTool.call({ file_path: file }, ctx); } finally { fs.readFileSync = original; }
  assert.equal(reads, 1);

  const plan = EditTool.plan;
  let plans = 0;
  EditTool.plan = function (...args) { plans++; return plan.apply(this, args); };
  try { await EditTool.call({ file_path: file, old_string: 'line 7\n', new_string: 'seven\n' }, ctx); } finally { EditTool.plan = plan; }
  assert.equal(plans, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /\nseven\n/);
});

test('Edit answers with the changed lines, not a snippet of the file (the snippet only repeated new_string, to be re-read every turn)', async () => {
  const dir = tmp();
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, lines(30));
  const ctx = ctxFor(dir);
  await ReadTool.call({ file_path: file }, ctx);
  const one = await EditTool.call({ file_path: file, old_string: 'line 12\n', new_string: 'twelve\n' }, ctx);
  assert.equal(one.content, `The file ${file} has been updated successfully (line 12).`);
  const many = await EditTool.call({ file_path: file, old_string: 'line 20\n', new_string: 'a\nb\nc\n' }, ctx);
  assert.equal(many.content, `The file ${file} has been updated successfully (lines 20-22).`);
  const inline = await EditTool.call({ file_path: file, old_string: 'line 5', new_string: 'x\ny' }, ctx);
  assert.match(inline.content, /\(lines 5-6\)\.$/);
  const removed = await EditTool.call({ file_path: file, old_string: 'line 3\n', new_string: '' }, ctx);
  assert.match(removed.content, /\(text removed at line 3\)\.$/);
  const all = await EditTool.call({ file_path: file, old_string: 'line', new_string: 'row', replace_all: true }, ctx);
  assert.match(all.content, /has been updated successfully\. All \d+ occurrences were replaced\.$/);
  for (const r of [one, many, inline, removed, all]) {
    assert.ok(!r.isError);
    assert.doesNotMatch(r.content, /cat -n|\n/, 'one line, no file content');
  }
  assert.match(fs.readFileSync(file, 'utf8'), /^row 1\nrow 2\nrow 4\nx\ny\n/);
});
