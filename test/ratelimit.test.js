import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.js';
import { streamMessage, quickQuery } from '../src/api.js';
import { Agent } from '../src/agent.js';
import { ModeManager } from '../src/modes.js';
import { GlobTool } from '../src/tools/search.js';
import { endpoint } from '../src/oauth.js';
import {
  parseRateLimit, planRetry, humanDuration, formatClock, describePause, shouldAnnounce, sleepUntil, timing, resumeText,
} from '../src/ratelimit.js';

endpoint.url = 'http://127.0.0.1:9/never-reached'; // no test may reach the real token endpoint

const MIN = 60_000;
const HOUR = 60 * MIN;
const MESSAGE = "This request would exceed your account's rate limit. Please try again later.";

// The headers the API sends when a window of the subscription is used up.
const unified = (resetAtMs, extra = {}) => ({
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-reset': String(Math.floor(resetAtMs / 1000)),
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  ...extra,
});

// ---------------------------------------------------------------- reading the headers

test('parseRateLimit reads the reset of a rejected window (epoch seconds)', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0, 0);
  const rl = parseRateLimit(new Headers(unified(now + 3 * HOUR)), now);
  assert.equal(rl.label, '5-hour limit');
  assert.equal(rl.claim, 'five_hour');
  assert.equal(rl.status, 'rejected');
  assert.equal(rl.source, 'unified-reset');
  assert.equal(rl.waitMs, 3 * HOUR);
  assert.equal(rl.resetAt, now + 3 * HOUR);
});

test('parseRateLimit ignores a reset that does not block the request', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0, 0);
  const wait = (extra) => parseRateLimit(new Headers(unified(now + HOUR, extra)), now).waitMs;
  assert.equal(wait({}), HOUR);
  assert.equal(wait({ 'anthropic-ratelimit-unified-status': 'allowed_warning' }), null, 'only a warning');
  assert.equal(wait({ 'anthropic-ratelimit-unified-status': 'allowed' }), null);
  assert.equal(wait({ 'anthropic-ratelimit-unified-overage-status': 'allowed' }), null, 'extra usage takes over');
  assert.equal(wait({ 'anthropic-ratelimit-unified-overage-status': 'rejected' }), HOUR, 'extra usage is rejected too');
  assert.equal(parseRateLimit(new Headers(), now).waitMs, null);
  assert.equal(parseRateLimit(undefined, now).waitMs, null);
  assert.equal(parseRateLimit(null, now).label, 'rate limit');
});

test('parseRateLimit: Retry-After alone, and the longer of the two when both are there', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0, 0);
  const only = parseRateLimit(new Headers({ 'retry-after': '7' }), now);
  assert.equal(only.waitMs, 7000);
  assert.equal(only.source, 'retry-after');
  assert.equal(only.resetAt, now + 7000);
  const shortRetryAfter = parseRateLimit(new Headers(unified(now + 3 * HOUR, { 'retry-after': '60' })), now);
  assert.equal(shortRetryAfter.waitMs, 3 * HOUR);
  assert.equal(shortRetryAfter.source, 'unified-reset');
  const longRetryAfter = parseRateLimit(new Headers(unified(now + 3 * HOUR, { 'retry-after': '86400' })), now);
  assert.equal(longRetryAfter.waitMs, 24 * HOUR);
  assert.equal(longRetryAfter.source, 'retry-after');
});

test('parseRateLimit: milliseconds, past times and header lookup in any case', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0, 0);
  assert.equal(parseRateLimit(new Headers(unified(now + HOUR, { 'anthropic-ratelimit-unified-reset': String(now + HOUR) })), now).waitMs, HOUR, 'a reset in milliseconds');
  assert.equal(parseRateLimit(new Headers(unified(now - 5 * MIN)), now).waitMs, 0, 'a reset that has already passed');
  const plain = { 'Anthropic-RateLimit-Unified-Status': 'rejected', 'ANTHROPIC-RATELIMIT-UNIFIED-RESET': String(Math.floor((now + 2 * HOUR) / 1000)), 'Retry-After': ['30'] };
  assert.equal(parseRateLimit(plain, now).waitMs, 2 * HOUR);
  assert.equal(parseRateLimit({ 'retry-after': ['30'] }, now).waitMs, 30_000);
});

test('parseRateLimit names the window', () => {
  const label = (claim) => parseRateLimit(new Headers({ 'anthropic-ratelimit-unified-representative-claim': claim }), 0).label;
  assert.equal(label('five_hour'), '5-hour limit');
  assert.equal(label('seven_day'), 'weekly limit');
  assert.equal(label('seven_day_opus'), 'weekly Opus limit');
  assert.equal(label('seven_day_sonnet'), 'weekly Sonnet limit');
  assert.equal(label('seven_day_something_new'), 'weekly limit');
  assert.equal(label('overage'), 'extra usage limit');
  assert.equal(label('who_knows'), 'rate limit');
});

// ---------------------------------------------------------------- wording

test('humanDuration and formatClock', () => {
  assert.equal(humanDuration(45_000), '45s');
  assert.equal(humanDuration(12 * MIN + 30_000), '12m 30s');
  assert.equal(humanDuration(2 * HOUR + 13 * MIN + 29_000), '2h 13m');
  assert.equal(humanDuration(2 * HOUR + 13 * MIN + 31_000), '2h 14m', 'rounded to the nearest minute');
  assert.equal(humanDuration(3 * HOUR - 400), '3h 0m');
  assert.equal(humanDuration(59 * MIN + 59_000), '59m 59s', 'under an hour keeps the seconds');
  assert.equal(humanDuration(5 * 24 * HOUR + 13 * HOUR), '5d 13h');
  assert.equal(humanDuration(7 * 24 * HOUR - 900), '7d 0h');
  assert.equal(humanDuration(-5), '0s');
  const now = new Date(2026, 9, 4, 20, 10).getTime(); // local time on purpose
  assert.equal(formatClock(new Date(2026, 9, 4, 23, 41).getTime(), now), '23:41');
  assert.equal(formatClock(new Date(2026, 9, 5, 2, 15).getTime(), now), 'tomorrow 02:15');
  assert.equal(formatClock(new Date(2026, 9, 9, 21, 5).getTime(), now), 'Oct 9 21:05');
});

