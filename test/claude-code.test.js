import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config, loadConfig } from '../src/config.js';
import { getClient, buildParams, streamMessage, quickQuery, effortSupported } from '../src/api.js';
import { readClaudeCodeLogin, CLAUDE_CODE_SYSTEM } from '../src/claude-code.js';
import { Agent } from '../src/agent.js';
import { endpoint } from '../src/oauth.js';
import { ModeManager } from '../src/modes.js';
import { GlobTool } from '../src/tools/search.js';

endpoint.url = 'http://127.0.0.1:9/never-reached'; // no test may reach the real token endpoint

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-oauth-'));
  const configFile = path.join(dir, '.claude.json');
  const credentialsFile = path.join(dir, '.credentials.json');
  fs.writeFileSync(configFile, JSON.stringify({ userID: 'test-device', oauthAccount: { accountUuid: 'test-account' } }));
  fs.writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'test-oauth-token', expiresAt: Date.now() + 60000, scopes: ['user:inference'] } }));
  t.after(() => { fs.unlinkSync(configFile); fs.unlinkSync(credentialsFile); fs.rmdirSync(dir); });
  const cfg = new Config({
    CLAUDE_PRO_PROVIDER: 'claude-code', CLAUDE_PRO_CLAUDE_CONFIG_FILE: configFile,
    CLAUDE_PRO_CLAUDE_CREDENTIALS_FILE: credentialsFile, CLAUDE_PRO_CLAUDE_CODE_VERSION: '2.1.289',
    ANTHROPIC_API_KEY: 'wrong-api-key', ANTHROPIC_AUTH_TOKEN: 'wrong-bearer',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDE_PRO_MAX_RETRIES: '0',
    ANTHROPIC_MODEL: 'deepseek-flash[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
  }, {}, { hooks: {}, mcpServers: {} }, dir);
  return { dir, configFile, credentialsFile, cfg };
}

function sse(content, stopReason = 'end_turn') {
  const events = [
    { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 123, output_tokens: 0 } } },
    ...content.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } },
      { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

function mockFetch(t, handle) {
  const original = globalThis.fetch;
  globalThis.fetch = handle;
  t.after(() => { globalThis.fetch = original; });
}

test('subscription aliases resolve to Claude IDs independently of existing API configuration', () => {
  const cfg = new Config({ CLAUDE_PRO_PROVIDER: 'claude-code', ANTHROPIC_MODEL: 'deepseek-flash', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' }, {}, {}, process.cwd());
  assert.equal(cfg.mainModel.id, 'claude-sonnet-5-5');
  assert.equal(cfg.subagentModel.id, 'claude-sonnet-5-5');
  assert.equal(cfg.smallModel.id, 'claude-haiku-4-5-20251001');
  assert.equal(cfg.resolveModel('opus').id, 'claude-opus-5-5');
  assert.equal(cfg.mainModel.contextWindow, 1_000_000);
  const flags = loadConfig({ flags: { provider: 'claude-code', model: 'claude-sonnet-4-6' } });
  assert.equal(flags.mainModel.id, 'claude-sonnet-4-6');
  assert.equal(flags.sources.CLAUDE_PRO_CLAUDE_CODE_MODEL, '--model flag');
  assert.equal(new Config({ ANTHROPIC_MODEL: 'deepseek-flash' }, {}, {}, process.cwd()).provider, 'api');
});

test('direct HTTP uses the saved OAuth token, Claude Code headers and account metadata', async (t) => {
  const { cfg, credentialsFile, configFile } = fixture(t);
  const before = [fs.readFileSync(configFile, 'utf8'), fs.readFileSync(credentialsFile, 'utf8')];
  let count = 0;
  mockFetch(t, async (url, options) => {
    count++;
    assert.equal(new URL(url).origin, 'https://api.anthropic.com');
    assert.equal(new URL(url).pathname, '/v1/messages');
    assert.equal(new URL(url).searchParams.get('beta'), 'true');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-oauth-token');
    assert.equal(headers.get('x-api-key'), null);
    assert.equal(headers.get('x-app'), 'cli');
    assert.match(headers.get('anthropic-beta'), /oauth-2025-04-20/);
    assert.equal(headers.get('user-agent'), 'claude-cli/2.1.289 (external, cli)');
    const params = JSON.parse(options.body);
    assert.equal(params.system[0].text, CLAUDE_CODE_SYSTEM);
    assert.equal(params.system[1].text, 'Test system');
    const user = JSON.parse(params.metadata.user_id);
    assert.equal(user.device_id, 'test-device');
    assert.equal(user.account_uuid, 'test-account');
    assert.match(user.session_id, /^[0-9a-f-]{36}$/);
    return sse([{ type: 'text', text: 'pong' }]);
  });
  const events = [];
  const res = await streamMessage(cfg, { model: cfg.mainModel, system: 'Test system', messages: [{ role: 'user', content: 'ping' }] }, { onEvent: (ev) => events.push(ev.type) });
  assert.equal(count, 1);
  assert.equal(res.message.content[0].text, 'pong');
  assert.equal(res.usage.input_tokens, 123);
  assert.deepEqual(events, ['block_start', 'text', 'block_stop']);
  assert.deepEqual([fs.readFileSync(configFile, 'utf8'), fs.readFileSync(credentialsFile, 'utf8')], before);
});

test('credentials are reread when the native application replaces its token', (t) => {
  const { cfg, credentialsFile } = fixture(t);
  const login = readClaudeCodeLogin(cfg);
  const first = getClient(cfg, login);
  fs.writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'updated-token', expiresAt: Date.now() + 60000 } }));
  const updated = readClaudeCodeLogin(cfg);
  assert.equal(updated.accessToken, 'updated-token');
  assert.equal(updated.userId, login.userId);
  assert.notEqual(getClient(cfg, updated), first);
});

