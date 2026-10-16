import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpManager } from '../src/mcp.js';
import { mainSystemPrompt, subagentSystemPrompt } from '../src/prompts.js';
import { isAbort } from '../src/api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'mcp-echo-server.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stdioServer(t, extraEnv = {}) {
  const mgr = new McpManager({ echo: { command: 'node', args: [fixture], env: extraEnv } }, { cwd: here });
  await mgr.start();
  t.after(() => mgr.close());
  const tool = (name) => mgr.tools().find((x) => x.name === `mcp__echo__${name}`);
  return { mgr, tool };
}

test('initialize instructions are available as compact server guidance', async (t) => {
  const { mgr } = await stdioServer(t);
  const guidance = mgr.promptInstructions();
  assert.match(guidance, /^# MCP server guidance/);
  assert.match(guidance, /## echo/);
  assert.match(guidance, /Available tools: echo, add, hang/);
  assert.match(guidance, /Use echo for reversible text checks/);
  assert.match(guidance, /does not override the system, user, or project instructions/);
});

test('server guidance can be attached to main and sub-agent prompts', () => {
  const guidance = '# MCP server guidance\\n\\n## echo\\nUse echo for reversible text checks.';
  const base = { cwd: here, model: { id: 'mock' }, shellName: 'bash', snapshot: { date: '2026-01-01', git: null }, mcpInstructions: guidance };
  assert.match(mainSystemPrompt(base), /Use echo for reversible text checks/);
  assert.match(subagentSystemPrompt({ ...base, agentPrompt: 'You search.' }), /Use echo for reversible text checks/);
});

function receivedLog(t) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-mcp-')), 'received.jsonl');
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  return { file, read };
}

test('stdio: multi-byte characters survive when a chunk boundary falls inside one', async (t) => {
  const { tool } = await stdioServer(t);
  const text = '你好世界'.repeat(60_000); // 720 KB of 3-byte characters: many pipe chunks
  const r = await tool('echo').call({ text }, {});
  assert.ok(!r.isError);
  assert.equal(r.content.length, text.length);
  assert.equal(r.content, [...text].reverse().join(''));
  assert.ok(!r.content.includes('\ufffd'), 'no replacement characters');
});

test('stdio: aborting a pending call cancels it; a finished call is not cancelled later; an aborted signal sends nothing', async (t) => {
  const log = receivedLog(t);
  const { tool } = await stdioServer(t, { MCP_TEST_LOG: log.file });

  // abort while the server is still working on it
  const ctrl = new AbortController();
  const pending = tool('hang').call({}, { signal: ctrl.signal });
  await sleep(300);
  ctrl.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  await sleep(300);
  const cancelled = log.read().filter((m) => m.method === 'notifications/cancelled');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].params.reason, 'User interrupted');

  // a call that finished: aborting the signal afterwards must not send a cancellation for it
  const ctrl2 = new AbortController();
  const done = await tool('add').call({ a: 1, b: 2 }, { signal: ctrl2.signal });
  assert.equal(done.content, '3');
  ctrl2.abort();
  await sleep(300);
  assert.equal(log.read().filter((m) => m.method === 'notifications/cancelled').length, 1, 'still only the first cancellation');

  // a signal that is already aborted: the request is not even sent
  const before = log.read().filter((m) => m.method === 'tools/call').length;
  const ctrl3 = new AbortController();
  ctrl3.abort();
  await assert.rejects(tool('add').call({ a: 1, b: 2 }, { signal: ctrl3.signal }), (err) => err.name === 'AbortError');
  await sleep(200);
  assert.equal(log.read().filter((m) => m.method === 'tools/call').length, before);
});

// ---------------------------------------------------------------- streamable HTTP

// A minimal streamable-HTTP MCP server that insists on a finished handshake: it answers tools/list
// only after the "initialized" notification has been fully handled, and handles that one slowly.
async function httpServer(t, { toolHandler } = {}) {
  const seen = [];
  let initialized = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.push(msg.method);
      const json = (payload) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http-server', version: '1' } } });
      if (msg.method === 'notifications/initialized') { setTimeout(() => { initialized = true; res.writeHead(202); res.end(); }, 150); return undefined; }
      if (msg.method === 'tools/list') {
        if (!initialized) return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'Server not initialized' } });
        return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'slow', description: 'x', inputSchema: { type: 'object', properties: {} } }] } });
      }
      if (msg.method === 'tools/call') return toolHandler?.(msg, json, res);
      return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return { seen, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

test('http: tools are listed only after the "initialized" notification has been taken', async (t) => {
  const api = await httpServer(t);
  const mgr = new McpManager({ remote: { type: 'http', url: api.url } }, { cwd: here });
  await mgr.start();
  const status = mgr.status()[0];
  assert.equal(status.status, 'connected', `failed: ${status.error}`);
  assert.deepEqual(mgr.tools().map((x) => x.name), ['mcp__remote__slow']);
  assert.deepEqual(api.seen, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('http: a call that times out is an ordinary error, not a user interrupt', async (t) => {
  const api = await httpServer(t, { toolHandler: () => { /* never answers */ } });
  const mgr = new McpManager({ remote: { type: 'http', url: api.url } }, { cwd: here });
  await mgr.start();
  const previous = process.env.MCP_TOOL_TIMEOUT;
  process.env.MCP_TOOL_TIMEOUT = '300';
  t.after(() => { if (previous === undefined) delete process.env.MCP_TOOL_TIMEOUT; else process.env.MCP_TOOL_TIMEOUT = previous; });
  const slow = mgr.tools()[0];
  const started = Date.now();
  await assert.rejects(slow.call({}, { signal: new AbortController().signal }), (err) => {
    assert.match(err.message, /MCP request tools\/call timed out after 300ms/);
    assert.equal(isAbort(err), false, 'the agent would end the whole turn as "interrupted by user"');
    return true;
  });
  assert.ok(Date.now() - started < 3000);
});

test('http: the user aborting a call is still an abort', async (t) => {
  const api = await httpServer(t, { toolHandler: () => { /* never answers */ } });
  const mgr = new McpManager({ remote: { type: 'http', url: api.url } }, { cwd: here });
  await mgr.start();
  const slow = mgr.tools()[0];
  const ctrl = new AbortController();
  const pending = slow.call({}, { signal: ctrl.signal });
  await sleep(200);
  ctrl.abort();
  await assert.rejects(pending, (err) => isAbort(err));
  const already = new AbortController();
  already.abort();
  await assert.rejects(slow.call({}, { signal: already.signal }), (err) => isAbort(err));
});
