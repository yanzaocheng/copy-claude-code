// The terminals of the console's page (its 终端 tabs) run here, in a process of their own: the console restarts when
// its code changes (an update, an edit in a source checkout) once its sessions are idle, and a shell hanging on its
// process would end with it. This one stays. The next console finds it by the state file it is given,
// CONFIG_DIR/web-pty.json {pid, port, token, code, v}, and a page that comes back gets each terminal's screen as it is
// now (a headless xterm keeps it, with its scrollback) and then what follows.
//
// It knows nothing of claude-pro: what to run, where and with which environment comes with each request (see pty.js),
// so that one started by older code still serves a newer console. It answers only on 127.0.0.1 and only requests
// with its token, and exits once it has had no terminal for a few minutes.
//
//   node pty-host.js <state file>

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROTOCOL = 1;
const SCROLLBACK = 3000; // lines a page gets back
const IDLE_EXIT_MS = 3 * 60_000; // no terminal this long: the process ends
const EXITED_KEEP_MS = 30 * 60_000; // a shell that ended, its tab not closed and nobody looking: forgotten after this
const FLUSH_MS = 8; // output is sent in pieces at most this often (a burst is one event, not thousands)
const PING_MS = 25_000;
const SLOW_CLIENT_BYTES = 8 * 1024 * 1024; // a page that does not take what it is sent: cut (it reconnects, gets the screen)
const MAX_TERMINALS = 64;
const BODY_LIMIT = 4 * 1024 * 1024;

const stateFile = process.argv[2];
if (!stateFile) {
  process.stderr.write('usage: node pty-host.js <state file>\n');
  process.exit(2);
}
const logFile = path.join(path.dirname(stateFile), 'web-pty.log');
const token = crypto.randomBytes(24).toString('base64url');
const code = crypto.createHash('sha1').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 12);