test('describePause says when it resumes, and warns when the login will not last that long', () => {
  const now = new Date(2026, 9, 4, 20, 10).getTime();
  const ev = { label: '5-hour limit', resumeAt: now + 3 * HOUR + 12 * MIN, polling: false };
  const text = describePause(ev, now);
  assert.match(text, /^5-hour limit reached\. Pausing until 23:22 \(in 3h 12m\), then continuing automatically\.$/);
  const warned = describePause({ ...ev, loginExpiresAt: now + HOUR }, now);
  assert.match(warned, /The Claude Code login expires at 21:10, before that/);
  assert.doesNotMatch(describePause({ ...ev, loginExpiresAt: now + 8 * HOUR }, now), /login/);
  const polling = describePause({ label: 'rate limit', resumeAt: now + 5 * MIN, polling: true }, now);
  assert.match(polling, /^Rate limit reached and the server gave no reset time\. Checking again at 20:15 \(in 5m 0s\)/);
  // the limit is over, the login is not: say what to do and until when it keeps looking
  const login = describePause({ label: 'login', waitingForLogin: true, polling: true, resumeAt: now + 15_000, giveUpAt: now + 50 * MIN }, now);
  assert.equal(login, 'The limit has reset, but the Claude Code login has expired and cannot be renewed from here. Waiting for it to be renewed: run claude once, and this continues by itself. Giving up at 21:00.');
  // a renewal that was tried and failed says why
  const failed = describePause({ label: 'login', waitingForLogin: true, polling: true, resumeAt: now + 15_000, giveUpAt: now + 50 * MIN, renewError: 'The Claude Code login can no longer be renewed (invalid_grant). Sign in again: run `claude` and use /login.' }, now);
  assert.equal(failed, 'The limit has reset, but the login could not be renewed: The Claude Code login can no longer be renewed (invalid_grant). Sign in again: run `claude` and use /login. Trying again every 5 minutes, and this continues by itself as soon as the login is valid. Giving up at 21:00.');
  assert.match(warned, /run claude once after the reset: this continues by itself once the login is valid again/);
});

test('shouldAnnounce: the first wait is announced, waits that only continue it are not', () => {
  const at = Date.UTC(2026, 9, 4, 12, 0, 0) + 3 * HOUR;
  assert.equal(shouldAnnounce(null, { resumeAt: at, polling: false }), true);
  assert.equal(shouldAnnounce(null, { resumeAt: at, polling: true }), true);
  // polling comes back every few minutes with a later resume time: the pause is already announced
  assert.equal(shouldAnnounce({ resumeAt: at }, { resumeAt: at + 5 * MIN, polling: true }), false);
  assert.equal(shouldAnnounce({ resumeAt: at }, { resumeAt: at + 4 * HOUR, polling: true }), false);
  // a known reset that is repeated almost unchanged (jitter) is the same pause ...
  assert.equal(shouldAnnounce({ resumeAt: at }, { resumeAt: at + 8_000, polling: false }), false);
  assert.equal(shouldAnnounce({ resumeAt: at }, { resumeAt: at - 100_000, polling: false }), false);
  // ... but one that moved by more than two minutes (the server announced another window) is news
  assert.equal(shouldAnnounce({ resumeAt: at }, { resumeAt: at + 3 * MIN, polling: false }), true);
  assert.equal(shouldAnnounce({ resumeAt: at }, { resumeAt: at - 3 * MIN, polling: false }), true);
  // waiting for the login to be renewed is another kind of wait: told once when it begins, not at every check
  assert.equal(shouldAnnounce({ resumeAt: at }, { resumeAt: at + 15_000, polling: true, waitingForLogin: true }), true);
  assert.equal(shouldAnnounce({ resumeAt: at, waitingForLogin: true }, { resumeAt: at + 15_000, polling: true, waitingForLogin: true }), false);
  assert.equal(shouldAnnounce({ resumeAt: at, waitingForLogin: true }, { resumeAt: at + 4 * HOUR, polling: false }), true, 'back to waiting for a limit');
});

// ---------------------------------------------------------------- the decision

const NOW = 1_800_000_000_000;
const cfg = (over = {}) => ({ maxRetries: 6, rateLimitMaxWait: 6 * HOUR, rateLimitPoll: 5 * MIN, ...over });
const fresh = () => ({ attempt: 0, rateLimitHits: 0, waitedMs: 0 });
const e429 = (waitMs) => ({
  status: 429, retryable: true, message: 'rate limited', retryAfterMs: waitMs,
  rateLimit: waitMs == null
    ? { label: 'rate limit', waitMs: null, resetAt: null }
    : { label: '5-hour limit', claim: 'five_hour', status: 'rejected', waitMs, resetAt: NOW + waitMs, source: 'unified-reset' },
});
const plan = (err, state, config = cfg(), extra = {}) => planRetry(err, state, config, { now: NOW, rand: () => 0, ...extra });

test('planRetry: a known long reset becomes a pause that ends a little after it', () => {
  const p = plan(e429(3 * HOUR), fresh());
  assert.equal(p.action, 'wait');
  assert.equal(p.kind, 'rate_limit');
  assert.equal(p.delayMs, 3 * HOUR + 2000);
  assert.equal(p.resumeAt, NOW + 3 * HOUR + 2000);
  assert.equal(p.resetAt, NOW + 3 * HOUR);
  assert.equal(p.label, '5-hour limit');
  assert.equal(p.polling, false);
  // agents that were all waiting for the same reset do not wake in the same instant
  const late = plan(e429(3 * HOUR), fresh(), cfg(), { rand: () => 0.999 });
  assert.ok(late.delayMs > 3 * HOUR + 9000 && late.delayMs < 3 * HOUR + 10_000, `got ${late.delayMs - 3 * HOUR}`);
});

