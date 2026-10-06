// Renewing the Claude Code subscription login.
//
// The access token in ~/.claude/.credentials.json lives 8 hours. The official client renews it when it
// is used, with the refresh token stored next to it, and so does this program now: a token that is
// expired or about to be is renewed before a request is sent, instead of failing and asking the user to
// go and run `claude`.
//
// Renewing rotates the refresh token: the server answers with a new one and the old one stops working.
// So the new tokens must reach the credentials file, or the official client (which reads the same file)
// is left holding a dead one, and nobody may renew at the same moment as somebody else. The protocol is
// the official client's, read from its code:
//   - two directory locks (proper-lockfile style: mkdir to take it, rmdir to release, the holder touches
//     it every 5 s, one not touched for 60 s is stale): <config dir>/.oauth_refresh.lock and, for older
//     versions, <config dir>.lock, taken in that order;
//   - after getting the locks, read the file again: whoever held them may just have renewed it;
//   - the request: POST {grant_type: "refresh_token", refresh_token, client_id, scope} as JSON to
//     the token endpoint; the answer has access_token, expires_in and, normally, a new refresh_token;
//   - a refresh token that is rejected may have been used by another process a moment ago: look in the
//     file before giving up.
// Only the token fields of the file are changed, and it is replaced atomically.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

const REFRESH_MARGIN_MS = 5 * 60_000; // renew when this close to expiry, like the official client
const LOCK_STALE_MS = 60_000;
const LOCK_UPDATE_MS = 5_000;
const LOCK_WAIT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

// The token endpoint. Only tests replace it: it is deliberately not a setting, because the refresh token
// is sent there, and a setting can come from a .env file or a settings file of whatever project is open.
export const endpoint = { url: OAUTH_TOKEN_URL };

export const timing = { // replaceable so tests need not wait
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  }),
};

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// What the credentials file holds, or null when it cannot be read.
export function readStoredLogin(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(text.replace(/^\uFEFF/, ''));
    return { json, oauth: json?.claudeAiOauth || null, text };
  } catch {
    return null;
  }
}

export function needsRefresh(oauth, now = timing.now()) {
  const expiresAt = Number(oauth?.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > 0 && now + REFRESH_MARGIN_MS >= expiresAt;
}

const isExpired = (oauth, now = timing.now()) => Number(oauth?.expiresAt) > 0 && Number(oauth.expiresAt) <= now;

// ---------------------------------------------------------------- locks

async function takeLock(lockPath, signal) {
  const began = timing.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age;
      try {
        age = timing.now() - fs.statSync(lockPath).mtimeMs;
      } catch (statErr) {
        if (statErr.code === 'ENOENT') continue; // released just now: take it
        throw statErr;
      }
      if (age > LOCK_STALE_MS) { // its holder is gone
        try { fs.rmdirSync(lockPath); } catch { /* somebody else took it over first */ }
        continue;
      }
      if (timing.now() - began > LOCK_WAIT_MS) throw Object.assign(new Error(`Another process has held ${lockPath} for ${Math.round(LOCK_WAIT_MS / 1000)} seconds.`), { code: 'ELOCKED' });
      await timing.sleep(250 + Math.floor(Math.random() * 250), signal);
    }
  }
  const touch = setInterval(() => { try { const t = new Date(); fs.utimesSync(lockPath, t, t); } catch { /* released */ } }, LOCK_UPDATE_MS);
  touch.unref?.();
  return () => {
    clearInterval(touch);
    try { fs.rmdirSync(lockPath); } catch { /* already gone */ }
  };
}

// Both of the official client's locks. Returns the function that lets go of them.
async function lockLoginFile(file, signal) {
  const dir = path.dirname(file);
  const release = [];
  try {
    release.push(await takeLock(path.join(dir, '.oauth_refresh.lock'), signal));
    release.push(await takeLock(`${dir}.lock`, signal));
  } catch (err) {
    for (const fn of release.reverse()) fn();
    throw err;
  }
  return () => { for (const fn of release.reverse()) fn(); };
}

