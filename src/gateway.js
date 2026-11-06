// The codex-gateway provider: model requests go to a shared gateway (https://gw.predix.icu by default) with an
// API key of the user's gateway account, which pays for them from its balance. /login starts a local callback
// server, opens the gateway login page in the browser, and exchanges a one-time code for a key belonging to this machine
// (see handleCli in codex-gateway's server.mjs).

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG_DIR, GATEWAY_DEFAULT_URL, noteServedModels } from './config.js';

export { GATEWAY_DEFAULT_URL };
export const gatewayLoginFile = () => path.join(process.env.CLAUDE_PRO_CONFIG_DIR || CONFIG_DIR, 'gateway.json');
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export const normalizeGatewayUrl = (url) => String(url || GATEWAY_DEFAULT_URL).trim().replace(/\/+$/, '');

// The login /login saved for this gateway, {url, apiKey, account, savedAt}, or null when there is none. It is where
// the key of every model and remote request comes from: there is no environment variable or .env file for it.
export function gatewayLogin(url) {
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

// The models the gateway serves (GET /v1/models), kept per gateway and key. The reasoning fields are optional so
// older gateways still work; when present they are kept with the model for /effort and requests. Each model's
// max_input_tokens is its window (see Config.resolveModel).
// The first request waits for the list, so it gives up after a few seconds, and after a failure it is not asked again
// for a minute: a gateway whose /v1/models fails must not slow down every request. A list older than
// MODELS_MAX_AGE_MS is still answered at once, and a new one is fetched behind it; `fresh` (the /model and /effort
// pickers, the remote page's options) asks the gateway now and falls back to the kept list when it does not answer.
// The list used to be kept for the life of the process: a model the gateway added (or dropped) showed up in /model
// only after a restart.
const modelLists = new Map(); // key -> {list, at}
const modelListFailures = new Map(); // key -> {at, error}
const modelListFetches = new Map(); // key -> the request in flight, shared by its callers
const MODELS_TIMEOUT_MS = 5000;
const MODELS_RETRY_MS = 60_000;
const MODELS_MAX_AGE_MS = 10 * 60_000;

const listKey = ({ url, apiKey }) => `${normalizeGatewayUrl(url)}\n${apiKey}`;

// One GET /v1/models at a time per key. It carries only its own timeout: a caller that gives up (its signal) leaves
// it running for the others and the cache (see untilAborted).
function requestModels(key, { url, apiKey }, { fetchImpl, timeoutMs }) {
  if (modelListFetches.has(key)) return modelListFetches.get(key);
  const base = normalizeGatewayUrl(url);
  const pending = gatewayJson(`${base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) }, fetchImpl)
    .then((body) => {
      const list = (body.data || []).filter((m) => typeof m?.id === 'string').map((m) => ({
        ...m,
        supported_reasoning_levels: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : Array.isArray(m.reasoning_levels) ? m.reasoning_levels : [])
          .map((r) => typeof r === 'string' ? r : r?.effort || r?.name).filter(Boolean),
        default_reasoning_level: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level
          : m.default_reasoning_level?.effort || m.default_effort || null,
      }));
      modelLists.set(key, { list, at: Date.now() });
      modelListFailures.delete(key);
      noteServedModels(base, list);
      return list;
    }, (e) => {
      modelListFailures.set(key, { at: Date.now(), error: e });
      throw e;
    })
    .finally(() => modelListFetches.delete(key));
  modelListFetches.set(key, pending);
  return pending;
}

const untilAborted = (promise, signal) => (!signal ? promise : new Promise((resolve, reject) => {
  const onAbort = () => reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
  if (signal.aborted) return onAbort();
  signal.addEventListener('abort', onAbort, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
}));

export async function fetchGatewayModels(login, { fetchImpl = globalThis.fetch, signal, timeoutMs = MODELS_TIMEOUT_MS, fresh = false } = {}) {
  const key = listKey(login);
  const kept = modelLists.get(key);
  const failed = modelListFailures.get(key);
  const failedLately = failed && Date.now() - failed.at < MODELS_RETRY_MS;
  if (kept && !fresh) {
    if (Date.now() - kept.at >= MODELS_MAX_AGE_MS && !failedLately) requestModels(key, login, { fetchImpl, timeoutMs }).catch(() => {});
    return kept.list;
  }
  if (failedLately && !fresh) throw failed.error;
  try {
    return await untilAborted(requestModels(key, login, { fetchImpl, timeoutMs }), signal);
  } catch (e) {
    if (kept) return kept.list; // the gateway does not answer now: the list it gave last
    throw e;
  }
}

// The gateway's model list for a configuration, for the synchronous code that reads it: buildParams (a GPT model's
// effort levels) and Config.resolveModel (every model's window). When the gateway does not answer, the built-in
// values stand in. Never throws.
export async function loadGatewayModels(config, signal) {
  const login = gatewayLogin(config.gatewayUrl);
  if (!login) return;
  try { await fetchGatewayModels(login, { signal }); } catch { /* the built-in values stand in */ }
}

export function cachedGatewayModel(login, modelId) {
  if (!login?.url || !login?.apiKey) return null;
  return modelLists.get(listKey(login))?.list.find((m) => m.id === modelId) || null;
}

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function gatewayEfforts(model) { return model?.supported_reasoning_levels || []; }
export function gatewayDefaultEffort(model) { return model?.default_reasoning_level || null; }
export function gatewayEffort(model, effort) { return nearestEffort(effort, gatewayEfforts(model)); }

// The level of `supported` nearest to `effort` (in EFFORT_ORDER), or `effort` itself when it is one of them or there
// are none.
export function nearestEffort(effort, supported) {
  if (!effort || !supported.length || supported.includes(effort)) return effort;
  const want = EFFORT_ORDER.indexOf(effort);
  return supported.reduce((best, item) => (Math.abs(EFFORT_ORDER.indexOf(item) - want) < Math.abs(EFFORT_ORDER.indexOf(best) - want) ? item : best), supported[0]);
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
