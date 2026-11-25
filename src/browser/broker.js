// The connections to the user's own browsers, held by one process for every claude-pro session of this user.
//
// A browser whose remote debugging was turned on in its settings (edge://inspect, chrome://inspect) asks the user to
// allow every new connection, and has no "always allow". With a connection per claude-pro process, every restart
// (one after every change to claude-pro's own source, in every open session) and every other session asked again:
// the user had to click Allow over and over. The broker keeps one connection per browser instance and lends it to
// the sessions over a local pipe, passing the DevTools messages through: their ids renumbered, the events of an
// attached tab sent to the session that attached it, the browser's own events to all. It closes a connection ten
// minutes after the last session let go of it (a restart takes seconds), and exits when it has none.
//
// It runs as `node broker.js --serve`, started by the first session that needs it (connectShared); a session that
// cannot reach it connects on its own, as before. Only browsers on this computer are connected to, and a session
// must show the token the broker wrote into the config directory.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from '../utils/proc.js';
import { fileURLToPath } from 'node:url';
import { Cdp, CdpError, abortError } from './cdp.js';
import { CONFIG_DIR } from '../config.js';

export const brokerLimits = {
  keepMs: 10 * 60_000, // a connection no session uses any more stays this long
  exitMs: 30_000, // the broker exits after this long with no connection and no session
  openMs: 120_000, // the user may take a while to click Allow
  startMs: 5_000, // for a new broker to start listening
};
const PROTOCOL = 1;

const pipePath = (dir) => (process.platform === 'win32'
  ? `\\\\.\\pipe\\claude-pro-browser-${crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 12)}`
  : path.join(dir, 'browser-broker.sock'));
const stateFile = (dir) => path.join(dir, 'browser-broker.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const onThisComputer = (url) => {
  try {
    const u = new URL(url);
    return /^wss?:$/.test(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch { return false; }
};

// Newline-separated JSON on a socket: `onLine(text)` for each line.
function lines(sock, onLine) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
}

// ---- The broker

// One browser connection, shared by the sessions (`clients`) that use it.
class Upstream {
  constructor(url, onGone) {
    this.url = url;
    this.onGone = onGone;
    this.ws = null;
    this.connecting = null;
    this.clients = new Set();
    this.pending = new Map(); // id sent to the browser -> {client, id: the client's own, method}
    this.owners = new Map(); // sessionId of an attached tab -> the client that attached it
    this.nextId = 1;
    this.opens = 0; // connections made (each one the user had to allow)
    this.keep = null;
  }

  get open() { return this.ws?.readyState === 1; }

  connect() {
    if (this.open) return Promise.resolve();
    this.connecting ??= new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connecting = null;
        try { ws.close(); } catch { /* not open */ }
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error(`the browser did not accept the connection within ${brokerLimits.openMs / 1000} s (nobody allowed remote debugging?)`)), brokerLimits.openMs);
      ws.onopen = () => {
        if (settled) { try { ws.close(); } catch { /* gone */ } return; }
        settled = true;
        clearTimeout(timer);
        this.connecting = null;
        this.ws = ws;
        this.opens++;
        ws.onmessage = (m) => this.receive(m.data);
        ws.onclose = () => this.lost('the browser closed the connection');
        ws.onerror = () => {};
        resolve();
      };
      ws.onerror = (e) => fail(new Error(`cannot connect to the browser: ${e?.message || e?.error?.message || 'connection refused or declined'}`));
      ws.onclose = (e) => fail(new Error(`the browser refused the connection${e?.code && e.code !== 1006 ? ` (${e.code}${e.reason ? ` ${e.reason}` : ''})` : ''}: remote debugging was declined or turned off`));
    });
    return this.connecting;
  }

  add(client) {
    this.clients.add(client);
    clearTimeout(this.keep);
    this.keep = null;
  }

  // A session let go: its tabs are detached, and the connection is kept a while for the next one.
  remove(client) {
    if (!this.clients.delete(client)) return;
    for (const [sessionId, owner] of this.owners) {
      if (owner !== client) continue;
      this.owners.delete(sessionId);
      if (this.open) this.ws.send(JSON.stringify({ id: this.nextId++, method: 'Target.detachFromTarget', params: { sessionId } }));
    }
    for (const [id, p] of this.pending) if (p.client === client) this.pending.delete(id);
    if (!this.clients.size) {
      clearTimeout(this.keep);
      this.keep = setTimeout(() => this.close(), brokerLimits.keepMs);
    }
  }

  send(client, msg) {
    if (!this.open) {
      if (msg.id !== undefined) client.write({ id: msg.id, error: { code: -32000, message: 'the browser connection is closed' } });
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, { client, id: msg.id, method: msg.method });
    this.ws.send(JSON.stringify({ ...msg, id }));
  }

  receive(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return; // a detach of the broker's own
      this.pending.delete(msg.id);
      if (p.method === 'Target.attachToTarget' && msg.result?.sessionId) this.owners.set(msg.result.sessionId, p.client);
      p.client.write({ ...msg, id: p.id });
      return;
    }
    if (msg.sessionId) { this.owners.get(msg.sessionId)?.write(msg); return; }
    if (msg.method === 'Target.detachedFromTarget') this.owners.delete(msg.params?.sessionId);
    for (const c of this.clients) c.write(msg);
  }

  lost(reason) {
    this.ws = null;
    for (const c of [...this.clients]) c.end(reason);
    this.clients.clear();
    this.gone();
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch { /* gone */ }
    }
    this.gone();
  }

  gone() {
    clearTimeout(this.keep);
    this.keep = null;
    this.onGone(this);
  }
}

