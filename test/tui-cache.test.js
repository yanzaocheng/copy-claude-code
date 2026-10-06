import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// What the user sees of the prompt cache, in the real App inside a headless terminal: /cost says how much of the
// input came from the cache, and /model and /effort ask first while that cache is still warm.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-cachetui-config-'));
let requests = 0;
let withCache = true; // report cache use in the usage, as Anthropic does

const sse = (usage) => [
  { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 5, output_tokens: 0, ...usage } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'All done.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
].map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    requests++;
    const usage = !withCache ? {} : requests === 1 ? { cache_creation_input_tokens: 4000 } : { cache_read_input_tokens: 4000 + 200 * (requests - 2), cache_creation_input_tokens: 200 };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(usage));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

Object.assign(process.env, {
  CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_PROVIDER: 'api', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  ANTHROPIC_AUTH_TOKEN: 'test-token', ANTHROPIC_MODEL: 'mock', CLAUDE_PRO_MAX_RETRIES: '3', CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_PRO_RIPGREP_PATH: 'off', CLAUDE_CODE_EFFORT_LEVEL: 'auto', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '0', // "auto" and "0": an empty value would not override the repository's own .env
});
const { startTui } = await import('./tui-harness.js');

test.after(() => server.close());

const project = (name = 'cache-project') => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-cachetui-')), name);
  fs.mkdirSync(dir);
  return dir;
};

test('/cost says how much of the input came from the prompt cache, and /status says how it is set', async (t) => {
  requests = 0;
  withCache = true;
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  tui.send('first question\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  tui.send('second question\r');
  await tui.waitIdle({ timeout: 20_000 });
  await tui.wait(200);

  tui.send('/cost\r');
  const screen = await tui.waitFor('Prompt cache:', { timeout: 20_000 });
  assert.match(screen, /Total input: +\d[\d.k]* tokens \(\d[\d.k]* cache read, \d[\d.k]* cache write\)/);
  assert.match(screen, /API requests: +2/);
  assert.match(screen, /Prompt cache: +\d+% of the input came from the cache · 0 misses · warm for \d+m \d+s more \(TTL 5m\)/);

  tui.send('/status\r');
  const status = await tui.waitFor('Prompt cache ', { timeout: 20_000 });
  assert.match(status, /Prompt cache +on · TTL 5m for the conversation, 5m for sub-agents and compaction/);
});

test('/effort and /model ask first while the cache is warm; a "no" changes nothing, a "yes" does', async (t) => {
  requests = 0;
  withCache = true;
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  const cfg = tui.app.runtime.config;
  tui.send('hello there\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  assert.ok(tui.app.agent.cache.isWarm(), 'the reply reported 4000 cached tokens');

  tui.send('/effort high\r');
  const asked = (await tui.waitFor('The prompt cache is warm', { timeout: 20_000 })).replace(/[│\n]/g, ' ').replace(/\s+/g, ' ');
  assert.match(asked, /about 4\.0k tokens/);
  assert.match(asked, /Changing the effort makes the next request read the whole conversation again/);
  tui.send('\x1b'); // Esc: no
  await tui.waitFor('The effort was not changed.', { timeout: 20_000 });
  assert.equal(cfg.effort, null);

  tui.send('/effort high\r');
  await tui.waitFor('The prompt cache is warm', { timeout: 20_000 });
  tui.send('\r'); // the first option: yes
  await tui.waitFor('Effort set to high', { timeout: 20_000 });
  assert.equal(cfg.effort, 'high');

  tui.send('/effort high\r'); // the same effort again: nothing to lose, nothing to ask
  await tui.waitFor('Effort set to high', { timeout: 20_000 });
  assert.ok(!tui.app.dialogs.length);

  tui.send('/model other-model\r');
  const model = (await tui.waitFor('Switching the model', { timeout: 20_000 })).replace(/[│\n]/g, ' ').replace(/\s+/g, ' ');
  assert.match(model, /prompt cache is warm/);
  assert.match(model, /Switching the model makes the next request/);
  tui.send('\x1b');
  await tui.waitFor('The model was not changed.', { timeout: 20_000 });
  assert.equal(cfg.mainModel.id, 'mock');

  tui.send('/model other-model\r');
  await tui.waitFor('The prompt cache is warm', { timeout: 20_000 });
  tui.send('\r');
  await tui.waitFor('Model set to other-model', { timeout: 20_000 });
  assert.equal(cfg.mainModel.id, 'other-model');
  assert.equal(tui.app.runtime.systemPromptStale, false);
});

test('nothing is asked once the cache has expired, or in a new conversation', async (t) => {
  requests = 0;
  withCache = true;
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  tui.send('hello there\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });

  tui.app.agent.cache.expiresAt = Date.now() - 1; // five minutes went by
  tui.send('/effort low\r');
  await tui.waitFor('Effort set to low', { timeout: 20_000 });
  assert.ok(!tui.app.dialogs.length, 'an expired cache is not worth asking about');

  tui.send('/clear\r');
  await tui.waitFor('Welcome to', { timeout: 20_000 });
  tui.send('/effort max\r');
  await tui.waitFor('Effort set to max', { timeout: 20_000 });
  assert.ok(!tui.app.dialogs.length, 'a new conversation has nothing cached');
});

test('an endpoint that reports no cache use: nothing is known to be cached, so nothing is asked', async (t) => {
  requests = 0;
  withCache = false;
  const tui = await startTui({ cwd: project() });
  t.after(() => { withCache = true; return tui.close(); });
  tui.send('hello there\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  assert.ok(!tui.app.agent.cache.isWarm());
  tui.send('/effort medium\r');
  await tui.waitFor('Effort set to medium', { timeout: 20_000 });
  assert.ok(!tui.app.dialogs.length);
  tui.send('/cost\r');
  await tui.waitFor('nothing reported', { timeout: 20_000 });
});

test('a memory saved with # waits for /clear or a compaction instead of changing the system prompt at once', async (t) => {
  requests = 0;
  withCache = true;
  const cwd = project();
  const tui = await startTui({ cwd });
  t.after(() => tui.close());
  const before = tui.app.runtime.systemPrompt();
  tui.app.addMemory('Always use tabs.');
  await tui.waitFor('Where should this memory be saved?', { timeout: 20_000 });
  tui.send('\r'); // project memory
  await tui.waitFor('the model sees it from the next /clear or /compact', { timeout: 20_000 });
  assert.match(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8'), /Always use tabs\./);
  assert.equal(tui.app.runtime.systemPrompt(), before, 'the prompt is the one the conversation started with');
  assert.equal(tui.app.runtime.systemPromptStale, true);
  tui.send('/status\r');
  await tui.waitFor('reach the system prompt at /clear or /compact', { timeout: 20_000 });
  tui.send('/clear\r');
  await tui.waitFor('Welcome to', { timeout: 20_000 });
  assert.match(tui.app.runtime.systemPrompt(), /Always use tabs\./);
  assert.equal(tui.app.runtime.systemPromptStale, false);
});
