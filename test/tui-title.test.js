import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The terminal tab's title and the footer's model and effort, in the real App inside a headless terminal.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-title-config-'));
const HOUR = 3_600_000;
let limited = false; // answer with a 5-hour limit instead of a reply

const sse = (text) => [
  { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
].map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (limited) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(Math.floor((Date.now() + 3 * HOUR) / 1000)),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse('All done.'));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

Object.assign(process.env, {
  CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_PRO_GATEWAY_API_KEY: 'test-token', CLAUDE_PRO_GATEWAY_MODEL: 'mock', CLAUDE_PRO_MAX_RETRIES: '3', CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_PRO_RIPGREP_PATH: 'off', CLAUDE_CODE_EFFORT_LEVEL: '', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
});
const { startTui } = await import('./tui-harness.js');
const { timing } = await import('../src/ratelimit.js');
const { cleanTitle } = await import('../src/ui/screen.js');
const { modelTag, modelInfo } = await import('../src/ui/repl.js');
const { defaultEffort } = await import('../src/api.js');
const { Config } = await import('../src/config.js');

test.after(() => server.close());

const project = (name = 'my-project') => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-title-')), name);
  fs.mkdirSync(dir);
  return dir;
};

// Every title the terminal was given, in order.
function titles(tui) {
  const seen = [];
  tui.term.onTitleChange((title) => seen.push(title));
  return seen;
}

test('cleanTitle: one line of plain text of a sensible length, whatever it is given', () => {
  assert.equal(cleanTitle('fix the\nbug\t\tnow'), 'fix the bug now');
  assert.equal(cleanTitle('a\x07b\x1b]0;evil\x07c'), 'a b ]0;evil c', 'a BEL or ESC in a prompt cannot end the title early and run on as escape codes');
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(cleanTitle('x\x00\x01\x9b31my')));
  assert.equal(cleanTitle(null), '');
  const long = cleanTitle('word '.repeat(100));
  assert.ok(long.length <= 100 && long.endsWith('…'));
});

test('modelTag says the model as people do', () => {
  assert.equal(modelTag({ id: 'claude-sonnet-5-5' }), 'sonnet-5-5');
  assert.equal(modelTag({ id: 'claude-haiku-4-5-20251001' }), 'haiku-4-5');
  assert.equal(modelTag({ id: 'deepseek-flash' }), 'deepseek-flash');
});

test('modelInfo leaves the effort out when none is sent and for a model that does not take one', () => {
  const config = (env) => new Config({ CLAUDE_PRO_PROVIDER: 'gateway', ...env }, {}, { hooks: {}, mcpServers: {} }, process.cwd());
  assert.deepEqual(modelInfo(config({ CLAUDE_CODE_EFFORT_LEVEL: 'high' })), { model: 'opus-5-5', effort: 'high' });
  assert.deepEqual(modelInfo(config({})), { model: 'opus-5-5', effort: null });
  assert.deepEqual(modelInfo(config({ CLAUDE_CODE_EFFORT_LEVEL: 'auto' })), { model: 'opus-5-5', effort: null });
});

test('defaultEffort is the effort a model uses when none is sent', () => {
  assert.equal(defaultEffort('claude-opus-5-5'), 'medium');
  assert.equal(defaultEffort('claude-haiku-5-5'), 'medium');
  assert.equal(defaultEffort('claude-sonnet-5-5'), 'high');
  assert.equal(defaultEffort('claude-opus-4-7'), 'high');
  assert.equal(defaultEffort('claude-haiku-4-5-20251001'), null);
  assert.equal(defaultEffort('mock'), null);
});

test('the tab is titled with the directory, model and effort from the start, and the shell\'s title is saved and brought back', async (t) => {
  limited = false;
  const cwd = project('copy-claude-code');
  const tui = await startTui({ cwd, flags: { effort: 'high' } });
  t.after(() => tui.close()); // (closing twice is harmless)
  const seen = titles(tui);
  tui.app.screen.schedule();
  await tui.wait(80);
  const raw = tui.raw();
  const first = raw.indexOf('\x1b]0;');
  assert.ok(first > 0, 'a title was set');
  assert.equal(raw.lastIndexOf('\x1b[22;0t', first), first - '\x1b[22;0t'.length, 'the shell\'s title is saved immediately before the first one');
  assert.match(raw.slice(first, raw.indexOf('\x07', first) + 1), /^\x1b\]0;✳ copy-claude-code · mock · high\x07$/);
  await tui.close();
  await tui.wait(100); // the terminal takes what was written last a moment later
  const after = tui.raw();
  assert.ok(after.lastIndexOf('\x1b[23;0t') > after.lastIndexOf('\x1b]0;✳ copy-claude-code'), 'the saved title is brought back on exit, after the last one of ours');
  assert.ok(seen.every((title) => !/[\x00-\x1f]/.test(title)));
});

