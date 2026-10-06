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

const { Config, loadConfig, KNOWN_KEYS } = await import('../src/config.js');
const { buildParams, streamMessage } = await import('../src/api.js');
const { CLAUDE_CODE_SYSTEM } = await import('../src/claude-code.js');
const { CacheStats, cacheControl, cachePlanOf, fingerprint, normalizeTtl } = await import('../src/cache.js');
const { Agent } = await import('../src/agent.js');
const { ModeManager } = await import('../src/modes.js');
const { SUMMARY_SYSTEM, subagentSystemPrompt } = await import('../src/prompts.js');
const { environmentBlock, takeEnvSnapshot } = await import('../src/context.js');
const { SessionStore } = await import('../src/session.js');
const { createRuntime } = await import('../src/runtime.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-cache-'));
let port = 20_000; // every test talks to an "endpoint" of its own: what an endpoint refuses is remembered per endpoint
const makeConfig = (env = {}) => new Config({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port++}`, ANTHROPIC_AUTH_TOKEN: 'test-token', ANTHROPIC_MODEL: 'mock', ...env }, {}, { hooks: {}, mcpServers: {} }, process.cwd());
const tool = (name) => ({ name, description: `the ${name} tool`, input_schema: { type: 'object', properties: {} } });
const tools = [tool('Alpha'), tool('Beta'), tool('Gamma')];

function mockFetch(t, handle) {
  const original = globalThis.fetch;
  globalThis.fetch = handle;
  t.after(() => { globalThis.fetch = original; });
}

const sse = (events) => new Response(events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
// A reply: text (or a tool call), with the usage the API would report.
function replyWith({ text = 'ok', toolUse = null, usage = {} } = {}) {
  return sse([
    { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 10, output_tokens: 0, ...usage } } },
    ...(toolUse
      ? [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: toolUse, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 },
      ]
      : [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
      ]),
    { type: 'message_delta', delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}
const rejected = (message) => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), { status: 400, headers: { 'content-type': 'application/json' } });
const bodyOf = (init) => JSON.parse(init.body);
const request = (cfg, extra = {}) => ({ model: cfg.mainModel, system: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools, ...extra });

// ---------------------------------------------------------------------------------------------- TTL and switches

test('cache TTL follows Claude Code: FORCE 5m, the bucket\'s own value, ENABLE 1h, then 5 minutes', () => {
  const ttl = (env, bucket) => makeConfig(env).cacheTtl(bucket);
  assert.equal(ttl({}, 'main'), '5m');
  assert.equal(ttl({}, 'other'), '5m');
  assert.equal(ttl({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, 'main'), '1h');
  assert.equal(ttl({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, 'other'), '5m', 'the two buckets are separate');
  assert.equal(ttl({ CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1H' }, 'other'), '1h');
  assert.equal(ttl({ CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, 'main'), '5m');
  assert.equal(ttl({ ENABLE_PROMPT_CACHING_1H: '1' }, 'main'), '1h');
  assert.equal(ttl({ ENABLE_PROMPT_CACHING_1H: '1' }, 'other'), '1h');
  assert.equal(ttl({ ENABLE_PROMPT_CACHING_1H: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, 'main'), '5m', 'a bucket\'s own value wins over ENABLE');
  assert.equal(ttl({ ENABLE_PROMPT_CACHING_1H: '1', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' }, 'other'), '5m');
  assert.equal(ttl({ FORCE_PROMPT_CACHING_5M: '1', ENABLE_PROMPT_CACHING_1H: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, 'main'), '5m', 'FORCE wins over everything');
  assert.equal(ttl({ FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, 'other'), '5m');
  assert.equal(ttl({ CLAUDE_CODE_PROMPT_CACHE_TTL: '30m' }, 'main'), '5m', 'any other value is ignored');
  assert.equal(ttl({ CLAUDE_CODE_PROMPT_CACHE_TTL: '30m', ENABLE_PROMPT_CACHING_1H: 'true' }, 'main'), '1h', '... and then the next rule applies');
  assert.equal(normalizeTtl(' 1H '), '1h');
  assert.equal(normalizeTtl('2h'), null);
  assert.equal(normalizeTtl(undefined), null);
  for (const key of ['CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'ENABLE_PROMPT_CACHING_1H', 'FORCE_PROMPT_CACHING_5M', 'DISABLE_PROMPT_CACHING', 'DISABLE_PROMPT_CACHING_HAIKU', 'DISABLE_PROMPT_CACHING_SONNET', 'DISABLE_PROMPT_CACHING_OPUS', 'DISABLE_PROMPT_CACHING_FABLE']) {
    assert.ok(key in KNOWN_KEYS, `${key} is a known key (so it is read from the shell environment and shown by /config)`);
  }
});

test('the TTL settings promptCacheTtl and subagentPromptCacheTtl work like the variables, which win over them', () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, '.claude-pro'));
  const file = path.join(cwd, '.claude-pro', 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' }));
  let cfg = loadConfig({ cwd });
  assert.equal(cfg.cacheTtl('main'), '1h');
  assert.equal(cfg.cacheTtl('other'), '1h');
  assert.match(cfg.sources.CLAUDE_CODE_PROMPT_CACHE_TTL, /promptCacheTtl/);
  fs.writeFileSync(file, JSON.stringify({ promptCacheTtl: '1h', env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } }));
  cfg = loadConfig({ cwd });
  assert.equal(cfg.cacheTtl('main'), '5m', 'the variable in "env" wins over the setting');
  assert.equal(cfg.cacheTtl('other'), '5m');
});

test('DISABLE_PROMPT_CACHING turns it off everywhere; the per-model variables only for the model their alias is', () => {
  const off = (env, id) => makeConfig(env).promptCachingDisabled(id);
  assert.equal(off({}, 'mock'), false);
  assert.equal(off({ DISABLE_PROMPT_CACHING: '1' }, 'mock'), true);
  assert.equal(off({ DISABLE_PROMPT_CACHING: '0' }, 'mock'), false);
  const env = { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small-one', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mid-one', ANTHROPIC_DEFAULT_OPUS_MODEL: 'big-one' };
  assert.equal(off({ ...env, DISABLE_PROMPT_CACHING_HAIKU: '1' }, 'small-one'), true);
  assert.equal(off({ ...env, DISABLE_PROMPT_CACHING_HAIKU: '1' }, 'mid-one'), false);
  assert.equal(off({ ...env, DISABLE_PROMPT_CACHING_SONNET: '1' }, 'mid-one'), true);
  assert.equal(off({ ...env, DISABLE_PROMPT_CACHING_OPUS: '1' }, 'big-one'), true);
  assert.equal(off({ ...env, DISABLE_PROMPT_CACHING_OPUS: '1' }, 'big-two'), false, 'another version pinned as the model keeps caching');
  assert.equal(off({ DISABLE_PROMPT_CACHING_FABLE: '1' }, 'claude-fable-5-1'), true);
  assert.equal(off({ DISABLE_PROMPT_CACHING_FABLE: '1' }, 'claude-opus-5-5'), false);
  assert.equal(off({ ANTHROPIC_SMALL_FAST_MODEL: 'old-small', DISABLE_PROMPT_CACHING_HAIKU: '1' }, 'old-small'), true, 'the deprecated small model variable still names the haiku model');
});

// ---------------------------------------------------------------------------------------------- the request

test('a request marks the last tool, the system prompt and the newest message; a 5-minute TTL sends no ttl field', () => {
  const cfg = makeConfig();
  const params = buildParams(cfg, request(cfg));
  assert.deepEqual(params.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(params.tools.map((t) => t.cache_control), [undefined, undefined, { type: 'ephemeral' }]);
  assert.deepEqual(params.messages[0].content, [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(cachePlanOf(params), { caching: true, ttl: '5m' });
  assert.equal(JSON.stringify(params).includes('"ttl"'), false);
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
  const haiku = makeConfig({ DISABLE_PROMPT_CACHING_HAIKU: '1', ANTHROPIC_MODEL: 'haiku' });
  assert.equal(JSON.stringify(buildParams(haiku, request(haiku))).includes('cache_control'), false);
  const sonnet = makeConfig({ DISABLE_PROMPT_CACHING_HAIKU: '1', ANTHROPIC_MODEL: 'sonnet' });
  assert.equal(JSON.stringify(buildParams(sonnet, request(sonnet))).includes('cache_control'), true);
});

test('a message list that ends with an assistant message, or is empty, gets no message marker', () => {
  const cfg = makeConfig();
  const params = buildParams(cfg, request(cfg, { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }] }));
  assert.equal(JSON.stringify(params.messages).includes('cache_control'), false);
  assert.deepEqual(buildParams(cfg, request(cfg, { messages: [] })).messages, []);
});

test('with the subscription login the Claude Code system line goes first and is never marked', () => {
  const cfg = makeConfig({ CLAUDE_PRO_PROVIDER: 'claude-code', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
  const login = { accessToken: 'x', userId: '{}', version: '2.1.289' };
  const params = buildParams(cfg, request(cfg), login);
  assert.equal(params.system[0].text, CLAUDE_CODE_SYSTEM);
  assert.equal(params.system[0].cache_control, undefined);
  assert.deepEqual(params.system[1].cache_control, { type: 'ephemeral', ttl: '1h' });
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
  assert.deepEqual(bodies[1].tools.at(-1).cache_control, { type: 'ephemeral' }, 'and left where it was not');
  assert.deepEqual(bodies[1].messages[0].content[0].cache_control, { type: 'ephemeral' });
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

test('an endpoint that refuses cache_control without saying where gets none at all; other 400s are not swallowed', async (t) => {
  const bodies = [];
  let message = 'cache_control is not supported by this gateway';
  mockFetch(t, async (url, init) => {
    bodies.push(bodyOf(init));
    return init.body.includes('cache_control') ? rejected(message) : replyWith();
  });
  const cfg = makeConfig();
  await streamMessage(cfg, request(cfg));
  assert.equal(bodies.length, 2);
  assert.equal(JSON.stringify(bodies[1]).includes('cache_control'), false);
  await streamMessage(cfg, request(cfg));
  assert.equal(bodies.length, 3);
  assert.equal(JSON.stringify(bodies[2]).includes('cache_control'), false, 'and none is sent later');

  // an error that has nothing to do with caching reaches the caller as it is
  const plain = makeConfig();
  mockFetch(t, async () => rejected('messages: roles must alternate'));
  await assert.rejects(() => streamMessage(plain, request(plain)), (err) => err.status === 400 && /roles must alternate/.test(err.message));
  // and a gateway that keeps complaining about cache_control ends in an error, not in a loop
  let calls = 0;
  const stubborn = makeConfig();
  mockFetch(t, async () => { calls++; return rejected('cache_control: nope'); });
  await assert.rejects(() => streamMessage(stubborn, request(stubborn)), /cache_control/);
  assert.ok(calls <= 3, `gave up after ${calls} requests`);
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
  return new Agent({ config: cfg, modes: new ModeManager(), tools, systemPrompt, io, model: cfg.mainModel, cwd: process.cwd(), ...rest });
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
  assert.deepEqual(JSON.stringify(compaction.tools), JSON.stringify(turn.tools), 'the same tools, marker included');
  assert.deepEqual(compaction.output_config, { effort: 'high' }, 'the same effort');
  assert.deepEqual(compaction.output_config, turn.output_config);
  assert.equal(compaction.model, turn.model);
  // the history is a continuation of the turn's request, and the instruction comes last
  assert.deepEqual(compaction.messages[0].content.map((b) => b.text), ['hello']);
  assert.equal(compaction.messages[1].role, 'assistant');
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

test('the summary request misses on purpose only when the shared one fails: an empty answer, or a prompt that is too long', async (t) => {
  const run = async (first) => {
    const bodies = [];
    mockFetch(t, async (url, init) => {
      bodies.push(bodyOf(init));
      return bodies.length === 1 ? first() : replyWith({ text: '<summary>PLAIN</summary>', usage: usageOf(0, 100) });
    });
    const cfg = makeConfig({ CLAUDE_CODE_EFFORT_LEVEL: 'high' });
    const agent = makeAgent(cfg);
    agent.messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }];
    const summary = await agent.compact();
    return { bodies, summary, agent };
  };
  // the model keeps calling tools instead of writing the summary
  let r = await run(() => replyWith({ toolUse: 'Alpha' }));
  assert.equal(r.summary, 'PLAIN');
  assert.equal(r.bodies.length, 2);
  assert.equal(r.bodies[0].system[0].text, 'MAIN SYSTEM');
  assert.equal(r.bodies[1].system[0].text, SUMMARY_SYSTEM, 'then the plain request');
  assert.equal(r.bodies[1].output_config, undefined);
  assert.equal(r.agent.usage.compactions, 2, 'both were billed');
  assert.equal(r.agent.cache.misses, 0, 'the one that was made to miss is not reported as a miss');
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
  // an empty summary from the plain request too is the error it always was
  mockFetch(t, async () => replyWith({ text: '   ' }));
  const empty = makeAgent(makeConfig());
  empty.messages = [{ role: 'user', content: 'hello' }];
  await assert.rejects(() => empty.compact(), /empty summary/);
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
  const answers = [usageOf(0, 30_000), usageOf(30_000, 500), usageOf(0, 31_000)];
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
  // a new conversation starts without expecting anything from the cache
  agent.resetConversation();
  assert.ok(!agent.cache.isWarm());
  // sub-agents' usage is the main agent's to report
  agent.addSubUsage({ input: 100, output: 20, cacheRead: 5000, cacheWrite: 700, cacheWrite1h: 0, requests: 4, compactions: 1 });
  const total = agent.totalUsage();
  assert.equal(total.requests, 7);
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

test('sub-agents share one snapshot of the date and git state, while the git state itself moves on', () => {
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

async function runtimeIn(cwd, env = {}) {
  Object.assign(process.env, { CLAUDE_PRO_PROVIDER: 'api', ANTHROPIC_AUTH_TOKEN: 'test-token', ANTHROPIC_MODEL: 'mock', CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1', CLAUDE_PRO_RIPGREP_PATH: 'off', ...env });
  const runtime = await createRuntime({ cwd, flags: { noMcp: true }, io: {} });
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
  assert.equal(rt.resumeSystemPrompt(saved), true);
  assert.equal(rt.systemPrompt(), saved, 'the saved prompt, not a freshly built one');
  assert.equal(rt.agent.reminders.length, 1);
  assert.match(rt.agent.reminders[0], /2020-01-02/);
  assert.match(rt.agent.reminders[0], /out of date/);
  // the same day: nothing to add
  const rt2 = await runtimeIn(tmp());
  const today = rt2.systemPrompt();
  rt2.invalidateSystemPrompt();
  assert.equal(rt2.resumeSystemPrompt(today), true);
  assert.equal(rt2.agent.reminders.length, 0);
  // a prompt that was built for another model is not used: the model's cache is its own, and the prompt names it
  rt2.invalidateSystemPrompt();
  assert.equal(rt2.resumeSystemPrompt(today.replace('You are powered by the model mock.', 'You are powered by the model another.')), false);
  assert.equal(rt2.systemPrompt(), today, 'a fresh one is built instead');
  // nothing saved, or garbage
  assert.equal(rt2.resumeSystemPrompt(null), false);
  assert.equal(rt2.resumeSystemPrompt('  '), false);
  rt.mcp.close();
  rt2.mcp.close();
});