function log(e, where = '') {
  try {
    if (fs.statSync(logFile, { throwIfNoEntry: false })?.size > 512 * 1024) fs.rmSync(logFile, { force: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${where} ${e?.stack || e}\n`);
  } catch { /* nowhere to say it */ }
}
// a shell gone wrong must not take the others with it
process.on('uncaughtException', (e) => log(e, 'uncaught'));
process.on('unhandledRejection', (e) => log(e, 'unhandled rejection'));

// (loaded here rather than imported: on a system node-pty has no binary for, the reason goes to the log, and the
// console reports it)
let pty, Terminal, SerializeAddon;
try {
  pty = (await import('@lydell/node-pty')).default;
  ({ Terminal } = (await import('@xterm/headless')).default);
  ({ SerializeAddon } = (await import('@xterm/addon-serialize')).default);
} catch (e) {
  log(e, 'loading');
  process.exit(3);
}

const terminals = new Map(); // id -> {id, proc, term, ser, clients: Set<{res, buf, live}>, flushTimer, info}
let idleSince = Date.now();
const clamp = (v, lo, hi, dflt) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt);

function sendEvent(c, msg) {
  if (c.res.destroyed) return;
  c.res.write(`data: ${JSON.stringify(msg)}\n\n`);
  if (c.res.writableLength > SLOW_CLIENT_BYTES) c.res.destroy();
}

function flush(t) {
  clearTimeout(t.flushTimer);
  t.flushTimer = null;
  for (const c of t.clients) {
    if (!c.live || !c.buf) continue;
    const d = c.buf;
    c.buf = '';
    sendEvent(c, { t: 'out', d });
  }
}

function create(spec) {
  if (terminals.size >= MAX_TERMINALS) throw Object.assign(new Error(`最多同时开 ${MAX_TERMINALS} 个终端`), { status: 409 });
  if (typeof spec?.file !== 'string' || !spec.file || typeof spec.cwd !== 'string' || !spec.cwd) throw Object.assign(new Error('file and cwd are required'), { status: 400 });
  const cols = clamp(spec.cols, 2, 1000, 80);
  const rows = clamp(spec.rows, 1, 500, 24);
  const windowsPty = spec.windowsPty && typeof spec.windowsPty === 'object' ? spec.windowsPty : undefined;
  const proc = pty.spawn(spec.file, Array.isArray(spec.args) ? spec.args.map(String) : [], {
    name: 'xterm-256color', cols, rows, cwd: spec.cwd, env: spec.env && typeof spec.env === 'object' ? spec.env : process.env,
  });
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true, ...(windowsPty ? { windowsPty } : {}) });
  const ser = new SerializeAddon();
  term.loadAddon(ser);
  const id = crypto.randomBytes(6).toString('hex');
  const t = {
    id, proc, term, ser, clients: new Set(), flushTimer: null,
    info: {
      id, label: String(spec.label || path.basename(spec.file)), shell: String(spec.shell || ''), cwd: spec.cwd,
      workspace: String(spec.workspace || spec.cwd), cols, rows, pid: proc.pid, title: '', startedAt: Date.now(),
      exited: false, exitCode: null, endedAt: null,
    },
  };
  term.onTitleChange((title) => { t.info.title = String(title).slice(0, 200); });
  proc.onData((d) => {
    term.write(d);
    for (const c of t.clients) c.buf += d;
    t.flushTimer ??= setTimeout(() => flush(t), FLUSH_MS);
  });
  proc.onExit(({ exitCode }) => {
    Object.assign(t.info, { exited: true, exitCode: exitCode ?? null, endedAt: Date.now() });
    flush(t);
    for (const c of t.clients) if (c.live) sendEvent(c, { t: 'exit', code: t.info.exitCode });
  });
  terminals.set(id, t);
  return t.info;
}

function remove(t) {
  terminals.delete(t.id);
  if (!terminals.size) idleSince = Date.now();
  clearTimeout(t.flushTimer);
  if (!t.info.exited) { try { t.proc.kill(); } catch { /* gone already */ } }
  for (const c of t.clients) {
    sendEvent(c, { t: 'closed' });
    c.res.end();
  }
  t.clients.clear();
  try { t.term.dispose(); } catch { /* ignore */ }
}

// A page watching a terminal: the screen as it is (once what came before is drawn on the headless terminal), then the
// output as it comes. Output that arrives while the screen is being taken is kept for this page and follows it.
function attach(t, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  const c = { res, buf: '', live: false };
  t.clients.add(c);
  t.term.write('', () => {
    if (res.destroyed || !t.clients.has(c)) return;
    let screen = '';
    try { screen = t.ser.serialize({ scrollback: SCROLLBACK }); } catch (e) { log(e, 'serialize'); }
    sendEvent(c, { t: 'snapshot', d: screen, cols: t.term.cols, rows: t.term.rows, info: t.info });
    c.live = true;
    if (c.buf) { const d = c.buf; c.buf = ''; sendEvent(c, { t: 'out', d }); }
    if (t.info.exited) sendEvent(c, { t: 'exit', code: t.info.exitCode });
  });
  const ping = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, PING_MS);
  res.on('close', () => { clearInterval(ping); t.clients.delete(c); });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > BODY_LIMIT) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(d);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const equal = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  try {
    if (!equal(req.headers.authorization, `Bearer ${token}`)) return send(401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/hello') return send(200, { v: PROTOCOL, pid: process.pid, code, terminals: [...terminals.values()].filter((t) => !t.info.exited).length });
    if (req.method === 'GET' && url.pathname === '/terminals') return send(200, { terminals: [...terminals.values()].map((t) => t.info) });
    if (req.method === 'POST' && url.pathname === '/terminals') return send(200, create(await readBody(req)));
    // a console with newer code: this one ends if nothing runs in it (`force`: in any case)
    if (req.method === 'POST' && url.pathname === '/quit') {
      const body = await readBody(req);
      const running = [...terminals.values()].filter((t) => !t.info.exited).length;
      if (running && !body.force) return send(409, { error: 'terminals running', terminals: running });
      send(200, { ok: true });
      setTimeout(quit, 50);
      return;
    }
    const m = /^\/terminals\/([0-9a-f]{12})(?:\/(events|input|resize))?$/.exec(url.pathname);
    const t = m && terminals.get(m[1]);
    if (!t) return send(404, { error: '这个终端已经关闭' });
    if (req.method === 'GET' && m[2] === 'events') return attach(t, res);
    if (req.method === 'POST' && m[2] === 'input') {
      const { data } = await readBody(req);
      if (typeof data === 'string' && data && !t.info.exited) t.proc.write(data);
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && m[2] === 'resize') {
      const body = await readBody(req);
      const cols = clamp(body.cols, 2, 1000, t.info.cols);
      const rows = clamp(body.rows, 1, 500, t.info.rows);
      if (cols !== t.info.cols || rows !== t.info.rows) {
        if (!t.info.exited) { try { t.proc.resize(cols, rows); } catch (e) { log(e, 'resize'); } }
        t.term.resize(cols, rows);
        Object.assign(t.info, { cols, rows });
      }
      return send(200, { ok: true });
    }
    if (req.method === 'DELETE' && !m[2]) { remove(t); return send(200, { ok: true }); }
    return send(404, { error: 'not found' });
  } catch (e) {
    if (!e.status) log(e, req.url);
    return send(e.status || 500, { error: e.message || String(e) });
  }
});

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
}

function quit() {
  for (const t of [...terminals.values()]) remove(t);
  if (readState()?.pid === process.pid) { try { fs.rmSync(stateFile, { force: true }); } catch { /* ignore */ } }
  process.exit(0);
}

// One host for the user: a second one started meanwhile (two consoles at once, for a moment) leaves.
async function anotherAnswers() {
  const s = readState();
  if (!s?.port || !s.token || s.pid === process.pid) return false;
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: s.port, path: '/hello', headers: { authorization: `Bearer ${s.token}` }, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

if (await anotherAnswers()) process.exit(0);
server.listen(0, '127.0.0.1', () => {
  const state = { v: PROTOCOL, pid: process.pid, port: server.address().port, token, code, startedAt: Date.now() };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
});
setInterval(() => {
  const now = Date.now();
  for (const t of [...terminals.values()]) if (t.info.exited && !t.clients.size && now - t.info.endedAt > EXITED_KEEP_MS) remove(t);
  if (!terminals.size && now - idleSince > IDLE_EXIT_MS) quit();
}, 30_000);
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
