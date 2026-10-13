import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Background sessions for real: the computer service (HostService + BackgroundSessions) against a fake gateway
// starts claude-pro --headless processes (each a supervisor and its session), which go online at the gateway as
// background sessions of this computer, answer the page, write their log, can be attached to, restarted, crash
// and come back, end with /exit or the service's stop, and are taken over or opened again by a later service.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-bg-config-'));
process.env.CLAUDE_PRO_CONFIG_DIR = configDir;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'claude-pro.js');

const { HostService, computerId } = await import('../src/host.js');
const { BackgroundSessions, killTree, pidAlive, liveSessionProcesses } = await import('../src/background.js');
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
const toolReply = (id, name, input) => frames([
  { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]);
const LONG_COMMAND = 'node -e "let i = 0; const t = setInterval(() => { console.log(\'tick \' + (++i)); if (i === 12) clearInterval(t); }, 400)"';
const gw = { hostStream: null, states: [], sessions: new Map(), registrations: [], streams: new Map(), pending: new Map(), cid: 0, outputs: new Map(), byes: [] };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b ? JSON.parse(b) : {})); });
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/v1/messages') {
    const body = await readBody(req);
    const last = JSON.stringify(body.messages.at(-1).content);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // a long task: a command that prints for a few seconds, then an answer
    if (last.includes('toolu_long')) return res.end(textReply('Long task done.'));
    if (last.includes('long task')) return res.end(toolReply('toolu_long', 'Bash', { command: LONG_COMMAND, description: 'Count slowly' }));
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

