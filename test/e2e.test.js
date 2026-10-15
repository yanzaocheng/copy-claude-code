import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs the real command line (bin/claude-pro.js -p) against a fake Anthropic-compatible server, so
// startup, the agent loop, the tools and session saving are exercised through the actual entry point.

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'claude-pro.js');

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

// A server that answers each POST /v1/messages with the next scripted reply and records the request bodies.
async function fakeApi(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(reply.blocks, reply.stopReason));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function runCli(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const baseEnv = (api, configDir) => ({
  CLAUDE_PRO_GATEWAY_URL: api.url, CLAUDE_PRO_GATEWAY_API_KEY: 'test-token', CLAUDE_PRO_GATEWAY_MODEL: 'mock',
  CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_MAX_RETRIES: '0', CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_PRO_RIPGREP_PATH: 'off', CLAUDE_CODE_EFFORT_LEVEL: '', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '', CLAUDE_PRO_PROVIDER: 'gateway',
});

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-e2e-'));
  const write = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  write('src/a.js', 'const needle = 1;\n');
  write('README.md', 'needle in the docs\n');
  write('node_modules/dep/index.js', 'needle in a dependency\n');
  return dir;
}

test('claude-pro -p runs the agent loop end to end: tool call, tool result, final answer', async (t) => {
  const dir = project();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-e2e-config-'));
  const api = await fakeApi([
    // a negated-only glob: this used to match no file at all with the built-in scanner
    { stopReason: 'tool_use', blocks: [{ type: 'text', text: 'Searching.' }, { type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'needle', glob: '!*.md' } }] },
    { stopReason: 'end_turn', blocks: [{ type: 'text', text: 'Found it in src/a.js.' }] },
  ]);
  t.after(() => api.close());

  const r = await runCli(['-p', 'find needle'], { cwd: dir, env: baseEnv(api, configDir) });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(r.stdout.trim(), 'Found it in src/a.js.');

  assert.equal(api.requests.length, 2);
  assert.equal(api.requests[0].model, 'mock');
  assert.ok(api.requests[0].tools.some((tool) => tool.name === 'Grep'));
  const toolResult = api.requests[1].messages.at(-1).content.find((b) => b.type === 'tool_result');
  assert.equal(toolResult.tool_use_id, 'toolu_1');
  assert.ok(!toolResult.is_error, JSON.stringify(toolResult));
  assert.match(toolResult.content, /Found 1 file/);
  assert.ok(toolResult.content.includes(path.join(dir, 'src', 'a.js')), toolResult.content);
  assert.ok(!toolResult.content.includes('README.md'));
  assert.ok(!toolResult.content.includes('node_modules'));
});

// A server that answers every request with a 429 (the headers given), and counts the requests.
async function limitedApi(t, headers) {
  const api = { requests: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      api.requests++;
      res.writeHead(429, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "This request would exceed your account's rate limit." } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  api.url = `http://127.0.0.1:${server.address().port}`;
  return api;
}

test('claude-pro -p reports a rate limit that resets later than it may wait, with the time, and exits with 1', async (t) => {
  const dir = project();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-e2e-config-'));
  const api = await limitedApi(t, { 'retry-after': '7200' });
  const r = await runCli(['-p', 'hello'], { cwd: dir, env: { ...baseEnv(api, configDir), CLAUDE_PRO_MAX_RETRIES: '3', CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS: '1000' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /exceed your account's rate limit/);
  assert.match(r.stderr, /resets at .+ \(in 2h 0m\), beyond the 1s this session may wait/, 'the time it resets must be shown, not just "try later"');
  assert.equal(api.requests, 1, 'nothing is retried in a loop');
});

test('claude-pro -p pauses for an exhausted 5-hour window, says when it resumes, and does not hammer the server', async (t) => {
  const dir = project();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-e2e-config-'));
  const resetAt = Math.floor((Date.now() + 2 * 3_600_000) / 1000);
  const api = await limitedApi(t, {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(resetAt),
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  });
  const child = spawn(process.execPath, [bin, '-p', 'hello'], { cwd: dir, env: { ...process.env, ...baseEnv(api, configDir), CLAUDE_PRO_MAX_RETRIES: '3' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  t.after(() => child.kill());
  const started = Date.now();
  while (!/continuing automatically/.test(stderr)) {
    assert.ok(Date.now() - started < 20_000, `no pause notice within 20 seconds; stderr so far: ${stderr}`);
    assert.equal(child.exitCode, null, `the process exited instead of pausing: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(stderr, /5-hour limit reached\. Pausing until .+ \(in 2h \d+m\), then continuing automatically\./);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(child.exitCode, null, 'it keeps waiting');
  assert.equal(api.requests, 1, 'one request, then silence until the reset');
});

test('claude-pro -p retries a 429 that gives no timing and completes when the limit clears', async (t) => {
  const dir = project();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-e2e-config-'));
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests++;
      if (requests < 3) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse([{ type: 'text', text: 'The limit cleared.' }], 'end_turn'));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const api = { url: `http://127.0.0.1:${server.address().port}` };
  const r = await runCli(['-p', 'hello'], { cwd: dir, env: { ...baseEnv(api, configDir), CLAUDE_PRO_MAX_RETRIES: '3' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'The limit cleared.');
  assert.equal(requests, 3);
});

test('claude-pro --help and config list start without loading errors', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-e2e-config-'));
  const help = await runCli(['--help'], { cwd: here, env: { CLAUDE_PRO_CONFIG_DIR: configDir } });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--model/);
  const list = await runCli(['config', 'list'], { cwd: here, env: { CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_RIPGREP_PATH: 'off' } });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /CLAUDE_PRO_RIPGREP_PATH/);
});

test('the interactive and print modules load (a syntax or import error would only show up at startup)', async () => {
  for (const file of ['ui/repl.js', 'print.js', 'main.js']) {
    const mod = await import(new URL(`../src/${file}`, import.meta.url));
    assert.ok(Object.keys(mod).length >= 0);
  }
});
