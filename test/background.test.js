import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Background sessions for real: the computer service (HostService + BackgroundSessions) against a fake gateway
// starts claude-pro --headless processes (each a supervisor and its session), which go online at the gateway as
// background sessions of this computer, answer the page, write their log, can be attached to, restarted, crash
// and come back, end with /exit or the service's stop, and are taken over or opened again by a later service.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-bg-config-'));
process.env.CLAUDE_PRO_CONFIG_DIR = configDir;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'claude-pro.js');

const { HostService, computerId } = await import('../src/host.js');
const { BackgroundSessions, killTree, pidAlive } = await import('../src/background.js');
const { listPeers } = await import('../src/peers.js');

// ---------------------------------------------------------------- the fake gateway (and model)

const KEY = 'bg-key';
const frames = (events) => events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
const textReply = (text) => frames([
  { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]);
const gw = { hostStream: null, states: [], sessions: new Map(), registrations: [], streams: new Map(), pending: new Map(), cid: 0, outputs: new Map(), byes: [] };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b ? JSON.parse(b) : {})); });
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/v1/messages') {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.end(textReply('Hello from the model.'));
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: { message: 'bad key' } });
  if (req.method === 'POST' && url.pathname === '/v1/remote/hosts') return json(res, 200, { id: (await readBody(req)).id, ok: true });
  let m = /^\/v1\/remote\/hosts\/([\w-]+)\/(commands|results|state)$/.exec(url.pathname);
  if (m) {
    if (m[2] === 'commands') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n');
      gw.hostStream = res;
      req.on('close', () => { if (gw.hostStream === res) gw.hostStream = null; });
      return;
    }
    const body = await readBody(req);
    if (m[2] === 'state') gw.states.push(body);
    else { gw.pending.get(body.cid)?.(body); gw.pending.delete(body.cid); }
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/v1/remote/sessions') {
    const body = await readBody(req);
    gw.sessions.set(body.id, body);
    gw.registrations.push(body);
    return json(res, 200, { id: body.id, url: `https://gw.example/#remote/${body.id}` });
  }
  if (url.pathname === '/v1/remote/sessions') return json(res, 200, { data: [] });
  m = /^\/v1\/remote\/sessions\/([\w-]+)\/(commands|events|results)$/.exec(url.pathname);
  if (!m || !gw.sessions.has(m[1])) return json(res, 404, { error: { message: 'not found' } });
  if (m[2] === 'commands') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'viewers', count: 1 })}\n\n`);
    gw.streams.set(m[1], res);
    req.on('close', () => { if (gw.streams.get(m[1]) === res) gw.streams.delete(m[1]); });
    return;
  }
  const body = await readBody(req);
  if (m[2] === 'results') { gw.pending.get(body.cid)?.(body); gw.pending.delete(body.cid); return json(res, 200, { ok: true }); }
  const seen = gw.outputs.get(m[1]) || [];
  for (const msg of body.messages || []) {
    if (msg.t === 'bye') gw.byes.push({ id: m[1], ...msg });
    for (const it of msg.t === 'snapshot' ? msg.items : msg.t === 'batch' ? msg.events : []) {
      if (it.lines) seen.push(...it.lines);
      if (it.text) seen.push(it.text);
    }
  }
  gw.outputs.set(m[1], seen);
  return json(res, 200, { ok: true });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
fs.writeFileSync(path.join(configDir, 'gateway.json'), JSON.stringify({ url: base, apiKey: KEY, account: { email: 'me@example.com' } }));

const until = async (what, check, timeout = 30_000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const send = (stream, type, body = {}) => new Promise((resolve, reject) => {
  if (!stream) { reject(new Error('not connected')); return; }
  const cid = `c${++gw.cid}`;
  gw.pending.set(cid, resolve);
  stream.write(`data: ${JSON.stringify({ cid, type, body })}\n\n`);
});
const toHost = (type, body) => send(gw.hostStream, type, body);
const toSession = (id, type, body) => send(gw.streams.get(id), type, body);

// What the sessions get: this config directory and gateway, the fake model, nothing that starts more.
const sessionEnv = { ...process.env };
for (const k of ['NODE_TEST_CONTEXT', 'CLAUDE_PRO_SUPERVISED', 'CLAUDE_PRO_RESTART_FILE', 'CLAUDE_PRO_RESTARTED']) delete sessionEnv[k];
Object.assign(sessionEnv, {
  CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_GATEWAY_URL: base, CLAUDE_PRO_PROVIDER: 'api', ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'test-token', ANTHROPIC_MODEL: 'mock', CLAUDE_PRO_AUTO_UPDATE: '0', CLAUDE_PRO_HOST: '0',
  CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1', CLAUDE_PRO_DISABLE_TOPIC_TITLE: '1', CLAUDE_PRO_RIPGREP_PATH: 'off', CLAUDE_CODE_EFFORT_LEVEL: 'auto',
  CLAUDE_PRO_MACHINE_NAME: 'bg-test-pc',
});

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-bg-project-'));
const peerOf = (id) => listPeers().find((p) => p.remoteId === id);
const logs = [];

function startService() {
  const sessions = new BackgroundSessions({ dir: configDir, entry: BIN, env: sessionEnv, log: (m) => logs.push(m) });
  const service = new HostService({
    id: computerId(), sessions, terminal: null, home: os.homedir(), log: (m) => logs.push(m),
    readLogin: () => ({ url: base, apiKey: KEY }), loadConfig: () => ({ env: { CLAUDE_PRO_MACHINE_NAME: 'bg-test-pc' }, gatewayUrl: base }),
  });
  sessions.onChange = () => service.reportState();
  sessions.start();
  const running = service.run();
  return { sessions, service, running, async stop() { service.stop(); await running; sessions.close(); } };
}

const stateOf = (id) => gw.states.at(-1)?.sessions.find((s) => s.sessionId === id);

test('background sessions: opened for the page without a window, online, logged, attached to, restarted, crashed and back, stopped, ended with /exit, taken over and opened again', { timeout: 240_000 }, async (t) => {
  let svc = startService();
  t.after(async () => {
    await svc.stop();
    for (const p of listPeers()) if (p.kind === 'background') killTree(p.pid);
    for (const id of ['bg-test-0001', 'bg-test-0002', 'bg-test-0003']) { const pid = svc.sessions.sessions.get(id)?.pid; if (pid) killTree(pid); }
  });
  await until('the service online', () => gw.hostStream && svc.service.online);

  // open, in the background
  const opened = await toHost('open', { sessionId: 'bg-test-0001', cwd: project, name: 'worker', window: false });
  assert.equal(opened.ok, true, opened.error);
  assert.ok(Number.isInteger(opened.pid));
  await until('the session online', () => gw.streams.has('bg-test-0001'));
  const reg = gw.sessions.get('bg-test-0001');
  assert.deepEqual([reg.kind, reg.computerId, reg.name, reg.machine], ['background', computerId(), 'worker', 'bg-test-pc']);
  assert.match(reg.conversationId, /^[0-9a-f-]{36}$/);
  await until('reported as running', () => stateOf('bg-test-0001')?.state === 'running');
  const st = gw.states.at(-1);
  assert.ok(st.stats.memTotal > 0 && st.stats.uptime > 0 && st.stats.cpu >= 0);
  assert.equal(peerOf('bg-test-0001').kind, 'background');

  // the page uses it: a turn, the status with the new fields, the log
  assert.equal((await toSession('bg-test-0001', 'send', { text: 'hello there' })).ok, true);
  await until('the answer on the page', () => (gw.outputs.get('bg-test-0001') || []).some((l) => /Hello from the model/.test(l)));
  const log = await toHost('logs', { sessionId: 'bg-test-0001', lines: 50 });
  assert.match(log.text, /hello there/);
  assert.match(log.text, /Hello from the model\./);
  fs.writeFileSync(path.join(configDir, 'host.log'), '[t] the service\'s own log\n');
  assert.equal((await toHost('logs', {})).text, '[t] the service\'s own log');
  assert.match((await toHost('logs', { sessionId: 'nonexistent-1' })).error, /没有日志/);

  // attach: the whole screen, and keys that work
  const peer = peerOf('bg-test-0001');
  const socket = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: peer.port, path: '/attach?cols=100&rows=30', headers: { connection: 'Upgrade', upgrade: 'claude-pro-attach', authorization: `Bearer ${peer.token}` } });
    req.on('upgrade', (_res, s) => resolve(s));
    req.on('response', (r) => reject(new Error(`HTTP ${r.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
  let screen = '';
  socket.on('data', (d) => { screen += d; });
  await until('the screen', () => screen.includes('\x1b[?1049h') && /for shortcuts/.test(screen));
  socket.write(`${JSON.stringify({ keys: Buffer.from('/cost\r').toString('base64') })}\n`);
  await until('the command in the log', async () => /Total cost/.test((await toHost('logs', { sessionId: 'bg-test-0001' })).text));
  socket.destroy();

  // restart: the same process tree, a new session process, the same id at the gateway
  const before = peerOf('bg-test-0001').pid;
  const regs = gw.registrations.filter((r) => r.id === 'bg-test-0001').length;
  assert.equal((await toHost('restart', { sessionId: 'bg-test-0001' })).ok, true);
  await until('restarted', () => peerOf('bg-test-0001') && peerOf('bg-test-0001').pid !== before && stateOf('bg-test-0001')?.state === 'running');
  await until('registered again', () => gw.registrations.filter((r) => r.id === 'bg-test-0001').length > regs);

  // a crash: opened again with --resume, the conversation and the id kept
  const conversation = peerOf('bg-test-0001').conversationId;
  process.kill(peerOf('bg-test-0001').pid);
  await until('back after the crash', () => stateOf('bg-test-0001')?.restarts === 1 && stateOf('bg-test-0001')?.state === 'running' && peerOf('bg-test-0001'), 60_000);
  assert.equal(peerOf('bg-test-0001').conversationId, conversation, 'the same conversation');
  assert.equal(gw.registrations.at(-1).conversationId, conversation);

  // stop: ended, off the list to open again
  assert.equal((await toHost('stop', { sessionId: 'bg-test-0001' })).ok, true);
  assert.equal(svc.sessions.list().find((s) => s.sessionId === 'bg-test-0001').state, 'exited');
  await until('reported as ended', () => stateOf('bg-test-0001')?.state === 'exited');
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'host-sessions.json'), 'utf8')).some((s) => s.sessionId === 'bg-test-0001'), false);
  await until('its processes gone', () => !peerOf('bg-test-0001'));

  // /exit from the page: ended for good too
  assert.equal((await toHost('open', { sessionId: 'bg-test-0002', cwd: project, window: false })).ok, true);
  await until('the second session online', () => gw.streams.has('bg-test-0002'));
  await toSession('bg-test-0002', 'send', { text: '/exit' });
  await until('ended by /exit', () => svc.sessions.list().find((s) => s.sessionId === 'bg-test-0002')?.state === 'exited');
  assert.equal(svc.sessions.list().find((s) => s.sessionId === 'bg-test-0002').restarts, 0, 'not taken for a crash');

  // a later service takes over a session that runs, and opens again one that does not (a reboot)
  assert.equal((await toHost('open', { sessionId: 'bg-test-0003', cwd: project, window: false })).ok, true);
  await until('the third session online', () => peerOf('bg-test-0003') && stateOf('bg-test-0003')?.state === 'running');
  const pid3 = svc.sessions.sessions.get('bg-test-0003').pid;
  await svc.stop();
  assert.ok(pidAlive(pid3), 'the sessions outlive the service');
  svc = startService();
  assert.equal(svc.sessions.sessions.get('bg-test-0003').pid, pid3, 'taken over');
  assert.equal(svc.sessions.sessions.get('bg-test-0003').state, 'running');
  await svc.stop();
  killTree(pid3);
  await until('gone', () => !pidAlive(pid3) && !peerOf('bg-test-0003'));
  const saved = JSON.parse(fs.readFileSync(path.join(configDir, 'host-sessions.json'), 'utf8'));
  fs.writeFileSync(path.join(configDir, 'host-sessions.json'), JSON.stringify(saved.map((s) => ({ ...s, boot: 0 }))));
  const regs3 = gw.registrations.filter((r) => r.id === 'bg-test-0003').length;
  svc = startService();
  await until('opened again after the "reboot"', () => gw.registrations.filter((r) => r.id === 'bg-test-0003').length > regs3 && peerOf('bg-test-0003'), 60_000);
  assert.ok(logs.some((l) => /opening the background session bg-test-0003 again/.test(l)));
});
