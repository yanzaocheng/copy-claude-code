import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rebuildFileState } from '../src/filestate.js';
import { SessionStore } from '../src/session.js';
import { Agent } from '../src/agent.js';
import { Config } from '../src/config.js';
import { ReadTool, EditTool, WriteTool } from '../src/tools/files.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-resume-'));
const setMtime = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));

const use = (id, name, input) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] });
const ok = (id, content = 'ok') => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
const failed = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'File does not exist', is_error: true }] });

test('rebuildFileState trusts a file only if it has not changed since the model saw it', () => {
  const dir = tmp();
  const T = Date.now() - 3600_000; // the transcript is an hour old
  const make = (name, mtime) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, name);
    setMtime(file, mtime);
    return file;
  };
  const unchanged = make('unchanged.js', T - 60_000); // last modified before the model read it
  const changed = make('changed.js', T + 60_000); // edited by someone after the read
  const written = make('written.js', T - 1000); // written by the model itself just before its result
  const notebook = make('nb.ipynb', T - 5000);
  const failedRead = make('failed.js', T - 60_000);
  const unknownTime = make('unknown.js', T - 60_000);
  const relative = make('rel.js', T - 60_000);
  const missing = path.join(dir, 'gone.js');

  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] }, // 0
    use('r1', 'Read', { file_path: unchanged }), ok('r1'), // 1, 2
    use('r2', 'Read', { file_path: changed }), ok('r2'), // 3, 4
    use('w1', 'Write', { file_path: written, content: 'x' }), ok('w1'), // 5, 6
    use('n1', 'NotebookEdit', { notebook_path: notebook, new_source: 'x' }), ok('n1'), // 7, 8
    use('r3', 'Read', { file_path: failedRead }), failed('r3'), // 9, 10
    use('r4', 'Read', { file_path: missing }), ok('r4'), // 11, 12
    use('r5', 'Read', { file_path: unknownTime }), ok('r5'), // 13, 14
    use('r6', 'Read', { file_path: 'rel.js' }), ok('r6'), // 15, 16 (relative to the project)
    use('g1', 'Grep', { pattern: 'x', path: failedRead }), ok('g1'), // 17, 18 (not a file-reading tool)
  ];
  const times = messages.map((_, i) => T + i * 1000);
  times[14] = 0; // the time of r5's result is unknown

  const state = rebuildFileState(messages, times, dir);
  assert.deepEqual([...state.keys()].sort(), [unchanged, written, notebook, relative].sort());
  assert.equal(state.get(unchanged).mtimeMs, fs.statSync(unchanged).mtimeMs);
  assert.ok(!state.has(changed), 'a file modified after the read must be read again');
  assert.ok(!state.has(failedRead), 'a failed Read does not count');
  assert.ok(!state.has(unknownTime), 'results with an unknown time are never trusted');
  assert.ok(!state.has(missing));
});

test('the latest successful Read or Write of a file decides', () => {
  const dir = tmp();
  const T = Date.now() - 3600_000;
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  setMtime(file, T + 30_000); // changed after the first read, but the model wrote it again later
  const messages = [
    use('r1', 'Read', { file_path: file }), ok('r1'),
    use('w1', 'Write', { file_path: file, content: 'x' }), ok('w1'),
  ];
  assert.ok(!rebuildFileState(messages, [T, T + 1000, T + 2000, T + 3000], dir).has(file));
  assert.ok(rebuildFileState(messages, [T, T + 1000, T + 40_000, T + 41_000], dir).has(file));
  assert.equal(rebuildFileState([], [], dir).size, 0);
});