test('planRetry: a short announced wait is an ordinary retry and counts', () => {
  const state = fresh();
  for (let i = 1; i <= 10; i++) {
    const p = plan(e429(20_000), state);
    assert.equal(p.action, 'wait');
    assert.equal(p.kind, 'retry');
    assert.ok(p.delayMs >= 20_000);
    assert.equal(p.attempt, i);
    assert.equal(p.maxRetries, 10);
  }
  assert.equal(plan(e429(20_000), state).action, 'throw');
  assert.equal(plan(e429(20_000), fresh()).delayMs, 20_000);
});

test('planRetry: without a reset time it backs off up to the poll interval, and pauses once the waits get long', () => {
  const state = fresh();
  const delays = [];
  const kinds = [];
  for (let i = 0; i < 11; i++) {
    const p = plan(e429(null), state);
    assert.equal(p.polling, true);
    assert.equal(p.resetAt, null);
    delays.push(p.delayMs);
    kinds.push(p.kind);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);
  assert.deepEqual(kinds, [...Array(5).fill('retry'), ...Array(6).fill('rate_limit')]);
  assert.equal(state.waitedMs, delays.reduce((a, b) => a + b, 0));
});

test('planRetry: a reset further away than the budget is reported with its time instead of waited for', () => {
  const state = fresh();
  const p = plan(e429(7 * HOUR), state);
  assert.equal(p.action, 'throw');
  assert.match(p.message, /^rate limited \(5-hour limit reached; it resets at .+ \(in 7h 0m\), beyond the 6h 0m this session may wait\. CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS raises that\.\)$/);
  assert.equal(state.waitedMs, 0);
  assert.equal(plan(e429(6 * HOUR - 2000), fresh()).action, 'wait', 'a reset that just fits is waited for');
  assert.equal(plan(e429(6 * HOUR - 1999), fresh()).action, 'throw');
});

test('planRetry: polling ends when the budget is used up', () => {
  const state = fresh();
  const config = cfg({ rateLimitMaxWait: 10 * MIN });
  let last;
  let waits = 0;
  for (let i = 0; i < 50; i++) {
    last = plan(e429(null), state, config);
    if (last.action === 'throw') break;
    waits++;
  }
  assert.equal(last.action, 'throw');
  assert.equal(waits, 9);
  assert.match(last.message, /^rate limited \(still rate limited after waiting 8m 31s\)$/);
  assert.ok(state.waitedMs <= 10 * MIN);
});

test('planRetry: with the pause switched off, 429s are limited by attempts as before', () => {
  const off = cfg({ rateLimitMaxWait: 0 });
  const long = plan(e429(3 * HOUR), fresh(), off);
  assert.equal(long.action, 'throw');
  assert.match(long.message, /\(5-hour limit reached; it resets at .+ \(in 3h 0m\)\. Set CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS above 0 to wait for it automatically\.\)$/);
  const state = fresh();
  for (let i = 0; i < 10; i++) assert.equal(plan(e429(null), state, off).action, 'wait');
  assert.equal(plan(e429(null), state, off).action, 'throw');
  // a request that must not wait (a diagnostic) fails the same way, without claiming the setting is 0
  const nowait = plan(e429(3 * HOUR), fresh(), cfg(), { allowWait: false });
  assert.equal(nowait.action, 'throw');
  assert.match(nowait.message, /resets at/);
  assert.doesNotMatch(nowait.message, /Set CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS/);
});

test('planRetry: when nobody waits for limits, a Retry-After of 30 seconds or more is reported, not sat through attempt by attempt', () => {
  // a diagnostic request: 10 attempts of 4 minutes each would be 40 silent minutes
  const diagnostic = plan(e429(4 * MIN), fresh(), cfg(), { allowWait: false });
  assert.equal(diagnostic.action, 'throw');
  assert.match(diagnostic.message, /resets at .+ \(in 4m 0s\)/);
  assert.doesNotMatch(diagnostic.message, /Set CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS/, 'the setting is not what stopped it');
  // waiting switched off in the settings behaves the same, and says how to turn it on
  const off = plan(e429(4 * MIN), fresh(), cfg({ rateLimitMaxWait: 0 }));
  assert.equal(off.action, 'throw');
  assert.match(off.message, /Set CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS above 0/);
  // a short announced wait is still just retried, as it always was
  assert.equal(plan(e429(10_000), fresh(), cfg(), { allowWait: false }).action, 'wait');
  assert.equal(plan(e429(29_000), fresh(), cfg({ rateLimitMaxWait: 0 })).action, 'wait');
  assert.equal(plan(e429(30_000), fresh(), cfg(), { allowWait: false }).action, 'throw', '30 seconds is where a wait stops being short');
  // other errors may still ask for up to five minutes
  const e503 = { status: 503, retryable: true, message: 'down', retryAfterMs: 4 * MIN, rateLimit: { label: 'rate limit', waitMs: 4 * MIN, resetAt: NOW + 4 * MIN } };
  assert.equal(plan(e503, fresh()).action, 'wait');
});

test('planRetry: retries switched off means nothing is waited for', () => {
  const p = plan(e429(3 * HOUR), fresh(), cfg({ maxRetries: 0 }));
  assert.equal(p.action, 'throw');
  assert.equal(p.message, undefined);
  assert.equal(plan({ status: 500, retryable: true, message: 'x' }, fresh(), cfg({ maxRetries: 0 })).action, 'throw');
});

