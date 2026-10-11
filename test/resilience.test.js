import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.js';
import { streamMessage, isAbort } from '../src/api.js';
import { parseRetryAfter, retryDelay, timing } from '../src/ratelimit.js';
import { Agent } from '../src/agent.js';
import { ModeManager } from '../src/modes.js';
import { GlobTool } from '../src/tools/search.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-resilience-'));
const configWith = (env) => new Config({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'test-token', ANTHROPIC_MODEL: 'mock', ...env }, {}, { hooks: {}, mcpServers: {} }, process.cwd());
const request = (cfg) => ({ model: cfg.mainModel, system: 's', messages: [{ role: 'user', content: 'hi' }] });

function mockFetch(t, handle) {
  const original = globalThis.fetch;
  globalThis.fetch = handle;
  t.after(() => { globalThis.fetch = original; });
}

// A clock that only moves when the code under test sleeps, so waits of any length run instantly.
function fakeClock(t) {
  const original = { ...timing };
  let now = Date.now();
  timing.now = () => now;
  timing.sleep = async (ms, signal) => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    now += ms;
    await new Promise((resolve) => setImmediate(resolve));
  };
  t.after(() => Object.assign(timing, original));
  return { get now() { return now; } };
}

const errorResponse = (status, message, headers = {}) => new Response(
  JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message } }),
  { status, headers: { 'content-type': 'application/json', ...headers } },
);

function okResponse(text = 'ok') {
  const events = [
    { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

test('parseRetryAfter reads seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(' 0.5 '), 500);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter('soon'), null);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now), 0);
});

test('retryDelay: exponential backoff with jitter, but never shorter than Retry-After', () => {
  for (let i = 0; i < 50; i++) {
    const first = retryDelay(1);
    assert.ok(first >= 1000 && first < 1500, `attempt 1 gave ${first}`);
    const capped = retryDelay(9);
    assert.ok(capped >= 32_000 && capped < 32_500, `attempt 9 gave ${capped}`);
  }
  assert.equal(retryDelay(1, 60_000), 60_000);
  assert.ok(retryDelay(1, 0) >= 1000);
  assert.ok(retryDelay(3, 500) >= 4000);
});

test('isAbort recognises our aborts but not server errors that merely mention "aborted"', () => {
  assert.ok(isAbort(Object.assign(new Error('x'), { name: 'AbortError' })));
  assert.ok(isAbort(new Error('aborted')));
  assert.ok(isAbort(new Error('Request was aborted.')));
  assert.ok(!isAbort(new Error('upstream request aborted by the gateway')));
  assert.ok(!isAbort(new Error('Connection error.')));
  assert.ok(!isAbort(null));
});

test('a 429 that announces a short wait is retried after that wait, not the shorter backoff', async (t) => {
  const clock = fakeClock(t);
  const times = [];
  mockFetch(t, async () => {
    times.push(clock.now);
    return times.length === 1 ? errorResponse(429, 'slow down', { 'retry-after': '7' }) : okResponse('fine');
  });
  const cfg = configWith({ CLAUDE_PRO_MAX_RETRIES: '3' });
  const events = [];
  const res = await streamMessage(cfg, request(cfg), { onEvent: (ev) => events.push(ev) });
  assert.equal(res.message.content[0].text, 'fine');
  assert.equal(times.length, 2);
  assert.equal(times[1] - times[0], 7000);
  const retry = events.find((ev) => ev.type === 'retry');
  assert.equal(retry.delayMs, 7000);
  assert.equal(retry.error.status, 429);
  assert.ok(!events.some((ev) => ev.type === 'rate_limit_wait'), 'a 7 second wait is not a pause');
});

test('a 429 without any timing backs off exponentially', async (t) => {
  const clock = fakeClock(t);
  const times = [];
  mockFetch(t, async () => {
    times.push(clock.now);
    return times.length < 3 ? errorResponse(429, 'slow down') : okResponse();
  });
  const cfg = configWith({ CLAUDE_PRO_MAX_RETRIES: '3' });
  await streamMessage(cfg, request(cfg));
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 1000 && times[1] - times[0] < 1500, `first wait ${times[1] - times[0]}`);
  assert.ok(times[2] - times[1] >= 2000 && times[2] - times[1] < 2500, `second wait ${times[2] - times[1]}`);
});

test('CLAUDE_PRO_MAX_RETRIES=0 turns retries off, also for 429 and also for a long reset', async (t) => {
  let calls = 0;
  mockFetch(t, async () => {
    calls++;
    return errorResponse(429, 'rate limited', { 'retry-after': calls === 1 ? '1' : '7200' });
  });
  const cfg = configWith({ CLAUDE_PRO_MAX_RETRIES: '0' });
  await assert.rejects(() => streamMessage(cfg, request(cfg)), /rate limited/);
  assert.equal(calls, 1);
  await assert.rejects(() => streamMessage(cfg, request(cfg)), /rate limited/);
  assert.equal(calls, 2, 'one request each: nothing was waited for or retried');
});

test('a server error that mentions "aborted" is retried, not mistaken for a user interrupt', async (t) => {
  fakeClock(t);
  let calls = 0;
  mockFetch(t, async () => { calls++; return errorResponse(500, 'upstream request aborted'); });
  const cfg = configWith({ CLAUDE_PRO_MAX_RETRIES: '2' });
  const events = [];
  await assert.rejects(() => streamMessage(cfg, request(cfg), { onEvent: (ev) => events.push(ev) }), (err) => {
    assert.notEqual(err.name, 'AbortError');
    assert.match(err.message, /upstream request aborted/);
    return true;
  });
  assert.equal(calls, 3, 'the first request and two retries');
  assert.equal(events.filter((ev) => ev.type === 'retry').length, 2);
});

test('aborting while waiting to retry stops at once', async (t) => {
  // the real, abortable timer: this wait would otherwise last two minutes
  mockFetch(t, async () => errorResponse(500, 'overloaded', { 'retry-after': '120' }));
  const cfg = configWith({ CLAUDE_PRO_MAX_RETRIES: '3' });
  const ctrl = new AbortController();
  const started = Date.now();
  await assert.rejects(
    () => streamMessage(cfg, request(cfg), { signal: ctrl.signal, onEvent: (ev) => { if (ev.type === 'retry') ctrl.abort(); } }),
    (err) => err.name === 'AbortError',
  );
  assert.ok(Date.now() - started < 2000, 'the 120s wait must be cancelled');
});

test('Agent.assistantText keeps what a failed run had already written', async () => {
  const dir = tmp();
  const cfg = new Config({ ANTHROPIC_MODEL: 'mock' }, {}, { hooks: {}, mcpServers: {} }, dir);
  const agent = new Agent({ config: cfg, modes: new ModeManager(), tools: [GlobTool], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: dir });
  let calls = 0;
  agent.callModel = async () => {
    calls++;
    if (calls === 1) {
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: 'Found the bug in a.js line 3.' }, { type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '*.none' } }] },
        stopReason: 'tool_use',
      };
    }
    throw new Error('rate limited');
  };
  await assert.rejects(() => agent.run('investigate'), /rate limited/);
  assert.equal(agent.assistantText(), 'Found the bug in a.js line 3.');
  assert.equal(agent.assistantText(10), '…js line 3.');
});

