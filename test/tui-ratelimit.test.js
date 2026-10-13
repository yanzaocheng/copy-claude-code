import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The real interactive App in a headless terminal, against a fake API server, with a clock that only
// moves when the test says so. The environment is set before the app modules are loaded.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-tui-config-'));
const MESSAGE = "This request would exceed your account's rate limit. Please try again later.";
const HOUR = 3_600_000;

let requests = 0;
let resetAtMs = 0;
let limitedRequests = 1; // how many requests are answered with a 429 before the server lets one through
let script = null; // optional (n) => 'limit' | {blocks, stopReason}: the answer to request number n instead of the rule above

function sse(blocks, stopReason) {
  const events = [
    { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 1, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  return events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
}

const say = (text) => ({ stopReason: 'end_turn', blocks: [{ type: 'text', text }] });
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    requests++;
    const step = script ? script(requests) : requests <= limitedRequests ? 'limit' : say('Back at work.');
    if (step === 'limit') {
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(Math.floor(resetAtMs / 1000)),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: MESSAGE } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(step.blocks, step.stopReason));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

Object.assign(process.env, {
  CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_PROVIDER: 'api', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  ANTHROPIC_AUTH_TOKEN: 'test-token', ANTHROPIC_MODEL: 'mock', CLAUDE_PRO_MAX_RETRIES: '3', CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_PRO_RIPGREP_PATH: 'off', CLAUDE_CODE_EFFORT_LEVEL: '', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
});
const { startTui } = await import('./tui-harness.js');
const { timing } = await import('../src/ratelimit.js');

// The pause waits on this instead of the real clock; release() lets it end and moves the clock past the reset.
function controlledClock(t) {
  const original = { ...timing };
  let offset = 0;
  let wake = null;
  timing.now = () => Date.now() + offset;
  timing.sleep = (ms, signal) => new Promise((resolve, reject) => {
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal?.aborted) return reject(aborted());
    signal?.addEventListener('abort', () => reject(aborted()), { once: true });
    wake = resolve;
  });
  t.after(() => Object.assign(timing, original));
  return { release(advanceMs) { offset += advanceMs; wake?.(); } };
}

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-tui-'));
const reset = (limited) => { requests = 0; limitedRequests = limited; resetAtMs = Date.now() + 3 * HOUR; script = null; };

test.after(() => server.close());

test('interactive: a rate limit shows a live countdown, then continues by itself when the window resets', async (t) => {
  const clock = controlledClock(t);
  reset(1);
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());

  tui.send('hello\r');
  const paused = await tui.waitFor(/5-hour limit reached · resumes at (tomorrow )?\d\d:\d\d \(in (2h 59m|3h 0m)\)/, { timeout: 20_000 });
  assert.match(paused, /esc to cancel/);
  // the notice is logged once and may wrap at the terminal width
  assert.match(paused, /5-hour limit reached\. Pausing until (tomorrow )?\d\d:\d\d \(in (2h 59m|3h 0m)\), then continuing automatically\.\s+Esc\s+cancels\./);
  assert.equal(tui.app.busy, true);
  assert.equal(requests, 1, 'one request, then it waits');
  assert.doesNotMatch(paused, /Back at work/);

  clock.release(3 * HOUR + 15_000);
  const resumed = await tui.waitFor('Back at work.', { timeout: 20_000 });
  assert.match(resumed, /The limit has cleared; continuing\./);
  await tui.waitIdle({ timeout: 20_000 });
  assert.equal(requests, 2);
  assert.equal(tui.app.rateWait, null);
  const idle = await tui.snapshot();
  assert.doesNotMatch(idle, /limit reached · resumes/, 'the countdown is gone once the turn is over');
});

test('interactive: Esc cancels the pause and the app is usable again', async (t) => {
  controlledClock(t);
  reset(100);
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());

  tui.send('hello\r');
  await tui.waitFor(/5-hour limit reached · resumes at/, { timeout: 20_000 });
  tui.send('\x1b');
  const cancelled = await tui.waitFor('Interrupted by user', { timeout: 20_000 });
  assert.match(cancelled, /Interrupted by user/);
  await tui.waitIdle({ timeout: 20_000 });
  assert.equal(tui.app.rateWait, null);
  assert.equal(tui.app.busy, false);
  assert.equal(requests, 1, 'cancelling did not send anything more');
  const screen = await tui.snapshot();
  assert.doesNotMatch(screen, /limit reached · resumes/);
});