const until = async (what, check, timeout = 60_000) => { // generous: the whole suite runs at once
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
    // the supervisors (and their sessions), then any session left; again once whatever was starting has started
    for (let round = 0; round < 2; round++) {
      for (const rec of svc.sessions.sessions.values()) if (rec.pid) killTree(rec.pid);
      for (const p of listPeers()) if (p.kind === 'background') killTree(p.pid);
      await new Promise((r) => setTimeout(r, 2000));
    }
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

  // `claude-pro attach worker` (its own terminal here): attached, typing, still attached across a restart, detached
  const { attachCommand } = await import('../src/attach.js');
  const { PassThrough } = await import('node:stream');
  const keys = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
  const term = Object.assign(new PassThrough(), { isTTY: true, columns: 90, rows: 30 });
  let shown = '';
  term.on('data', (d) => { shown += d; });
  const attached = attachCommand(['worker'], { stdin: keys, stdout: term, stderr: term });
  await until('attached', () => shown.includes('\x1b[?1049h'));
  await until('one terminal attached, reported', () => stateOf('bg-test-0001')?.attached === 1);
  keys.write('/status\r');
  await until('typed there, run here', async () => /Remote control/.test((await toHost('logs', { sessionId: 'bg-test-0001' })).text));

  // restart: the same process tree, a new session process, the same id at the gateway
  const before = peerOf('bg-test-0001').pid;
  const regs = gw.registrations.filter((r) => r.id === 'bg-test-0001').length;
  assert.equal((await toHost('restart', { sessionId: 'bg-test-0001' })).ok, true);
  await until('restarted', () => peerOf('bg-test-0001') && peerOf('bg-test-0001').pid !== before && stateOf('bg-test-0001')?.state === 'running');
  await until('registered again', () => gw.registrations.filter((r) => r.id === 'bg-test-0001').length > regs);
  await until('attach back on the restarted session', () => shown.split('\x1b[?1049h').length >= 3, 30_000);
  keys.write('\x1d'); // ctrl+]
  assert.equal(await attached, 0);
  assert.match(shown, /Detached from &worker: it goes on in the background/);
  assert.ok(peerOf('bg-test-0001'), 'it goes on');
  await until('none attached, reported', () => stateOf('bg-test-0001')?.attached === 0);

  // brought to the front while a long task runs: the window shows it going on, and the task is not cut short
  assert.equal((await toSession('bg-test-0001', 'send', { text: 'start the long task' })).ok, true);
  await new Promise((r) => setTimeout(r, 1500)); // the command runs (it prints for about 5 seconds)
  const peer2 = peerOf('bg-test-0001');
  const socket2 = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: peer2.port, path: '/attach?cols=100&rows=30', headers: { connection: 'Upgrade', upgrade: 'claude-pro-attach', authorization: `Bearer ${peer2.token}` } });
    req.on('upgrade', (_res, s2) => resolve(s2));
    req.on('error', reject);
    req.end();
  });
  let live = '';
  socket2.on('data', (d) => { live += d; });
  const plain = () => live.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  await until('the running command in the window', () => /Count slowly|tick \d+/.test(plain()));
  const before2 = live.length;
  await until('more of it, live', () => live.length > before2 + 50);
  await until('the task done', () => (gw.outputs.get('bg-test-0001') || []).some((l) => /Long task done/.test(l)), 30_000);
  assert.ok(!(gw.outputs.get('bg-test-0001') || []).some((l) => /Interrupted/.test(l)), 'not interrupted');
  await until('its end in the window too', () => /Long task done/.test(plain()));
  await until('attached, reported', () => stateOf('bg-test-0001')?.attached === 1);
  // its window closed (the X): the process is gone, its connection closed without a word; the session goes on
  const closedAt = Date.now();
  socket2.end();
  await until('none attached, reported at once', () => stateOf('bg-test-0001')?.attached === 0);
  assert.ok(Date.now() - closedAt < 8000, `reported after ${Date.now() - closedAt} ms`);
  assert.ok(peerOf('bg-test-0001') && stateOf('bg-test-0001').state === 'running', 'the session goes on');

  // window: the same, in a new terminal window, through the service
  const launched = [];
  const realLaunch = svc.service.launch;
  const realTerminal = svc.service.terminal;
  svc.service.launch = async (spec) => { launched.push(spec); };
  svc.service.terminal = { kind: 'wt', name: 'Windows Terminal', path: 'wt.exe' };
  const win = await toHost('window', { sessionId: 'bg-test-0001' });
  assert.deepEqual([win.ok, win.terminal], [true, 'Windows Terminal'], win.error);
  const a = launched[0].args;
  assert.deepEqual(a.slice(0, 4), ['-w', 'new', '--title', 'worker · claude-pro']);
  assert.deepEqual(a.slice(4, 6), ['-d', project]);
  assert.deepEqual(a.slice(-3), ['attach', 'bg-test-0001', '--keep-open']);
  assert.equal((await toHost('window', { sessionId: 'nope-not-here' })).error, '这个会话不是这台电脑上的后台会话');
  svc.service.terminal = null;
  assert.equal((await toHost('window', { sessionId: 'bg-test-0001' })).error, '这台电脑没有可以打开窗口的桌面（可以在终端里运行 claude-pro attach worker）');
  svc.service.launch = realLaunch;
  svc.service.terminal = realTerminal;

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

  // delete: a conversation open in a background session of the service is ended first only when asked; one open in a
  // terminal is not touched; one that is closed is gone with its files
  const { projectDir } = await import('../src/session.js');
  assert.equal((await toHost('open', { sessionId: 'bg-test-0004', cwd: project, window: false })).ok, true);
  await until('the fourth session online', () => gw.streams.has('bg-test-0004') && peerOf('bg-test-0004'));
  await toSession('bg-test-0004', 'send', { text: 'remember this' });
  await until('its answer', () => (gw.outputs.get('bg-test-0004') || []).some((l) => /Hello from the model/.test(l)));
  const conv4 = peerOf('bg-test-0004').conversationId;
  const file4 = path.join(projectDir(project), `${conv4}.jsonl`);
  assert.ok(fs.existsSync(file4));
  assert.equal((await toHost('delete', { conversationId: conv4 })).error, `这段对话正开在会话 &${peerOf('bg-test-0004').name} 里：先结束它`);
  assert.ok(fs.existsSync(file4) && peerOf('bg-test-0004'), 'nothing done');
  const deleted = await toHost('delete', { conversationId: conv4, stop: true });
  assert.equal(deleted.ok, true, deleted.error);
  assert.ok(deleted.files >= 2 && deleted.bytes > 0, JSON.stringify(deleted)); // the conversation and the session's log
  assert.equal(fs.existsSync(file4), false);
  assert.equal(fs.existsSync(svc.sessions.logFile('bg-test-0004')), false, 'its log: it holds the conversation too');
  assert.equal(peerOf('bg-test-0004'), undefined, 'the session ended first');
  assert.ok(!svc.sessions.list().some((x) => x.sessionId === 'bg-test-0004'), 'not to be opened again');
  assert.ok(!(await toHost('history', {})).items.some((i) => i.conversationId === conv4));
  assert.equal((await toHost('delete', { conversationId: '../../outside-1' })).error, '对话 id 不对');
  assert.equal((await toHost('delete', { conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })).error, '这台电脑上没有这段对话');
  // open in a terminal (a registry entry of a terminal session, here this process): refused, nothing deleted
  const termConv = '11112222-3333-4444-5555-666677778888';
  const termFile = path.join(projectDir(project), `${termConv}.jsonl`);
  fs.writeFileSync(termFile, `${JSON.stringify({ type: 'meta', cwd: project })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: 'x' } })}\n`);
  const fakePeer = path.join(configDir, 'peers', 'aaaabbbbcccc.json');
  fs.writeFileSync(fakePeer, JSON.stringify({ id: 'aaaabbbbcccc', name: 'in-a-terminal', cwd: project, pid: process.pid, port: 9, token: 't', kind: 'terminal', conversationId: termConv }));
  assert.equal((await toHost('delete', { conversationId: termConv, stop: true })).error, '这段对话正开在终端里的会话 &in-a-terminal 里：请先在那台电脑上结束它（/exit）');
  assert.ok(fs.existsSync(termFile));
  fs.rmSync(fakePeer);
  assert.equal((await toHost('delete', { conversationId: termConv })).ok, true, 'closed: deleted');
  assert.equal(fs.existsSync(termFile), false);

  // a later service takes over a session that runs, and opens again one that does not (a reboot)
  assert.equal((await toHost('open', { sessionId: 'bg-test-0003', cwd: project, window: false })).ok, true);
  await until('the third session online', () => peerOf('bg-test-0003') && stateOf('bg-test-0003')?.state === 'running');
  const pid3 = svc.sessions.sessions.get('bg-test-0003').pid;
  await svc.stop();
  assert.ok(pidAlive(pid3), 'the sessions outlive the service');
  svc = startService();
  assert.equal(svc.sessions.sessions.get('bg-test-0003').pid, pid3, 'taken over');
  assert.equal(svc.sessions.sessions.get('bg-test-0003').state, 'running');
  // service after service (new versions), the session's own process restarted in between: still one copy
  const one = () => { const p = liveSessionProcesses().get('bg-test-0003'); return [p?.supervisors.length ?? 0, p?.sessions.length ?? 0]; };
  for (let round = 0; round < 3; round++) {
    await until('this service online', () => gw.hostStream && svc.service.online && !gw.hostStream.writableEnded);
    const child = peerOf('bg-test-0003').pid;
    assert.equal((await toHost('restart', { sessionId: 'bg-test-0003' })).ok, true);
    await until(`restarted, round ${round}`, () => peerOf('bg-test-0003') && peerOf('bg-test-0003').pid !== child && stateOf('bg-test-0003')?.state === 'running');
    await svc.stop();
    gw.hostStream = null; // the stopped service's
    svc = startService();
    assert.equal(svc.sessions.sessions.get('bg-test-0003').pid, pid3, `taken over again, round ${round}`);
    assert.deepEqual(one(), [1, 1], `one supervisor and one session, round ${round}`);
  }
  assert.ok(!logs.some((l) => /opening the background session bg-test-0003 again/.test(l)), 'never opened twice');
  // a copy that should not be there (as a service before this fix made): the next service ends it, keeps the one it knew
  const copy = spawn(process.execPath, [BIN, '--headless', '--remote-id', 'bg-test-0003'], { cwd: project, env: sessionEnv, detached: true, windowsHide: true, stdio: 'ignore' });
  copy.unref();
  await until('the copy runs', () => liveSessionProcesses().get('bg-test-0003')?.supervisors.length === 2);
  await svc.stop();
  svc = startService();
  assert.equal(svc.sessions.sessions.get('bg-test-0003').pid, pid3, 'the one it knew is kept');
  await until('the copy ended', () => !pidAlive(copy.pid) && one()[0] === 1 && one()[1] === 1, 30_000);
  assert.ok(logs.some((l) => new RegExp(`ran twice: ended the copy with pid ${copy.pid}`).test(l)));
  await svc.stop();
  killTree(pid3);
  await until('gone', () => !pidAlive(pid3) && !peerOf('bg-test-0003'));
  const regs3 = gw.registrations.filter((r) => r.id === 'bg-test-0003').length;
  svc = startService();
  await until('opened again after the "reboot"', () => gw.registrations.filter((r) => r.id === 'bg-test-0003').length > regs3 && peerOf('bg-test-0003'), 60_000);
  assert.ok(logs.some((l) => /opening the background session bg-test-0003 again/.test(l)));
});
