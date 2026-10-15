import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Leaving a conversation (/clear, /resume) must not damage it: it has to stay in the list of
// conversations that can be resumed, with everything that was said in it. Runs the real App in a
// headless terminal against a fake API, with the environment set before the app modules load.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-switch-config-'));
let replies = 0;
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    replies++;
    const events = [
      { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Answer number ${replies}.` } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join(''));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, {
  CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_PRO_GATEWAY_API_KEY: 'test-token', CLAUDE_PRO_GATEWAY_MODEL: 'mock', CLAUDE_PRO_MAX_RETRIES: '0', CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_PRO_RIPGREP_PATH: 'off', CLAUDE_PRO_DISABLE_TOPIC_TITLE: '1', CLAUDE_CODE_EFFORT_LEVEL: '', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
});
const { startTui } = await import('./tui-harness.js');
const { SessionStore } = await import('../src/session.js');

test.after(() => server.close());

const texts = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [{ text: m.content }]).filter((b) => b.type === 'text' || b.text).map((b) => b.text));

test('/clear and /resume leave the conversation they come from intact and resumable', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-switch-'));
  const tui = await startTui({ cwd });
  t.after(() => tui.close());

  tui.send('first question\r');
  await tui.waitFor('Answer number 1.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  const first = tui.app.store.id;

  tui.send('/clear\r');
  await tui.wait(400);
  assert.notEqual(tui.app.store.id, first, '/clear starts a new session');
  assert.equal(tui.app.agent.messages.length, 0);
  let listed = SessionStore.list(cwd);
  assert.deepEqual(listed.map((s) => [s.id, s.count]), [[first, 2]], 'the cleared conversation can still be resumed, complete');
  assert.ok(texts(SessionStore.load(listed[0].file).messages).some((x) => x.includes('first question')));

  tui.send('second question\r');
  await tui.waitFor(/Answer number [2-9]\./, { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  const second = tui.app.store.id;

  tui.send(`/resume ${first.slice(0, 8)}\r`);
  await tui.wait(600);
  assert.equal(tui.app.store.id, first, 'the first conversation is active again');
  assert.ok(texts(tui.app.agent.messages).some((x) => x.includes('first question')), 'with its messages');
  listed = SessionStore.list(cwd).filter((s) => s.id !== first);
  assert.deepEqual(listed.map((s) => [s.id, s.count]), [[second, 2]], 'the conversation that was left is still there, complete');
  assert.ok(texts(SessionStore.load(listed[0].file).messages).some((x) => x.includes('second question')));
});

test('a restart keeps the session\'s own model and effort, not what another window chose meanwhile', async (t) => {
  const { rememberChoice, rememberedChoices } = await import('../src/config.js');
  const tui = await startTui({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-switch-')) });
  t.after(() => { rememberChoice('gateway', { model: null, effort: null }); return tui.close(); });
  // Another window chose these with /model and /effort; the restarted process started with them.
  rememberChoice('gateway', { model: 'gpt-6.1-sol', effort: 'low' });
  const cfg = tui.app.config;
  Object.assign(cfg, { modelOverride: 'gpt-6.1-sol', effortOverride: 'low' });
  tui.app.resumeAfterRestart({ modelOverride: null, effortOverride: 'high' }, false);
  assert.equal(cfg.modelOverride, null, 'this session had no model chosen: it stays on the configured one');
  assert.equal(cfg.effortOverride, 'high');
  assert.deepEqual(rememberedChoices('gateway'), { model: 'gpt-6.1-sol', effort: 'low' }, 'a restart chooses nothing');
});
