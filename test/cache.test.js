// Prompt caching the way Claude Code does it: cache_control markers and TTL buckets, the switches that turn
// it off, the fallback for endpoints that refuse it, the summary request that shares the conversation's cache,
// the statistics, the system prompt that stays put (and the sub-agents' snapshot of the environment), and the
// system prompt that goes with a resumed conversation.
// CONFIG_DIR is fixed when config.js is first imported, so point it at a temp dir first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.CLAUDE_PRO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-cache-config-'));
// The shell this runs in, or the repository's own .env (loadConfig and createRuntime read it), must not change
// what these tests expect: the cache variables are neutral here (tests that read settings files pass their own .env).
for (const key of ['CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL']) delete process.env[key];
for (const key of ['ENABLE_PROMPT_CACHING_1H', 'FORCE_PROMPT_CACHING_5M', 'DISABLE_PROMPT_CACHING', 'DISABLE_PROMPT_CACHING_HAIKU', 'DISABLE_PROMPT_CACHING_SONNET', 'DISABLE_PROMPT_CACHING_OPUS', 'DISABLE_PROMPT_CACHING_FABLE']) process.env[key] = '0';
const realFetch = globalThis.fetch;
let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { hasGit = false; }

const { Config, loadConfig, KNOWN_KEYS } = await import('../src/config.js');
const { buildParams, streamMessage, quickQuery, cacheRefusals } = await import('../src/api.js');
const { CacheStats, cacheControl, cachePlanOf, fingerprint, normalizeTtl } = await import('../src/cache.js');
const { Agent, CLEARED, clearOldToolResults } = await import('../src/agent.js');
const { resolvePath } = await import('../src/utils/paths.js');
const { SUMMARY_SYSTEM, subagentSystemPrompt } = await import('../src/prompts.js');
const { environmentBlock, takeEnvSnapshot } = await import('../src/context.js');
const { SessionStore } = await import('../src/session.js');
const { createRuntime } = await import('../src/runtime.js');
const { PROMPT_CODE_VERSION: CODE, mainSystemPrompt } = await import('../src/prompts.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-cache-'));
let port = 20_000; // every test talks to an "endpoint" of its own: what an endpoint refuses is remembered per endpoint
const makeConfig = (env = {}) => new Config({ CLAUDE_PRO_GATEWAY_URL: `http://127.0.0.1:${port++}`, CLAUDE_PRO_GATEWAY_API_KEY: 'test-token', CLAUDE_PRO_GATEWAY_MODEL: 'mock', ...env }, {}, { hooks: {}, mcpServers: {} }, process.cwd());
const tool = (name) => ({ name, description: `the ${name} tool`, input_schema: { type: 'object', properties: {} } });
const tools = [tool('Alpha'), tool('Beta'), tool('Gamma')];

function mockFetch(t, handle) {
  globalThis.fetch = handle;
  t.after(() => { globalThis.fetch = realFetch; }); // the real one, however many times a test installs a mock
}
const strip = (value) => JSON.parse(JSON.stringify(value, (k, v) => (k === 'cache_control' ? undefined : v)));

const sse = (events) => new Response(events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
// A reply: text (or a tool call), with the usage the API would report.
function replyWith({ text = 'ok', toolUse = null, preamble = null, usage = {}, stop = null } = {}) {
  const at = preamble ? 1 : 0; // a tool call may come after a few words of text
  return sse([
    { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 10, output_tokens: 0, ...usage } } },
    ...(preamble
      ? [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: preamble } },
        { type: 'content_block_stop', index: 0 },
      ]
      : []),
    ...(toolUse
      ? [
        { type: 'content_block_start', index: at, content_block: { type: 'tool_use', id: 'toolu_1', name: toolUse, input: {} } },
        { type: 'content_block_delta', index: at, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: at },
      ]
      : [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
      ]),
    { type: 'message_delta', delta: { stop_reason: stop || (toolUse ? 'tool_use' : 'end_turn') }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}
const rejected = (message) => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), { status: 400, headers: { 'content-type': 'application/json' } });
const bodyOf = (init) => JSON.parse(init.body);
const request = (cfg, extra = {}) => ({ model: cfg.mainModel, system: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools, ...extra });

// ---------------------------------------------------------------------------------------------- TTL and switches