test('Agent.assistantText is empty when nothing was written', () => {
  const cfg = new Config({ ANTHROPIC_MODEL: 'mock' }, {}, { hooks: {}, mcpServers: {} }, process.cwd());
  const agent = new Agent({ config: cfg, modes: new ModeManager(), tools: [], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: process.cwd() });
  agent.messages.push({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
  assert.equal(agent.assistantText(), '');
});

test('an image the API refuses as too large is scaled in the conversation itself, and the request goes through', { skip: process.platform !== 'win32' && 'scaling uses System.Drawing here' }, async (t) => {
  const zlib = await import('node:zlib');
  const { imageSize } = await import('../src/utils/images.js');
  // a 400×3200 PNG, as a full-page screenshot read before images were scaled would be
  const w = 400, h = 3200, stride = 1 + w * 3;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(stride * h))), chunk('IEND', Buffer.alloc(0))]);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } };
  const messages = [
    { role: 'user', content: 'look' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: [image] }] },
  ];
  const sent = [];
  mockFetch(t, async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.messages[2].content[0].content[0].source.data);
    return sent.length === 1
      ? errorResponse(400, 'messages.2.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels')
      : okResponse('seen');
  });
  const cfg = configWith({ CLAUDE_PRO_MAX_RETRIES: '0' });
  const res = await streamMessage(cfg, { model: cfg.mainModel, system: 's', messages });
  assert.equal(res.message.content[0].text, 'seen');
  assert.equal(sent.length, 2);
  assert.deepEqual(imageSize(Buffer.from(sent[1], 'base64')), { width: 196, height: 1568 });
  assert.equal(image.source.data, sent[1], 'the conversation holds the scaled image from now on');
});