test('interactive: a compaction that hits the limit shows the countdown too, and completes after the reset', async (t) => {
  const clock = controlledClock(t);
  reset(0); // the first message is answered at once
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  tui.send('hello\r');
  await tui.waitFor('Back at work.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });

  reset(1); // from here on the first request, the compaction, is limited
  tui.send('/compact\r');
  const paused = await tui.waitFor(/5-hour limit reached · resumes at (tomorrow )?\d\d:\d\d \(in (2h 59m|3h 0m)\)/, { timeout: 20_000 });
  assert.match(paused, /Pausing until/, 'a compaction must not sit silent on "Compacting conversation" for hours');
  assert.equal(tui.app.busy, true);
  assert.notEqual(tui.app.rateWait, null);
  assert.equal(requests, 1);
  assert.doesNotMatch(paused, /Conversation compacted/);

  clock.release(3 * HOUR + 15_000);
  const done = await tui.waitFor('Conversation compacted', { timeout: 20_000 });
  assert.match(done, /The limit has cleared; continuing\./);
  await tui.waitIdle({ timeout: 20_000 });
  assert.equal(requests, 2);
  assert.equal(tui.app.rateWait, null);
  assert.equal(tui.app.busy, false);
});

test('interactive: Esc during a compaction pause leaves no stale countdown, and the next pause is announced again', async (t) => {
  controlledClock(t);
  reset(0);
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  tui.send('hello\r');
  await tui.waitFor('Back at work.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });

  reset(100); // from here on every request is limited
  tui.send('/compact\r');
  await tui.waitFor(/5-hour limit reached · resumes at/, { timeout: 20_000 });
  tui.send('\x1b');
  await tui.waitFor('Compaction interrupted', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  assert.equal(tui.app.rateWait, null, 'the cancelled pause must not linger');
  assert.equal(tui.app.busy, false);
  assert.doesNotMatch(await tui.snapshot(), /limit reached · resumes/, 'no countdown on the idle screen');

  // the same limit again: it is news again, not a continuation of the cancelled pause
  tui.send('/compact\r');
  const twice = await tui.waitFor((snap) => (snap.match(/Pausing until/g) || []).length >= 2, { timeout: 20_000 });
  assert.equal((twice.match(/Pausing until/g) || []).length, 2);
  tui.send('\x1b');
  await tui.waitIdle({ timeout: 20_000 });
});

test('interactive: what is typed during a compaction pause is sent once the compaction is done', async (t) => {
  const clock = controlledClock(t);
  reset(0);
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  tui.send('hello\r');
  await tui.waitFor('Back at work.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });

  reset(1); // the compaction is limited
  tui.send('/compact\r');
  await tui.waitFor(/5-hour limit reached · resumes at/, { timeout: 20_000 });
  tui.send('and then do the other thing\r'); // typed while it waits: queued
  await tui.waitFor('queued: and then do the other thing', { timeout: 10_000 });

  clock.release(3 * HOUR + 15_000);
  await tui.waitFor('Conversation compacted', { timeout: 20_000 });
  // the queued message must now go out as a turn of its own, without another keystroke
  await tui.waitFor(() => requests >= 3, { timeout: 5_000 }).catch(() => {}); // the assertion below says what is wrong
  await tui.waitIdle({ timeout: 20_000 });
  assert.equal(requests, 3, 'the limited compaction, the repeated compaction, and the queued message');
  assert.deepEqual(tui.app.queue, [], 'nothing is left waiting');
  const screen = await tui.snapshot({ all: true });
  assert.match(screen, /and then do the other thing/);
  assert.doesNotMatch(await tui.snapshot(), /queued: and then/, 'the "queued" line is gone from the live area');
});

test('interactive: a notice of several lines keeps its lines, each indented, and a long one wraps between words', async (t) => {
  controlledClock(t);
  reset(0);
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  tui.app.notice('first line of a warning\nsecond line of a warning', 'warn');
  tui.app.notice(`${'word '.repeat(40)}end`, 'warn');
  const screen = await tui.snapshot({ all: true });
  assert.match(screen, /^ {2}first line of a warning$/m);
  assert.match(screen, /^ {2}second line of a warning$/m);
  const wrapped = screen.split('\n').filter((line) => /^ {2}(word )*(word|end)$/.test(line));
  assert.ok(wrapped.length >= 2, `the long notice takes several lines: ${JSON.stringify(wrapped)}`);
  assert.ok(wrapped.every((line) => line.length <= tui.term.cols - 1), 'and none of them is wider than the screen');
  assert.equal(wrapped.join(' ').replace(/\s+/g, ' ').trim(), `${'word '.repeat(40)}end`, 'no word was lost or cut');
});

test('interactive: while the login is being waited for the countdown line says so, and the notice comes once', async (t) => {
  controlledClock(t);
  reset(0);
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  // what streamMessage reports after a pause whose login has expired: a check every 15 seconds
  const waiting = () => ({ type: 'rate_limit_wait', label: 'login', polling: true, waitingForLogin: true, resumeAt: Date.now() + 15_000, giveUpAt: Date.now() + HOUR });
  tui.app.busy = true;
  tui.app.turnStart = Date.now();
  tui.app.rateLimitEvent({ type: 'rate_limit_wait', label: '5-hour limit', polling: false, resumeAt: Date.now() + HOUR });
  tui.app.rateLimitEvent(waiting());
  tui.app.rateLimitEvent(waiting());
  tui.app.rateLimitEvent(waiting());
  const screen = await tui.waitFor(/Waiting for the Claude subscription login to be renewed · checking again in \d+s/, { timeout: 10_000 });
  assert.match(screen, /esc to cancel/);
  assert.equal((screen.match(/The limit has reset, but the Claude subscription login has expired/g) || []).length, 1, 'announced once, not at every check');
  assert.match(screen.replace(/\s+/g, ' '), /run claude once, and this continues by itself\./, 'the notice says what to do (it may wrap at the terminal width)');
  // a long notice breaks between words: "claude" used to be cut into "clau" and "de" at the 100th column
  for (const word of ['claude', 'continues', 'itself', 'expired', 'Giving']) assert.match(screen, new RegExp(`\\b${word}\\b`), `"${word}" must not be split across two lines`);
  assert.doesNotMatch(screen.split('\n').slice(-6).join('\n'), /5-hour limit reached · resumes/, 'the countdown line is the login one now');
  tui.app.rateLimitEvent({ type: 'rate_limit_resume' });
  tui.app.busy = false;
  assert.equal(tui.app.rateWait, null);
});

test('interactive: a pause while a sub-agent compacts its own conversation is announced under its name too', async (t) => {
  const clock = controlledClock(t);
  reset(0);
  const cwd = project();
  const big = path.join(cwd, 'big.txt');
  fs.writeFileSync(big, 'some text on a line\n'.repeat(2000));
  const saved = { window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, pct: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE };
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '20000';
  process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '10'; // compact from 2000 tokens on
  const task = { stopReason: 'tool_use', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'look around', prompt: 'find the answer', subagent_type: 'general-purpose' } }] };
  const readBig = { stopReason: 'tool_use', blocks: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: big } }] };
  const steps = [task, readBig, 'limit', say('<summary>THE SUB-AGENT SUMMARY</summary>'), say('The sub-agent found 42.'), say('All done: 42.')];
  script = (n) => steps[n - 1];
  const tui = await startTui({ cwd });
  t.after(() => {
    tui.close();
    script = null;
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = saved.window ?? '';
    if (saved.pct === undefined) delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE; else process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = saved.pct;
  });

  tui.send('go\r');
  await tui.waitFor(/\[general-purpose\] 5-hour limit reached\. Pausing until/, { timeout: 20_000 });
  assert.equal(requests, 3, 'main, the sub-agent reading the file, and its compaction');
  clock.release(3 * HOUR + 15_000);
  const resumed = await tui.waitFor('All done: 42.', { timeout: 20_000 });
  assert.match(resumed, /\[general-purpose\] The limit has cleared; continuing\./);
  await tui.waitIdle({ timeout: 20_000 });
  assert.equal(requests, 6);
});