export function serve(dir = CONFIG_DIR) {
  const token = crypto.randomBytes(24).toString('hex');
  const upstreams = new Map(); // url -> Upstream
  let sessions = 0;
  let exitTimer = null;
  const maybeExit = () => {
    clearTimeout(exitTimer);
    if (!sessions && !upstreams.size) exitTimer = setTimeout(() => process.exit(0), brokerLimits.exitMs);
  };
  const server = net.createServer((sock) => {
    sessions++;
    clearTimeout(exitTimer);
    let upstream = null;
    let greeted = false;
    const client = {
      write: (msg) => { if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`); },
      end: (reason) => { client.write({ t: 'closed', reason }); sock.end(); },
    };
    const refuse = (message, extra = {}) => { client.write({ t: 'error', message, ...extra }); sock.end(); };
    const hello = async (msg) => {
      if (msg.token !== token) return refuse('not allowed');
      if (msg.protocol !== PROTOCOL) return refuse(`the broker speaks protocol ${PROTOCOL}`, { protocol: PROTOCOL });
      if (msg.t === 'status') {
        client.write({ t: 'status', pid: process.pid, upstreams: [...upstreams.values()].map((u) => ({ url: u.url, sessions: u.clients.size, opens: u.opens, open: u.open })) });
        return sock.end();
      }
      if (!onThisComputer(msg.url)) return refuse('only a browser on this computer');
      let u = upstreams.get(msg.url);
      if (!u) {
        u = new Upstream(msg.url, (gone) => { if (upstreams.get(gone.url) === gone) upstreams.delete(gone.url); maybeExit(); });
        upstreams.set(msg.url, u);
      }
      upstream = u;
      u.add(client);
      const waiting = setTimeout(() => client.write({ t: 'waiting' }), 1500);
      try {
        await u.connect();
        clearTimeout(waiting);
        client.write({ t: 'open' });
      } catch (e) {
        clearTimeout(waiting);
        u.remove(client);
        if (!u.clients.size && !u.open) u.gone();
        refuse(e.message);
      }
    };
    lines(sock, (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (!greeted) { greeted = true; hello(msg); return; }
      if (upstream?.open) upstream.send(client, msg);
    });
    sock.on('close', () => {
      sessions--;
      upstream?.remove(client);
      maybeExit();
    });
    sock.on('error', () => {});
  });
  server.on('error', () => process.exit(0)); // another broker has the pipe: it serves
  server.listen(pipePath(dir), () => {
    try { fs.writeFileSync(stateFile(dir), JSON.stringify({ pid: process.pid, pipe: pipePath(dir), token, protocol: PROTOCOL }), { mode: 0o600 }); } catch { process.exit(1); }
    maybeExit();
  });
  return server;
}

// ---- A session's side

function readState(dir) {
  try { return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')); } catch { return null; }
}

function dial(pipe) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    sock.once('connect', () => { sock.removeListener('error', reject); resolve(sock); });
    sock.once('error', reject);
  });
}

function startBroker() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.on('error', () => {});
  child.unref();
}

// A socket to the broker, and the token to show it: the running one, else one started now.
async function reach(dir) {
  let state = readState(dir);
  if (state?.pipe) {
    try { return { sock: await dial(state.pipe), state }; } catch { /* gone */ }
  }
  startBroker();
  for (const until = Date.now() + brokerLimits.startMs; Date.now() < until;) {
    await sleep(100);
    state = readState(dir);
    if (!state?.pipe) continue;
    try { return { sock: await dial(state.pipe), state }; } catch { /* not listening yet, or the old one's file */ }
  }
  throw new Error('the browser broker did not start');
}

// The broker's connection to the browser at `url`, in the shape Cdp takes (send, close, onmessage, onclose). Rejects
// with a CdpError when the browser refuses or nobody allows it (as Cdp.connect), with another error when the broker
// cannot be had.
export async function brokerSocket(url, { signal, timeoutMs = brokerLimits.openMs, onWaiting, dir = CONFIG_DIR } = {}) {
  if (signal?.aborted) throw abortError();
  const { sock, state } = await reach(dir);
  return new Promise((resolve, reject) => {
    let settled = false;
    let handler = null;
    const queue = []; // what comes before Cdp takes over
    const socket = {
      onclose: null,
      onerror: null,
      get onmessage() { return handler; },
      set onmessage(h) { handler = h; while (handler && queue.length) handler({ data: queue.shift() }); },
      send: (text) => { if (!sock.destroyed) sock.write(`${text}\n`); },
      close: () => sock.end(),
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      sock.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new CdpError(`the browser did not accept the connection within ${timeoutMs / 1000} s (nobody allowed remote debugging?)`)), timeoutMs);
    const onAbort = () => fail(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    lines(sock, (line) => {
      if (!settled) {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.t === 'waiting') { onWaiting?.(); return; }
        if (msg.t === 'open') {
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(socket);
          return;
        }
        if (msg.t === 'error') {
          // the browser's answer is the browser's; the broker's own trouble (another protocol) is not
          fail(msg.protocol ? new Error(msg.message) : new CdpError(msg.message));
          return;
        }
        return;
      }
      if (line.startsWith('{"t":"closed"')) { sock.end(); return; }
      if (handler) handler({ data: line }); else queue.push(line);
    });
    sock.on('close', () => { if (settled) socket.onclose?.({}); else fail(new Error('the browser broker went away')); });
    sock.on('error', () => {});
    sock.write(`${JSON.stringify({ t: 'hello', token: state.token, protocol: PROTOCOL, url })}\n`);
  });
}

// A Cdp to the browser at `url` through the broker, so that the user allows it once for all sessions and restarts;
// one of this process's own when the broker cannot be had.
export async function connectShared(url, opts = {}) {
  let socket;
  try {
    socket = await brokerSocket(url, opts);
  } catch (e) {
    if (e?.name === 'AbortError' || e instanceof CdpError) throw e;
    return Cdp.connect(url, opts);
  }
  return new Cdp(socket);
}

// What the broker holds (for tests and diagnosis): {pid, upstreams: [{url, sessions, opens, open}]}, or null.
export async function brokerStatus(dir = CONFIG_DIR) {
  const state = readState(dir);
  if (!state?.pipe) return null;
  let sock;
  try { sock = await dial(state.pipe); } catch { return null; }
  return new Promise((resolve) => {
    lines(sock, (line) => { try { resolve(JSON.parse(line)); } catch { resolve(null); } sock.end(); });
    sock.on('close', () => resolve(null));
    sock.write(`${JSON.stringify({ t: 'status', token: state.token, protocol: PROTOCOL })}\n`);
  });
}

if (process.argv.includes('--serve') && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
