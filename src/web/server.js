// The local web console (claude-pro web, /web): a page on http://127.0.0.1:7878 that shows and edits what the
// terminal does (settings, providers, memory, extensions), every project's conversations, the usage, and the sessions
// running now, live, with a box to send them messages.
//
// One server for the user, shared by every session: `node server.js --serve`, started by the first /web
// (ensureWebServer). Its address and secret are in CONFIG_DIR/web.json (readable by the user alone); /web opens the
// page with the secret once, and the page keeps it as a cookie. It answers only on 127.0.0.1, only requests that name
// it as their host (no DNS rebinding), and changes only from its own page (Origin). It exits 30 minutes after the
// last page went away, and gives way to a newer one (another version, or its code changed in a source checkout).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, VERSION } from '../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7878;
const IDLE_MS = 30 * 60_000;
const BODY_LIMIT = 20 * 1024 * 1024;
const COOKIE = 'cpweb';
export const stateFile = () => path.join(CONFIG_DIR, 'web.json');

const STATIC = {
  '/': ['page.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

// What the code of the console is: the version, and in a source checkout the times of its files, so that a server
// started by older code gives way to the new one.
export function codeStamp() {
  const files = ['server.js', 'api.js', 'data.js', 'page.html', 'app.js', 'app.css'].map((f) => path.join(HERE, f));
  files.push(path.join(HERE, '..', 'live.js'), path.join(HERE, '..', 'remote.js'), path.join(HERE, '..', 'session.js'), path.join(HERE, '..', 'config.js'));
  const times = files.map((f) => { try { return Math.round(fs.statSync(f).mtimeMs); } catch { return 0; } });
  return `${VERSION}:${crypto.createHash('sha1').update(times.join(',')).digest('hex').slice(0, 10)}`;
}

// ---------------------------------------------------------------- the server

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > BODY_LIMIT) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(undefined);
      try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
};
const equal = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function serve() {
  // the secret of the server before this one, when there was one: the page's cookie stays good across a restart
  const before = readState()?.token;
  const token = typeof before === 'string' && /^[\w-]{32}$/.test(before) ? before : crypto.randomBytes(24).toString('base64url');
  const code = codeStamp(); // the code this server runs (a later start compares it with the files as they are then)
  const { routes } = await import('./api.js');
  const data = await import('./data.js');
  data.purgeTrash();
  let port = PORT;
  let lastActivity = Date.now();
  let streams = 0;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const send = (res, status, body, headers = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(text);
  };

  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    // only requests for this server by its own name: a page elsewhere cannot reach it through a name that points here
    if (!hosts().has(String(req.headers.host || '').toLowerCase())) return send(res, 421, { error: 'wrong host' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      // the secret, once, from /web: kept as a cookie, then out of the address
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
        if (!equal(url.searchParams.get('t'), token)) return send(res, 403, { error: '链接已失效：请在 claude-pro 里重新运行 /web' });
        res.writeHead(302, { location: '/', 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`, 'cache-control': 'no-store' });
        return res.end();
      }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
        return res.end(fs.readFileSync(path.join(HERE, file)));
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      const authed = equal(cookieOf(req, COOKIE), token) || equal(String(req.headers.authorization || '').replace(/^Bearer /, ''), token);
      if (!authed) return send(res, 401, { error: '需要从 claude-pro 打开：在会话里输入 /web，或运行 claude-pro web' });
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // a change only from the console's own page
        if (!origins().has(String(req.headers.origin || '').toLowerCase())) return send(res, 403, { error: 'cross-site request refused' });
        if (req.headers['content-length'] && req.headers['content-length'] !== '0' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'JSON body required' });
      }
      if (url.pathname === '/api/ping') return send(res, 200, { ok: true, version: VERSION, code, pid: process.pid });

      // an image of a running session's conversation, from its peer server
      const liveImage = /^\/api\/live\/([0-9a-f]{12})\/image\/(\d+)$/.exec(url.pathname);
      if (liveImage && req.method === 'GET') {
        const peer = data.findPeerById(liveImage[1]);
        const upstream = http.get({ host: '127.0.0.1', port: peer.port, path: `/image/${liveImage[2]}`, headers: { authorization: `Bearer ${peer.token}` } }, (up) => {
          if (up.statusCode !== 200) { up.resume(); return send(res, 404, { error: 'no such image' }); }
          res.writeHead(200, { 'content-type': up.headers['content-type'] || 'application/octet-stream', 'cache-control': 'private, max-age=3600' });
          up.pipe(res);
        });
        upstream.on('error', () => { if (!res.headersSent) send(res, 502, { error: '连不上这个会话' }); else res.end(); });
        return;
      }
      // a running session's live view: its peer server's event stream, passed through
      const live = /^\/api\/live\/([0-9a-f]{12})\/events$/.exec(url.pathname);
      if (live && req.method === 'GET') {
        const peer = data.findPeerById(live[1]);
        const upstream = http.get({ host: '127.0.0.1', port: peer.port, path: '/events', headers: { authorization: `Bearer ${peer.token}` } }, (up) => {
          if (up.statusCode !== 200) { up.resume(); return send(res, up.statusCode === 404 ? 409 : 502, { error: up.statusCode === 404 ? '这个会话的 claude-pro 版本较旧，不支持实时查看' : '会话没有回应' }); }
          streams++;
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write('retry: 2000\n\n');
          up.pipe(res);
          const end = () => { try { res.end(); } catch { /* gone */ } };
          up.on('end', end);
          up.on('error', end);
          res.once('close', () => { streams = Math.max(0, streams - 1); lastActivity = Date.now(); up.destroy(); });
        });
        upstream.on('error', () => { if (!res.headersSent) send(res, 502, { error: '连不上这个会话' }); else res.end(); });
        req.on('close', () => upstream.destroy());
        return;
      }

      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const m = pattern.exec(url.pathname);
        if (!m) continue;
        const body = method === 'GET' || method === 'DELETE' ? undefined : await readBody(req);
        const result = await handler(req, m.slice(1).map(decodeURIComponent), body, url);
        if (result?.raw) {
          const { type, data: payload, name } = result.raw;
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...(name ? { 'content-disposition': `attachment; filename="${name}"` } : {}) });
          return res.end(payload);
        }
        return send(res, 200, result ?? {});
      }
      return send(res, 404, { error: `${req.method} ${url.pathname} is not part of the console` });
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
      return send(res, e.status || 500, { error: e.message || String(e) });
    }
  });

  // 7878, or the port the server before this one had (it may still be letting go of it for a moment: tried for 3 s),
  // else any port
  const wanted = Number(readState()?.port) || PORT;
  const listen = (p) => new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, '127.0.0.1');
  });
  let bound = false;
  for (const p of [...new Set([wanted, PORT])]) {
    for (let i = 0; i < 15 && !bound; i++) {
      try { await listen(p); bound = true; } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (bound) break;
  }
  if (!bound) await listen(0);
  port = server.address().port;
  const state = { pid: process.pid, port, token, version: VERSION, code, startedAt: Date.now() };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, stateFile());

  // (web.json stays: the next server takes its secret over, so that the page's cookie still works)
  const quit = () => process.exit(0);
  setInterval(() => { if (!streams && Date.now() - lastActivity > IDLE_MS) quit(); }, 60_000).unref();
  // Its code changed (an update, or an edit in a source checkout): a new server takes over at once, on the same port
  // and with the same secret, so that an open page keeps working with the new page code (it is read from disk at
  // every load) instead of new pages talking to an old server.
  const handOver = setInterval(() => {
    if (codeStamp() === code) return;
    clearInterval(handOver);
    server.close();
    server.closeAllConnections?.();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.on('error', () => {});
    child.unref();
    setTimeout(() => process.exit(0), 200);
  }, 15_000);
  handOver.unref();
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
}

// ---------------------------------------------------------------- starting it, from a session or the command line

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; }
}

async function ping(state) {
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/ping`, { headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The running console, started (or restarted, when it is older code) if need be. Resolves with {url, port, started}:
// `url` opens the page logged in.
export async function ensureWebServer() {
  let state = readState();
  let alive = state ? await ping(state) : null;
  if (alive && alive.code !== codeStamp()) {
    try { process.kill(alive.pid); } catch { /* gone already */ }
    await sleep(300);
    alive = null;
  }
  let started = false;
  if (!alive) {
    const env = { ...process.env, FORCE_COLOR: '1' }; // the tool headers it renders keep their colours for the page
    delete env.NO_COLOR;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on('error', () => {});
    child.unref();
    started = true;
    const until = Date.now() + 8000;
    for (;;) {
      await sleep(150);
      state = readState();
      if (state?.pid === child.pid && (alive = await ping(state))) break;
      if (Date.now() > until) throw new Error('the web console did not start (see whether port 7878 or the config directory is usable)');
    }
  }
  return { url: `http://127.0.0.1:${state.port}/?t=${state.token}`, port: state.port, started };
}

// The page in the user's browser.
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

// `claude-pro web [--no-open]`
export async function webCommand(argv = []) {
  try {
    const { url, port, started } = await ensureWebServer();
    const open = !argv.includes('--no-open');
    if (open) openBrowser(url);
    process.stdout.write(`claude-pro web console ${started ? 'started' : 'is running'} at http://127.0.0.1:${port}\n${open ? 'Opened it in your browser. ' : ''}Log-in link (keep it to yourself): ${url}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`Could not start the web console: ${e.message}\n`);
    return 1;
  }
}

if (process.argv.includes('--serve') && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
}