test('interactive: a sub-agent that hits the limit is announced under its name, and finishes after the reset', async (t) => {
  const clock = controlledClock(t);
  reset(0);
  const task = { stopReason: 'tool_use', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'look around', prompt: 'find the answer', subagent_type: 'general-purpose' } }] };
  script = (n) => (n === 1 ? task : n === 2 ? 'limit' : n === 3 ? say('The sub-agent found 42.') : say('All done: 42.'));
  const tui = await startTui({ cwd: project() });
  t.after(() => { tui.close(); script = null; });

  tui.send('go\r');
  const paused = await tui.waitFor(/\[general-purpose\] 5-hour limit reached\. Pausing until/, { timeout: 20_000 });
  assert.equal(tui.app.busy, true);
  assert.equal(requests, 2, 'the main agent asked once, the sub-agent once');
  assert.equal(tui.app.rateWait, null, 'the countdown line is the main agent\'s: a background agent can be paused while the main one works');
  assert.doesNotMatch(paused, /All done/);

  clock.release(3 * HOUR + 15_000);
  const resumed = await tui.waitFor('All done: 42.', { timeout: 20_000 });
  assert.match(resumed, /\[general-purpose\] The limit has cleared; continuing\./);
  await tui.waitIdle({ timeout: 20_000 });
  assert.equal(requests, 4);
});