// ---------------------------------------------------------------- writing the file

function replaceFile(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        // On Windows the file may be open in another process for a moment.
        if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        const until = Date.now() + 40 * attempt;
        while (Date.now() < until) { /* a short blocking wait: this is a rare, tiny operation */ }
      }
    }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

// Put the new tokens into the file, keeping everything else in it as it is (and its layout).
function storeTokens(file, tokens, now) {
  const stored = readStoredLogin(file);
  if (!stored) throw new Error(`Could not read ${file} to store the renewed login.`);
  const oauth = { ...(stored.oauth || {}) };
  oauth.accessToken = tokens.accessToken;
  oauth.refreshToken = tokens.refreshToken;
  oauth.expiresAt = now + tokens.expiresInSec * 1000;
  if (tokens.refreshExpiresInSec) oauth.refreshTokenExpiresAt = now + tokens.refreshExpiresInSec * 1000;
  if (tokens.scopes?.length) oauth.scopes = tokens.scopes;
  const json = { ...stored.json, claudeAiOauth: oauth };
  const indent = /^\uFEFF?\{\r?\n([ \t]+)"/.exec(stored.text)?.[1];
  const text = JSON.stringify(json, null, indent) + (/\n$/.test(stored.text) ? '\n' : '');
  replaceFile(file, text);
  // what was written is what is read back: a renewed token that did not reach the file is worse than none
  const check = readStoredLogin(file);
  if (check?.oauth?.accessToken !== tokens.accessToken || check?.oauth?.refreshToken !== tokens.refreshToken) {
    throw new Error(`The renewed login was not saved correctly in ${file}.`);
  }
}

// ---------------------------------------------------------------- the request

// The server's own words about a failure, without anything that could be a token.
function describeFailure(data) {
  const text = [data?.error, data?.error_description || data?.error?.message].filter((x) => typeof x === 'string').join(': ');
  return text.replace(/[A-Za-z0-9_-]{40,}/g, '…').slice(0, 200);
}

async function requestTokens(config, { refreshToken, scopes, signal }) {
  const url = endpoint.url;
  const post = async (withScope) => {
    const body = { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID };
    if (withScope && scopes?.length) body.scope = scopes.join(' ');
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'claude-cli (external, cli)' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, data };
  };
  let res = await post(true);
  // a scope the server does not know (any more): renewing without one keeps the scopes the token had
  if (res.status === 400 && /invalid_scope/i.test(JSON.stringify(res.data?.error ?? '')) && scopes?.length) res = await post(false);
  return res;
}

function parseTokens(data, oldRefreshToken) {
  if (typeof data?.access_token !== 'string' || !data.access_token || !(Number(data.expires_in) > 0)) return null;
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : oldRefreshToken,
    expiresInSec: Number(data.expires_in),
    refreshExpiresInSec: Number(data.refresh_token_expires_in) > 0 ? Number(data.refresh_token_expires_in) : null,
    scopes: typeof data.scope === 'string' && data.scope.trim() ? data.scope.trim().split(/\s+/) : null,
  };
}

// ---------------------------------------------------------------- renewing

const SIGN_IN_AGAIN = 'Sign in again: run `claude` and use /login.';

