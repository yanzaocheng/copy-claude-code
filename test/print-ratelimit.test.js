import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Print mode (claude-pro -p) run in this process against a fake API server, with a clock that only moves
// when the test says so. e2e.test.js starts the real command and can see a pause begin, but cannot wait
// hours for it to end; this file covers the rest: the pause ending, a pause during compaction, and a
// pause inside a sub-agent. The environment is set before the app modules are loaded.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-print-config-'));
const MESSAGE = "This request would exceed your account's rate limit. Please try again later.";
const HOUR = 3_600_000;

function sse(blocks, stopReason) {
  const events = [
    { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 10, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
}

// One scripted answer per request: LIMIT is a 429 for the 5-hour window, PLAIN_LIMIT a 429 that says
// nothing about when it ends, anything else is a reply.
const LIMIT = { limit: true };
const PLAIN_LIMIT = { limit: true, plain: true };
const say = (text) => ({ stopReason: 'end_turn', blocks: [{ type: 'text', text }] });
let steps = [];
let requests = [];
let resetAtMs = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    requests.push(JSON.parse(body));
    const step = steps[Math.min(requests.length - 1, steps.length - 1)];
    if (step.limit) {
      res.writeHead(429, {
        'content-type': 'application/json',
        ...(step.plain ? {} : {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-reset': String(Math.floor(resetAtMs / 1000)),
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        }),
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: MESSAGE } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(step.blocks, step.stopReason));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

Object.assign(process.env, {
  CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_PRO_GATEWAY_API_KEY: 'test-token', CLAUDE_PRO_GATEWAY_MODEL: 'mock', CLAUDE_PRO_MAX_RETRIES: '3', CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_PRO_RIPGREP_PATH: 'off', CLAUDE_CODE_EFFORT_LEVEL: '', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
});
const { runPrint } = await import('../src/print.js');
const { SessionStore } = await import('../src/session.js');
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

// A clock that jumps over every wait at once, for runs that sit through many of them.
function fastClock(t) {
  const original = { ...timing };
  let offset = 0;
  timing.now = () => Date.now() + offset;
  timing.sleep = async (ms, signal) => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    offset += ms;
  };
  t.after(() => Object.assign(timing, original));
}

const noColor = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-print-'));
const sink = () => ({ text: '', write(s) { this.text += s; return true; } });

// Run `claude-pro -p` to the end with every wait skipped, and return what it printed.
async function runThrough(t, steps_, { prompt = 'hello' } = {}) {
  steps = steps_;
  requests = [];
  resetAtMs = Date.now() + 3 * HOUR;
  fastClock(t);
  const out = sink();
  const err = sink();
  const code = await runPrint({ prompt, flags: { noMcp: true }, cwd: project(), stdout: out, stderr: err });
  return { code, stdout: out.text, stderr: noColor(err.text) };
}

// Start `claude-pro -p` and hand back its output so far, plus the means to wait for the pause and end it.
function start(t, steps_, { prompt = 'hello', cwd = project(), flags = {} } = {}) {
  steps = steps_;
  requests = [];
  resetAtMs = Date.now() + 3 * HOUR;
  const clock = controlledClock(t);
  const out = sink();
  const err = sink();
  let finished = false;
  const done = runPrint({ prompt, flags: { noMcp: true, ...flags }, cwd, stdout: out, stderr: err }).finally(() => { finished = true; });
  return {
    out,
    done,
    stderr: () => noColor(err.text),
    // Wait until the pause has been announced (and has not already ended the run).
    async paused() {
      const began = Date.now();
      while (!/continuing automatically/.test(err.text)) {
        assert.ok(Date.now() - began < 20_000, `no pause within 20 seconds; stderr: ${err.text}`);
        assert.equal(finished, false, `the run ended instead of pausing; stderr: ${err.text}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    resume: () => clock.release(3 * HOUR + 15_000),
  };
}

const PAUSE = /5-hour limit reached\. Pausing until (tomorrow )?\d\d:\d\d \(in (2h 59m|3h 0m)\), then continuing automatically\./;

test('print mode: the pause ends by itself and the answer is printed, with both events reported on stderr', async (t) => {
  const run = start(t, [LIMIT, say('Back at work.')]);
  await run.paused();
  assert.match(run.stderr(), PAUSE);
  assert.equal(requests.length, 1, 'one request, then it waits');
  assert.equal(run.out.text, '', 'nothing is printed to stdout while paused');

  run.resume();
  assert.equal(await run.done, 0);
  assert.equal(run.out.text, 'Back at work.\n');
  const stderr = run.stderr();
  assert.equal(stderr.match(/The limit has cleared; continuing\./g)?.length, 1);
  assert.ok(stderr.indexOf('continuing automatically') < stderr.indexOf('The limit has cleared'), 'pause is reported before the resume');
  assert.doesNotMatch(stderr, /\[general-purpose\]/, 'the main agent is not labelled as a sub-agent');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages, requests[0].messages, 'the same request is repeated, not a new one');
});

test('print mode: --output-format json still reports the pause on stderr and keeps stdout to the JSON result', async (t) => {
  const run = start(t, [LIMIT, say('Done.')], { flags: { outputFormat: 'json' } });
  await run.paused();
  run.resume();
  assert.equal(await run.done, 0);
  const lines = run.out.text.trim().split('\n');
  assert.equal(lines.length, 1, `stdout must hold the JSON result only: ${run.out.text}`);
  const result = JSON.parse(lines[0]);
  assert.equal(result.type, 'result');
  assert.equal(result.is_error, false);
  assert.equal(result.result, 'Done.');
  assert.match(run.stderr(), PAUSE);
});

// Compaction from 2000 tokens on, for as long as the test runs.
function compactEarly(t) {
  const saved = { window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, pct: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE };
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '20000';
  process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '10';
  t.after(() => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = saved.window ?? '';
    if (saved.pct === undefined) delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE; else process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = saved.pct;
  });
}

// An earlier conversation to resume, and a prompt big enough to make the next request compact it first.
function longConversation(t) {
  compactEarly(t);
  const cwd = project();
  const store = new SessionStore(cwd);
  store.message({ role: 'user', content: [{ type: 'text', text: 'an earlier question' }] });
  store.message({ role: 'assistant', content: [{ type: 'text', text: 'an earlier answer' }] });
  return { cwd, prompt: `Please continue. ${'filler text '.repeat(1500)}`, flags: { resumeFile: store.file, resumeId: store.id } };
}

test('print mode: a pause while compacting a long conversation is reported, and the compaction completes', async (t) => {
  const run = start(t, [LIMIT, say('<analysis>thinking</analysis><summary>SUMMARY OF THE EARLIER WORK</summary>'), say('Final answer.')], longConversation(t));
  await run.paused();
  assert.match(run.stderr(), PAUSE, 'a pause during compaction must not be silent');
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0].messages.at(-1)), /detailed summary of the conversation/, 'the request that was limited is the compaction');

  run.resume();
  assert.equal(await run.done, 0);
  assert.equal(run.out.text, 'Final answer.\n');
  assert.equal(run.stderr().match(/The limit has cleared; continuing\./g)?.length, 1);
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[1].messages.at(-1)), /detailed summary of the conversation/, 'the compaction is repeated after the pause');
  assert.match(JSON.stringify(requests[2].messages), /SUMMARY OF THE EARLIER WORK/, 'and its summary is what the next request is built on');
  assert.equal(requests[2].messages.length, 1, 'the earlier conversation was replaced by the summary');
});

test('print mode: Ctrl-C during a pause ends the run as an interruption (exit code 130), not as an error', async (t) => {
  const run = start(t, [LIMIT, say('never reached')]);
  await run.paused();
  process.emit('SIGINT');
  assert.equal(await run.done, 130);
  assert.doesNotMatch(run.stderr(), /Error/);
  assert.equal(requests.length, 1, 'nothing more was sent after the interrupt');
});

test('print mode: Ctrl-C during the pause of an automatic compaction is an interruption too', async (t) => {
  const run = start(t, [LIMIT, say('never reached')], longConversation(t));
  await run.paused();
  assert.match(JSON.stringify(requests[0].messages.at(-1)), /detailed summary of the conversation/, 'it is the compaction that is paused');
  process.emit('SIGINT');
  assert.equal(await run.done, 130, run.stderr()); // used to be "Error: aborted" and exit code 1
  assert.doesNotMatch(run.stderr(), /Error/);
  assert.equal(requests.length, 1);
});

test('print mode: a pause inside a sub-agent is reported with the name of the agent, then the run goes on', async (t) => {
  const run = start(t, [
    { stopReason: 'tool_use', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'look around', prompt: 'find the answer', subagent_type: 'general-purpose' } }] },
    LIMIT, // the sub-agent's first request
    say('The sub-agent found 42.'),
    say('All done: 42.'),
  ]);
  await run.paused();
  assert.match(run.stderr(), /\[general-purpose\] 5-hour limit reached\. Pausing until/, 'the pause must say which agent it is');
  assert.equal(requests.length, 2);
  assert.equal(run.out.text, '');

  run.resume();
  assert.equal(await run.done, 0);
  assert.equal(run.out.text, 'All done: 42.\n');
  assert.match(run.stderr(), /\[general-purpose\] The limit has cleared; continuing\./);
  assert.equal(requests.length, 4);
  const toolResult = requests[3].messages.at(-1).content.find((b) => b.type === 'tool_result');
  assert.equal(toolResult.tool_use_id, 'toolu_1');
  assert.ok(!toolResult.is_error, JSON.stringify(toolResult));
  assert.match(JSON.stringify(toolResult.content), /The sub-agent found 42\./, 'the sub-agent finished its work after the pause');
});

// With no reset time to go by, the request is repeated at growing intervals: five short retries, then
// waits of 32s, 64s, ... that are real pauses. Each of those is reported to the agent's io, but the user
// is told once; a log line every few minutes for six hours would bury everything else.
const TASK_CALL = { stopReason: 'tool_use', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'look around', prompt: 'find the answer', subagent_type: 'general-purpose' } }] };

test('print mode: a pause without a reset time is announced once, however often it checks again', async (t) => {
  const r = await runThrough(t, [...Array(9).fill(PLAIN_LIMIT), say('Finally.')]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Finally.\n');
  assert.equal(requests.length, 10);
  assert.equal(r.stderr.match(/the server gave no reset time/g)?.length, 1, `announced once:\n${r.stderr}`);
  assert.equal(r.stderr.match(/The limit has cleared; continuing\./g)?.length, 1);
});

test('print mode: a sub-agent that keeps checking is announced once too, under its own name', async (t) => {
  const r = await runThrough(t, [TASK_CALL, ...Array(9).fill(PLAIN_LIMIT), say('The sub-agent found 42.'), say('All done: 42.')]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'All done: 42.\n');
  assert.equal(r.stderr.match(/\[general-purpose\] Rate limit reached and the server gave no reset time/g)?.length, 1, `announced once:\n${r.stderr}`);
  assert.equal(r.stderr.match(/\[general-purpose\] The limit has cleared; continuing\./g)?.length, 1);
  assert.doesNotMatch(r.stderr.replace(/\[general-purpose\][^\n]*/g, ''), /limit/i, 'the main agent was not paused, so nothing is reported for it');
});

test('print mode: a pause while a sub-agent compacts its own conversation is reported under its name', async (t) => {
  const cwd = project();
  const big = path.join(cwd, 'big.txt');
  fs.writeFileSync(big, 'some text on a line\n'.repeat(2000));
  const saved = { window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, pct: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE };
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '20000';
  process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '10'; // compact from 2000 tokens on
  t.after(() => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = saved.window ?? '';
    if (saved.pct === undefined) delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE; else process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = saved.pct;
  });
  const readBig = { stopReason: 'tool_use', blocks: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: big } }] };
  const run = start(t, [
    TASK_CALL,
    readBig, // the sub-agent reads a big file, which takes it past the compaction threshold
    LIMIT, // so its next request is a compaction, and that is limited
    say('<summary>THE SUB-AGENT SUMMARY</summary>'),
    say('The sub-agent found 42.'),
    say('All done: 42.'),
  ], { cwd });
  await run.paused();
  assert.match(run.stderr(), /\[general-purpose\] 5-hour limit reached\. Pausing until/, 'a sub-agent compaction pause must not be silent');
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[2].messages.at(-1)), /detailed summary of the conversation/, 'the limited request is the sub-agent\'s compaction');

  run.resume();
  assert.equal(await run.done, 0, run.stderr());
  assert.equal(run.out.text, 'All done: 42.\n');
  assert.match(run.stderr(), /\[general-purpose\] The limit has cleared; continuing\./);
  assert.equal(requests.length, 6);
});

test('print mode: the SIGINT listener of a finished run is removed again', async (t) => {
  const before = process.listenerCount('SIGINT');
  steps = [say('ok')];
  requests = [];
  const out = { write() { return true; } };
  assert.equal(await runPrint({ prompt: 'hi', flags: { noMcp: true }, cwd: project(), stdout: out, stderr: out }), 0);
  assert.equal(process.listenerCount('SIGINT'), before);
});
