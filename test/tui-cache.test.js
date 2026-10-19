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
let costRequests = 0;
let withCache = true; // report cache use in the usage, as Anthropic does
let replyModel = 'mock'; // the model the replies say answered: one with a price is billed (see pricing.js)

const sse = (usage) => [
  { type: 'message_start', message: { model: replyModel, usage: { input_tokens: 5, output_tokens: 0, ...usage } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'All done.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
].map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    requests++;
    let body;
    try { body = JSON.parse(raw); } catch { return; }
    const last = body.messages?.at(-1)?.content;
    const text = Array.isArray(last) ? last.map((b) => b.text || '').join(' ') : String(last || '');
    const isCostTurn = text.includes('cost first question') || text.includes('cost second question');
    if (isCostTurn) costRequests++;
    const n = isCostTurn ? costRequests : requests;
    const usage = !withCache ? {} : n === 1 ? { cache_creation_input_tokens: 4000 } : { cache_read_input_tokens: 4000 + 200 * (n - 2), cache_creation_input_tokens: 200 };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(usage));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

delete process.env.NO_COLOR; // colours on (FORCE_COLOR below): the band behind the user's messages
Object.assign(process.env, {
  CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_PRO_GATEWAY_API_KEY: 'test-token', CLAUDE_PRO_GATEWAY_MODEL: 'mock', CLAUDE_PRO_MAX_RETRIES: '3', CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1', CLAUDE_PRO_DISABLE_TOPIC_TITLE: '1',
  FORCE_COLOR: '1',
  CLAUDE_PRO_RIPGREP_PATH: 'off', CLAUDE_CODE_EFFORT_LEVEL: 'auto', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '0', // "auto" and "0": an empty value would not override the repository's own .env
  CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m', ENABLE_PROMPT_CACHING_1H: '0', FORCE_PROMPT_CACHING_5M: '0', DISABLE_PROMPT_CACHING: '0',
});
const { startTui } = await import('./tui-harness.js');
const { SessionStore } = await import('../src/session.js');

test.after(() => server.close());

const project = (name = 'cache-project') => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-cachetui-')), name);
  fs.mkdirSync(dir);
  return dir;
};
const serialTest = (name, fn) => test(name, { concurrency: false }, fn);