test('planRetry: other errors keep their attempt limit, and an error that is not retryable ends at once', () => {
  const e500 = { status: 500, retryable: true, message: 'boom', retryAfterMs: null, rateLimit: null };
  const state = fresh();
  for (let i = 1; i <= 6; i++) {
    const p = plan(e500, state);
    assert.equal(p.action, 'wait');
    assert.equal(p.kind, 'retry');
    assert.equal(p.attempt, i);
  }
  assert.equal(plan(e500, state).action, 'throw');
  const e503 = { status: 503, retryable: true, message: 'down', retryAfterMs: 10 * MIN, rateLimit: { label: 'rate limit', waitMs: 10 * MIN, resetAt: NOW + 10 * MIN } };
  const p = plan(e503, fresh());
  assert.equal(p.action, 'throw');
  assert.equal(p.message, 'down (the server asked to wait 10m 0s before retrying)');
  assert.equal(plan({ status: 400, retryable: false, message: 'bad' }, fresh()).action, 'throw');
});

// ---------------------------------------------------------------- sleeping

function withFakeTiming(t, now, sleep) {
  const original = { ...timing };
  timing.now = () => now.value;
  timing.sleep = sleep;
  t.after(() => Object.assign(timing, original));
}

test('sleepUntil sleeps in short pieces and checks the clock after each', async (t) => {
  const now = { value: 1000 };
  const asked = [];
  withFakeTiming(t, now, async (ms) => { asked.push(ms); now.value += ms; });
  await sleepUntil(1000 + 40_000);
  assert.deepEqual(asked, [15_000, 15_000, 10_000]);
  asked.length = 0;
  await sleepUntil(now.value - 5);
  assert.deepEqual(asked, [], 'a deadline in the past does not sleep');
});

test('sleepUntil notices that the computer was suspended in the meantime', async (t) => {
  const now = { value: 1000 };
  const asked = [];
  withFakeTiming(t, now, async (ms) => { asked.push(ms); now.value += 2 * HOUR; }); // one 15 s nap that took 2 hours
  await sleepUntil(1000 + HOUR);
  assert.deepEqual(asked, [15_000]);
});

test('sleepUntil can be cancelled, before and during the sleep', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(() => sleepUntil(Date.now() + HOUR, before.signal), (e) => e.name === 'AbortError');
  const during = new AbortController();
  setTimeout(() => during.abort(), 20);
  const started = Date.now();
  await assert.rejects(() => sleepUntil(Date.now() + HOUR, during.signal), (e) => e.name === 'AbortError');
  assert.ok(Date.now() - started < 1000);
});

// ---------------------------------------------------------------- through streamMessage

const configWith = (env = {}) => new Config({
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'test-token', ANTHROPIC_MODEL: 'mock', CLAUDE_PRO_MAX_RETRIES: '3', ...env,
}, {}, { hooks: {}, mcpServers: {} }, process.cwd());
const request = (config) => ({ model: config.mainModel, system: 's', messages: [{ role: 'user', content: 'hi' }] });

function mockFetch(t, handle) {
  const original = globalThis.fetch;
  globalThis.fetch = handle;
  t.after(() => { globalThis.fetch = original; });
}

// A clock that only moves when the code under test sleeps: a wait of hours takes no time.
function fakeClock(t, { onSleep } = {}) {
  const original = { ...timing };
  let now = Date.now();
  timing.now = () => now;
  timing.sleep = async (ms, signal) => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    onSleep?.(ms);
    now += ms;
    await new Promise((resolve) => setImmediate(resolve));
  };
  t.after(() => Object.assign(timing, original));
  return { get now() { return now; } };
}

const limited = (headers = {}) => new Response(
  JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: MESSAGE } }),
  { status: 429, headers: { 'content-type': 'application/json', ...headers } },
);

function sse(events) {
  return new Response(events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const start = { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 1, output_tokens: 0 } } };
