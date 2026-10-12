// The gateway and codex providers: configuration, the gateway's browser login, and the Codex translation with
// its token renewal. Nothing here reaches a real server, the real ~/.claude-pro or the real ~/.codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-providers-'));
const codexHome = path.join(tmp, 'codex');
fs.mkdirSync(codexHome, { recursive: true });
process.env.CLAUDE_PRO_CONFIG_DIR = path.join(tmp, 'config');
process.env.CODEX_HOME = codexHome;

const { Config } = await import('../src/config.js');
const { streamMessage, buildParams } = await import('../src/api.js');
const { loginWithBrowser, readGatewayLogin, gatewayLoginFile, clearGatewayLogin, fetchGatewayModels } = await import('../src/gateway.js');
const { createCodexFetch } = await import('../src/codex/client.js');
const { makeTaskTool } = await import('../src/tools/task.js');

const jwt = (payload) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'plus' } };
const config = (env) => new Config({ CODEX_HOME: codexHome, CLAUDE_PRO_MAX_RETRIES: '0', ...env }, {}, { hooks: {}, mcpServers: {} }, tmp);

fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
  client_version: '0.162.1',
  models: [{ slug: 'gpt-6.1-sol', visibility: 'list', context_window: 272000, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }] }],
}));

test('gateway and codex providers: models, windows, sub-agent and output defaults', () => {
  const gw = config({ CLAUDE_PRO_PROVIDER: 'gateway' });
  assert.equal(gw.mainModel.id, 'claude-opus-5-5');
  assert.equal(gw.mainModel.contextWindow, 1_000_000);
  assert.equal(gw.subagentModel.id, 'claude-opus-5-5', 'a sub-agent given no model runs on the main model');
  assert.equal(gw.subagentModelChosen, true);
  assert.equal(gw.smallModel.id, 'claude-haiku-5-5');
  assert.equal(gw.maxOutputTokens, 48_000, 'a smaller balance hold per request');
  assert.equal(gw.gatewayUrl, 'https://gw.predix.icu');
  const gpt = config({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_MODEL: 'gpt-6.1-sol' });
  assert.deepEqual([gpt.mainModel.id, gpt.mainModel.contextWindow, gpt.subagentModel.id], ['gpt-6.1-sol', 272_000, 'gpt-6.1-sol']);
  assert.equal(gpt.subagentModelChosen, false, 'a GPT main model keeps its own');
  assert.deepEqual(buildParams(gpt, { model: gpt.mainModel, system: 's', messages: [{ role: 'user', content: 'x' }] }).output_config, { effort: 'low' }, 'the model default is sent');
  const effortOf = (env) => { const c = config(env); return buildParams(c, { model: c.mainModel, system: 's', messages: [{ role: 'user', content: 'x' }] }).output_config?.effort; };
  assert.equal(effortOf({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_MODEL: 'gpt-6.1-sol', CLAUDE_CODE_EFFORT_LEVEL: 'none' }), 'low', 'a level the GPT model does not take goes out as the nearest one');
  assert.equal(effortOf({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_CODE_EFFORT_LEVEL: 'ultra' }), 'max', 'ultra, chosen on a GPT model, is max on Claude');
  assert.equal(effortOf({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_CODE_EFFORT_LEVEL: 'high' }), 'high');
  assert.equal(effortOf({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_CODE_EFFORT_LEVEL: 'none' }), 'low', 'Claude takes low … max, not OpenAI\'s none');
  assert.equal(effortOf({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' }), 'xhigh');

  const cx = config({ CLAUDE_PRO_PROVIDER: 'codex' });
  assert.equal(cx.mainModel.id, 'gpt-6.1-sol');
  assert.equal(cx.subagentModel.id, 'gpt-6.1-sol');
  assert.match(cx.endpointLabel, /chatgpt\.com/);
  assert.throws(() => config({ CLAUDE_PRO_PROVIDER: 'nope' }).provider, /api, claude-code, gateway, codex/);
});

test('gateway: the Task tool tells the main agent to choose each sub-agent\'s model by the task', () => {
  const agents = new Map([['general-purpose', { name: 'general-purpose', description: 'd', tools: '*', prompt: 'p' }]]);
  const gw = config({ CLAUDE_PRO_PROVIDER: 'gateway' });
  const text = makeTaskTool(agents, gw).description();
  assert.match(text, /Choosing the model: there is no fixed sub-agent model/);
  assert.match(text, /- haiku \(claude-haiku-5-5, \$0\.1\/\$0\.5 per million/);
  assert.match(text, /- sonnet \(claude-sonnet-5-5, \$2\/\$10 per million/);
  assert.match(text, /- opus \(claude-opus-5-5, your own model, \$4\/\$20 per million/);
  assert.match(text, /else on claude-opus-5-5\.$/);
  gw.modelOverride = 'sonnet'; // /model: the text follows it
  assert.match(makeTaskTool(agents, gw).description(), /- sonnet \(claude-sonnet-5-5, your own model/);
  for (const other of [config({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_MODEL: 'gpt-6.1-sol' }), config({ CLAUDE_PRO_PROVIDER: 'codex' }), null]) {
    assert.doesNotMatch(makeTaskTool(agents, other).description(), /Choosing the model/);
  }
});

test('thinking made from Codex reasoning (cgw1:) goes to the Codex backend only; the session keeps it', () => {
  const codexThinking = { type: 'thinking', thinking: '**Planning**', signature: 'cgw1:gAAAAB-enc' };
  const claudeThinking = { type: 'thinking', thinking: 'hmm', signature: 'EqQBCkYIBxgCKkA-anthropic' };
  const history = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [codexThinking, { type: 'text', text: 'b' }] },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: [codexThinking] },
    { role: 'user', content: 'd' },
    { role: 'assistant', content: [claudeThinking, { type: 'text', text: 'e' }] },
    { role: 'user', content: 'f' },
  ];
  const replies = (params) => params.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  const send = (cfg, messages) => buildParams(cfg, { model: cfg.mainModel, system: 's', messages });

  const claude = config({ CLAUDE_PRO_PROVIDER: 'gateway', MAX_THINKING_TOKENS: '4000' });
  const toClaude = send(claude, history);
  assert.deepEqual(replies(toClaude), [[{ type: 'text', text: 'b' }], [claudeThinking, { type: 'text', text: 'e' }]], 'Codex thinking left out, Claude\'s kept');
  assert.equal(toClaude.thinking.type, 'enabled', 'a new prompt thinks as configured');
  assert.deepEqual(history[1].content, [codexThinking, { type: 'text', text: 'b' }], 'the session is not changed');
  const direct = config({ CLAUDE_PRO_PROVIDER: 'claude-code' });
  assert.equal(JSON.stringify(buildParams(direct, { model: direct.mainModel, system: 's', messages: history }, { accessToken: 'x', userId: '{}', version: '2.1.289' })).includes('cgw1:'), false);

  const gpt = config({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_MODEL: 'gpt-6.1-sol' });
  assert.deepEqual(replies(send(gpt, history))[0], [codexThinking, { type: 'text', text: 'b' }], 'a GPT model replays it');
  assert.deepEqual(replies(send(config({ CLAUDE_PRO_PROVIDER: 'codex' }), history))[1], [codexThinking]);

  // A tool loop begun by a GPT model and carried on by Claude: `thinking` left out until the next prompt ("disabled"
  // is refused by Opus 5.5, Fable and Sonnet 5.5; left out, they think adaptively and older models do not think).
  const loop = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [codexThinking, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ];
  const first = send(claude, loop);
  assert.deepEqual(first.messages[1].content, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]);
  assert.equal(first.thinking, undefined);
  const carried = [...loop, { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }];
  assert.equal(send(claude, carried).thinking, undefined, 'Claude\'s own steps in that loop have no thinking budget either');
  // An interrupted GPT tool loop, then new prompts: they merge into the tool_result message, so the loop goes on.
  const opus = config({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_MODEL: 'claude-opus-5-5', MAX_THINKING_TOKENS: '0' });
  const resumed = [loop[0], loop[1], { role: 'user', content: [...loop[2].content, { type: 'text', text: '[Request interrupted by user]' }, { type: 'text', text: '继续' }] }];
  assert.equal(send(opus, resumed).thinking, undefined);
  const next = [...carried, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, { role: 'user', content: 'next' }];
  assert.equal(send(claude, next).thinking.type, 'enabled');
});

test('gateway login: browser round trip, code exchange, key saved privately; requests use it', async (t) => {
  const seen = [];
  const bodies = [];
  const sessions = []; // the X-Claude-Code-Session-Id of each /v1/messages request
  const gateway = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push(`${req.method} ${req.url.split('?')[0]} ${req.headers.authorization || ''}`);
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
        { id: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], default_reasoning_level: 'high' },
        { id: 'gpt-6-luna', display_name: 'GPT-6 Luna', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'], default_reasoning_level: 'medium' },
      ] }));
      return;
    }
    if (req.url.startsWith('/v1/messages')) {
      bodies.push(JSON.parse(body));
      sessions.push(req.headers['x-claude-code-session-id'] ?? null);
    }
    if (req.url === '/cli/token') {
      const { code, state } = JSON.parse(body);
      const ok = code === 'cli_code_1' && state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { api_key: 'gw_live_test', key: {}, account: { id: 'u1', name: 'Tester', email: 't@example.com', available_usd: 3 } } : { error: { message: 'bad code' } }));
      return;
    }
    if (req.url.startsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const ev of [
        { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      res.end();
      return;
    }
    if (req.url === '/v1/account') { res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'Insufficient gateway balance.' } })); return; }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => { gateway.close(); clearGatewayLogin(); });
  const url = `http://127.0.0.1:${gateway.address().port}`;

  let opened = null;
  const login = await loginWithBrowser({
    url,
    open: async (page) => {
      opened = new URL(page);
      // A wrong state is refused by the local callback and does not end the login.
      assert.equal((await fetch(`http://127.0.0.1:${opened.searchParams.get('port')}/callback?code=x&state=wrong`)).status, 400);
      const res = await fetch(`http://127.0.0.1:${opened.searchParams.get('port')}/callback?code=cli_code_1&state=${opened.searchParams.get('state')}`);
      assert.equal(res.status, 200);
    },
  });
  assert.equal(opened.pathname, '/cli/login');
  assert.equal(opened.searchParams.get('client'), 'claude-pro');
  assert.equal(login.apiKey, 'gw_live_test');
  assert.equal(readGatewayLogin(url).account.email, 't@example.com');
  assert.equal(readGatewayLogin('https://other.example'), null, 'a key belongs to its gateway');
  if (process.platform !== 'win32') assert.equal(fs.statSync(gatewayLoginFile()).mode & 0o077, 0, 'only the user can read it');

  const cfg = config({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_URL: url });
  const res = await streamMessage(cfg, { model: cfg.mainModel, system: 's', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.message.content[0].text, 'hi');
  assert.ok(seen.includes('POST /v1/messages Bearer gw_live_test'), seen.join('\n'));
  assert.equal(sessions.at(-1), null, 'no session, no header');
  // The conversation's id names it to the gateway, which keeps it on the upstream account that has its cache.
  cfg.sessionId = 'session-1';
  await streamMessage(cfg, { model: cfg.mainModel, system: 's', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(sessions.at(-1), 'session-1');

  // Two GPT conversations use the gateway's per-model metadata, not the local Codex cache or each other's context.
  const sol = config({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_URL: url, CLAUDE_PRO_GATEWAY_MODEL: 'gpt-6.1-sol', CLAUDE_CODE_EFFORT_LEVEL: 'ultra' });
  await streamMessage(sol, { model: sol.mainModel, system: 'sol context', messages: [{ role: 'user', content: 'sol question' }] });
  assert.deepEqual(bodies.at(-1).output_config, { effort: 'max' }, 'unsupported ultra is clamped to the gateway model maximum');
  assert.equal(bodies.at(-1).model, 'gpt-6.1-sol');
  assert.equal(bodies.at(-1).system[0].text, 'sol context');
  assert.equal(bodies.at(-1).messages.at(-1).content.at(-1).text, 'sol question');
  const luna = config({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_URL: url, CLAUDE_PRO_GATEWAY_MODEL: 'gpt-6-luna' });
  await streamMessage(luna, { model: luna.mainModel, system: 'luna context', messages: [{ role: 'user', content: 'luna question' }] });
  assert.deepEqual(bodies.at(-1).output_config, { effort: 'medium' }, 'the second model gets its own gateway default');
  assert.equal(bodies.at(-1).model, 'gpt-6-luna');
  assert.equal(bodies.at(-1).system[0].text, 'luna context');
  assert.equal(bodies.at(-1).messages.at(-1).content.at(-1).text, 'luna question');
  assert.equal(seen.filter((line) => line.startsWith('GET /v1/models')).length, 1, 'metadata is cached per gateway login, not fetched per conversation');

  // A /v1/models that fails is not asked again on every request.
  let asked = 0;
  const failing = async () => { asked++; return new Response('{}', { status: 500 }); };
  const other = { url: 'https://models-fail.example', apiKey: 'k' };
  await assert.rejects(fetchGatewayModels(other, { fetchImpl: failing }));
  await assert.rejects(fetchGatewayModels(other, { fetchImpl: failing }));
  assert.equal(asked, 1);

  clearGatewayLogin();
  await assert.rejects(streamMessage(cfg, { model: cfg.mainModel, system: 's', messages: [{ role: 'user', content: 'x' }] }), /Not logged in to the gateway .*\/login/);
});

test('codex fetch: Anthropic request in, Responses request out, SSE translated back; a 401 renews the token and writes it back', async () => {
  const authFile = path.join(codexHome, 'auth.json');
  const stale = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims, n: 1 });
  const fresh = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims, n: 2 });
  fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: stale, id_token: jwt(claims), refresh_token: 'rt_1', account_id: 'acct_1' } }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    if (url.includes('oauth/token')) {
      assert.equal(body.refresh_token, 'rt_1');
      return new Response(JSON.stringify({ access_token: fresh, refresh_token: 'rt_2' }), { status: 200 });
    }
    if (init.headers.authorization === `Bearer ${stale}`) return new Response('{"detail":"Unauthorized"}', { status: 401 });
    const events = [
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'Read', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc1', delta: '{"file_path":"a.txt"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.txt"}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 20 } } },
    ];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const cfg = config({ CLAUDE_PRO_PROVIDER: 'codex' });
  const codexFetch = createCodexFetch({ env: { CODEX_HOME: codexHome }, fetchImpl, sessionId: 'sess-1' });
  const anth = buildParams(cfg, {
    model: cfg.mainModel, system: 'You are a coding agent.', effort: 'max',
    messages: [{ role: 'user', content: 'read a.txt' }],
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
  });
  const res = await codexFetch('https://codex.invalid/v1/messages?beta=true', { method: 'POST', body: JSON.stringify(anth) });
  assert.equal(res.status, 200);
  const sse = await res.text();
  assert.match(sse, /"type":"tool_use","id":"call_1","name":"Read"/);
  assert.match(sse, /"cache_read_input_tokens":800/);
  const upstream = calls.filter((c) => c.url.includes('/codex/responses'));
  assert.equal(upstream.length, 2, 'refused once, then sent again with the renewed token');
  assert.equal(upstream[1].headers['chatgpt-account-id'], 'acct_1');
  assert.equal(upstream[1].headers.version, '0.162.1');
  assert.equal(upstream[1].body.model, 'gpt-6.1-sol');
  assert.deepEqual(upstream[1].body.reasoning, { effort: 'max', summary: 'auto' });
  assert.equal(upstream[1].body.prompt_cache_key, 'sess-1');
  assert.equal(upstream[1].body.instructions, 'You are a coding agent.');
  assert.equal(upstream[1].body.tools[0].name, 'Read');
  const saved = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  assert.equal(saved.tokens.access_token, fresh);
  assert.equal(saved.tokens.refresh_token, 'rt_2');

  // A usage limit becomes a rate limit with the reset time, which the program waits for.
  const limited = createCodexFetch({ env: { CODEX_HOME: codexHome }, fetchImpl: async () => new Response(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 120 } }), { status: 429 }) });
  const r = await limited('https://codex.invalid/v1/messages', { method: 'POST', body: JSON.stringify(anth) });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '120');
  assert.equal((await r.json()).error.type, 'rate_limit_error');
});