test('the title follows the conversation: what the session is about, and what it is doing', async (t) => {
  limited = false;
  const tui = await startTui({ cwd: project('shop'), flags: { effort: 'low' } });
  t.after(() => tui.close());
  const seen = titles(tui);

  tui.send('fix the checkout bug\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  await tui.wait(100);
  assert.equal(seen.at(-1), '✳ fix the checkout bug | shop · mock · low');
  assert.ok(seen.some((title) => /^[⠂⠐] fix the checkout bug \| shop/.test(title)), 'busy while it works');

  // a second message does not change what the session is about
  tui.send('and add a test\r');
  await tui.waitIdle({ timeout: 20_000 });
  await tui.wait(100);
  assert.equal(seen.at(-1), '✳ fix the checkout bug | shop · mock · low');
  assert.equal(seen.filter((title, i) => title === seen[i - 1]).length, 0, 'a title is only sent when it changes');
});

test('/effort and /clear change the title, and a long first message leaves room for the model', async (t) => {
  limited = false;
  const tui = await startTui({ cwd: project('app'), flags: { effort: 'low' } });
  t.after(() => tui.close());
  const seen = titles(tui);

  tui.send(`${'refactor everything about the way that files are saved and loaded, '.repeat(3)}\r`);
  await tui.waitIdle({ timeout: 20_000 });
  await tui.wait(100);
  const long = seen.at(-1);
  assert.match(long, /^✳ refactor everything about the way that file…? \| app · mock · low$|^✳ .{1,41} \| app · mock · low$/, long);
  assert.ok(long.endsWith('app · mock · low'), 'model and effort are kept whole');

  tui.send('/effort high\r');
  await tui.waitFor('Effort set to high', { timeout: 20_000 });
  await tui.wait(100);
  assert.ok(seen.at(-1).endsWith('app · mock · high'), seen.at(-1));

  tui.send('/clear\r');
  await tui.waitFor('Welcome to', { timeout: 20_000 });
  await tui.wait(100);
  assert.equal(seen.at(-1), '✳ app · mock · high', 'a cleared session is about nothing yet');
});

test('a resumed session is titled with what it was about', async (t) => {
  limited = false;
  const cwd = project('resumed');
  const first = await startTui({ cwd, flags: { effort: 'auto' } });
  first.send('migrate the database\r');
  await first.waitFor('All done.', { timeout: 20_000 });
  await first.waitIdle({ timeout: 20_000 });
  const { file, id } = first.app.store;
  await first.close();

  const second = await startTui({ cwd, flags: { effort: 'auto', resumeFile: file, resumeId: id } });
  t.after(() => second.close());
  await second.waitFor('Resumed session', { timeout: 20_000 });
  await second.wait(100);
  assert.equal(second.app.terminalTitle(), '✳ migrate the database | resumed · mock');
  assert.ok(second.raw().includes('\x1b]0;✳ migrate the database | resumed · mock\x07'), 'and the terminal was told');
});

test('a rate limit pause shows in the tab, so it can be seen from another tab', async (t) => {
  limited = true;
  const original = { ...timing };
  timing.sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  t.after(() => Object.assign(timing, original));
  const tui = await startTui({ cwd: project('paused'), flags: { effort: 'auto' } });
  t.after(() => tui.close());
  const seen = titles(tui);

  tui.send('do the thing\r');
  await tui.waitFor(/5-hour limit reached · resumes at/, { timeout: 20_000 });
  await tui.wait(100);
  assert.equal(seen.at(-1), '⏸ do the thing | paused · mock');
  tui.send('\x1b');
  await tui.waitFor('Interrupted by user', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  await tui.wait(100);
  assert.equal(seen.at(-1), '✳ do the thing | paused · mock');
});

test('the footer always shows the model and effort in use', async (t) => {
  limited = false;
  const tui = await startTui({ cwd: project(), flags: { effort: 'high' } });
  t.after(() => tui.close());
  const bottom = async () => (await tui.snapshot()).split('\n').filter((l) => l.trim()).at(-1);
  assert.match(await bottom(), new RegExp(`^ {2}\\? for shortcuts {2,}ctx \\d+(?:\\.\\d+)?[kM]?/\\d+(?:\\.\\d+)?[kM]? · v\\d+\\.\\d+\\.\\d+ · mock · effort high$`));

  tui.send('/effort low\r');
  await tui.waitFor('Effort set to low', { timeout: 20_000 });
  await tui.wait(100);
  assert.match(await bottom(), /\? for shortcuts {2,}ctx \d+(?:\.\d+)?[kM]?\/\d+(?:\.\d+)?[kM]? · v\d+\.\d+\.\d+ · mock · effort low$/);

  tui.send('/effort auto\r');
  await tui.waitFor('Effort set to auto', { timeout: 20_000 });
  await tui.wait(100);
  assert.match(await bottom(), /\? for shortcuts {2,}ctx \d+(?:\.\d+)?[kM]?\/\d+(?:\.\d+)?[kM]? · v\d+\.\d+\.\d+ · mock$/, 'no effort is sent and the model\'s default is not known, so none is shown');

  tui.send('check context usage\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  await tui.wait(100);
  assert.match(await bottom(), /\? for shortcuts {2,}ctx [1-9]\d*(?:\.\d+)?[kM]?\/\d+(?:\.\d+)?[kM]? · v\d+\.\d+\.\d+ · mock$/, 'the footer reports context tokens after a request');
});

test('the footer drops the model when the window is too narrow, instead of overflowing', async (t) => {
  limited = false;
  const tui = await startTui({ cwd: project(), flags: { effort: 'high' }, cols: 60 });
  t.after(() => tui.close());
  const bottom = async () => (await tui.snapshot()).split('\n').filter((l) => l.trim()).at(-1);
  assert.match(await bottom(), /\? for shortcuts +ctx \d+(?:\.\d+)?[kM]?\/\d+(?:\.\d+)?[kM]? · v\d+\.\d+\.\d+ · mock · effort high$/);
  await tui.resize(24);
  const narrow = await bottom();
  assert.ok(narrow.length <= 24, `"${narrow}" fits the window`);
  assert.match(narrow, /\? for shortcuts/);
  await tui.resize(60);
  assert.match(await bottom(), /\? for shortcuts +ctx \d+(?:\.\d+)?[kM]?\/\d+(?:\.\d+)?[kM]? · v\d+\.\d+\.\d+ · mock · effort high$/, 'and it is back when there is room');
});
