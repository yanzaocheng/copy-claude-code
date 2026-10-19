import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-providers-'));
process.env.CLAUDE_PRO_CONFIG_DIR = path.join(tmp, 'config');

const { Config } = await import('../src/config.js');
const { streamMessage, buildParams } = await import('../src/api.js');
const { saveGatewayLogin, clearGatewayLogin } = await import('../src/gateway.js');
const { makeTaskTool } = await import('../src/tools/task.js');

const config = (env = {}) => new Config({ CLAUDE_PRO_MAX_RETRIES: '0', ...env }, {}, { hooks: {}, mcpServers: {} }, tmp);

test('gateway is the only provider and supplies model defaults', () => {
  const gw = config({ CLAUDE_PRO_PROVIDER: 'gateway' });
  assert.equal(gw.provider, 'gateway');
  assert.equal(gw.model.id, 'claude-opus-5-5');
  assert.equal(gw.model.contextWindow, 1_000_000);
  assert.equal(gw.subagentModel, undefined, 'there is no separate sub-agent model');
  assert.equal(gw.smallModel, undefined, 'there is no separate small model');
  assert.equal(gw.maxOutputTokens, 48_000);
  assert.throws(() => config({ CLAUDE_PRO_PROVIDER: 'api' }).provider, /Only the gateway provider is supported/);
  assert.throws(() => config({ CLAUDE_PRO_PROVIDER: 'claude-code' }).provider, /Only the gateway provider is supported/);
  assert.throws(() => config({ CLAUDE_PRO_PROVIDER: 'codex' }).provider, /Only the gateway provider is supported/);
});

test('gateway Task tool uses the selected model and exposes effort as the only task-level choice', () => {
  const agents = new Map([['general-purpose', { name: 'general-purpose', description: 'd', tools: '*', prompt: 'p' }]]);
  const tool = makeTaskTool(agents);
  const text = tool.description();
  assert.match(text, /Every agent uses the model currently selected for this session/);
  assert.doesNotMatch(text, /smaller model|Choosing the model|haiku \(claude-/);
  assert.equal(tool.input_schema.properties.model, undefined);
  assert.ok(tool.input_schema.properties.effort);
  assert.equal(tool.summarize({ description: 'probe', model: 'haiku', effort: 'high' }), 'probe (effort high)');
});

test('gateway requests use the saved gateway key and contain only the custom system block', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/messages') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const params = JSON.parse(body);
        assert.equal(params.system.length, 1);
        assert.equal(params.system[0].text, 'custom system');
        assert.equal(req.headers.authorization, 'Bearer gateway-test-key');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const ev of [
          { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); clearGatewayLogin(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  saveGatewayLogin({ url, apiKey: 'gateway-test-key', account: {} });
  const cfg = config({ CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_URL: url });
  const res = await streamMessage(cfg, { model: cfg.model, system: 'custom system', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.message.content[0].text, 'pong');
  assert.equal(buildParams(cfg, { model: cfg.model, system: 's', messages: [] }).system.length, 1);
});