test('a 401 retries once with a token replaced by the native application', async (t) => {
  const { cfg, credentialsFile } = fixture(t);
  let calls = 0;
  mockFetch(t, async (url, options) => {
    calls++;
    const headers = new Headers(options.headers);
    if (calls === 1) {
      assert.equal(headers.get('authorization'), 'Bearer test-oauth-token');
      fs.writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'rotated-token', expiresAt: Date.now() + 60000 } }));
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Old token' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(headers.get('authorization'), 'Bearer rotated-token');
    return sse([{ type: 'text', text: 'pong' }]);
  });
  assert.equal(await quickQuery(cfg, { model: cfg.mainModel, system: 's', prompt: 'p' }), 'pong');
  assert.equal(calls, 2);
});

test('an unchanged invalid token does not cause a 401 retry loop', async (t) => {
  const { cfg } = fixture(t);
  let calls = 0;
  mockFetch(t, async () => {
    calls++;
    return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid token' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(quickQuery(cfg, { model: cfg.mainModel, system: 's', prompt: 'p' }), /Claude Code OAuth authentication failed/);
  assert.equal(calls, 1);
});

test('missing, malformed and expired credentials fail without exposing credential contents', (t) => {
  const { cfg, credentialsFile } = fixture(t);
  fs.writeFileSync(credentialsFile, '{ secret-token-must-not-be-in-errors');
  assert.throws(() => readClaudeCodeLogin(cfg), (err) => /Invalid JSON/.test(err.message) && !err.message.includes('secret-token-must-not-be-in-errors'));
  fs.writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'secret-token', expiresAt: 1 } }));
  assert.throws(() => readClaudeCodeLogin(cfg), (err) => /expired/.test(err.message) && !err.message.includes('secret-token'));
  fs.writeFileSync(credentialsFile, '{}');
  assert.throws(() => readClaudeCodeLogin(cfg), /No existing Claude Code subscription access token/);
});

test('subscription requests retain native tool calls, tool results and the existing Agent loop', async (t) => {
  const { cfg } = fixture(t);
  let turns = 0;
  mockFetch(t, async (url, options) => {
    const params = JSON.parse(options.body);
    assert.equal(params.tools[0].name, 'Glob');
    assert.equal(params.model, 'claude-sonnet-5-5');
    turns++;
    if (turns === 1) return sse([{ type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '*.none' } }], 'tool_use');
    const last = params.messages.at(-1);
    assert.equal(last.content[0].type, 'tool_result');
    assert.equal(last.content[0].tool_use_id, 't1');
    assert.equal(last.content[0].content, 'No files found');
    return sse([{ type: 'text', text: 'done' }]);
  });
  const agent = new Agent({ config: cfg, modes: new ModeManager(), tools: [GlobTool], systemPrompt: 's', io: {}, model: cfg.mainModel, cwd: cfg.cwd });
  const result = await agent.run('List files');
  assert.equal(result.text, 'done');
  assert.equal(turns, 2);
  assert.equal(agent.toolUseCount, 1);
});

test('API requests keep their original authentication and prompt format', () => {
  const cfg = new Config({ ANTHROPIC_AUTH_TOKEN: 'api-bearer', ANTHROPIC_MODEL: 'deepseek-flash' }, {}, {}, process.cwd());
  assert.equal(getClient(cfg).authToken, 'api-bearer');
  const params = buildParams(cfg, { model: cfg.mainModel, system: 's', messages: [{ role: 'user', content: 'p' }] });
  assert.equal(params.system.length, 1);
  assert.equal(params.system[0].text, 's');
  assert.equal(params.metadata, undefined);
});

test('live direct HTTP reuses the existing local subscription', { skip: !process.env.CLAUDE_PRO_LIVE_TEST }, async () => {
  const cfg = loadConfig({ flags: { provider: 'claude-code' } });
  const text = await quickQuery(cfg, { model: cfg.mainModel, system: 'Reply with exactly pong.', prompt: 'ping', maxTokens: 64 });
  assert.equal(text, 'pong');
});

test('a model that does not take an effort level is retried without it, and remembered', async (t) => {
  const { cfg } = fixture(t);
  cfg.effortOverride = 'high';
  const seen = [];
  mockFetch(t, async (url, options) => {
    const params = JSON.parse(options.body);
    seen.push(params.output_config?.effort ?? null);
    if (params.output_config) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'This model does not support the effort parameter.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    return sse([{ type: 'text', text: 'fine' }]);
  });
  const model = cfg.resolveModel('claude-haiku-4-5-20251001');
  const ask = () => streamMessage(cfg, { model, system: 's', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((await ask()).message.content[0].text, 'fine');
  assert.deepEqual(seen, ['high', null], 'retried at once without it');
  assert.equal(effortSupported(model.id), false);
  await ask();
  assert.deepEqual(seen, ['high', null, null], 'and not asked again');
  assert.equal(effortSupported(cfg.mainModel.id), true, 'other models keep theirs');
});