test('SessionStore.load keeps message times; messages restored from a reset have unknown times', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  const entries = [
    { type: 'meta', cwd: dir },
    { type: 'message', message: { role: 'user', content: 'a' }, at: 1111 },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, at: 2222 },
  ];
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  let loaded = SessionStore.load(file);
  assert.deepEqual(loaded.times, [1111, 2222]);
  assert.equal(loaded.messages.length, 2);

  fs.appendFileSync(file, `${JSON.stringify({ type: 'reset', messages: [{ role: 'user', content: 'summary' }], at: 3333 })}\n`);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'c' }] }, at: 4444 })}\n`);
  loaded = SessionStore.load(file);
  assert.equal(loaded.messages.length, 2);
  assert.deepEqual(loaded.times, [0, 4444]);
});

test('a resumed conversation can edit files it remembers reading, but not ones changed since', async () => {
  const dir = tmp();
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  fs.writeFileSync(a, 'one\ntwo\n');
  fs.writeFileSync(b, 'alpha\nbeta\n');
  const readAt = Date.now() - 60_000;
  setMtime(a, readAt - 5000); // unchanged since the read
  setMtime(b, readAt + 30_000); // changed after the read
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'edit the files' }] },
    use('r1', 'Read', { file_path: a }), ok('r1', '     1\tone\n     2\ttwo'),
    use('r2', 'Read', { file_path: b }), ok('r2', '     1\talpha\n     2\tbeta'),
  ];
  const cfg = new Config({ ANTHROPIC_MODEL: 'mock' }, {}, { hooks: {}, mcpServers: {} }, dir);
  const agent = new Agent({ config: cfg, tools: [ReadTool, EditTool], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir });
  agent.fileState.set(path.join(dir, 'left-over.txt'), { mtimeMs: 1 }); // from the conversation being replaced
  agent.messages = messages;
  agent.restoreFileState(messages, messages.map(() => readAt));
  assert.ok(!agent.fileState.has(path.join(dir, 'left-over.txt')), 'the previous conversation\'s reads must be forgotten');

  const edited = await EditTool.call({ file_path: a, old_string: 'two', new_string: '2' }, agent.makeCtx());
  assert.ok(!edited.isError, edited.content);
  assert.equal(fs.readFileSync(a, 'utf8'), 'one\n2\n');

  const stale = await EditTool.call({ file_path: b, old_string: 'beta', new_string: 'B' }, agent.makeCtx());
  assert.equal(stale.isError, true);
  assert.match(stale.content, /has not been read yet/);
  assert.equal(fs.readFileSync(b, 'utf8'), 'alpha\nbeta\n');
});

test('a restored partial read stays partial, so Write still refuses to overwrite unseen lines', async () => {
  const dir = tmp();
  const T = Date.now() - 3600_000;
  const make = (name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'l1\nl2\nl3\nl4\n');
    setMtime(file, T - 60_000);
    return file;
  };
  const head = make('head.txt'); // Read with a limit that left lines out
  const tail = make('tail.txt'); // Read starting at line 3
  const whole = make('whole.txt'); // Read in full
  const edited = make('edited.txt'); // partial Read, then an Edit
  const written = make('written.txt'); // partial Read, then Write of the whole file
  const note = '\n\n(File has 4 lines total; showing lines 1-2. Use offset/limit to read more.)';
  const messages = [
    use('a', 'Read', { file_path: head, limit: 2 }), ok('a', `     1\tl1\n     2\tl2${note}`),
    use('b', 'Read', { file_path: tail, offset: 3 }), ok('b', '     3\tl3\n     4\tl4'),
    use('c', 'Read', { file_path: whole, limit: 100 }), ok('c', '     1\tl1\n     2\tl2\n     3\tl3\n     4\tl4'),
    use('d', 'Read', { file_path: edited, limit: 2 }), ok('d', `     1\tl1\n     2\tl2${note}`),
    use('e', 'Edit', { file_path: edited, old_string: 'l1', new_string: 'L1' }), ok('e', 'The file has been updated.'),
    use('f', 'Read', { file_path: written, limit: 2 }), ok('f', `     1\tl1\n     2\tl2${note}`),
    use('g', 'Write', { file_path: written, content: 'new\n' }), ok('g', 'The file has been updated successfully.'),
  ];
  const state = rebuildFileState(messages, messages.map((_, i) => T + i * 1000), dir);
  assert.equal(state.get(head).partial, true);
  assert.equal(state.get(tail).partial, true);
  assert.equal(state.get(whole).partial, false);
  assert.equal(state.get(edited).partial, true, 'an Edit does not show the rest of the file');
  assert.equal(state.get(written).partial, false, 'after a Write the model knows the whole file');

  const cfg = new Config({ ANTHROPIC_MODEL: 'mock' }, {}, { hooks: {}, mcpServers: {} }, dir);
  const agent = new Agent({ config: cfg, tools: [], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir });
  agent.restoreFileState(messages, messages.map((_, i) => T + i * 1000));
  const refused = await WriteTool.call({ file_path: head, content: 'x\n' }, agent.makeCtx());
  assert.equal(refused.isError, true);
  assert.match(refused.content, /only partly read/);
  assert.ok(!(await WriteTool.call({ file_path: whole, content: 'x\n' }, agent.makeCtx())).isError);
});
