// The local web console (claude-pro web, /web): a page on http://127.0.0.1:7878 that shows and edits what the
// terminal does (settings, providers, memory, extensions), every project's conversations, the usage, and the sessions
// running now, live, with a box to send them messages.
//
// One server for the user, shared by every session: `node server.js --serve`, started by the first /web
// (ensureWebServer). Its address and secret are in CONFIG_DIR/web.json (readable by the user alone); /web opens the
// page with the secret once, and the page keeps it as a cookie. It answers only on 127.0.0.1, only requests that name
// it as their host (no DNS rebinding), and changes only from its own page (Origin). It also runs the 后台会话, the
// sessions started from the page, in its own process (see host.js). It exits 30 minutes after the last page went
// away when it runs no session, and gives way to a newer one (another version, or its code changed in a source
// checkout) once its sessions are idle, handing them over.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, VERSION, readGatewayLogin } from '../config.js';
import { machineName } from '../peers.js';
import { autostartStatus, setAutostart } from './autostart.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7878;
// The project's page (package.json's repository, as a browser opens it): the console's menu links to it.
const REPO = (() => {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).repository;
    const url = String(typeof r === 'string' ? r : r?.url || '').replace(/^git\+/, '').replace(/\.git$/, '');
    return /^https:\/\//.test(url) ? url : null;
  } catch { return null; }
})();
const IDLE_MS = 30 * 60_000;
const BODY_LIMIT = 20 * 1024 * 1024;
const COOKIE = 'cpweb';
export const stateFile = () => path.join(CONFIG_DIR, 'web.json');

