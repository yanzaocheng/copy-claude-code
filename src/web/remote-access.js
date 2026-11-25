// 远程访问 of the web console: https://<prefix>.7bit.fun reaches this computer's console through the gateway (a
// WebSocket the console's server keeps open, see TunnelClient), and asks for a password first. The password is checked
// here (the gateway never knows it): its scrypt hash, the logged-in devices and the recent logins are kept in
// CONFIG_DIR/web-remote.json, readable by the user alone.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { CONFIG_DIR, VERSION, normalizeGatewayUrl } from '../config.js';

export const remoteFile = () => path.join(CONFIG_DIR, 'web-remote.json');
export const MIN_PASSWORD = 10;
const SESSION_DAYS = 30;
const LOGINS_KEPT = 30;

export function readRemote() {
  try {
    const data = JSON.parse(fs.readFileSync(remoteFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

export function writeRemote(mutate) {
  const data = readRemote();
  mutate(data);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${remoteFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, remoteFile());
  return data;
}

const scrypt = (password, salt) => crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64');

// A new password logs every device out.
export function setPassword(password) {
  if (String(password || '').length < MIN_PASSWORD) throw new Error(`密码至少 ${MIN_PASSWORD} 位`);
  const salt = crypto.randomBytes(16).toString('base64');
  return writeRemote((d) => { d.salt = salt; d.hash = scrypt(password, salt); d.sessions = {}; });
}

export function hasPassword(data = readRemote()) { return Boolean(data.salt && data.hash); }

export function checkPassword(password, data = readRemote()) {
  if (!hasPassword(data)) return false;
  const got = Buffer.from(scrypt(password, data.salt), 'base64');
  const want = Buffer.from(data.hash, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// This computer's id among the account's computers (the gateway lists them by it).
export function computerId() {
  const data = readRemote();
  if (/^[\w-]{6,64}$/.test(data.computer || '')) return data.computer;
  const id = crypto.randomBytes(8).toString('hex');
  writeRemote((d) => { d.computer = id; });
  return id;
}

export function setEnabled(on) { return writeRemote((d) => { d.enabled = Boolean(on); }); }

// The address's prefix (<prefix>.7bit.fun), kept by the account at the gateway: asked for (handle null) or set with
// the gateway key (/v1/remote/contacts: named after the 通讯录 that is gone, where the prefix was the 通讯号), the
// gateway checking the form, its reserved names and that no other account has it. {handle, auto, domain}; `auto`: still the one the gateway made up (cp and 6
// characters of its alphabet), not one the user chose. Throws with the gateway's words and a status for the page.
export async function addressPrefix(login, handle = null, { fetchImpl = globalThis.fetch } = {}) {
  if (!login?.apiKey) throw Object.assign(new Error('远程访问需要先连接 7bit.fun'), { status: 409 });
  const base = normalizeGatewayUrl(login.url);
  let r;
  try {
    r = await fetchImpl(`${base}/v1/remote/contacts${handle ? '/handle' : ''}`, {
      method: handle ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${login.apiKey}`, ...(handle ? { 'content-type': 'application/json' } : {}) },
      ...(handle ? { body: JSON.stringify({ handle }) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) { throw Object.assign(new Error(`连不上网关：${e.message}`), { status: 502 }); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || `网关返回 ${r.status}`), { status: r.status === 409 || r.status === 400 ? r.status : 502 });
  const now = String(j?.handle || '');
  let domain = '7bit.fun';
  try { domain = new URL(base).hostname; } catch { /* the default */ }
  return { handle: now, auto: /^cp[a-hjkmnp-z2-9]{6}$/.test(now), domain };
}

// ---------------------------------------------------------------- logged-in devices

const hashToken = (secret) => crypto.createHash('sha256').update(secret).digest('base64url');

// A device that typed the password: the cookie's value ("<id>.<secret>"; only the secret's hash is kept).
export function newSession({ remember, ip, ua }) {
  const id = crypto.randomBytes(9).toString('base64url');
  const secret = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  writeRemote((d) => {
    d.sessions = Object.fromEntries(Object.entries(d.sessions || {}).filter(([, s]) => s.expires > now));
    d.sessions[id] = { hash: hashToken(secret), created: now, expires: now + (remember ? SESSION_DAYS : 1) * 86_400_000, remember: Boolean(remember), ip, ua: String(ua || '').slice(0, 200), lastSeen: now };
  });
  return { token: `${id}.${secret}`, maxAge: remember ? SESSION_DAYS * 86400 : null };
}

const seenWritten = new Map(); // id -> when lastSeen was last written (at most every 10 minutes)
export function validSession(token) {
  const [id, secret] = String(token || '').split('.');
  if (!id || !secret) return null;
  const s = readRemote().sessions?.[id];
  if (!s || s.expires < Date.now()) return null;
  const a = Buffer.from(hashToken(secret)), b = Buffer.from(String(s.hash || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() - (seenWritten.get(id) || 0) > 600_000) {
    seenWritten.set(id, Date.now());
    try { writeRemote((d) => { if (d.sessions?.[id]) d.sessions[id].lastSeen = Date.now(); }); } catch { /* next time */ }
  }
  return { id, ...s };
}

export function endSession(token) {
  const [id] = String(token || '').split('.');
  if (id) writeRemote((d) => { if (d.sessions) delete d.sessions[id]; });
}

export function endAllSessions() { writeRemote((d) => { d.sessions = {}; }); }

export function noteLogin({ ip, ua, ok }) {
  try {
    writeRemote((d) => {
      d.logins = [{ at: Date.now(), ip, ua: String(ua || '').slice(0, 200), ok: Boolean(ok) }, ...(d.logins || [])].slice(0, LOGINS_KEPT);
    });
  } catch { /* not recorded */ }
}

// Brute force: 5 wrong passwords from an address lock it for 15 minutes; 20 in an hour from anywhere lock all logins
// for the rest of that hour.
// An attempt counts while it is being made too (loginBegin): many requests opened together, their bodies held back,
// are not each a guess beyond the limit.
const failures = new Map(); // ip -> {count, until}
const pending = new Map(); // ip -> attempts being made
let pendingAll = 0;
let hourly = { start: Date.now(), count: 0 };
export function loginBlocked(ip) {
  const now = Date.now();
  if (now - hourly.start > 3600_000) hourly = { start: now, count: 0 };
  if (hourly.count + pendingAll >= 20) return Math.max(1, Math.ceil((hourly.start + 3600_000 - now) / 60_000));
  const f = failures.get(ip);
  if (f && f.until > now) return Math.ceil((f.until - now) / 60_000);
  if ((f?.count || 0) + (pending.get(ip) || 0) >= 5) return 1;
  return 0;
}
// An attempt of `ip` starts; call what it returns when it is over (after loginFailed or loginPassed).
export function loginBegin(ip) {
  pending.set(ip, (pending.get(ip) || 0) + 1);
  pendingAll++;
  let over = false;
  return () => {
    if (over) return;
    over = true;
    pendingAll--;
    const left = (pending.get(ip) || 1) - 1;
    if (left > 0) pending.set(ip, left); else pending.delete(ip);
  };
}
export function loginFailed(ip) {
  hourly.count++;
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) { f.until = Date.now() + 15 * 60_000; f.count = 0; }
  failures.set(ip, f);
  if (failures.size > 2000) for (const [k, v] of failures) { if (v.until < Date.now() && failures.size > 1000) failures.delete(k); }
}
export function loginPassed(ip) { failures.delete(ip); }

// ---------------------------------------------------------------- the tunnel to the gateway

// The console's end of the tunnel (see the gateway's tunnel.mjs): each request the gateway passes on is made to this
// server itself on 127.0.0.1 with `secret` in a header (it never leaves this process, so nothing else can claim to be
// a remote request), and the answer goes back as it comes.
export class TunnelClient {
  constructor({ gatewayUrl, apiKey, localPort, secret, onState = () => {} }) {
    this.wsUrl = `${normalizeGatewayUrl(gatewayUrl).replace(/^http/, 'ws')}/v1/tunnel`;
    this.apiKey = apiKey;
    this.localPort = localPort;
    this.secret = secret;
    this.onState = onState;
    this.state = { status: 'connecting', host: null, error: null, since: null };
    this.local = new Map(); // id -> the request to this server
    this.closed = false;
    this.wait = 1000;
    this.open();
  }

  set(patch) { this.state = { ...this.state, ...patch }; try { this.onState(this.state); } catch { /* ignore */ } }

  open() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(this.wsUrl); } catch (e) { this.retry(e.message); return; }
    this.ws = ws;
    let ready = false;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', key: this.apiKey, computer: computerId(), machine: machineLabel(), version: VERSION }));
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.t === 'ready') { ready = true; this.wait = 1000; this.set({ status: 'online', host: msg.host, error: null, since: Date.now() }); return; }
      if (msg.t === 'error') { this.fatal = msg.message; this.set({ status: 'error', error: msg.message }); return; }
      this.fromGateway(msg);
    };
    ws.onclose = (event) => {
      for (const req of this.local.values()) req.destroy();
      this.local.clear();
      if (this.closed) return;
      // refused for good (a bad key, a prefix that is not a host name): tried again only slowly
      if (event.code === 4003 || event.code === 4005) { this.wait = 5 * 60_000; this.set({ status: 'error', error: this.fatal || '网关拒绝了这台电脑' }); }
      else if (!ready) this.set({ status: 'connecting', error: this.state.error });
      else this.set({ status: 'connecting' });
      this.retry();
    };
    ws.onerror = () => {};
  }

  retry(error) {
    if (this.closed) return;
    if (error) this.set({ status: 'connecting', error });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), this.wait);
    this.timer.unref?.();
    this.wait = Math.min(this.wait * 2, 60_000);
  }

  send(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  fromGateway(msg) {
    if (msg.t === 'req') return this.start(msg);
    const req = this.local.get(msg.id);
    if (!req) return;
    if (msg.t === 'body') req.write(Buffer.from(String(msg.data || ''), 'base64'));
    else if (msg.t === 'end') req.end();
    else if (msg.t === 'abort') { req.destroy(); this.local.delete(msg.id); }
  }

  start(msg) {
    const headers = { ...(msg.headers || {}) };
    for (const k of Object.keys(headers)) if (/^x-cpweb-/i.test(k)) delete headers[k];
    headers.host = `127.0.0.1:${this.localPort}`;
    headers['x-cpweb-tunnel'] = this.secret;
    headers['x-cpweb-ip'] = String(msg.ip || '');
    headers['x-cpweb-host'] = String(msg.host || this.state.host || '');
    headers['x-cpweb-origin'] = String(msg.origin || `https://${headers['x-cpweb-host']}`);
    const req = http.request({ host: '127.0.0.1', port: this.localPort, method: msg.method, path: msg.path, headers }, (res) => {
      this.send({ t: 'res', id: msg.id, status: res.statusCode, headers: res.headers });
      res.on('data', (chunk) => {
        for (let i = 0; i < chunk.length; i += 256 * 1024) this.send({ t: 'body', id: msg.id, data: chunk.subarray(i, i + 256 * 1024).toString('base64') });
      });
      res.on('end', () => { this.send({ t: 'end', id: msg.id }); this.local.delete(msg.id); });
      res.on('error', () => { this.send({ t: 'end', id: msg.id }); this.local.delete(msg.id); });
    });
    req.on('error', () => { this.send({ t: 'res', id: msg.id, status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } }); this.send({ t: 'end', id: msg.id }); this.local.delete(msg.id); });
    this.local.set(msg.id, req);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const req of this.local.values()) req.destroy();
    this.local.clear();
    try { this.ws?.close(); } catch { /* gone */ }
    this.set({ status: 'off', host: null });
  }
}

function machineLabel() {
  const raw = process.env.CLAUDE_PRO_MACHINE_NAME || os.hostname() || 'computer';
  return String(raw).replace(/[^\p{L}\p{M}\p{N}_.-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'computer';
}
