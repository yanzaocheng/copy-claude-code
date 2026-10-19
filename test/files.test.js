import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ReadTool, EditTool, WriteTool } from '../src/tools/files.js';
import { imageSize } from '../src/utils/images.js';

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

test('Read never returns more than 400k characters, and then says exactly where it stopped', async () => {
  const dir = tmp();
  // 60 lines of about 20k characters, numbered at their start; `width` decides where the 400k cut falls
  const readWide = async (width) => {
    const file = path.join(dir, `wide-${width}.txt`);
    fs.writeFileSync(file, Array.from({ length: 60 }, (_, i) => `${String(i + 1).padStart(2, '0')}${'x'.repeat(width - 2)}`).join('\n') + '\n');
    const ctx = ctxFor(dir);
    const r = await ReadTool.call({ file_path: file, limit: 60 }, ctx);
    assert.ok(!r.isError, r.content);
    assert.ok(r.content.length < 400_400, `${r.content.length} characters`);
    assert.equal(ctx.fileState.get(file).partial, true);
    return r.content;
  };
  // the cut falls inside line 20
  let out = await readWide(19_995);
  assert.match(out, /output cut at 400000 characters: line 20 is the last one shown, and only in part;/);
  assert.match(out, /showing lines 1-20\./, 'the footer names the last line shown, not the last one asked for');
  assert.ok(out.includes('\t20x') && !out.includes('\t21x'));
  // the cut falls exactly between lines 20 and 21 (each numbered line is 20,000 characters)
  out = await readWide(19_992);
  assert.match(out, /output cut at 400000 characters: line 20 is the last one shown;/);
  assert.match(out, /showing lines 1-20\./);
  assert.ok(out.includes('\t20x') && !out.includes('\t21x'));
});

// A PNG of the given size (a pattern, so that it does not compress to nothing). `grain`: a gradient with fine
// noise on every channel, as a rendered 3D scene has: heavy as PNG, light as JPEG.
function makePng(w, h, { grain = false } = {}) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = 1 + w * 3;
  const raw = Buffer.alloc(stride * h);
  let seed = 12345;
  const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 24) & 31;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!grain) { raw[y * stride + 1 + x * 3] = (x * 7 + y) & 255; continue; }
      for (let ch = 0; ch < 3; ch++) raw[y * stride + 1 + x * 3 + ch] = (((x + y) >> 2) + ch * 40 + noise()) & 255;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('imageSize reads PNG, JPEG, GIF and WebP headers', () => {
  assert.deepEqual(imageSize(makePng(31, 17)), { width: 31, height: 17 });
  const gif = Buffer.from('GIF89a\x40\x01\xf0\x00\x00\x00', 'latin1');
  assert.deepEqual(imageSize(gif), { width: 320, height: 240 });
  // JPEG: SOI, an APP0 segment, then SOF0 with height 600 and width 800
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpeg), { width: 800, height: 600 });
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8X', 8, 'latin1');
  webp.writeUIntLE(1919, 24, 3);
  webp.writeUIntLE(4999, 27, 3);
  assert.deepEqual(imageSize(webp), { width: 1920, height: 5000 });
  assert.equal(imageSize(Buffer.from('not an image at all')), null);
});

test('Read scales a tall screenshot to what the API takes, and says so; a small image is sent as it is', { skip: process.platform !== 'win32' && 'scaling uses System.Drawing here' }, async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'tall.png'), makePng(600, 3400));
  fs.writeFileSync(path.join(dir, 'small.png'), makePng(300, 200));
  const tall = await ReadTool.call({ file_path: path.join(dir, 'tall.png') }, ctxFor(dir));
  assert.ok(!tall.isError, tall.content);
  assert.deepEqual(imageSize(Buffer.from(tall.content[0].source.data, 'base64')), { width: 277, height: 1568 });
  assert.match(tall.content[1].text, /Scaled from 600×3400 to 277×1568/);
  assert.match(tall.display.summary, /600×3400, scaled to 277×1568/);
  const small = await ReadTool.call({ file_path: path.join(dir, 'small.png') }, ctxFor(dir));
  assert.equal(small.content.length, 1);
  assert.equal(small.content[0].source.data, makePng(300, 200).toString('base64'));
});

test('a heavy PNG goes as JPEG: from Read, and once in a conversation that already holds one', { skip: process.platform !== 'win32' && 'images are re-encoded with System.Drawing here' }, async () => {
  const { PNG_AS_JPEG_BYTES } = await import('../src/utils/images.js');
  const { Agent } = await import('../src/agent.js');
  const { Config } = await import('../src/config.js');
  const dir = tmp();
  const heavy = makePng(700, 700, { grain: true });
  assert.ok(heavy.length > PNG_AS_JPEG_BYTES, `the test PNG is ${heavy.length} bytes`);
  fs.writeFileSync(path.join(dir, 'scene.png'), heavy);
  const read = await ReadTool.call({ file_path: path.join(dir, 'scene.png') }, ctxFor(dir));
  assert.ok(!read.isError, read.content);
  const sent = Buffer.from(read.content[0].source.data, 'base64');
  assert.equal(read.content[0].source.media_type, 'image/jpeg');
  assert.deepEqual(imageSize(sent), { width: 700, height: 700 }, 'the same pixels');
  assert.ok(sent.length < heavy.length / 2, `${sent.length} bytes as JPEG, ${heavy.length} as PNG`);
  assert.equal(read.content.length, 1, 'not scaled: no note about it');
  assert.match(read.display.summary, /^Read image \(700×700, \d+KB\)$/);

  // a conversation from before: the heavy PNG in a tool result, a light one in a user message
  const cfg = new Config({ CLAUDE_PRO_GATEWAY_MODEL: 'mock' }, {}, { hooks: {}, mcpServers: {} }, dir);
  const replaced = [];
  const agent = new Agent({ config: cfg, tools: [], systemPrompt: 's', io: { messagesReplaced: (m) => replaced.push(m) }, model: cfg.model, cwd: dir });
  const light = makePng(300, 200).toString('base64');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: heavy.toString('base64') } };
  agent.messages = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: light } }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'scene.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: [image] }] },
  ];
  agent.cache.expected = 1234;
  await agent.lightenImages();
  assert.equal(image.source.media_type, 'image/jpeg', 'changed in the conversation itself');
  assert.equal(agent.messages[0].content[1].source.data, light, 'a light PNG stays as it is');
  assert.equal(replaced.length, 1, 'kept so in the session file');
  assert.equal(agent.cache.expected, null, 'the cache rewrite that follows is expected, not a miss');
  await agent.lightenImages();
  assert.equal(replaced.length, 1, 'once');
});