// (__Host-: only this host can set it, not a page of another 7bit.fun subdomain; plain on http, in tests)
const REMOTE_COOKIE = 'cpremote';
const remoteCookieName = (origin) => (String(origin).startsWith('https:') ? `__Host-${REMOTE_COOKIE}` : REMOTE_COOKIE);
// the page's script: ES modules in js/ (main.js starts it), each served as /js/<name>.js
const SCRIPTS = fs.readdirSync(path.join(HERE, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`);
const STATIC = {
  '/': ['page.html', 'text/html; charset=utf-8'],
  ...Object.fromEntries(SCRIPTS.map((f) => [`/${f}`, [f, 'text/javascript; charset=utf-8']])),
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['logo.svg', 'image/svg+xml'], // (also before 远程访问's login: its page shows it too)
  // installing the console as an app (the browser's 「安装」): fetched without the cookie, so before any log-in
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon-maskable.png': ['icon-maskable.png', 'image/png'],
};
// what is served before the log-in of 远程访问 too
const PUBLIC_ASSETS = new Set(['/favicon.svg', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable.png']);

// What the code of the console is: the version, and in a source checkout the times of its files, so that a server
// started by older code gives way to the new one.
export function codeStamp() {
  const files = ['server.js', 'api.js', 'data.js', 'remote-access.js', 'autostart.js', 'page.html', 'login.html', ...SCRIPTS, 'app.css', 'logo.svg', 'manifest.webmanifest'].map((f) => path.join(HERE, f));
  files.push(path.join(HERE, '..', 'live.js'), path.join(HERE, '..', 'remote.js'), path.join(HERE, '..', 'session.js'), path.join(HERE, '..', 'config.js'), path.join(HERE, '..', 'updater.js'));
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
  // The page as it was when this server started: a page read from disk at every load could be newer than the API
  // this process serves (an update or an edit waits for the sessions to be idle) and call routes it does not have.
  const pages = Object.fromEntries(Object.values(STATIC).map(([file]) => [file, fs.readFileSync(path.join(HERE, file))]));
  const { routes, useHost } = await import('./api.js');
  const data = await import('./data.js');
  const ra = await import('./remote-access.js');
  const { SessionHost } = await import('./host.js');
  // the 后台会话 run here: a crash in one of them must not end the others (nor the console)
  let host = null;
  process.on('uncaughtException', (e) => host?.log(e, 'uncaught'));
  process.on('unhandledRejection', (e) => host?.log(e, 'unhandled rejection'));
  // 远程访问: what marks a request that came through the tunnel (made by this process to itself; never leaves it)
  const tunnelSecret = crypto.randomBytes(24).toString('base64url');
  let tunnel = null;
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

  // A running session by its peer id; one the console is taking up again (a hand-over) is waited for a moment.
  async function livePeer(peerId) {
    try { return data.findPeerById(peerId); } catch (e) {
      const peer = await host?.waitForPeer(peerId);
      if (peer) return peer;
      throw e;
    }
  }

  // POST /__login {password, remember}: the remote login page's form.
  async function remoteLogin(req, res, ip, origin) {
    if (!origin || String(req.headers.origin || '').toLowerCase() !== origin) return send(res, 403, { error: 'cross-site request refused' });
    const blocked = ra.loginBlocked(ip);
    if (blocked) return send(res, 429, { error: `密码错误次数太多，请 ${blocked} 分钟后再试` });
    let body;
    try { body = (await readBody(req)) || {}; } catch { return send(res, 400, { error: 'bad request' }); }
    const ua = req.headers['user-agent'];
    if (!ra.readRemote().enabled || !ra.checkPassword(String(body.password || ''))) {
      ra.loginFailed(ip);
      ra.noteLogin({ ip, ua, ok: false });
      await new Promise((r) => setTimeout(r, 600)); // a little slower for each guess
      return send(res, 401, { error: '密码不对' });
    }
    ra.loginPassed(ip);
    ra.noteLogin({ ip, ua, ok: true });
    const { token: value, maxAge } = ra.newSession({ remember: Boolean(body.remember), ip, ua });
    return send(res, 200, { ok: true }, { 'set-cookie': `${remoteCookieName(origin)}=${value}; Path=/; HttpOnly; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}${maxAge ? `; Max-Age=${maxAge}` : ''}` });
  }

  function remoteView() {
    const d = ra.readRemote();
    const now = Date.now();
    return {
      enabled: Boolean(d.enabled), hasPassword: ra.hasPassword(d), minPassword: ra.MIN_PASSWORD,
      tunnel: tunnel ? tunnel.state : { status: d.enabled ? 'connecting' : 'off', host: null, error: null },
      gateway: Boolean(gatewayLoginNow()),
      sessions: Object.entries(d.sessions || {}).filter(([, s]) => s.expires > now).map(([id, s]) => ({ id, created: s.created, lastSeen: s.lastSeen, expires: s.expires, ip: s.ip, ua: s.ua, remember: s.remember })),
      logins: (d.logins || []).slice(0, 15),
    };
  }

  // The tunnel follows web-remote.json (changed here, or by /web remote in a session) and the gateway login.
  // (as everywhere: an address saved before 2026-11-19 read as the gateway's present one)
  function gatewayLoginNow() {
    const g = readGatewayLogin();
    return g?.apiKey ? { url: g.url || process.env.CLAUDE_PRO_GATEWAY_URL || 'https://7bit.fun', apiKey: g.apiKey } : null;
  }
  const gatewayHandle = (handle = null) => ra.addressPrefix(gatewayLoginNow(), handle);

  function syncTunnel() {
    const want = ra.readRemote().enabled && ra.hasPassword();
    const login = want ? gatewayLoginNow() : null;
    const key = login ? `${login.url}|${login.apiKey}` : '';
    if (tunnel && tunnel.key === key) return;
    tunnel?.close();
    tunnel = null;
    if (!login) return;
    tunnel = new ra.TunnelClient({ gatewayUrl: login.url, apiKey: login.apiKey, localPort: port, secret: tunnelSecret });
    tunnel.key = key;
  }

  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    // only requests for this server by its own name: a page elsewhere cannot reach it through a name that points here
    if (!hosts().has(String(req.headers.host || '').toLowerCase())) return send(res, 421, { error: 'wrong host' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    // 远程访问: through the tunnel, from https://<prefix>.7bit.fun: its own password and cookie, and its own origin
    const remote = equal(req.headers['x-cpweb-tunnel'], tunnelSecret) && /^(?:127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
    // (the address the browser is at, https://<prefix>.7bit.fun, as the gateway says: changes must come from it)
    const remoteOrigin = remote ? String(req.headers['x-cpweb-origin'] || '').toLowerCase() : '';
    const ip = remote ? String(req.headers['x-cpweb-ip'] || '') : '127.0.0.1';
    try {
      if (req.method === 'GET' && PUBLIC_ASSETS.has(url.pathname)) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=86400' });
        return res.end(pages[file]);
      }
      if (remote) {
        if (url.pathname === '/__login' && req.method === 'POST') return remoteLogin(req, res, ip, remoteOrigin);
        const session = ra.validSession(cookieOf(req, remoteCookieName(remoteOrigin)));
        if (!session) {
          if (url.pathname.startsWith('/api/')) return send(res, 401, { error: '请先登录', login: true });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'" });
          return res.end(fs.readFileSync(path.join(HERE, 'login.html')));
        }
        if (url.pathname === '/api/logout' && req.method === 'POST') {
          ra.endSession(cookieOf(req, remoteCookieName(remoteOrigin)));
          return send(res, 200, { ok: true }, { 'set-cookie': `${remoteCookieName(remoteOrigin)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${remoteOrigin.startsWith('https:') ? '; Secure' : ''}` });
        }
        if (req.method !== 'GET' && req.method !== 'HEAD' && String(req.headers.origin || '').toLowerCase() !== remoteOrigin) return send(res, 403, { error: 'cross-site request refused' });
      }
      // the secret, once, from /web: kept as a cookie, then out of the address
      if (!remote && req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
        if (!equal(url.searchParams.get('t'), token)) return send(res, 403, { error: '链接已失效：请在 claude-pro 里重新运行 /web' });
        res.writeHead(302, { location: '/', 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`, 'cache-control': 'no-store' });
        return res.end();
      }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
        return res.end(pages[file]);
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      const bearer = equal(String(req.headers.authorization || '').replace(/^Bearer /, ''), token);
      const authed = remote || bearer || equal(cookieOf(req, COOKIE), token);
      if (!authed) return send(res, 401, { error: '需要从 claude-pro 打开：在会话里输入 /web，或运行 claude-pro web' });
      // the cookie lives on while the page is used (an installed app opens at / and has no ?t= to renew it)
      if (!remote && !bearer && url.pathname === '/api/ping') res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`);
      // (a request with the secret in its header is claude-pro's, not a page's: no cross-site question)
      if (!remote && !bearer && req.method !== 'GET' && req.method !== 'HEAD') {
        // a change only from the console's own page
        if (!origins().has(String(req.headers.origin || '').toLowerCase())) return send(res, 403, { error: 'cross-site request refused' });
        if (req.headers['content-length'] && req.headers['content-length'] !== '0' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'JSON body required' });
      }
      if (url.pathname === '/api/ping') return send(res, 200, { ok: true, version: VERSION, code, pid: process.pid, machine: machineName(), repo: REPO, remote, hosted: host?.size ?? 0, pending: host?.pendingUpdate() || null });
      // a newer console was started (ensureWebServer): this one gives way once its sessions are idle
      if (url.pathname === '/api/handover' && req.method === 'POST') { host?.requestHandover(); return send(res, 200, { ok: true }); }
      // a session an older version started in a hidden window moves in (App.maybeMoveIntoConsole): the state it leaves
      if (url.pathname === '/api/adopt' && req.method === 'POST') {
        if (!bearer) return send(res, 403, { error: 'claude-pro only' });
        const state = (await readBody(req))?.state;
        if (!host || !state || typeof state.cwd !== 'string' || !fs.existsSync(state.cwd)) return send(res, 400, { error: 'no state' });
        if ([...host.apps].some((a) => a.store?.id === state.sessionId)) return send(res, 409, { error: 'running here already' });
        const app = await host.launch({ cwd: state.cwd, restart: state });
        if (app.exiting) return send(res, 500, { error: 'it did not start' });
        return send(res, 200, { ok: true, peerId: app.peers?.id || null });
      }
      // 远程访问's own settings: on or off, the password, the devices logged in, the recent logins
      if (url.pathname === '/api/remote' && req.method === 'GET') return send(res, 200, remoteView());
      // 开机自动启动 (on the 远程访问 page): the console started at log-in
      if (url.pathname === '/api/autostart' && req.method === 'GET') return send(res, 200, autostartStatus());
      if (url.pathname === '/api/autostart' && req.method === 'POST') {
        const body = (await readBody(req)) || {};
        try { return send(res, 200, await setAutostart(body.enabled === true)); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (url.pathname === '/api/remote/handle' && req.method === 'GET') {
        try { return send(res, 200, await gatewayHandle()); } catch (e) { return send(res, e.status || 502, { error: e.message }); }
      }
      if (url.pathname === '/api/remote' && req.method === 'POST') {
        const body = (await readBody(req)) || {};
        // the prefix chosen (the first time, or changed): set at the gateway before anything else
        if (typeof body.handle === 'string' && body.handle.trim()) {
          try { await gatewayHandle(body.handle.trim().toLowerCase()); } catch (e) { return send(res, e.status || 502, { error: e.message }); }
          // (an open tunnel took its host when it connected: again, for the new one)
          tunnel?.close();
          tunnel = null;
        }
        if (typeof body.password === 'string' && body.password) {
          try { ra.setPassword(body.password); } catch (e) { return send(res, 400, { error: e.message }); }
        }
        if (typeof body.enabled === 'boolean') {
          if (body.enabled && !ra.hasPassword()) return send(res, 400, { error: '先设一个密码' });
          ra.setEnabled(body.enabled);
        }
        if (body.logoutAll) ra.endAllSessions();
        syncTunnel();
        return send(res, 200, remoteView());
      }

      // an image of a running session's conversation, from its peer server
      const liveImage = /^\/api\/live\/([0-9a-f]{12})\/image\/(\d+)$/.exec(url.pathname);
      if (liveImage && req.method === 'GET') {
        const peer = await livePeer(liveImage[1]);
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
        let upstream, upstreamResponse, counted = false;
        res.once('close', () => {
          if (counted) { streams--; lastActivity = Date.now(); }
          upstreamResponse?.destroy();
          upstream?.destroy();
        });
        const peer = await livePeer(live[1]);
        if (res.destroyed || res.writableEnded) return;
        upstream = http.get({ host: '127.0.0.1', port: peer.port, path: '/events', headers: { authorization: `Bearer ${peer.token}` } }, (up) => {
          upstreamResponse = up;
          if (res.destroyed || res.writableEnded) { up.destroy(); return; }
          if (up.statusCode !== 200) { up.resume(); return send(res, up.statusCode === 404 ? 409 : 502, { error: up.statusCode === 404 ? '这个会话的 claude-pro 版本较旧，不支持实时查看' : '会话没有回应' }); }
          streams++;
          counted = true;
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write('retry: 2000\n\n');
          up.pipe(res);
          up.on('error', () => res.end());
        });
        upstream.on('error', () => {
          if (res.destroyed || res.writableEnded) return;
          if (!res.headersSent) send(res, 502, { error: '连不上这个会话' }); else res.end();
        });
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
      return send(res, e.status || 500, { ...(e.data && typeof e.data === 'object' ? e.data : {}), error: e.message || String(e) });
    }
  });

  // A terminal attaching (see attach.js): claude-pro on this computer only, with the secret in its header, never
  // through the tunnel.
  const { acceptTerminal } = await import('./terminals.js');
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const local = /^(?:127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
    const bearer = equal(String(req.headers.authorization || '').replace(/^Bearer /, ''), token);
    if (url.pathname !== '/api/attach' || String(req.headers.upgrade).toLowerCase() !== 'claude-pro-attach' || !local || !bearer || req.headers['x-cpweb-tunnel'] || !host) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: claude-pro-attach\r\nConnection: Upgrade\r\n\r\n');
    lastActivity = Date.now();
    acceptTerminal(host, socket, head);
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

  syncTunnel();
  setInterval(syncTunnel, 3000).unref();

  // Its code changed (an update, an edit in a source checkout, see SessionHost.watch), or a session asked for a
  // restart: once the sessions are idle a new server takes over, on the same port and with the same secret (an open
  // page keeps working, with the new page code, read from disk at every load), and takes the sessions up again.
  host = new SessionHost({
    restartProcess: () => {
      tunnel?.close();
      server.close();
      server.closeAllConnections?.();
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
      child.on('error', () => {});
      child.unref();
      setTimeout(() => process.exit(0), 200);
    },
  });
  useHost(host);
  host.watch();
  host.recover().catch((e) => host.log(e, 'recover'));

  // (web.json stays: the next server takes its secret over, so that the page's cookie still works; the list of
  // sessions stays too: the next server brings them back)
  const quit = () => process.exit(0);
  // with 远程访问 on, or a session running, it stays (a phone may come any time)
  setInterval(() => { if (!streams && !tunnel && !host.size && Date.now() - lastActivity > IDLE_MS) quit(); }, 60_000).unref();
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
    if (alive.hosted) {
      // it runs sessions: they are not cut off, it gives way once they are idle, handing them over (it is used meanwhile)
      await fetch(`http://127.0.0.1:${state.port}/api/handover`, { method: 'POST', headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(1500) }).catch(() => {});
    } else {
      try { process.kill(alive.pid); } catch { /* gone already */ }
      await sleep(300);
      alive = null;
    }
  }
  let started = false;
  if (!alive) {
    const env = { ...process.env, FORCE_COLOR: '1' }; // the tool headers it renders keep their colours for the page
    delete env.NO_COLOR;
    delete env.CLAUDE_PRO_BACKGROUND; // (the server is no session: a 后台会话 that starts it must not pass that on)
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

// A session of an older version, in a hidden window, moves into the console's process: the console (started if need
// be) takes it up from `state` (what a restart carries over). Resolves {ok, peerId} or {ok: false, error}.
export async function adoptIntoConsole(state) {
  const { port } = await ensureWebServer();
  const token = readState()?.token;
  const res = await fetch(`http://127.0.0.1:${port}/api/adopt`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  return res.ok ? body : { ok: false, error: body.error || `HTTP ${res.status}` };
}

// The page in the user's browser.
// `app`: in a window of its own, without the browser's tabs and address bar (Chrome's or Edge's --app), when there is
// one; else as any page.
export async function openBrowser(url, { app = false } = {}) {
  if (app) {
    try {
      const { browserExecutables } = await import('../browser/session.js');
      const exe = browserExecutables().find((p) => p && fs.existsSync(p));
      if (exe) {
        const child = spawn(exe, [`--app=${url}`], { detached: true, stdio: 'ignore', windowsHide: false });
        child.on('error', () => {});
        child.unref();
        return true;
      }
    } catch { /* the default browser then */ }
  }
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

// `claude-pro web [--no-open | --app]` (--app: in a window of its own; the desktop shortcut of the install scripts)
export async function webCommand(argv = []) {
  try {
    const { url, port, started } = await ensureWebServer();
    const open = !argv.includes('--no-open');
    if (open) await openBrowser(url, { app: argv.includes('--app') });
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
