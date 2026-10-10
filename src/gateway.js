// The codex-gateway provider: model requests go to a shared gateway (https://gw.predix.icu by default) with an
// API key of the user's gateway account, which pays for them from its balance. /login gets that key the way
// Claude Code logs in: a local callback server, the gateway's login page in the browser, and a one-time code
// exchanged for a key of this machine's own (see handleCli in codex-gateway's server.mjs).

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG_DIR, GATEWAY_DEFAULT_URL } from './config.js';

export { GATEWAY_DEFAULT_URL };
export const gatewayLoginFile = () => path.join(process.env.CLAUDE_PRO_CONFIG_DIR || CONFIG_DIR, 'gateway.json');
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export const normalizeGatewayUrl = (url) => String(url || GATEWAY_DEFAULT_URL).trim().replace(/\/+$/, '');

// {url, apiKey, account, savedAt}, or null when there is none for this gateway.
export function readGatewayLogin(url) {
  try {
    const data = JSON.parse(fs.readFileSync(gatewayLoginFile(), 'utf8'));
    if (!data?.apiKey || (url && normalizeGatewayUrl(data.url) !== normalizeGatewayUrl(url))) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveGatewayLogin(login) {
  const file = gatewayLoginFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...login, url: normalizeGatewayUrl(login.url), savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function clearGatewayLogin() {
  try { fs.unlinkSync(gatewayLoginFile()); return true; } catch { return false; }
}

export function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function gatewayJson(url, init = {}, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { status: res.status });
  return body;
}

// The account behind a key: balance, usage totals (GET /v1/account).
export async function fetchGatewayAccount({ url, apiKey }, { fetchImpl = globalThis.fetch, signal } = {}) {
  const body = await gatewayJson(`${normalizeGatewayUrl(url)}/v1/account`, { headers: { authorization: `Bearer ${apiKey}` }, signal }, fetchImpl);
  return body.account;
}

const PAGE = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.6"><h2>${title}</h2><p>${text}</p></body>`;

// Log in through the browser. `onUrl(url)` is told the login page's address (to show it, for when the browser
// does not open by itself); `open` opens it. Resolves with the saved login once the key is in.
export async function loginWithBrowser({ url = GATEWAY_DEFAULT_URL, onUrl = () => {}, open = openBrowser, signal, fetchImpl = globalThis.fetch, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const base = normalizeGatewayUrl(url);
  const state = crypto.randomBytes(24).toString('base64url');
  let settle;
  const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ok ? PAGE('登录成功', '可以关掉这个页面，回到终端继续使用 claude-pro。') : PAGE('登录失败', '链接无效或已过期。请回到终端重新执行 /login。'));
    if (ok) settle.resolve(u.searchParams.get('code'));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => settle.reject(new Error('Login timed out: the browser did not come back within 10 minutes.')), timeoutMs);
  const onAbort = () => settle.reject(Object.assign(new Error('Login cancelled'), { name: 'AbortError' }));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const page = `${base}/cli/login?${new URLSearchParams({ port: String(server.address().port), state, client: 'claude-pro', device: os.hostname().slice(0, 60) })}`;
    onUrl(page);
    Promise.resolve().then(() => open(page)).catch((e) => settle.reject(e));
    const code = await result;
    const token = await gatewayJson(`${base}/cli/token`, { method: 'POST', body: JSON.stringify({ code, state }) }, fetchImpl);
    const login = { url: base, apiKey: token.api_key, account: { id: token.account?.id, name: token.account?.name, email: token.account?.email } };
    saveGatewayLogin(login);
    return { ...login, balance: token.account };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    server.close();
  }
}

export const formatUsd = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}` : '-';
};