test('gateway cache TTL follows overrides and keeps the conversation at one hour by default', () => {
  const ttl = (env, bucket) => makeConfig(env).cacheTtl(bucket);
  assert.equal(ttl({}, 'main'), '1h');
  assert.equal(ttl({}, 'other'), '5m');
  assert.equal(ttl({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, 'main'), '5m');
  assert.equal(ttl({ CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1H' }, 'other'), '1h');
  assert.equal(ttl({ ENABLE_PROMPT_CACHING_1H: '1' }, 'other'), '1h');
  assert.equal(ttl({ FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, 'main'), '5m', 'FORCE wins over everything');
  assert.equal(ttl({ CLAUDE_CODE_PROMPT_CACHE_TTL: '30m' }, 'main'), '1h', 'any other value is ignored');
  assert.equal(ttl({ CLAUDE_CODE_PROMPT_CACHE_TTL: '30m', ENABLE_PROMPT_CACHING_1H: 'true' }, 'main'), '1h');
  assert.equal(normalizeTtl(' 1H '), '1h');
  assert.equal(normalizeTtl('2h'), null);
  assert.equal(normalizeTtl(undefined), null);
  for (const key of ['CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'ENABLE_PROMPT_CACHING_1H', 'FORCE_PROMPT_CACHING_5M', 'DISABLE_PROMPT_CACHING', 'DISABLE_PROMPT_CACHING_HAIKU', 'DISABLE_PROMPT_CACHING_SONNET', 'DISABLE_PROMPT_CACHING_OPUS', 'DISABLE_PROMPT_CACHING_FABLE']) {
    assert.ok(key in KNOWN_KEYS, `${key} is a known key`);
  }
});

test('the TTL settings promptCacheTtl and subagentPromptCacheTtl rank below the variables, from whichever file; invalid values are ignored', () => {
  const noDotEnv = path.join(tmp(), 'none.env'); // not the repository's own .env
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, '.claude-pro'));
  const project = path.join(cwd, '.claude-pro', 'settings.json');
  const user = path.join(process.env.CLAUDE_PRO_CONFIG_DIR, 'settings.json');
  const load = () => loadConfig({ cwd, dotEnvFile: noDotEnv });
  try {
    fs.writeFileSync(project, JSON.stringify({ promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' }));
    assert.equal(load().cacheTtl('main'), '1h');
    assert.equal(load().cacheTtl('other'), '1h');
    fs.writeFileSync(project, JSON.stringify({ promptCacheTtl: '1h', env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } }));
    assert.equal(load().cacheTtl('main'), '5m', 'the variable in "env" wins over the setting');
    assert.equal(load().cacheTtl('other'), '5m');
    // the variable wins from a lower file too: a setting does not override a variable of another file
    fs.writeFileSync(user, JSON.stringify({ env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } }));
    fs.writeFileSync(project, JSON.stringify({ promptCacheTtl: '5m' }));
    assert.equal(load().cacheTtl('main'), '1h');
    fs.writeFileSync(user, JSON.stringify({ env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } }));
    fs.writeFileSync(project, JSON.stringify({ promptCacheTtl: '1h' }));
    assert.equal(load().cacheTtl('main'), '5m');
    // invalid values are ignored: they neither count nor hide what is below them
    fs.writeFileSync(user, JSON.stringify({ env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } }));
    fs.writeFileSync(project, JSON.stringify({ promptCacheTtl: 'soon' }));
    assert.equal(load().cacheTtl('main'), '1h');
    // ... and an invalid setting falls through to the gateway default, 1 hour
    const sub = () => loadConfig({ cwd, dotEnvFile: noDotEnv, flags: { provider: 'gateway' } });
    fs.writeFileSync(user, JSON.stringify({ promptCacheTtl: true }));
    fs.writeFileSync(project, JSON.stringify({}));
    assert.equal(sub().cacheTtl('main'), '1h');
    fs.writeFileSync(project, JSON.stringify({ promptCacheTtl: '5m' }));
    assert.equal(sub().cacheTtl('main'), '5m', 'a valid one does count');
  } finally {
    fs.rmSync(user, { force: true });
  }
});

test('gateway cache markers use the one-hour conversation TTL and five-minute side-query TTL', () => {
  const cfg = makeConfig();
  assert.equal(cfg.cacheTtl('main'), '1h');
  assert.equal(cfg.cacheTtl('other'), '5m');
  const main = buildParams(cfg, request(cfg));
  assert.deepEqual(main.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  const other = buildParams(cfg, request(cfg, { cacheBucket: 'other' }));
  assert.deepEqual(other.system[0].cache_control, { type: 'ephemeral' });
});

test('gateway tuning in .env is applied directly', () => {
  const dir = tmp();
  const dotEnv = path.join(dir, '.env');
  fs.writeFileSync(dotEnv, ['CLAUDE_CODE_EFFORT_LEVEL=max', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000', 'MAX_THINKING_TOKENS=0', 'BASH_DEFAULT_TIMEOUT_MS=1000', 'CLAUDE_PRO_GATEWAY_MODEL=claude-sonnet-5-5'].join('\n'));
  const cfg = loadConfig({ cwd: tmp(), dotEnvFile: dotEnv });
  assert.equal(cfg.provider, 'gateway');
  assert.equal(cfg.effort, 'max');
  assert.equal(cfg.compactWindow(), 786_432);
  assert.equal(cfg.maxOutputTokens, 32_000);
  assert.equal(cfg.thinkingBudget, 0);
  assert.equal(cfg.bashDefaultTimeout, 1000);
});

test('DISABLE_PROMPT_CACHING turns it off everywhere; the per-model variables only for the model their alias is', () => {
  const off = (env, id) => makeConfig(env).promptCachingDisabled(id);
  assert.equal(off({}, 'mock'), false);
  assert.equal(off({ DISABLE_PROMPT_CACHING: '1' }, 'mock'), true);
  assert.equal(off({ DISABLE_PROMPT_CACHING: '0' }, 'mock'), false);
  assert.equal(off({ DISABLE_PROMPT_CACHING_HAIKU: '1' }, 'claude-haiku-5-5'), true);
  assert.equal(off({ DISABLE_PROMPT_CACHING_HAIKU: '1' }, 'claude-sonnet-5-5'), false);
  assert.equal(off({ DISABLE_PROMPT_CACHING_SONNET: '1' }, 'claude-sonnet-5-5'), true);
  assert.equal(off({ DISABLE_PROMPT_CACHING_OPUS: '1' }, 'claude-opus-5-5'), true);
  assert.equal(off({ DISABLE_PROMPT_CACHING_OPUS: '1' }, 'claude-opus-4-5'), false, 'another version pinned as the model keeps caching');
  assert.equal(off({ DISABLE_PROMPT_CACHING_FABLE: '1' }, 'claude-fable-5-1'), true);
  assert.equal(off({ DISABLE_PROMPT_CACHING_FABLE: '1' }, 'claude-opus-5-5'), false);
});

// ---------------------------------------------------------------------------------------------- the request

test('a gateway request marks the last tool, system prompt and newest message with the one-hour TTL', () => {
  const cfg = makeConfig();
  const params = buildParams(cfg, request(cfg));
  assert.deepEqual(params.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
  assert.deepEqual(params.tools.map((t) => t.cache_control), [undefined, undefined, { type: 'ephemeral', ttl: '1h' }]);
  assert.deepEqual(params.messages[0].content, [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
  assert.deepEqual(cachePlanOf(params), { caching: true, ttl: '1h' });
  assert.equal(JSON.stringify(params).includes('"ttl":"1h"'), true);
});

test('the conversation\'s requests use the "main" TTL and the others the "other" one', () => {
  const cfg = makeConfig({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
  const main = buildParams(cfg, request(cfg));
  assert.deepEqual(main.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(main.tools.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(main.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(cachePlanOf(main), { caching: true, ttl: '1h' });
  const other = buildParams(cfg, request(cfg, { cacheBucket: 'other' }));
  assert.deepEqual(other.system[0].cache_control, { type: 'ephemeral' }, 'sub-agents, compaction and side queries keep the 5 minutes');
  const both = makeConfig({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' });
  assert.deepEqual(buildParams(both, request(both, { cacheBucket: 'other' })).system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(buildParams(both, request(both)).system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(cacheControl('1h'), { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(cacheControl('5m'), { type: 'ephemeral' });
});

test('with caching disabled no marker is sent at all, and the request is otherwise the same', () => {
  const on = makeConfig();
  const off = makeConfig({ DISABLE_PROMPT_CACHING: '1' });
  const a = buildParams(on, request(on));
  const b = buildParams(off, request(off));
  assert.equal(JSON.stringify(b).includes('cache_control'), false);
  assert.deepEqual(cachePlanOf(b), { caching: false, ttl: '5m' });
  const strip = (p) => JSON.parse(JSON.stringify(p, (k, v) => (k === 'cache_control' ? undefined : v)));
  assert.deepEqual(strip({ ...a, messages: null }), strip({ ...b, messages: null }), 'only the markers differ');
  assert.deepEqual(b.messages, [{ role: 'user', content: 'hi' }], 'the messages are sent as they are');
  // a model that is switched off alone
  const haiku = makeConfig({ DISABLE_PROMPT_CACHING_HAIKU: '1', CLAUDE_PRO_GATEWAY_MODEL: 'haiku' });
  assert.equal(JSON.stringify(buildParams(haiku, request(haiku))).includes('cache_control'), false);
  const sonnet = makeConfig({ DISABLE_PROMPT_CACHING_HAIKU: '1', CLAUDE_PRO_GATEWAY_MODEL: 'sonnet' });
  assert.equal(JSON.stringify(buildParams(sonnet, request(sonnet))).includes('cache_control'), true);
});

test('a message list that ends with an assistant message, or is empty, gets no message marker', () => {
  const cfg = makeConfig();
  const params = buildParams(cfg, request(cfg, { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }] }));
  assert.equal(JSON.stringify(params.messages).includes('cache_control'), false);
  assert.deepEqual(buildParams(cfg, request(cfg, { messages: [] })).messages, []);
});

test('gateway requests keep the custom system prompt as the only system block', () => {
  const cfg = makeConfig({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
  const params = buildParams(cfg, request(cfg));
  assert.equal(params.system.length, 1);
  assert.equal(params.system[0].text, 'SYS');
  assert.deepEqual(params.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(params.metadata, undefined);
});

// ---------------------------------------------------------------------------------------------- endpoints that refuse it

test('an endpoint that refuses cache_control on the system prompt: the request goes on without it, and it is not sent again', async (t) => {
  const bodies = [];
  mockFetch(t, async (url, init) => {
    const body = bodyOf(init);
    bodies.push(body);
    return body.system[0].cache_control ? rejected('system.0.cache_control: Extra inputs are not permitted') : replyWith({ text: 'fine' });
  });
  const cfg = makeConfig();
  const res = await streamMessage(cfg, request(cfg));
  assert.equal(res.message.content[0].text, 'fine');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].system[0].cache_control, undefined, 'taken off where it was refused');
  assert.deepEqual(bodies[1].tools.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' }, 'and left where it was not');
  assert.deepEqual(bodies[1].messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(res.cache.caching, true, 'the reply says it was still cached');
  await streamMessage(cfg, request(cfg));
  assert.equal(bodies.length, 3, 'the next request is made once, without asking again');
  assert.equal(bodies[2].system[0].cache_control, undefined);
  // another endpoint is not affected
  const other = makeConfig();
  await streamMessage(other, request(other));
  assert.ok(bodies.at(-2).system[0].cache_control, 'another endpoint is asked for itself');
});

test('an endpoint that does not know the 1-hour ttl is sent the 5-minute default instead, from then on', async (t) => {
  const bodies = [];
  mockFetch(t, async (url, init) => {
    bodies.push(bodyOf(init));
    return init.body.includes('"ttl"') ? rejected("ttl: Extra inputs are not permitted") : replyWith();
  });
  const cfg = makeConfig({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
  const res = await streamMessage(cfg, request(cfg));
  assert.equal(bodies.length, 2);
  assert.equal(JSON.stringify(bodies[1]).includes('"ttl"'), false);
  assert.deepEqual(bodies[1].system[0].cache_control, { type: 'ephemeral' }, 'still cached, for 5 minutes');
  assert.equal(res.cache.ttl, '5m', 'the result tells the TTL that was really used');
  await streamMessage(cfg, request(cfg));
  assert.equal(bodies.length, 3);
  assert.equal(JSON.stringify(bodies[2]).includes('"ttl"'), false);
});

test('an endpoint that refuses cache_control without saying where loses the markers one place at a time, newest first', async (t) => {
  const bodies = [];
  mockFetch(t, async (url, init) => {
    bodies.push(bodyOf(init));
    return init.body.includes('cache_control') ? rejected('cache_control is not supported by this gateway') : replyWith();
  });
  const cfg = makeConfig();
  await streamMessage(cfg, request(cfg));
  const marks = (b) => ({ system: Boolean(b.system[0].cache_control), tools: Boolean(b.tools.at(-1).cache_control), messages: JSON.stringify(b.messages).includes('cache_control') });
  assert.deepEqual(bodies.map((b) => Object.values(marks(b)).filter(Boolean).length), [3, 2, 1, 0]);
  assert.equal(marks(bodies[1]).messages, false, 'the messages go first');
  assert.equal(marks(bodies[2]).tools, false, 'then the tools');
  assert.deepEqual(cacheRefusals(cfg, cfg.mainModel.id).sort(), ['messages', 'system', 'tools'], 'what it refused is known (and shown by /status)');
  await streamMessage(cfg, request(cfg));
  assert.equal(bodies.length, 5, 'the next request is made once');
  assert.equal(JSON.stringify(bodies[4]).includes('cache_control'), false, 'and none is sent later');
});

test('an error that merely mentions cache_control does not switch caching off for good', async (t) => {
  // a gateway that keeps complaining ends in an error, not in a loop, and nothing is remembered
  let calls = 0;
  const firstMarks = [];
  mockFetch(t, async (url, init) => { calls++; if (calls === 1 || calls === 5) firstMarks.push(JSON.stringify(init.body).split('cache_control').length - 1); return rejected('cache_control: nope'); });
  const stubborn = makeConfig();
  await assert.rejects(() => streamMessage(stubborn, request(stubborn)), /cache_control/);
  assert.equal(calls, 4, 'three places, one at a time, then the end');
  await assert.rejects(() => streamMessage(stubborn, request(stubborn)), /cache_control/);
  assert.deepEqual(firstMarks, [3, 3], 'the second call starts with all three markers again: the first one proved nothing');
  assert.deepEqual(cacheRefusals(stubborn, stubborn.mainModel.id), []);
  // a "maximum of 4 blocks" style error names no place: the messages marker goes, the rest stays, and that is remembered once it worked
  const bodies = [];
  mockFetch(t, async (url, init) => {
    const body = bodyOf(init);
    bodies.push(body);
    return JSON.stringify(body.messages).includes('cache_control') ? rejected('A maximum of 4 blocks with cache_control may be provided. Found 5.') : replyWith();
  });
  const cfg = makeConfig();
  await streamMessage(cfg, request(cfg));
  assert.equal(bodies.length, 2);
  assert.ok(bodies[1].system[0].cache_control && bodies[1].tools.at(-1).cache_control, 'the system prompt and the tools keep theirs');
  await streamMessage(cfg, request(cfg));
  assert.equal(bodies.length, 3);
  assert.deepEqual(cacheRefusals(cfg, cfg.mainModel.id), ['messages']);
  assert.ok(bodies[2].system[0].cache_control, 'still cached where it can be');
  // a 400 about the ttl on a 5-minute request cannot loop either
  let ttlCalls = 0;
  mockFetch(t, async () => { ttlCalls++; return rejected('ttl value is not valid for this request'); });
  const plain = makeConfig();
  await assert.rejects(() => streamMessage(plain, request(plain)), /ttl/);
  assert.ok(ttlCalls <= 5, `gave up after ${ttlCalls} requests`);
  // other 400s reach the caller as they are
  mockFetch(t, async () => rejected('messages: roles must alternate'));
  const other = makeConfig();
  await assert.rejects(() => streamMessage(other, request(other)), (err) => err.status === 400 && /roles must alternate/.test(err.message));
});

test('what an endpoint refused is remembered per model, and quickQuery marks neither its message nor the 1-hour TTL', async (t) => {
  const bodies = [];
  mockFetch(t, async (url, init) => {
    const body = bodyOf(init);
    bodies.push(body);
    return body.model === 'model-one' && body.system[0].cache_control ? rejected('system.0.cache_control: Extra inputs are not permitted') : replyWith();
  });
  const cfg = makeConfig({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
  await streamMessage(cfg, request(cfg, { model: { ...cfg.mainModel, id: 'model-one' } }));
  await streamMessage(cfg, request(cfg, { model: { ...cfg.mainModel, id: 'model-two' } }));
  assert.equal(bodies.at(-1).model, 'model-two');
  assert.ok(bodies.at(-1).system[0].cache_control, 'another model of the same endpoint is not affected');
  assert.deepEqual(cacheRefusals(cfg, 'model-one'), ['system']);
  assert.deepEqual(cacheRefusals(cfg, 'model-two'), []);
  // a side query: its content is never sent twice, so it is not written to the cache, and it never gets the conversation's TTL
  bodies.length = 0;
  await quickQuery(cfg, { model: cfg.mainModel, system: 'be brief', prompt: 'a whole web page and a question' });
  assert.equal(bodies.length, 1);
  assert.equal(JSON.stringify(bodies[0].messages).includes('cache_control'), false);
  assert.equal(JSON.stringify(bodies[0]).includes('"ttl"'), false);
});

// ---------------------------------------------------------------------------------------------- the statistics

const usageOf = (read, write, input = 10, extra = {}) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, ...extra });
const fp = (over = {}) => ({ model: 'mock', system: 's', tools: 't', effort: null, thinking: 'null', ...over });

test('CacheStats: the hit ratio, the misses and why they happened', () => {
  const stats = new CacheStats();
  const T0 = 1_000_000;
  stats.record({ usage: usageOf(0, 20_000), fingerprint: fp(), at: T0 }); // the first request: nothing to find, not a miss
  assert.equal(stats.misses, 0);
  assert.ok(stats.isWarm(T0 + 60_000));
  assert.ok(!stats.isWarm(T0 + 5 * 60_000 + 1), 'a 5-minute TTL runs out');
  stats.record({ usage: usageOf(20_000, 1_000), fingerprint: fp(), at: T0 + 60_000 });
  assert.equal(stats.misses, 0);
  assert.equal(Math.round(stats.hitRatio * 100), 49); // 20000 of 41020
  // the system prompt changed: nothing is read
  stats.record({ usage: usageOf(0, 21_000), fingerprint: fp({ system: 'other' }), at: T0 + 90_000 });
  assert.equal(stats.misses, 1);
  assert.equal(stats.lastMiss.cause, 'the system prompt changed');
  assert.match(stats.describe(T0 + 100_000).join('\n'), /1 miss · warm/);
  // each of the other causes
  const miss = (over, at) => { stats.record({ usage: usageOf(0, 21_000), fingerprint: fp({ system: 'other', ...over }), at }); return stats.lastMiss.cause; };
  assert.equal(miss({ tools: 'u' }, T0 + 120_000), 'the tool definitions changed');
  assert.equal(miss({ tools: 'u', effort: 'high' }, T0 + 150_000), 'the effort changed (auto → high)');
  assert.equal(miss({ tools: 'u', effort: 'high', thinking: '{"type":"disabled"}' }, T0 + 180_000), 'the thinking settings changed');
  assert.match(miss({ tools: 'u', effort: 'high', thinking: '{"type":"disabled"}', model: 'bigger' }, T0 + 210_000), /^the model changed \(mock → bigger\)/);
  // nothing changed, but more time went by than the TTL
  assert.match(miss({ tools: 'u', effort: 'high', thinking: '{"type":"disabled"}', model: 'bigger' }, T0 + 210_000 + 6 * 60_000), /the cache had expired \(6m 0s since the previous request, TTL 5m\)/);
  // nothing changed, nothing expired
  assert.match(miss({ tools: 'u', effort: 'high', thinking: '{"type":"disabled"}', model: 'bigger' }, T0 + 210_000 + 6 * 60_000 + 1000), /earlier messages changed|does not cache/);
  assert.equal(stats.misses, 7);
});

test('CacheStats: a rewritten history, a new conversation and an endpoint that does not cache are not misses', () => {
  const stats = new CacheStats();
  assert.deepEqual(stats.describe(), [], 'nothing to say before the first request');
  stats.record({ usage: usageOf(0, 30_000), fingerprint: fp(), at: 1000 });
  stats.noteRewrite(); // compaction, /rewind
  stats.record({ usage: usageOf(1_500, 2_000), fingerprint: fp(), at: 2000 });
  assert.equal(stats.misses, 0);
  stats.newConversation(); // /clear, /resume
  assert.ok(!stats.isWarm(2500), 'nothing is cached for a new conversation');
  stats.record({ usage: usageOf(0, 9_000), fingerprint: fp(), at: 3000 });
  assert.equal(stats.misses, 0);
  // a request that was sent without any marker leaves nothing to expect
  stats.record({ usage: usageOf(0, 0), fingerprint: fp(), caching: false, at: 4000 });
  stats.record({ usage: usageOf(0, 0), fingerprint: fp(), caching: false, at: 5000 });
  assert.equal(stats.misses, 0);
  // an endpoint that never reports cache use
  const plain = new CacheStats();
  plain.record({ usage: { input_tokens: 50_000 }, fingerprint: fp(), at: 1 });
  plain.record({ usage: { input_tokens: 51_000 }, fingerprint: fp(), at: 2 });
  assert.equal(plain.misses, 0);
  assert.match(plain.describe().join(' '), /nothing reported/);
  assert.ok(!plain.isWarm(3));
  // small prompts are below what the API caches: not worth a miss
  const small = new CacheStats();
  small.record({ usage: usageOf(0, 500), fingerprint: fp(), at: 1 });
  small.record({ usage: usageOf(0, 600), fingerprint: fp(), at: 2 });
  assert.equal(small.misses, 0);
});

test('CacheStats: a 1-hour request keeps the cache warm for an hour, and counts its 1-hour writes', () => {
  const stats = new CacheStats();
  stats.record({ usage: usageOf(0, 10_000, 10, { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 } }), fingerprint: fp(), ttl: '1h', at: 0 });
  assert.equal(stats.write1h, 10_000);
  assert.ok(stats.isWarm(59 * 60_000));
  assert.ok(!stats.isWarm(61 * 60_000));
  assert.match(stats.describe(60_000).join('\n'), /TTL 1h/);
});

test('fingerprint ignores the cache markers and the messages, and sees everything else', () => {
  const cfg = makeConfig();
  const a = fingerprint(buildParams(cfg, request(cfg)));
  const b = fingerprint(buildParams(makeConfig({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }), request(cfg, { messages: [{ role: 'user', content: 'something else' }] })));
  assert.deepEqual(a, b);
  assert.notEqual(fingerprint(buildParams(cfg, request(cfg, { system: 'OTHER' }))).system, a.system);
  assert.notEqual(fingerprint(buildParams(cfg, request(cfg, { tools: [tool('Alpha')] }))).tools, a.tools);
  assert.equal(fingerprint(buildParams(cfg, request(cfg, { effort: 'max' }))).effort, 'max');
});

// ---------------------------------------------------------------------------------------------- the agent

function makeAgent(cfg, { systemPrompt = 'MAIN SYSTEM', io = {}, ...rest } = {}) {
  return new Agent({ config: cfg, tools, systemPrompt, io, model: cfg.mainModel, cwd: process.cwd(), ...rest });
}

test('the summary request is the conversation\'s own request with the instruction at the end', async (t) => {
  const bodies = [];
  const answers = [
    () => replyWith({ text: 'first answer', usage: usageOf(0, 12_000, 20, { cache_creation: { ephemeral_5m_input_tokens: 12_000, ephemeral_1h_input_tokens: 0 } }) }),
    () => replyWith({ text: '<analysis>x</analysis><summary>THE SUMMARY</summary>', usage: usageOf(12_000, 300, 15) }),
  ];
  mockFetch(t, async (url, init) => { bodies.push(bodyOf(init)); return answers[bodies.length - 1](); });
  const cfg = makeConfig({ CLAUDE_CODE_EFFORT_LEVEL: 'high' });
  let refreshed = 0;
  const agent = makeAgent(cfg, { refreshSystemPrompt: () => { refreshed++; } });
  await agent.run('hello');
  const summary = await agent.compact();
  assert.equal(summary, 'THE SUMMARY');
  assert.equal(bodies.length, 2, 'one request for the summary');
  const [turn, compaction] = bodies;
  assert.equal(compaction.system[0].text, 'MAIN SYSTEM', 'the same system prompt');
  assert.deepEqual(compaction.tools.map((t) => t.name), turn.tools.map((t) => t.name));
  assert.deepEqual(strip(compaction.tools), strip(turn.tools), 'the same tools apart from the bucket-specific marker TTL');
  assert.deepEqual(compaction.tools.at(-1).cache_control, { type: 'ephemeral' });
  assert.deepEqual(compaction.output_config, { effort: 'high' }, 'the same effort');
  assert.deepEqual(compaction.output_config, turn.output_config);
  assert.equal(compaction.model, turn.model);
  // the history is a continuation of the turn's request, and the instruction comes last
  assert.deepEqual(compaction.messages[0].content.map((b) => b.text), ['hello']);
  assert.deepEqual(strip(compaction.messages.slice(0, turn.messages.length)), strip(turn.messages), 'the history is the turn\'s request, unchanged');
  assert.equal(compaction.messages[1].role, 'assistant');
  assert.equal(compaction.messages[1].content.map((b) => b.text).join(''), 'first answer', 'the reply that came after it is kept as it was');
  const last = compaction.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.match(last.content.at(-1).text, /detailed summary of the conversation/);
  assert.match(last.content.at(-1).text, /Do NOT call any tools/);
  assert.deepEqual(last.content.at(-1).cache_control, { type: 'ephemeral' }, 'the newest message carries the marker');
  // what came of it
  assert.equal(refreshed, 1, 'the new conversation may start from a rebuilt system prompt');
  assert.equal(agent.messages.length, 1);
  assert.match(agent.messages[0].content[0].text, /THE SUMMARY/);
  assert.equal(agent.usage.requests, 1);
  assert.equal(agent.usage.compactions, 1);
  assert.equal(agent.usage.cacheRead, 12_000, 'the summary request counts in the usage');
  assert.equal(agent.usage.cacheWrite, 12_300);
  assert.equal(agent.usage.cacheWrite1h, 0);
  assert.equal(agent.cache.misses, 0, 'it found the conversation in the cache');
  assert.ok(agent.cache.expected == null, 'and the new conversation has nothing in the cache yet');
  assert.deepEqual(agent.totalUsage().requests, 1);
  assert.deepEqual(agent.totalUsage().compactions, 1);
});

test('the summary request misses on purpose only when the shared one fails: no summary, or a prompt that is too long', async (t) => {
  const run = async (first, cfgEnv = {}) => {
    const bodies = [];
    mockFetch(t, async (url, init) => {
      bodies.push(bodyOf(init));
      if (bodies.length === 1) return replyWith({ text: 'hi', usage: usageOf(0, 12_000) }); // a real turn: 12,000 tokens are in the cache
      return bodies.length === 2 ? first() : replyWith({ text: '<summary>PLAIN</summary>', usage: usageOf(0, 100) });
    });
    const cfg = makeConfig({ CLAUDE_CODE_EFFORT_LEVEL: 'high', ...cfgEnv });
    const agent = makeAgent(cfg);
    await agent.run('hello');
    const summary = await agent.compact();
    return { bodies: bodies.slice(1), summary, agent };
  };
  // the model keeps calling tools instead of writing the summary
  let r = await run(() => replyWith({ toolUse: 'Alpha', usage: usageOf(12_000, 50) }));
  assert.equal(r.summary, 'PLAIN');
  assert.equal(r.bodies.length, 2);
  assert.equal(r.bodies[0].system[0].text, 'MAIN SYSTEM');
  assert.equal(r.bodies[1].system[0].text, SUMMARY_SYSTEM, 'then the plain request');
  assert.equal(r.bodies[1].output_config, undefined);
  assert.equal(r.agent.usage.compactions, 2, 'both were billed');
  assert.equal(r.agent.cache.misses, 0, 'the one that was made to miss is not reported as a miss (it read 0 of the 12,000 cached tokens)');
  // the model writes a few words and then calls a tool: that is not a summary, whatever the words are
  r = await run(() => replyWith({ preamble: 'Let me look at the file first.', toolUse: 'Alpha', usage: usageOf(12_000, 50) }));
  assert.equal(r.summary, 'PLAIN', 'the preamble must not be taken for the summary');
  assert.equal(r.bodies[1].system[0].text, SUMMARY_SYSTEM);
  // a summary that the output limit cut off is not a summary: it would end in the middle of a sentence
  r = await run(() => replyWith({ text: '<summary>1. Primary request: fix the bug in the pars', stop: 'max_tokens', usage: usageOf(12_000, 50) }));
  assert.equal(r.summary, 'PLAIN');
  assert.equal(r.bodies.length, 2);
  // ... but one that was finished before the limit is kept
  r = await run(() => replyWith({ text: '<summary>COMPLETE</summary>', stop: 'max_tokens', usage: usageOf(12_000, 50) }));
  assert.equal(r.summary, 'COMPLETE');
  assert.equal(r.bodies.length, 1);
  // the shared request is too long by the size of the instruction
  r = await run(() => rejected('prompt is too long: 200100 tokens > 200000 maximum'));
  assert.equal(r.summary, 'PLAIN');
  assert.equal(r.bodies[1].system[0].text, SUMMARY_SYSTEM);
  // any other error is not hidden behind a second request
  let calls = 0;
  mockFetch(t, async () => { calls++; return rejected('something else is wrong'); });
  const cfg = makeConfig();
  const agent = makeAgent(cfg);
  agent.messages = [{ role: 'user', content: 'hello' }];
  await assert.rejects(() => agent.compact(), /something else is wrong/);
  assert.equal(calls, 1);
  // an empty summary from the plain request too is the error it always was; a cut-off one says so
  mockFetch(t, async () => replyWith({ text: '   ' }));
  const empty = makeAgent(makeConfig());
  empty.messages = [{ role: 'user', content: 'hello' }];
  await assert.rejects(() => empty.compact(), /empty summary/);
  mockFetch(t, async () => replyWith({ text: '<summary>cut', stop: 'max_tokens' }));
  const cut = makeAgent(makeConfig());
  cut.messages = [{ role: 'user', content: 'hello' }];
  await assert.rejects(() => cut.compact(), /cut off by the output token limit/);
  assert.equal(cut.messages.length, 1, 'the conversation is kept');
  assert.equal(cut.messages[0].content, 'hello');
});

test('compaction and its plain fallback are "other" requests: they never get the conversation\'s 1-hour TTL', async (t) => {
  const bodies = [];
  mockFetch(t, async (url, init) => {
    bodies.push(bodyOf(init));
    if (bodies.length === 1) return replyWith({ text: 'hi', usage: usageOf(0, 12_000) });
    return bodies.length === 2 ? replyWith({ toolUse: 'Alpha', usage: usageOf(12_000, 50) }) : replyWith({ text: '<summary>S</summary>' });
  });
  const cfg = makeConfig({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
  const agent = makeAgent(cfg);
  await agent.run('hello');
  await agent.compact();
  assert.equal(bodies.length, 3);
  assert.ok(JSON.stringify(bodies[0]).includes('"ttl":"1h"'), 'the conversation\'s own request has the 1-hour TTL');
  assert.equal(JSON.stringify(bodies[1]).includes('"ttl"'), false, 'the summary request does not');
  assert.equal(bodies[2].system[0].text, SUMMARY_SYSTEM);
  assert.equal(JSON.stringify(bodies[2]).includes('"ttl"'), false, 'nor does the plain one');
  assert.equal(JSON.stringify(bodies[2].messages).includes('cache_control'), false, 'the plain one cannot read the history from the cache, so it does not write it either');
});

test('a compaction after the cache ran out sends the history as plain input: no later request starts with it', async (t) => {
  const bodies = [];
  mockFetch(t, async (url, init) => {
    bodies.push(bodyOf(init));
    return bodies.length === 1 ? replyWith({ text: 'hi', usage: usageOf(0, 12_000) }) : replyWith({ text: '<summary>S</summary>' });
  });
  const agent = makeAgent(makeConfig());
  await agent.run('hello');
  assert.equal(agent.cacheExpired(), false, 'just written');
  agent.cache.expiresAt = Date.now() - 1; // the TTL has passed since that request
  assert.equal(agent.cacheExpired(), true);
  await agent.compact();
  const compaction = bodies[1];
  assert.equal(compaction.system[0].text, 'MAIN SYSTEM', 'still the shared request');
  assert.equal(JSON.stringify(compaction.messages).includes('cache_control'), false, 'the history is not written to the cache');
  assert.ok(compaction.system[0].cache_control, 'the system prompt keeps its marker: the next turn reads it');
  assert.ok(compaction.tools.at(-1).cache_control, 'and so do the tools');
  // a resumed or restarted conversation: nothing measured in this process, the time of its last message decides
  const resumed = makeAgent(makeConfig());
  resumed.messages = [{ role: 'user', content: 'hello' }];
  assert.equal(resumed.cacheExpired(), false, 'not knowing counts as warm');
  resumed.lastActivityAt = Date.now() - 60_000;
  assert.equal(resumed.cacheExpired(), false, 'a minute ago, with the one-hour TTL');
  resumed.lastActivityAt = Date.now() - 10 * 60_000;
  assert.equal(resumed.cacheExpired(), false, 'ten minutes ago is still within the gateway TTL');
  const hour = makeAgent(makeConfig({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }));
  hour.lastActivityAt = Date.now() - 10 * 60_000;
  assert.equal(hour.cacheExpired(), false, 'the conversation\'s own TTL counts');
});

test('a sub-agent\'s own compaction does not end the main conversation\'s checkpoints', async (t) => {
  mockFetch(t, async () => replyWith({ text: '<summary>S</summary>' }));
  const stale = [];
  const checkpoints = { markConversationStale: () => stale.push(1), reset() {} };
  for (const isSubagent of [true, false]) {
    const agent = makeAgent(makeConfig(), { checkpoints, isSubagent });
    agent.messages = [{ role: 'user', content: 'hello' }];
    await agent.compact();
  }
  assert.equal(stale.length, 1, 'only the main agent\'s compaction replaces the conversation the checkpoints belong to');
});

test('a sub-agent\'s requests use the "other" TTL; the main agent\'s use the "main" one', async (t) => {
  const bodies = [];
  mockFetch(t, async (url, init) => { bodies.push(bodyOf(init)); return replyWith(); });
  const cfg = makeConfig({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
  await makeAgent(cfg).run('main question');
  await makeAgent(cfg, { isSubagent: true, systemPrompt: 'SUB SYSTEM' }).run('sub question');
  assert.deepEqual(bodies[0].system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(bodies[1].system[0].cache_control, { type: 'ephemeral' });
});

test('the agent keeps the cache statistics of its requests, and tells the io about a new system prompt once', async (t) => {
  const answers = [usageOf(0, 30_000), usageOf(30_000, 500), usageOf(0, 31_000), usageOf(0, 100)];
  let n = 0;
  mockFetch(t, async () => replyWith({ usage: answers[n++] }));
  const prompts = [];
  let system = 'FIRST';
  const cfg = makeConfig();
  const agent = makeAgent(cfg, { systemPrompt: () => system, io: { systemPrompt: (text) => prompts.push(text) } });
  await agent.run('one');
  await agent.run('two');
  assert.deepEqual(prompts, ['FIRST'], 'reported once, not on every request');
  assert.equal(agent.cache.misses, 0);
  system = 'SECOND'; // the system prompt changes in the middle of the conversation
  await agent.run('three');
  assert.deepEqual(prompts, ['FIRST', 'SECOND']);
  assert.equal(agent.cache.misses, 1);
  assert.equal(agent.cache.lastMiss.cause, 'the system prompt changed');
  assert.equal(agent.usage.requests, 3);
  // a new conversation starts without expecting anything from the cache, and its session file gets the prompt too,
  // even when it is the very same text (a /clear that changed nothing)
  agent.resetConversation();
  assert.ok(!agent.cache.isWarm());
  await agent.run('four');
  assert.deepEqual(prompts, ['FIRST', 'SECOND', 'SECOND']);
  // sub-agents' usage is the main agent's to report
  agent.addSubUsage({ input: 100, output: 20, cacheRead: 5000, cacheWrite: 700, cacheWrite1h: 0, requests: 4, compactions: 1 });
  const total = agent.totalUsage();
  assert.equal(total.requests, 8);
  assert.equal(total.compactions, 1);
  assert.equal(total.cacheRead, 30_000 + 5000);
  assert.equal(agent.subUsage.runs, 1);
});

test('a reminder goes into the next user message only, after the user\'s own text', async (t) => {
  const bodies = [];
  mockFetch(t, async (url, init) => { bodies.push(bodyOf(init)); return replyWith(); });
  const agent = makeAgent(makeConfig());
  agent.addReminder('It is a new day.');
  await agent.run('hello');
  await agent.run('again');
  const first = bodies[0].messages[0].content;
  assert.equal(first[0].text, 'hello');
  assert.equal(first[1].text, '<system-reminder>It is a new day.</system-reminder>');
  assert.equal(JSON.stringify(bodies[1].messages).split('It is a new day.').length, 2, 'it stays where it was put, and is not added again');
});

// ---------------------------------------------------------------------------------------------- the system prompt

test('sub-agents share one snapshot of the date and git state, while the git state itself moves on', { skip: !hasGit && 'git is not installed' }, () => {
  const dir = tmp();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Tester');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const snapshot = takeEnvSnapshot(dir);
  assert.match(snapshot.date, /^\d{4}-\d{2}-\d{2}$/);
  const make = (snap) => subagentSystemPrompt({ cwd: dir, model: { id: 'mock' }, shellName: 'bash', agentPrompt: 'You search.', snapshot: snap });
  const before = make(snapshot);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new file'); // the repository changes while the conversation goes on
  assert.equal(make(snapshot), before, 'the same prompt: its prefix stays in the prompt cache');
  assert.notEqual(make(null), before, 'a prompt built afresh would differ');
  assert.match(make(null), /\?\? b\.txt/);
  assert.doesNotMatch(before, /b\.txt/);
  assert.equal(environmentBlock(dir, { model: { id: 'mock' }, shellName: 'bash', snapshot }).includes(`Today's date: ${snapshot.date}`), true);
});

test('the session file keeps the system prompt; the newest wins, and the same one is not written twice', () => {
  const cwd = tmp();
  const store = new SessionStore(cwd);
  store.setSystemPrompt('PROMPT ONE');
  store.setSystemPrompt('PROMPT ONE');
  store.message({ role: 'user', content: 'hello' });
  store.setSystemPrompt('PROMPT TWO');
  const lines = fs.readFileSync(store.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.systemPrompt).length, 2);
  const loaded = SessionStore.load(store.file);
  assert.equal(loaded.systemPrompt, 'PROMPT TWO');
  assert.equal(loaded.promptCode, CODE, 'with the fingerprint of the code that built it');
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.title, 'hello');
  const bare = new SessionStore(cwd);
  bare.message({ role: 'user', content: 'x' });
  assert.equal(SessionStore.load(bare.file).systemPrompt, null, 'a session from before has none');
  // a resumed store that knows the prompt does not write it again
  const resumed = new SessionStore(cwd, store.id);
  resumed.systemPrompt = loaded.systemPrompt;
  resumed.setSystemPrompt('PROMPT TWO');
  assert.equal(fs.readFileSync(store.file, 'utf8').trim().split('\n').length, lines.length);
});

async function runtimeIn(cwd, env = {}, flags = {}) {
  Object.assign(process.env, { CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_API_KEY: 'test-token', CLAUDE_PRO_GATEWAY_MODEL: 'mock', CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1', CLAUDE_PRO_RIPGREP_PATH: 'off', ...env });
  const runtime = await createRuntime({ cwd, flags: { noMcp: true, ...flags }, io: {} });
  return runtime;
}

test('the system prompt stays as it was built until /clear or a compaction; changes only mark it as stale', async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Use tabs.');
  const rt = await runtimeIn(cwd);
  const first = rt.systemPrompt();
  assert.match(first, /Use tabs\./);
  assert.equal(rt.systemPromptStale, false);
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Use spaces.'); // e.g. a memory saved with #
  rt.deferSystemPromptRefresh();
  assert.equal(rt.systemPromptStale, true);
  assert.equal(rt.systemPrompt(), first, 'the same prompt, byte for byte');
  assert.equal(rt.systemPrompt(), first);
  rt.invalidateSystemPrompt(); // /clear
  const second = rt.systemPrompt();
  assert.match(second, /Use spaces\./);
  assert.equal(rt.systemPromptStale, false);
  // a compaction does the same, through the agent
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Use semicolons.');
  rt.deferSystemPromptRefresh();
  rt.agent.refreshSystemPrompt();
  assert.match(rt.systemPrompt(), /Use semicolons\./);
  // nothing built yet: nothing to mark
  rt.invalidateSystemPrompt();
  rt.deferSystemPromptRefresh();
  assert.equal(rt.systemPromptStale, false);
  rt.mcp.close();
});

test('a resumed conversation continues behind its own system prompt; a note brings the date up to date', async () => {
  const cwd = tmp();
  const rt = await runtimeIn(cwd);
  const built = rt.systemPrompt();
  const saved = built.replace(/Today's date: \d{4}-\d{2}-\d{2}/, "Today's date: 2020-01-02").replace('Recent commits:', 'Recent commits (old):');
  rt.invalidateSystemPrompt();
  assert.equal(rt.resumeSystemPrompt(saved, CODE), true);
  assert.equal(rt.systemPrompt(), saved, 'the saved prompt, not a freshly built one');
  assert.equal(rt.agent.reminders.length, 1);
  assert.match(rt.agent.reminders[0], /2020-01-02/);
  assert.match(rt.agent.reminders[0], /out of date/);
  // the same day: nothing to add
  const rt2 = await runtimeIn(tmp());
  const today = rt2.systemPrompt();
  rt2.invalidateSystemPrompt();
  assert.equal(rt2.resumeSystemPrompt(today, CODE), true);
  assert.equal(rt2.agent.reminders.length, 0);
  // a prompt that was built for another model is not used: the model's cache is its own, and the prompt names it
  rt2.invalidateSystemPrompt();
  assert.equal(rt2.resumeSystemPrompt(today.replace('You are powered by the model mock.', 'You are powered by the model another.'), CODE), false);
  assert.equal(rt2.systemPrompt(), today, 'a fresh one is built instead');
  // one built by other code (the prompt was edited, then a Restart), or by code from before the fingerprint was kept
  rt2.invalidateSystemPrompt();
  assert.equal(rt2.resumeSystemPrompt(saved, 'older-code'), false);
  assert.equal(rt2.resumeSystemPrompt(saved, null), false);
  assert.equal(rt2.systemPrompt(), today, 'the new code builds it');
  // nothing saved, or garbage
  assert.equal(rt2.resumeSystemPrompt(null, CODE), false);
  assert.equal(rt2.resumeSystemPrompt('  ', CODE), false);
  rt.mcp.close();
  rt2.mcp.close();
});

test('the own-code section: fix yourself in a source checkout, only report in an installed copy', () => {
  const cwd = tmp();
  const base = { cwd, model: { id: 'mock' }, shellName: 'bash', snapshot: { date: '2026-01-01', git: null } };
  const checkout = mainSystemPrompt({ ...base, selfRestart: true });
  assert.match(checkout, /# Your own source code/);
  assert.match(checkout, /use the Restart tool/);
  assert.doesNotMatch(checkout, /npm run check/, 'how to verify there is that repository\'s CLAUDE.md\'s business');
  const installed = mainSystemPrompt({ ...base, installedCopy: true });
  assert.match(installed, /# Your own code\n.*an installed copy, e\.g\. from npm/);
  assert.match(installed, /Do not edit your own files there/);
  assert.doesNotMatch(installed, /Restart/);
  const neither = mainSystemPrompt(base); // a checkout without the supervisor (-p): nothing to say
  assert.doesNotMatch(neither, /# Your own/);
});

test('the model is told that a long conversation is summarized only while auto-compaction is on', () => {
  const base = { cwd: tmp(), model: { id: 'mock' }, shellName: 'bash', snapshot: { date: '2026-01-01', git: null } };
  assert.match(mainSystemPrompt(base), /its earlier part is summarized automatically/);
  assert.doesNotMatch(mainSystemPrompt({ ...base, autoCompact: false }), /summarized automatically/, 'DISABLE_AUTOCOMPACT=1');
});

test('sub-agents get the boundaries and the project\'s instructions, except read-only ones', async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Run tests with the dot reporter.');
  const base = { cwd, model: { id: 'mock' }, shellName: 'bash', agentPrompt: 'You work.', snapshot: { date: '2026-01-01', git: null } };
  const writer = subagentSystemPrompt(base);
  assert.match(writer, /# Boundaries/);
  assert.match(writer, /Do not commit, push or publish unless your task asks for it/);
  assert.match(writer, /# Project instructions\n[^\n]*committing, pushing and publishing stay the main agent's[\s\S]*Run tests with the dot reporter\./);
  assert.doesNotMatch(writer, /cwd reset/, 'the working directory persists between Bash calls here');
  const reader = subagentSystemPrompt({ ...base, readOnly: true });
  assert.doesNotMatch(reader, /# Boundaries|# Project instructions|dot reporter/);
  const { loadAgents } = await import('../src/agents.js');
  const agents = loadAgents(cwd);
  assert.deepEqual(['general-purpose', 'Explore', 'Plan'].map((n) => Boolean(agents.get(n).readOnly)), [false, true, true]);
});

test('--append-system-prompt: a saved prompt is only reused when it was built with the same text', async () => {
  const cwd = tmp();
  const first = await runtimeIn(cwd, {}, { appendSystemPrompt: 'EXTRA RULES' });
  const saved = first.systemPrompt();
  assert.ok(saved.endsWith('\n\nEXTRA RULES'));
  const same = await runtimeIn(cwd, {}, { appendSystemPrompt: 'EXTRA RULES' });
  assert.equal(same.resumeSystemPrompt(saved, CODE), true);
  assert.equal(same.systemPrompt(), saved);
  const other = await runtimeIn(cwd, {}, { appendSystemPrompt: 'OTHER RULES' });
  assert.equal(other.resumeSystemPrompt(saved, CODE), false, 'the flag of this run is not dropped in favour of the old one');
  assert.ok(other.systemPrompt().endsWith('\n\nOTHER RULES'));
  assert.doesNotMatch(other.systemPrompt(), /EXTRA RULES/);
  const plain = await runtimeIn(cwd);
  const plainSaved = plain.systemPrompt();
  assert.equal((await runtimeIn(cwd)).resumeSystemPrompt(plainSaved, CODE), true, 'no flag, nothing to compare');
  const added = await runtimeIn(cwd, {}, { appendSystemPrompt: 'NEW RULES' });
  assert.equal(added.resumeSystemPrompt(plainSaved, CODE), false, 'a flag added on resume is honoured');
  for (const rt of [first, same, other, plain, added]) rt.mcp.close();
});

test('through createRuntime: sub-agents share the snapshot, and their usage is the main agent\'s to report', { skip: !hasGit && 'git is not installed' }, async (t) => {
  const dir = tmp();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Tester');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const rt = await runtimeIn(dir);
  const systems = [];
  mockFetch(t, async (url, init) => { systems.push(JSON.stringify(bodyOf(init).system)); return replyWith({ usage: usageOf(700, 0) }); });
  t.after(() => rt.mcp.close());
  const run = (prompt) => rt.spawnSubagent({ def: { name: 'probe', prompt: 'You probe.', tools: [] }, prompt, description: prompt, ctx: { cwd: dir, depth: 0 } });
  await run('one');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x'); // the repository changes between the two runs
  await run('two');
  assert.equal(systems[0], systems[1], 'the same system prompt for both: its prefix stays in the cache');
  assert.doesNotMatch(systems[0], /b\.txt/);
  const total = rt.agent.totalUsage();
  assert.equal(total.requests, 2, 'the sub-agents\' requests are counted');
  assert.equal(total.cacheRead, 1400);
  assert.equal(rt.agent.subUsage.runs, 2);
  assert.equal(rt.agent.usage.requests, 0, 'none of them was the main agent\'s own');
  rt.invalidateSystemPrompt(); // /clear or a compaction: the snapshot is taken again
  await run('three');
  assert.match(systems[2], /b\.txt/);
  // the Task call's model and effort win over the definition's, and the definition's over the session's
  const bodies = [];
  mockFetch(t, async (url, init) => { bodies.push(bodyOf(init)); return replyWith({ usage: usageOf(700, 0) }); });
  const def = { name: 'probe', prompt: 'You probe.', tools: [], effort: 'high', model: 'opus' };
  await rt.spawnSubagent({ def, prompt: 'p', description: 'p', ctx: { cwd: dir, depth: 0 }, model: 'claude-haiku-5-5', effort: 'low' });
  await rt.spawnSubagent({ def, prompt: 'p', description: 'p', ctx: { cwd: dir, depth: 0 } });
  assert.deepEqual(bodies.map((b) => [b.model, b.output_config?.effort]), [['claude-haiku-5-5', 'low'], [rt.config.resolveModel('opus').id, 'high']]);
  // a sub-agent that fails is billed too
  mockFetch(t, async () => rejected('boom'));
  await assert.rejects(() => run('four'), /boom/);
  assert.equal(rt.agent.subUsage.runs, 6);
});

test('an automatic compaction that keeps failing does not fail the turns, and stops after 3 failures in a row', async (t) => {
  let summaries = 0;
  let turns = 0;
  mockFetch(t, async (url, init) => {
    if (init.body.includes('detailed summary of the conversation')) { summaries++; return rejected('the summary endpoint is broken'); }
    turns++;
    return replyWith({ usage: { input_tokens: 50_000 } }); // the context stays above the threshold
  });
  const notices = [];
  const cfg = makeConfig({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '1' }); // compact from 2,000 tokens on
  const agent = makeAgent(cfg, { io: { notice: (text) => notices.push(text) } });
  agent.messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: 'c' }];
  agent.lastContextTokens = 50_000;
  for (let i = 0; i < 5; i++) {
    const r = await agent.run(`question ${i}`);
    assert.equal(r.text, 'ok', 'the turn goes on without the summary');
  }
  assert.equal(summaries, 3, 'three attempts, then no more');
  assert.equal(turns, 5);
  assert.equal(notices.filter((n) => /continuing without it/.test(n)).length, 2);
  assert.equal(notices.filter((n) => /off for this conversation/.test(n)).length, 1);
  // a /compact that succeeds turns it back on, and so does a new conversation
  mockFetch(t, async (url, init) => (init.body.includes('detailed summary of the conversation') ? replyWith({ text: '<summary>S</summary>' }) : replyWith({ usage: { input_tokens: 50_000 } })));
  await agent.compact();
  assert.equal(agent.compactFailures, 0);
  agent.compactFailures = 3;
  agent.resetConversation();
  assert.equal(agent.compactFailures, 0);
  // a prompt that is already too long has nothing to go on with: the compaction's error ends the turn, as before
  const tooLong = makeAgent(makeConfig());
  tooLong.messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: 'c' }];
  mockFetch(t, async (url, init) => (init.body.includes('detailed summary of the conversation') ? rejected('the summary endpoint is broken') : rejected('prompt is too long: 210000 tokens > 200000 maximum')));
  await assert.rejects(() => tooLong.run('more'), /the summary endpoint is broken/);
});

test('a conversation that goes on past midnight is told the new date once a day, without rebuilding the system prompt', async (t) => {
  const rt = await runtimeIn(tmp());
  t.after(() => rt.mcp.close());
  assert.equal(rt.noteDateChange('2099-01-01'), false, 'no prompt built yet: nothing to compare');
  const built = rt.systemPrompt();
  const then = /^Today's date: (.+)$/m.exec(built)[1];
  assert.equal(rt.noteDateChange(then), false, 'the same day: nothing to say');
  assert.equal(rt.noteDateChange('2099-01-01'), true);
  assert.equal(rt.noteDateChange('2099-01-01'), false, 'once a day');
  assert.deepEqual(rt.agent.reminders, [`Today's date is 2099-01-01. This conversation started on ${then}, so the date in the environment block of your instructions is out of date.`]);
  assert.equal(rt.systemPrompt(), built, 'the prompt itself stays, and so does its cache');
  assert.equal(rt.noteDateChange('2099-01-02'), true, 'another day, another note');
  // the main agent asks before each turn; a sub-agent does not
  let calls = 0;
  mockFetch(t, async () => replyWith());
  rt.agent.reminders.length = 0;
  rt.agent.beforeTurn = () => { calls++; };
  await rt.agent.run('hello');
  assert.equal(calls, 1);
  await makeAgent(makeConfig(), { isSubagent: true, beforeTurn: () => { calls++; } }).run('sub');
  assert.equal(calls, 1);
});


// ------------------------------------------------------------------------------ clearing after a long pause

// A conversation of tool calls, each with thinking before it: Read a.js, Bash, Task, Read b.js, a small Grep,
// Read b.js again, then 4 more Bash calls. The big results are about 10k tokens each.
function longConversation() {
  const big = (tag) => `${tag}\n${'x'.repeat(40_000)}`;
  const calls = [
    ['Read', { file_path: '/proj/a.js' }, big('a.js')],
    ['Bash', { command: 'npm test' }, big('test log')],
    ['Task', { prompt: 'look around' }, big('report')],
    ['Read', { file_path: '/proj/b.js' }, big('b.js')],
    ['Grep', { pattern: 'x' }, 'one match'],
    ['Read', { file_path: '/proj/b.js' }, big('b.js again')],
    ...[6, 7, 8, 9].map((i) => ['Bash', { command: `step ${i}` }, big(`log ${i}`)]),
  ];
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'start' }] }];
  calls.forEach(([name, input, result], i) => {
    messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me think. '.repeat(50), signature: 'sig' }, { type: 'tool_use', id: `t${i}`, name, input }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: result }] });
  });
  messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'Done.', signature: 'sig' }, { type: 'text', text: 'All done.' }] });
  return messages;
}
const resultOf = (messages, id) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result' && b.tool_use_id === id);

test('clearing old tool results: all but the last 5, only what can be got again, and all the thinking', () => {
  const messages = longConversation();
  const before = JSON.stringify(messages);
  const saved = [];
  const out = clearOldToolResults(messages, { save: (id, text) => { saved.push([id, text]); return `/saved/${id}.txt`; }, cwd: '/proj' });
  assert.equal(out.results, 3, 'Read a.js, the first Bash and the first Read of b.js');
  assert.equal(resultOf(out.messages, 't0').content, `${CLEARED} Read the file again if you need it.`);
  assert.equal(resultOf(out.messages, 't1').content, `${CLEARED} The full output was saved to /saved/t1.txt; read it there if you need it.`);
  assert.deepEqual(saved.map(([id, text]) => [id, text.split('\n')[0]]), [['t1', 'test log']], 'a command\'s output is kept in a file; a file read is not');
  assert.equal(resultOf(out.messages, 't3').content, `${CLEARED} Read the file again if you need it.`);
  for (const id of ['t2', 't4', 't5', 't6', 't7', 't8', 't9']) assert.equal(resultOf(out.messages, id).content, resultOf(messages, id).content, `${id} stays`);
  assert.ok(out.messages.every((m) => !Array.isArray(m.content) || m.content.every((b) => b.type !== 'thinking')), 'no thinking is left');
  assert.equal(out.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content).filter((b) => b.type === 'tool_use').length, 10, 'the tool calls stay');
  assert.ok(out.tokens > 30_000);
  assert.deepEqual(out.forget, [resolvePath('/proj/a.js', '/proj')], 'b.js is still shown by its later Read');
  assert.equal(JSON.stringify(messages), before, 'the conversation it was given is not changed');
  assert.equal(clearOldToolResults(messages, { atLeast: 40_000 }), null, 'less than there is to gain: nothing is done');
  assert.equal(clearOldToolResults(out.messages, { atLeast: 1 }), null, 'what was cleared is not cleared again');
});

// Clearing after a pause on (or off) whatever the endpoint (the tests' mock endpoint has it off).
const idleClearing = (cfg, on = true) => Object.defineProperty(cfg, 'clearAfterIdle', { value: on });

test('back after more than 65 minutes, the next request goes out without the old results; the session file and the file state follow', async (t) => {
  const bodies = [];
  mockFetch(t, async (url, init) => { bodies.push(bodyOf(init)); return replyWith(); });
  const replaced = [];
  const notices = [];
  const agent = makeAgent(idleClearing(makeConfig({})), { io: { messagesReplaced: (m) => replaced.push(m), notice: (text) => notices.push(text) } });
  agent.cwd = '/proj';
  agent.messages = longConversation();
  agent.fileState.set(resolvePath('/proj/a.js', '/proj'), { mtimeMs: 1 });
  agent.fileState.set(resolvePath('/proj/b.js', '/proj'), { mtimeMs: 1 });
  agent.lastActivityAt = Date.now() - 66 * 60_000;
  await agent.run('back again');
  const sent = JSON.stringify(bodies[0].messages);
  assert.ok(sent.includes(CLEARED) && !sent.includes('"thinking"') && !sent.includes('a.js\\nxxxx'), 'the request carries the cleared conversation');
  assert.equal(replaced.length, 1, 'the session file gets the cleared conversation');
  assert.match(notices[0], /^Back after 66 minutes, with the prompt cache expired: cleared 3 old tool results and the earlier thinking \(about \d+k tokens\)/);
  assert.equal(agent.fileState.has(resolvePath('/proj/a.js', '/proj')), false, 'a.js has to be read again before it is edited');
  assert.equal(agent.fileState.has(resolvePath('/proj/b.js', '/proj')), true);
  await agent.run('and again');
  assert.equal(replaced.length, 1, 'right after a turn there is nothing to clear');
});

test('clearing after a pause: not before 65 minutes, not for a sub-agent, not after an unfinished tool call with manual thinking, and only where it is on', () => {
  const idleAgent = (cfg, extra = {}, minutes = 66) => {
    const agent = makeAgent(cfg, extra);
    agent.messages = longConversation();
    agent.lastActivityAt = Date.now() - minutes * 60_000;
    return agent;
  };
  const on = idleClearing(makeConfig({}));
  assert.equal(idleAgent(on, {}, 64).clearAfterIdle(), null, 'the 1-hour cache may still be there');
  assert.equal(idleAgent(on, { isSubagent: true }).clearAfterIdle(), null);
  assert.equal(idleAgent(idleClearing(makeConfig({}), false)).clearAfterIdle(), null);
  const unknown = idleAgent(on);
  unknown.lastActivityAt = 0;
  assert.equal(unknown.clearAfterIdle(), null, 'no idea when the last message came');
  // the turn before stopped after a tool result (the next request failed, or was interrupted)
  const interrupted = (cfg) => {
    const agent = idleAgent(cfg);
    agent.messages.splice(-1, 1, { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'tx', name: 'Edit', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tx', content: 'The file has been updated successfully.' }] });
    return agent;
  };
  const adaptive = interrupted(on);
  assert.equal(adaptive.clearAfterIdle()?.results, 4, 'adaptive thinking: all thinking may go, the unfinished call\'s too (and that call moves the last 5 on by one)');
  assert.ok(adaptive.messages.every((m) => !Array.isArray(m.content) || m.content.every((b) => b.type !== 'thinking')));
  assert.equal(interrupted(idleClearing(makeConfig({ MAX_THINKING_TOKENS: '8000' }))).clearAfterIdle(), null, 'manual thinking: that message has to start with its thinking');
  assert.equal(idleAgent(on).clearAfterIdle()?.results, 3);
  const configWith = (env) => new Config(env, {}, { hooks: {}, mcpServers: {} }, process.cwd());
  assert.equal(configWith({ CLAUDE_PRO_PROVIDER: 'gateway' }).clearAfterIdle, true);
  assert.equal(configWith({}).clearAfterIdle, true);
  assert.equal(configWith({ CLAUDE_PRO_GATEWAY_URL: 'https://api.deepseek.com/anthropic' }).clearAfterIdle, true);
});

test('a resumed conversation knows when it last changed, so a pause before it counts', () => {
  const store = new SessionStore(tmp());
  const start = Date.now();
  store.message({ role: 'user', content: 'hello' });
  assert.ok(SessionStore.load(store.file).lastAt >= start);
  store.reset([{ role: 'user', content: 'summary' }]);
  const loaded = SessionStore.load(store.file);
  assert.ok(loaded.lastAt >= start, 'the time of a reset counts: its messages have none of their own');
  assert.deepEqual(loaded.times, [0]);
});