const textBlock = (text) => [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
];
const finish = [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
const okResponse = (text = 'Done.') => sse([start, ...textBlock(text), ...finish]);

test('a rejected 5-hour window pauses until its reset, then the same request goes through', async (t) => {
  const clock = fakeClock(t);
  const resetAt = clock.now + 3 * HOUR + 12 * MIN;
  const calls = [];
  const bodies = [];
  mockFetch(t, async (url, options) => {
    calls.push(clock.now);
    bodies.push(options.body);
    return calls.length === 1 ? limited(unified(resetAt)) : okResponse('Done.');
  });
  const config = configWith();
  const events = [];
  const res = await streamMessage(config, request(config), { onEvent: (ev) => events.push(ev) });

  assert.equal(res.message.content[0].text, 'Done.');
  assert.equal(calls.length, 2);
  const resetMs = Math.floor(resetAt / 1000) * 1000;
  assert.ok(calls[1] >= resetMs + 2000, `the retry came ${resetMs - calls[1]} ms before the reset`);
  assert.ok(calls[1] <= resetMs + 10_500, 'and not long after it');
  assert.equal(bodies[0], bodies[1], 'the very same request is repeated');
  assert.deepEqual(events.map((ev) => ev.type).filter((type) => type.startsWith('rate_limit')), ['rate_limit_wait', 'rate_limit_resume']);
  const wait = events.find((ev) => ev.type === 'rate_limit_wait');
  assert.equal(wait.label, '5-hour limit');
  assert.equal(wait.polling, false);
  assert.equal(wait.error.status, 429);
  assert.equal(wait.resetAt, resetMs);
  assert.equal(wait.resumeAt - wait.resetAt >= 2000 && wait.resumeAt - wait.resetAt < 10_000, true);
  assert.equal(wait.maxWaitMs, 6 * HOUR);
  assert.ok(events.findIndex((ev) => ev.type === 'rate_limit_resume') < events.findIndex((ev) => ev.type === 'block_start'), 'resumed before the answer starts');
});

test('cancelling during the pause ends the request at once', async (t) => {
  // the real clock: the pause would last three hours
  let calls = 0;
  mockFetch(t, async () => { calls++; return limited(unified(Date.now() + 3 * HOUR)); });
  const config = configWith();
  const ctrl = new AbortController();
  const started = Date.now();
  await assert.rejects(
    () => streamMessage(config, request(config), { signal: ctrl.signal, onEvent: (ev) => { if (ev.type === 'rate_limit_wait') ctrl.abort(); } }),
    (err) => err.name === 'AbortError',
  );
  assert.ok(Date.now() - started < 2000);
  assert.equal(calls, 1);
});

test('without a reset time it keeps checking, backing off to the poll interval, and continues when the limit clears', async (t) => {
  const clock = fakeClock(t);
  const times = [];
  mockFetch(t, async () => {
    times.push(clock.now);
    return times.length <= 9 ? limited() : okResponse('Back.');
  });
  const config = configWith({ CLAUDE_PRO_RATE_LIMIT_POLL_MS: String(2 * MIN) });
  const events = [];
  const res = await streamMessage(config, request(config), { onEvent: (ev) => events.push(ev) });

  assert.equal(res.message.content[0].text, 'Back.');
  assert.equal(times.length, 10);
  const gaps = times.slice(1).map((time, i) => time - times[i]);
  const expected = [1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 120_000, 120_000];
  gaps.forEach((gap, i) => assert.ok(gap >= expected[i] && gap < expected[i] + 500, `gap ${i} was ${gap}, expected about ${expected[i]}`));
  assert.equal(events.filter((ev) => ev.type === 'retry').length, 5, 'waits under 30 seconds are ordinary retries');
  const pauses = events.filter((ev) => ev.type === 'rate_limit_wait');
  assert.equal(pauses.length, 4);
  assert.ok(pauses.every((ev) => ev.polling === true && ev.resetAt === null));
  assert.equal(events.filter((ev) => ev.type === 'rate_limit_resume').length, 1, 'one "continuing" for the whole pause');
});

test('a reset beyond the budget fails at once and says when it resets', async (t) => {
  const clock = fakeClock(t);
  let calls = 0;
  mockFetch(t, async () => { calls++; return limited(unified(clock.now + 7 * 24 * HOUR, { 'anthropic-ratelimit-unified-representative-claim': 'seven_day' })); });
  const config = configWith();
  const events = [];
  await assert.rejects(() => streamMessage(config, request(config), { onEvent: (ev) => events.push(ev) }), (err) => {
    assert.equal(err.status, 429);
    assert.match(err.message, /exceed your account's rate limit/);
    assert.match(err.message, /Weekly limit reached; it resets at .+ \(in 7d 0h\)/);
    assert.match(err.message, /CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(events.length, 0);
});

test('CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS=0 reports the limit instead of waiting, and a larger value allows a longer wait', async (t) => {
  const clock = fakeClock(t);
  let calls = 0;
  mockFetch(t, async () => { calls++; return calls === 1 || calls === 2 ? limited(unified(clock.now + 8 * HOUR)) : okResponse('late'); });
  const off = configWith({ CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS: '0' });
  await assert.rejects(() => streamMessage(off, request(off)), /5-hour limit reached; it resets at .+\. Set CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS above 0/);
  assert.equal(calls, 1);
  const long = configWith({ CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS: String(12 * HOUR) });
  const res = await streamMessage(long, request(long));
  assert.equal(res.message.content[0].text, 'late');
  assert.equal(calls, 3);
});

test('waitForRateLimit: false (diagnostics) reports the limit instead of pausing', async (t) => {
  const clock = fakeClock(t);
  let calls = 0;
  mockFetch(t, async () => { calls++; return limited(unified(clock.now + 3 * HOUR)); });
  const config = configWith();
  await assert.rejects(() => quickQuery(config, { model: config.mainModel, system: 's', prompt: 'ping', waitForRateLimit: false }), /5-hour limit reached; it resets at/);
  assert.equal(calls, 1);
});

test('waitForRateLimit: false does not sit through a Retry-After of minutes either (it used to: 10 attempts, 40 minutes, silently)', async (t) => {
  let slept = 0;
  fakeClock(t, { onSleep: (ms) => { slept += ms; } });
  let calls = 0;
  mockFetch(t, async () => { calls++; return limited({ 'retry-after': '240' }); });
  const config = configWith();
  await assert.rejects(() => quickQuery(config, { model: config.mainModel, system: 's', prompt: 'ping', waitForRateLimit: false }), /resets at/);
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test('quickQuery reports a rate limit by default: it has no way to show a pause, so it must not sit in one unseen', async (t) => {
  let slept = 0;
  const clock = fakeClock(t, { onSleep: (ms) => { slept += ms; } });
  let calls = 0;
  mockFetch(t, async () => { calls++; return limited(unified(clock.now + 3 * HOUR)); });
  const config = configWith();
  await assert.rejects(() => quickQuery(config, { model: config.mainModel, system: 's', prompt: 'ping' }), /5-hour limit reached; it resets at/);
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test('two limits in a row are waited out one after the other, with a single "continuing"', async (t) => {
  const clock = fakeClock(t);
  const times = [];
  mockFetch(t, async () => {
    times.push(clock.now);
    if (times.length === 1) return limited(unified(clock.now + HOUR));
    if (times.length === 2) return limited(unified(clock.now + 2 * HOUR, { 'anthropic-ratelimit-unified-representative-claim': 'seven_day' }));
    return okResponse('finally');
  });
  const config = configWith();
  const events = [];
  const res = await streamMessage(config, request(config), { onEvent: (ev) => events.push(ev) });
  assert.equal(res.message.content[0].text, 'finally');
  const waits = events.filter((ev) => ev.type === 'rate_limit_wait');
  assert.deepEqual(waits.map((ev) => ev.label), ['5-hour limit', 'weekly limit']);
  assert.ok(waits[1].waitedMs > waits[0].waitedMs && waits[1].waitedMs > 3 * HOUR - 1000, 'the waits add up');
  assert.equal(events.filter((ev) => ev.type === 'rate_limit_resume').length, 1);
  assert.ok(times[2] - times[0] >= 3 * HOUR);
});

test('a rate limit error in the middle of a stream discards the partial text and is waited out', async (t) => {
  const clock = fakeClock(t);
  let calls = 0;
  mockFetch(t, async () => {
    calls++;
    if (calls > 1) return okResponse('complete answer');
    return sse([start, ...textBlock('half an ans').slice(0, 2), { type: 'error', error: { type: 'rate_limit_error', message: 'limit hit mid-stream' } }]);
  });
  const config = configWith();
  const events = [];
  const res = await streamMessage(config, request(config), { onEvent: (ev) => events.push(ev) });
  assert.equal(res.message.content.length, 1);
  assert.equal(res.message.content[0].text, 'complete answer');
  const types = events.map((ev) => ev.type);
  assert.ok(types.indexOf('reset') > types.indexOf('text'), 'the partial text is discarded');
  assert.ok(types.includes('retry'));
  assert.ok(clock.now > 0);
});

test('an agent turn survives a pause: the conversation is intact and the prompt is not sent twice', async (t) => {
  const clock = fakeClock(t);
  const bodies = [];
  mockFetch(t, async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return bodies.length === 1 ? limited(unified(clock.now + 4 * HOUR)) : okResponse('All good.');
  });
  const config = configWith();
  const events = [];
  const agent = new Agent({ config, modes: new ModeManager(), tools: [GlobTool], systemPrompt: 's', io: { streamEvent: (ev) => events.push(ev) }, model: config.mainModel, cwd: process.cwd() });
  const result = await agent.run('hello');
  assert.equal(result.text, 'All good.');
  assert.deepEqual(agent.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].messages, bodies[1].messages);
  assert.ok(events.some((ev) => ev.type === 'rate_limit_wait'));
});

// A sleep that lasts until the caller's signal aborts, like a pause of hours that the user cancels.
function sleepUntilAborted(t) {
  const original = { ...timing };
  timing.sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  t.after(() => Object.assign(timing, original));
}

const untilTrue = async (fn, what) => {
  const began = Date.now();
  while (!fn()) {
    assert.ok(Date.now() - began < 10_000, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('Esc during an automatic compaction pause ends the turn as an interrupt, not as an error', async (t) => {
  sleepUntilAborted(t);
  mockFetch(t, async () => limited(unified(Date.now() + 3 * HOUR)));
  // a window this small makes the long prompt below compact first
  const config = configWith({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '20000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '10' });
  const events = [];
  const agent = new Agent({ config, modes: new ModeManager(), tools: [GlobTool], systemPrompt: 's', io: { compactProgress: (ev) => events.push(ev) }, model: config.mainModel, cwd: process.cwd() });
  agent.messages = [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }, { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] }];
  const ctrl = new AbortController();
  const run = agent.run(`A long prompt. ${'filler '.repeat(3000)}`, { signal: ctrl.signal });
  await untilTrue(() => events.some((ev) => ev.type === 'rate_limit_wait'), 'the compaction to be paused');
  ctrl.abort();
  const result = await run; // used to reject with "aborted", which the interface showed as an API error
  assert.equal(result.interrupted, true);
  assert.equal(JSON.stringify(agent.messages.at(-1)).includes('[Request interrupted by user]'), true, 'the model is told the turn was interrupted');
  assert.equal(agent.messages.length, 4, 'the conversation is untouched: earlier pair, the prompt, the interrupt marker');
});

// ---------------------------------------------------------------- the subscription login

function oauthFixture(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-ratelimit-'));
  const configFile = path.join(dir, '.claude.json');
  const credentialsFile = path.join(dir, '.credentials.json');
  const expiresAt = Date.now() + 8 * HOUR;
  fs.writeFileSync(configFile, JSON.stringify({ userID: 'test-device', oauthAccount: { accountUuid: 'test-account' } }));
  const writeToken = (token, expires) => fs.writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: expires, scopes: ['user:inference'] } }));
  writeToken('test-oauth-token', expiresAt);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = new Config({
    CLAUDE_PRO_PROVIDER: 'claude-code', CLAUDE_PRO_CLAUDE_CONFIG_FILE: configFile, CLAUDE_PRO_CLAUDE_CREDENTIALS_FILE: credentialsFile,
    CLAUDE_PRO_CLAUDE_CODE_VERSION: '2.1.289', CLAUDE_PRO_MAX_RETRIES: '3', ...env,
  }, {}, { hooks: {}, mcpServers: {} }, dir);
  return { config, expiresAt, writeToken };
}

test('after the pause the login is read again, so a token refreshed in the meantime is used', async (t) => {
  const { config, expiresAt, writeToken } = oauthFixture(t);
  let rotated = false;
  const clock = fakeClock(t, { onSleep: () => { if (!rotated) { rotated = true; writeToken('refreshed-token', Date.now() + 8 * HOUR); } } });
  const seen = [];
  mockFetch(t, async (url, options) => {
    seen.push(new Headers(options.headers).get('authorization'));
    return seen.length === 1 ? limited(unified(clock.now + 2 * HOUR)) : okResponse('back');
  });
  const events = [];
  const res = await streamMessage(config, request(config), { onEvent: (ev) => events.push(ev) });
  assert.equal(res.message.content[0].text, 'back');
  assert.deepEqual(seen, ['Bearer test-oauth-token', 'Bearer refreshed-token']);
  assert.equal(events.find((ev) => ev.type === 'rate_limit_wait').loginExpiresAt, expiresAt, 'the event carries the login expiry so it can be shown');
});

test('a login that expired during the pause and never comes back is reported clearly instead of failing with a 401', async (t) => {
  const { config, writeToken } = oauthFixture(t);
  let expired = false;
  const clock = fakeClock(t, { onSleep: () => { if (!expired) { expired = true; writeToken('test-oauth-token', Date.now() - 1000); } } });
  let calls = 0;
  mockFetch(t, async () => { calls++; return limited(unified(clock.now + 2 * HOUR)); });
  await assert.rejects(() => streamMessage(config, request(config)), /access token has expired/);
  assert.equal(calls, 1, 'no request is sent with an expired token');
});

test('a login that expired during the pause is waited for, and the request goes on once it is renewed', async (t) => {
  const { config, writeToken } = oauthFixture(t);
  let step = 0;
  const clock = fakeClock(t, {
    onSleep: () => {
      // what the local Claude Code does meanwhile, by the (virtual) time since the request was first sent
      const at = clock.now - started;
      if (step === 0 && at >= HOUR) { step = 1; writeToken('test-oauth-token', Date.now() - 1000); } // the token runs out during the pause
      else if (step === 1 && at >= 2 * HOUR + 5 * MIN) { step = 2; fs.writeFileSync(config.claudeCodeCredentialsFile, '{"claudeAiOauth": {"accessTo'); } // it is being rewritten right now
      else if (step === 2 && at >= 2 * HOUR + 6 * MIN) { step = 3; writeToken('renewed-token', Date.now() + 8 * HOUR); } // and then it is there
    },
  });
  const started = clock.now;
  const seen = [];
  mockFetch(t, async (url, options) => {
    seen.push(new Headers(options.headers).get('authorization'));
    return seen.length === 1 ? limited(unified(started + 2 * HOUR)) : okResponse('back');
  });
  const events = [];
  const res = await streamMessage(config, request(config), { onEvent: (ev) => events.push(ev) });

  assert.equal(res.message.content[0].text, 'back');
  assert.deepEqual(seen, ['Bearer test-oauth-token', 'Bearer renewed-token'], 'the renewed token is the one that is used');
  // the pause as the interface sees it: the wait for the limit, the waits for the login, one "continuing"
  const pause = events.map((ev) => (ev.type === 'rate_limit_wait' ? (ev.waitingForLogin ? 'login' : 'limit') : ev.type)).filter((kind) => kind === 'limit' || kind === 'login' || kind === 'rate_limit_resume');
  assert.equal(pause[0], 'limit');
  assert.equal(pause.at(-1), 'rate_limit_resume');
  assert.deepEqual([...new Set(pause.slice(1, -1))], ['login'], 'nothing but waits for the login in between');
  assert.equal(pause.filter((kind) => kind === 'rate_limit_resume').length, 1, 'one "continuing" for the whole pause');
  const logins = events.filter((ev) => ev.waitingForLogin);
  assert.ok(logins.length >= 18 && logins.length <= 30, `about 6 minutes of 15 second checks, got ${logins.length}`);
  assert.equal(logins[0].polling, true);
  assert.match(logins[0].error.message, /access token has expired/);
  assert.ok(logins.some((ev) => /Invalid JSON/.test(ev.error.message)), 'a file that is being rewritten is waited out like an expired token');
  assert.ok(logins[0].giveUpAt > logins[0].resumeAt, 'the event says when it would give up');
  assert.equal(logins[0].resumeAt - logins[0].giveUpAt < 0, true);
});

test('waiting for the login is limited by what is left of the waiting budget, and the error says how long it was waited', async (t) => {
  // budget: the 2 hour pause plus 10 minutes
  const { config, writeToken } = oauthFixture(t, { CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS: String(2 * HOUR + 10 * MIN) });
  let expired = false;
  const clock = fakeClock(t, { onSleep: () => { if (!expired) { expired = true; writeToken('test-oauth-token', Date.now() - 1000); } } });
  const started = clock.now;
  let calls = 0;
  mockFetch(t, async () => { calls++; return limited(unified(started + 2 * HOUR)); });
  await assert.rejects(() => streamMessage(config, request(config)), (err) => {
    assert.match(err.message, /access token has expired/);
    assert.match(err.message, /Waited 9m \d+s for it after the limit reset\./);
    return true;
  });
  assert.equal(calls, 1);
  assert.ok(clock.now - started <= 2 * HOUR + 10 * MIN + 20_000, `it waited ${(clock.now - started) / MIN} minutes in all, beyond its budget`);
});

// What the login looks like when this program can renew it itself: a refresh token is stored with it.
function renewableFixture(t, env = {}) {
  const fx = oauthFixture(t, env);
  endpoint.url = 'http://token.test/v1/oauth/token';
  t.after(() => { endpoint.url = 'http://127.0.0.1:9/never-reached'; });
  const write = (access, expires, refresh = 'refresh-1') => fs.writeFileSync(fx.config.claudeCodeCredentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: expires, scopes: ['user:inference'] } }, null, 2) + '\n');
  write('test-oauth-token', Date.now() + 8 * HOUR);
  return { ...fx, write };
}

// Routes the token endpoint to `token` and everything else to `api`.
function routedFetch(t, { token, api }) {
  const calls = { token: 0, api: [] };
  mockFetch(t, async (url, options) => {
    if (String(url).startsWith('http://token.test/')) { calls.token++; return token(calls.token, JSON.parse(options.body)); }
    calls.api.push(new Headers(options.headers).get('authorization'));
    return api(calls.api.length);
  });
  return calls;
}
const granted = (n) => new Response(JSON.stringify({ access_token: `renewed-${n}`, refresh_token: `refresh-${n + 1}`, expires_in: 28_800, scope: 'user:inference' }), { status: 200, headers: { 'content-type': 'application/json' } });
const refused = () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token not found or invalid' }), { status: 400, headers: { 'content-type': 'application/json' } });

test('a login that expired during the pause is renewed by this program at once, not waited for', async (t) => {
  const { config, write } = renewableFixture(t);
  let expired = false;
  const clock = fakeClock(t, { onSleep: () => { if (!expired) { expired = true; write('test-oauth-token', Date.now() - 1000); } } });
  const started = clock.now;
  const calls = routedFetch(t, { token: (n) => granted(n), api: (n) => (n === 1 ? limited(unified(started + 5 * HOUR)) : okResponse('back')) });
  const events = [];
  const res = await streamMessage(config, request(config), { onEvent: (ev) => events.push(ev) });
  assert.equal(res.message.content[0].text, 'back');
  assert.deepEqual(calls.api, ['Bearer test-oauth-token', 'Bearer renewed-1']);
  assert.equal(calls.token, 1, 'renewed once, when the pause was over');
  assert.equal(events.filter((ev) => ev.waitingForLogin).length, 0, 'there was nothing to wait for');
  assert.equal(JSON.parse(fs.readFileSync(config.claudeCodeCredentialsFile, 'utf8')).claudeAiOauth.refreshToken, 'refresh-2');
  const wait = events.find((ev) => ev.type === 'rate_limit_wait');
  assert.equal(wait.loginExpiresAt, null, 'no "your login expires before the limit resets" warning when it renews itself');
});

test('a refused renewal after the pause is retried every five minutes while waiting, and a login done meanwhile is used', async (t) => {
  const { config, write } = renewableFixture(t);
  let step = 0;
  const clock = fakeClock(t, {
    onSleep: () => {
      const at = clock.now - started;
      if (step === 0 && at >= HOUR) { step = 1; write('test-oauth-token', Date.now() - 1000); }
      else if (step === 1 && at >= 2 * HOUR + 12 * MIN) { step = 2; write('signed-in-again', Date.now() + 8 * HOUR, 'refresh-new'); } // /login in claude
    },
  });
  const started = clock.now;
  const calls = routedFetch(t, { token: () => refused(), api: (n) => (n === 1 ? limited(unified(started + 2 * HOUR)) : okResponse('back')) });
  const events = [];
  const res = await streamMessage(config, request(config), { onEvent: (ev) => events.push(ev) });
  assert.equal(res.message.content[0].text, 'back');
  assert.deepEqual(calls.api, ['Bearer test-oauth-token', 'Bearer signed-in-again']);
  assert.ok(calls.token >= 2 && calls.token <= 4, `renewal tried every 5 minutes for 12 minutes, not at every 15 second check: ${calls.token} tries`);
  const waits = events.filter((ev) => ev.waitingForLogin);
  assert.ok(waits.length > 20);
  assert.match(waits[0].renewError, /can no longer be renewed \(invalid_grant: Refresh token not found or invalid\)/);
  assert.match(describePause(waits[0]), /^The limit has reset, but the login could not be renewed: .*Sign in again/);
});

test('when the wait for a login ends, the error says why renewing failed', async (t) => {
  const { config, write } = renewableFixture(t, { CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS: String(2 * HOUR + 10 * MIN) });
  let expired = false;
  const clock = fakeClock(t, { onSleep: () => { if (!expired) { expired = true; write('test-oauth-token', Date.now() - 1000); } } });
  const started = clock.now;
  routedFetch(t, { token: () => refused(), api: () => limited(unified(started + 2 * HOUR)) });
  await assert.rejects(streamMessage(config, request(config)), (err) => {
    assert.match(err.message, /^The Claude Code login can no longer be renewed \(invalid_grant/);
    assert.match(err.message, /Waited 9m \d+s for it after the limit reset\./);
    return true;
  });
});

test('after a pause the quick retries start over', async (t) => {
  const clock = fakeClock(t);
  const overloaded = () => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Overloaded' } }), { status: 503, headers: { 'content-type': 'application/json' } });
  // 3 retries are allowed. Two failures before the limit and three after it only fit if the count restarts.
  const answers = [overloaded, overloaded, () => limited(unified(clock.now + HOUR)), overloaded, overloaded, overloaded, () => okResponse('made it')];
  let call = 0;
  mockFetch(t, async () => answers[call++]());
  const config = configWith();
  const res = await streamMessage(config, request(config));
  assert.equal(res.message.content[0].text, 'made it');
  assert.equal(call, 7);
});

test('planRetry: an overloaded API backs off as configured, then pauses at the longest delay within its own budget', () => {
  const e529 = { status: 529, retryable: true, message: 'Overloaded', retryAfterMs: null };
  const state = fresh();
  const config = cfg({ maxRetries: 3, overloadedRetryBaseDelay: 1000, overloadedRetryMaxDelay: 32_000, overloadedMaxWait: 100_000 });
  const plans = [];
  for (let p = plan(e529, state, config); p.action === 'wait'; p = plan(e529, state, config)) plans.push(p);
  assert.deepEqual(plans.map((p) => [p.kind, p.delayMs]), [
    ['retry', 1000], ['retry', 2000], ['retry', 4000],
    ['rate_limit', 8000], ['rate_limit', 16_000], ['rate_limit', 32_000], ['rate_limit', 32_000],
  ]);
  assert.ok(plans.slice(3).every((p) => p.overloaded && p.polling));
  assert.match(plan(e529, state, config).message, /still overloaded after \d+ retries and 1m 28s of waiting/);
  assert.match(describePause({ ...plans[3], resumeAt: NOW + 8000 }, NOW), /^The API is overloaded/);
  assert.deepEqual([2, 3].map(() => plan({ ...e529, status: 500, overloaded: true }, fresh(), cfg({ overloadedRetryBaseDelay: 5000 })).delayMs), [5000, 5000], 'a mid-stream overloaded_error and its own base delay');
  assert.equal(plan(e529, { ...fresh(), overloaded: 3 }, config, { allowWait: false }).action, 'throw', 'side queries do not pause');
});

test('a stream that keeps answering 529 is waited out and then goes on', async (t) => {
  fakeClock(t);
  const busy = () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529, headers: { 'content-type': 'application/json' } });
  let call = 0;
  mockFetch(t, async () => (++call <= 6 ? busy() : okResponse('made it')));
  const config = configWith({ CLAUDE_PRO_MAX_RETRIES: '2' });
  const events = [];
  const res = await streamMessage(config, request(config), { onEvent: (ev) => events.push(ev) });
  assert.equal(res.message.content[0].text, 'made it');
  const waits = events.filter((ev) => /retry|rate_limit/.test(ev.type));
  assert.deepEqual(waits.map((ev) => ev.type), ['retry', 'retry', 'rate_limit_wait', 'rate_limit_wait', 'rate_limit_wait', 'rate_limit_wait', 'rate_limit_resume']);
  assert.equal(waits.at(-1).overloaded, true);
  assert.match(resumeText(waits.at(-1)), /answering again/);
});