async function renew(config, { force }) {
  const signal = undefined; // one renewal serves every caller in the process, so none of them cancels it
  const file = config.claudeCodeCredentialsFile;
  const first = readStoredLogin(file);
  const oauth = first?.oauth;
  if (!oauth?.refreshToken) return { refreshed: false, reason: 'no refresh token' };
  if (!force && !needsRefresh(oauth)) return { refreshed: false, reason: 'still valid' };
  if (Number(oauth.refreshTokenExpiresAt) > 0 && Number(oauth.refreshTokenExpiresAt) <= timing.now()) {
    throw new Error(`The Claude Code login has expired and cannot be renewed: its refresh token ran out. ${SIGN_IN_AGAIN}`);
  }
  const startedWith = oauth.accessToken;
  // somebody else renewed it while we were looking: take theirs
  const renewedElsewhere = () => {
    const now = readStoredLogin(file)?.oauth;
    return now && now.accessToken !== startedWith && !needsRefresh(now) ? now : null;
  };
  const failed = (why) => {
    const now = readStoredLogin(file)?.oauth;
    // renewing early failed but the token still works: carry on with it (unless renewing was asked for)
    if (!force && now && !isExpired(now)) return { refreshed: false, reason: why, stillValid: true };
    throw new Error(force ? `The Claude Code login could not be renewed: ${why}` : `The Claude Code access token has expired and could not be renewed: ${why}`);
  };

  let release;
  try {
    release = await lockLoginFile(file, signal);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (renewedElsewhere()) return { refreshed: false, reason: 'renewed by another process' };
    return failed(err.message);
  }
  try {
    if (renewedElsewhere()) return { refreshed: false, reason: 'renewed by another process' };
    const current = readStoredLogin(file)?.oauth || oauth;
    let res;
    try {
      res = await requestTokens(config, { refreshToken: current.refreshToken, scopes: current.scopes, signal });
    } catch (err) {
      return failed(err.name === 'TimeoutError' ? 'the token server did not answer in time' : `the token server could not be reached (${err.cause?.code || err.message})`);
    }
    if (res.status === 200) {
      const tokens = parseTokens(res.data, current.refreshToken);
      if (!tokens) return failed('the token server sent an answer that is not a login');
      storeTokens(file, tokens, timing.now());
      return { refreshed: true, expiresAt: timing.now() + tokens.expiresInSec * 1000 };
    }
    // The refresh token was refused. Another process may have used it a moment ago and already stored the
    // new one: look before giving up.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      if (renewedElsewhere()) return { refreshed: false, reason: 'renewed by another process' };
      throw new Error(`The Claude Code login can no longer be renewed (${describeFailure(res.data) || `HTTP ${res.status}`}). ${SIGN_IN_AGAIN}`);
    }
    return failed(`the token server answered HTTP ${res.status}${describeFailure(res.data) ? ` (${describeFailure(res.data)})` : ''}`);
  } finally {
    release();
  }
}

const inflight = new Map();

const refreshDisabled = (config) => /^(1|true|yes)$/i.test(config.env?.CLAUDE_PRO_DISABLE_TOKEN_REFRESH || '');

// Whether this program is able to renew the login by itself: switched on, and the file has a refresh
// token that has not run out. (Whether the server will accept it is only known by asking.)
export function canRenewLogin(config) {
  if (refreshDisabled(config)) return false;
  const oauth = readStoredLogin(config.claudeCodeCredentialsFile)?.oauth;
  if (!oauth?.refreshToken) return false;
  return !(Number(oauth.refreshTokenExpiresAt) > 0 && Number(oauth.refreshTokenExpiresAt) <= timing.now());
}

// Renew the login in the credentials file if it is expired or about to expire (always with `force`).
// Resolves {refreshed, reason}; throws only when the login is unusable and could not be renewed: a
// failure to renew a token that still has a few minutes left is not an error. Callers in the same
// process share one renewal; `signal` only stops this caller from waiting for it.
export async function refreshClaudeCodeLogin(config, { signal, force = false } = {}) {
  if (refreshDisabled(config)) return { refreshed: false, reason: 'disabled' };
  if (signal?.aborted) throw abortError();
  const key = config.claudeCodeCredentialsFile;
  if (!inflight.has(key)) inflight.set(key, renew(config, { force }).finally(() => inflight.delete(key)));
  const shared = inflight.get(key);
  if (!signal) return shared;
  return Promise.race([shared, new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }))]);
}