serialTest('/cost says how much of the input came from the prompt cache, and /status says how it is set', async (t) => {
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

serialTest('the footer and /cost show what the conversation has cost: kept with the session, back to nothing after /clear', async (t) => {
  requests = 0;
  costRequests = 0;
  withCache = true;
  replyModel = 'claude-opus-5-5';
  t.after(() => { replyModel = 'mock'; });
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  tui.send('cost first question\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  tui.send('cost second question\r');
  await tui.waitIdle({ timeout: 20_000 });
  // Opus 5.5: 5 in, 3 out, 4,000 written for 5 minutes; then 5 in, 3 out, 4,000 read, 200 written
  const expected = (5 * 4 + 3 * 20 + 4000 * 5 + 5 * 4 + 3 * 20 + 4000 * 0.2 + 200 * 5) / 1e6;
  assert.ok(Math.abs(tui.app.cost - expected) < 1e-9, `cost ${tui.app.cost}, expected ${expected}`);
  await tui.waitFor(/\$0\.02 · mock\s*$/m, { timeout: 5000, all: false });
  const first = { file: tui.app.store.file, id: tui.app.store.id };
  assert.ok(Math.abs(SessionStore.load(first.file).cost - expected) < 1e-9, 'kept in the session file');

  tui.send('/cost\r');
  assert.match(await tui.waitFor('Total cost:', { timeout: 20_000 }), /Total cost: +\$0\.02 for this conversation/);

  tui.send('/clear\r');
  await tui.waitFor('Welcome to', { timeout: 20_000 });
  assert.equal(tui.app.cost, 0);
  assert.doesNotMatch(await tui.snapshot({ all: false }), /\$0\.02 · mock/);
  tui.app.agent.resetConversation();
  tui.app.loadSession(first.file, first.id);
  assert.ok(Math.abs(tui.app.cost - expected) < 1e-9, 'a resumed conversation goes on from its total');
});

serialTest('the footer\'s prompt cache clock counts down, is cold once the cache ran out or after a compaction, and is kept with the session', async (t) => {
  requests = 0;
  withCache = true;
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  assert.equal(tui.app.cacheClock(), '', 'nothing before a response');
  tui.send('first question\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  await tui.waitFor(/◷ 5m · mock\s*$/m, { timeout: 5000, all: false });
  const cache = tui.app.agent.cache;
  const first = { file: tui.app.store.file, id: tui.app.store.id };
  assert.equal(SessionStore.load(first.file).cacheUntil, cache.clockUntil, 'kept with the session');

  cache.clockUntil = Date.now() + 90_000; // it counts down by itself while idle
  await tui.waitFor(/◷ 2m · mock\s*$/m, { timeout: 5000, all: false });
  cache.clockUntil = Date.now() - 1; // ran out: the icon alone
  await tui.waitFor(/ ◷ · mock\s*$/m, { timeout: 5000, all: false });
  tui.send('second question\r');
  await tui.waitIdle({ timeout: 20_000 });
  await tui.waitFor(/◷ 5m · mock\s*$/m, { timeout: 5000, all: false });

  tui.send('/compact\r');
  await tui.waitFor('Conversation compacted', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  await tui.waitFor(/ ◷ · mock\s*$/m, { timeout: 5000, all: false });
  assert.equal(SessionStore.load(first.file).cacheUntil, 0, 'a conversation compacted after its last reply reads as cold when resumed');

  tui.send('/clear\r');
  await tui.waitFor('Welcome to', { timeout: 20_000 });
  assert.equal(tui.app.cacheClock(), '', 'a new conversation has none');
  tui.app.agent.resetConversation();
  tui.app.loadSession(first.file, first.id);
  assert.deepEqual(tui.app.agent.cache.clock(), { cold: true });
});

serialTest('the user\'s messages are on a band of colour; ctrl+f in fullscreen finds in the conversation, newest first', async (t) => {
  requests = 0;
  withCache = true;
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  tui.send('first question\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  tui.send('second question\r');
  await tui.waitIdle({ timeout: 20_000 });
  const screen = await tui.snapshot({ all: true });
  const row = screen.split('\n').findIndex((l) => l.startsWith('> first question'));
  const line = tui.term.buffer.active.getLine(row);
  assert.notEqual(line.getCell(2).getBgColor(), -1, 'the text on the band');
  assert.equal(line.getCell(90).getBgColor(), line.getCell(2).getBgColor(), 'which goes across the window');

  tui.app.screen.setFull(true);
  const full = (await tui.snapshot()).split('\n');
  const at = full.findIndex((l) => l.startsWith('> second question'));
  const banded = tui.term.buffer.active.getLine(tui.term.buffer.active.baseY + at);
  assert.notEqual(banded.getCell(2).getBgColor(), -1);
  assert.equal(banded.getCell(90).getBgColor(), banded.getCell(2).getBgColor(), 'in fullscreen too, across the window');
  tui.send('\x06'); // ctrl+f
  await tui.waitFor('Find in the conversation', { timeout: 5000, all: false });
  tui.send('ALL DONE');
  await tui.waitFor(/Find in the conversation.*1\/2/, { timeout: 5000, all: false });
  tui.send('\r'); // the older one
  await tui.waitFor(/Find in the conversation.*2\/2/, { timeout: 5000, all: false });
  tui.send('\r'); // round to the newest
  await tui.waitFor(/Find in the conversation.*1\/2/, { timeout: 5000, all: false });
  tui.send('x');
  await tui.waitFor('No results', { timeout: 5000, all: false });
  tui.send('\x1b');
  await tui.waitFor(/\? for shortcuts/, { timeout: 5000, all: false });
  assert.equal(tui.app.screen.finding, null);
  // again: the last text comes back selected, and typing replaces it
  tui.send('\x06');
  await tui.waitFor(/Find in the conversation.*No results/, { timeout: 5000, all: false });
  tui.send('first question');
  await tui.waitFor(/Find in the conversation.*1\/1/, { timeout: 5000, all: false });
  tui.send('\x1b');
  await tui.waitFor(/\? for shortcuts/, { timeout: 5000, all: false });
});

serialTest('/effort and /model ask first while the cache is warm; a "no" changes nothing, a "yes" does', async (t) => {
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
  assert.equal(cfg.model.id, 'mock');

  tui.send('/model other-model\r');
  await tui.waitFor('The prompt cache is warm', { timeout: 20_000 });
  tui.send('\r');
  await tui.waitFor('Model set to other-model', { timeout: 20_000 });
  assert.equal(cfg.model.id, 'other-model');
  assert.equal(tui.app.runtime.systemPromptStale, false);
});

serialTest('nothing is asked once the cache has expired, or in a new conversation', async (t) => {
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

serialTest('an endpoint that reports no cache use: nothing is known to be cached, so nothing is asked', async (t) => {
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

serialTest('a memory saved with # waits for /clear or a compaction instead of changing the system prompt at once', async (t) => {
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

serialTest('the system prompt goes into every session file, /clear included, and a resumed conversation continues behind its own', async (t) => {
  requests = 0;
  withCache = true;
  const cwd = project();
  const tui = await startTui({ cwd });
  t.after(() => tui.close());
  tui.send('first question\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  const first = { file: tui.app.store.file, id: tui.app.store.id };
  const built = tui.app.runtime.systemPrompt();
  assert.equal(SessionStore.load(first.file).systemPrompt, built, 'saved with the first conversation');

  tui.send('/clear\r'); // nothing changed: the new prompt is the same text, and still belongs in the new file
  await tui.waitFor('Welcome to', { timeout: 20_000 });
  tui.send('second question\r');
  await tui.waitIdle({ timeout: 20_000 });
  assert.notEqual(tui.app.store.id, first.id);
  assert.equal(SessionStore.load(tui.app.store.file).systemPrompt, tui.app.runtime.systemPrompt(), 'saved with the one that follows /clear');

  // the project changes, a fresh prompt would differ; resuming the first conversation keeps its own
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'MARKER-NEW use tabs\n');
  tui.send('/clear\r');
  await tui.waitFor('Welcome to', { timeout: 20_000 });
  assert.match(tui.app.runtime.systemPrompt(), /MARKER-NEW/, 'a new conversation starts from a fresh prompt');
  tui.app.agent.resetConversation();
  tui.app.loadSession(first.file, first.id);
  assert.equal(tui.app.runtime.systemPrompt(), built, 'the resumed conversation continues behind the prompt it had (and its cache)');
  assert.doesNotMatch(tui.app.runtime.systemPrompt(), /MARKER-NEW/);
});

serialTest('/model to the model in use changes nothing, /config set only marks the prompt, another model rebuilds it', async (t) => {
  requests = 0;
  withCache = true;
  const cwd = project();
  const tui = await startTui({ cwd });
  t.after(() => tui.close());
  tui.send('/model default\r'); // an earlier test's /model is remembered for later sessions: start from the configured model
  await tui.waitFor('Model set to mock', { timeout: 20_000 });
  tui.send('hello there\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  const built = tui.app.runtime.systemPrompt();
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'MARKER-RULES use tabs\n'); // what a rebuilt prompt would pick up

  tui.send('/model mock\r'); // the model that is already in use: no question, no change
  await tui.waitFor('Model set to mock', { timeout: 20_000 });
  assert.ok(!tui.app.dialogs.length);
  assert.equal(tui.app.runtime.systemPrompt(), built, 'the prompt was not rebuilt, so the cache is not lost');

  tui.send('/config set SOME_TEST_KEY 1\r');
  await tui.waitFor('Set SOME_TEST_KEY', { timeout: 20_000 });
  assert.equal(tui.app.runtime.systemPromptStale, true);
  assert.equal(tui.app.runtime.systemPrompt(), built);

  tui.send('/model other-model\r'); // another model: asked first (the cache is warm), and then the prompt names it
  await tui.waitFor('The prompt cache is warm', { timeout: 20_000 });
  tui.send('\r');
  await tui.waitFor('Model set to other-model', { timeout: 20_000 });
  assert.match(tui.app.runtime.systemPrompt(), /You are powered by the model other-model\./);
  assert.match(tui.app.runtime.systemPrompt(), /MARKER-RULES/, 'and a switch is a place where the changes that were waiting apply');
  assert.equal(tui.app.runtime.systemPromptStale, false);
});

serialTest('a model chosen with /config set is a switch: the prompt names it from then on', async (t) => {
  requests = 0;
  withCache = true;
  const saved = process.env.CLAUDE_PRO_GATEWAY_MODEL; // the shell's variable would win over a settings file
  delete process.env.CLAUDE_PRO_GATEWAY_MODEL;
  t.after(() => { process.env.CLAUDE_PRO_GATEWAY_MODEL = saved; });
  const tui = await startTui({ cwd: project() });
  t.after(() => tui.close());
  tui.send('/model default\r'); // forget what an earlier test chose
  await tui.waitFor('Model set to', { timeout: 20_000 });
  assert.doesNotMatch(tui.app.runtime.systemPrompt(), /You are powered by the model third-model\./);
  tui.send('/config set CLAUDE_PRO_GATEWAY_MODEL third-model\r');
  await tui.waitFor('Set CLAUDE_PRO_GATEWAY_MODEL', { timeout: 20_000 });
  assert.equal(tui.app.runtime.config.model.id, 'third-model');
  assert.match(tui.app.runtime.systemPrompt(), /You are powered by the model third-model\./);
  assert.equal(tui.app.runtime.systemPromptStale, false);
});
