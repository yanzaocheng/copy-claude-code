// Renewing the subscription login by itself: the token endpoint is a local server and the credentials
// file a temporary one. Nothing here may ever reach the real endpoint or the real ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Config } from '../src/config.js';
import { streamMessage } from '../src/api.js';
import { readClaudeCodeLogin } from '../src/claude-code.js';
import { refreshClaudeCodeLogin, needsRefresh, readStoredLogin, timing as oauthTiming, endpoint, OAUTH_CLIENT_ID, OAUTH_TOKEN_URL } from '../src/oauth.js';

// Whatever a test forgets to set up, it must never reach the real endpoint.
const NOWHERE = 'http://127.0.0.1:9/never-reached';
endpoint.url = NOWHERE;

const MIN = 60_000;
const HOUR = 60 * MIN;
const OLD = { access: 'old-access-token', refresh: 'old-refresh-token' };

// A token endpoint. `answer(body, seen)` returns [status, json] or may do anything else with the request.
async function tokenServer(t, answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') };
      seen.push(entry);
      const [status, json] = await (answer ? answer(entry.body, seen) : [200, grant()]);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); endpoint.url = NOWHERE; });
  return { url: `http://127.0.0.1:${server.address().port}/v1/oauth/token`, seen };
}

const grant = (extra = {}) => ({
  access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 28_800, refresh_token_expires_in: 90 * 24 * 3600,
  scope: 'user:inference user:profile', token_type: 'Bearer', ...extra,
});

// A temporary Claude config directory, its credentials file as the official client writes it
// (two-space indent, a newline at the end, other keys next to the OAuth ones), and a Config using them.
function world(t, { oauth = {}, env = {}, top = {}, raw } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-oauth-'));
  const configFile = path.join(dir, '.claude.json');
  const file = path.join(dir, '.credentials.json');
  fs.writeFileSync(configFile, JSON.stringify({ userID: 'test-device', oauthAccount: { accountUuid: 'test-account' } }));
  const stored = {
    claudeAiOauth: {
      accessToken: OLD.access, refreshToken: OLD.refresh, expiresAt: Date.now() + 2 * MIN, refreshTokenExpiresAt: Date.now() + 30 * 24 * HOUR,
      scopes: ['user:inference', 'user:profile'], subscriptionType: 'pro', rateLimitTier: 'default_claude_ai', ...oauth,
    },
    organizationUuid: 'org-1', ...top,
  };
  fs.writeFileSync(file, raw ?? JSON.stringify(stored, null, 2) + '\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = new Config({
    CLAUDE_PRO_PROVIDER: 'claude-code', CLAUDE_PRO_CLAUDE_CONFIG_FILE: configFile, CLAUDE_PRO_CLAUDE_CREDENTIALS_FILE: file,
    CLAUDE_PRO_CLAUDE_CODE_VERSION: '2.1.289', CLAUDE_PRO_MAX_RETRIES: '0',
    ...env,
  }, {}, { hooks: {}, mcpServers: {} }, dir);
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { dir, file, config, read, text: () => fs.readFileSync(file, 'utf8') };
}

// Lock waits in real time are a quarter second each: shorten them, and optionally run on a virtual clock.
function quickLocks(t, { virtual = false } = {}) {
  const original = { ...oauthTiming };
  let now = Date.now();
  if (virtual) oauthTiming.now = () => now;
  oauthTiming.sleep = async (ms) => { now += ms; await new Promise((resolve) => (virtual ? setImmediate : (fn) => setTimeout(fn, 2))(resolve)); };
  t.after(() => Object.assign(oauthTiming, original));
}

const leftovers = (dir) => fs.readdirSync(dir).filter((name) => /\.tmp$|\.lock$/.test(name));

// ---------------------------------------------------------------- when to renew

test('needsRefresh: five minutes before the expiry, like the official client', () => {
  const now = 1_000_000_000_000;
  assert.equal(needsRefresh({ expiresAt: now + 6 * MIN }, now), false);
  assert.equal(needsRefresh({ expiresAt: now + 5 * MIN }, now), true);
  assert.equal(needsRefresh({ expiresAt: now - 1 }, now), true);
  assert.equal(needsRefresh({}, now), false, 'no expiry recorded: nothing to renew');
  assert.equal(needsRefresh(null, now), false);
});

test('the endpoint and client id are the official ones', () => {
  assert.equal(OAUTH_TOKEN_URL, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(OAUTH_CLIENT_ID, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
});

// ---------------------------------------------------------------- renewing

test('a token about to expire is renewed and the new tokens are stored, rotating the refresh token', async (t) => {
  const server = await tokenServer(t);
  const w = world(t);
  endpoint.url = server.url;
  const before = Date.now();
  const res = await refreshClaudeCodeLogin(w.config);
  assert.equal(res.refreshed, true);

  assert.equal(server.seen.length, 1);
  const [req] = server.seen;
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.deepEqual(req.body, { grant_type: 'refresh_token', refresh_token: OLD.refresh, client_id: OAUTH_CLIENT_ID, scope: 'user:inference user:profile' });

  const saved = w.read();
  assert.equal(saved.claudeAiOauth.accessToken, 'new-access-token');
  assert.equal(saved.claudeAiOauth.refreshToken, 'new-refresh-token', 'the rotated refresh token must reach the file or the official client is left with a dead one');
  assert.ok(saved.claudeAiOauth.expiresAt >= before + 28_800_000 && saved.claudeAiOauth.expiresAt <= Date.now() + 28_800_000);
  assert.ok(saved.claudeAiOauth.refreshTokenExpiresAt > Date.now() + 89 * 24 * HOUR);
  assert.deepEqual(saved.claudeAiOauth.scopes, ['user:inference', 'user:profile']);
  assert.equal(saved.claudeAiOauth.subscriptionType, 'pro', 'what the file holds besides the tokens is left alone');
  assert.equal(saved.claudeAiOauth.rateLimitTier, 'default_claude_ai');
  assert.equal(saved.organizationUuid, 'org-1');

  assert.match(w.text(), /^\{\n {2}"claudeAiOauth": \{\n {4}"accessToken"/, 'the layout of the file is kept');
  assert.ok(w.text().endsWith('\n'));
  assert.deepEqual(leftovers(w.dir), [], 'no temporary file and no lock is left behind');
  assert.equal(readClaudeCodeLogin(w.config).accessToken, 'new-access-token', 'and the program reads it from there');
});

test('a token that is good for hours is left alone', async (t) => {
  const server = await tokenServer(t);
  const w = world(t, { oauth: { expiresAt: Date.now() + 6 * HOUR } });
  endpoint.url = server.url;
  const before = w.text();
  assert.deepEqual(await refreshClaudeCodeLogin(w.config), { refreshed: false, reason: 'still valid' });
  assert.equal(server.seen.length, 0);
  assert.equal(w.text(), before);
});

test('an expired token is renewed too', async (t) => {
  const server = await tokenServer(t);
  const w = world(t, { oauth: { expiresAt: Date.now() - 3 * HOUR } });
  endpoint.url = server.url;
  assert.equal((await refreshClaudeCodeLogin(w.config)).refreshed, true);
  assert.equal(w.read().claudeAiOauth.accessToken, 'new-access-token');
});

test('when the server sends no new refresh token the old one is kept', async (t) => {
  const server = await tokenServer(t, () => [200, grant({ refresh_token: undefined, refresh_token_expires_in: undefined, scope: undefined })]);
  const w = world(t);
  endpoint.url = server.url;
  await refreshClaudeCodeLogin(w.config);
  const saved = w.read().claudeAiOauth;
  assert.equal(saved.accessToken, 'new-access-token');
  assert.equal(saved.refreshToken, OLD.refresh);
  assert.deepEqual(saved.scopes, ['user:inference', 'user:profile']);
});

test('callers at the same moment share one renewal: the refresh token can be used only once', async (t) => {
  const server = await tokenServer(t, async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return [200, grant()]; });
  const w = world(t);
  endpoint.url = server.url;
  const results = await Promise.all(Array.from({ length: 6 }, () => refreshClaudeCodeLogin(w.config)));
  assert.equal(server.seen.length, 1);
  assert.ok(results.every((r) => r.refreshed === true));
  // and a later call finds the token fresh and sends nothing
  assert.equal((await refreshClaudeCodeLogin(w.config)).refreshed, false);
  assert.equal(server.seen.length, 1);
});

test('one caller giving up does not cancel the renewal the others wait for', async (t) => {
  const server = await tokenServer(t, async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return [200, grant()]; });
  const w = world(t);
  endpoint.url = server.url;
  const ctrl = new AbortController();
  const impatient = refreshClaudeCodeLogin(w.config, { signal: ctrl.signal });
  const patient = refreshClaudeCodeLogin(w.config);
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(impatient, (err) => err.name === 'AbortError');
  assert.equal((await patient).refreshed, true);
  assert.equal(w.read().claudeAiOauth.accessToken, 'new-access-token');
  assert.equal(server.seen.length, 1);
  await assert.rejects(refreshClaudeCodeLogin(w.config, { signal: AbortSignal.abort() }), (err) => err.name === 'AbortError');
});

test('force renews a token that is not due, which is what a 401 asks for', async (t) => {
  const server = await tokenServer(t);
  const w = world(t, { oauth: { expiresAt: Date.now() + 6 * HOUR } });
  endpoint.url = server.url;
  assert.equal((await refreshClaudeCodeLogin(w.config, { force: true })).refreshed, true);
  assert.equal(server.seen.length, 1);
  assert.equal(w.read().claudeAiOauth.accessToken, 'new-access-token');
});

test('there is nothing to renew without a refresh token, and it can be switched off', async (t) => {
  const server = await tokenServer(t);
  const none = world(t, { oauth: { refreshToken: undefined, expiresAt: Date.now() - HOUR } });
  endpoint.url = server.url;
  assert.deepEqual(await refreshClaudeCodeLogin(none.config), { refreshed: false, reason: 'no refresh token' });

  const off = world(t, { oauth: { expiresAt: Date.now() - HOUR }, env: { CLAUDE_PRO_DISABLE_TOKEN_REFRESH: '1' } });
  endpoint.url = server.url;
  assert.deepEqual(await refreshClaudeCodeLogin(off.config, { force: true }), { refreshed: false, reason: 'disabled' });
  assert.equal(server.seen.length, 0);
  assert.equal(off.read().claudeAiOauth.accessToken, OLD.access);
});

test('no setting can send the refresh token somewhere else', async (t) => {
  const server = await tokenServer(t);
  const w = world(t, { env: { CLAUDE_PRO_OAUTH_TOKEN_URL: server.url, ANTHROPIC_BASE_URL: server.url, CLAUDE_PRO_ANTHROPIC_BASE_URL: server.url } });
  endpoint.url = NOWHERE; // what the program uses when nothing replaces it
  const res = await refreshClaudeCodeLogin(w.config);
  assert.equal(res.stillValid, true, 'it went to the fixed endpoint, which is not there');
  assert.equal(server.seen.length, 0, 'the project\'s own settings did not get the token');
});

test('a refresh token that ran out is reported without asking the server', async (t) => {
  const server = await tokenServer(t);
  const w = world(t, { oauth: { expiresAt: Date.now() - HOUR, refreshTokenExpiresAt: Date.now() - MIN } });
  endpoint.url = server.url;
  await assert.rejects(refreshClaudeCodeLogin(w.config), /refresh token ran out.*run `claude` and use \/login/);
  assert.equal(server.seen.length, 0);
});

test('a scope the server does not know is dropped and the renewal repeated without one', async (t) => {
  const server = await tokenServer(t, (body) => (body.scope ? [400, { error: 'invalid_scope', error_description: 'unknown scope' }] : [200, grant()]));
  const w = world(t);
  endpoint.url = server.url;
  assert.equal((await refreshClaudeCodeLogin(w.config)).refreshed, true);
  assert.equal(server.seen.length, 2);
  assert.equal('scope' in server.seen[1].body, false);
});

// ---------------------------------------------------------------- when it goes wrong

test('a refused refresh token is reported as a login that has to be done again, and the file is untouched', async (t) => {
  const server = await tokenServer(t, () => [400, { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' }]);
  const w = world(t, { oauth: { expiresAt: Date.now() - HOUR } });
  endpoint.url = server.url;
  const before = w.text();
  await assert.rejects(refreshClaudeCodeLogin(w.config), (err) => {
    assert.match(err.message, /can no longer be renewed \(invalid_grant: Refresh token not found or invalid\)/);
    assert.match(err.message, /run `claude` and use \/login/);
    return true;
  });
  assert.equal(w.text(), before);
  assert.deepEqual(leftovers(w.dir), []);
});

test('a refresh token refused because another process just used it: that process\'s new login is taken', async (t) => {
  const w = world(t);
  const server = await tokenServer(t, () => {
    // the official client renewed a moment ago: its tokens are in the file by the time this answer arrives
    const json = w.read();
    json.claudeAiOauth = { ...json.claudeAiOauth, accessToken: 'their-access-token', refreshToken: 'their-refresh-token', expiresAt: Date.now() + 8 * HOUR };
    fs.writeFileSync(w.file, JSON.stringify(json, null, 2) + '\n');
    return [400, { error: 'invalid_grant' }];
  });
  endpoint.url = server.url;
  assert.deepEqual(await refreshClaudeCodeLogin(w.config), { refreshed: false, reason: 'renewed by another process' });
  assert.equal(w.read().claudeAiOauth.accessToken, 'their-access-token', 'theirs is left as it is');
  assert.equal(w.read().claudeAiOauth.refreshToken, 'their-refresh-token');
});

test('the server being unreachable is no problem while the token still has minutes left, and an error once it has none', async (t) => {
  const server = await tokenServer(t);
  const url = server.url;
  // a port nobody listens on
  const dead = http.createServer();
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const closedUrl = `http://127.0.0.1:${dead.address().port}/v1/oauth/token`;
  await new Promise((resolve) => dead.close(resolve));
  assert.ok(url);

  const soon = world(t, { oauth: { expiresAt: Date.now() + 3 * MIN } });
  endpoint.url = closedUrl;
  const res = await refreshClaudeCodeLogin(soon.config);
  assert.equal(res.refreshed, false);
  assert.equal(res.stillValid, true);
  assert.match(res.reason, /could not be reached/);

  const gone = world(t, { oauth: { expiresAt: Date.now() - MIN } });
  endpoint.url = closedUrl;
  await assert.rejects(refreshClaudeCodeLogin(gone.config), /access token has expired and could not be renewed: the token server could not be reached/);

  const forced = world(t, { oauth: { expiresAt: Date.now() + 3 * MIN } });
  endpoint.url = closedUrl;
  await assert.rejects(refreshClaudeCodeLogin(forced.config, { force: true }), /login could not be renewed/, 'a 401 asked for it: a token that is merely not expired does not make it succeed');
});

test('a server error is handled like an unreachable server, and says what the server said', async (t) => {
  const server = await tokenServer(t, () => [503, { error: 'overloaded_error', error_description: 'try again later' }]);
  const soon = world(t, { oauth: { expiresAt: Date.now() + 3 * MIN } });
  endpoint.url = server.url;
  assert.equal((await refreshClaudeCodeLogin(soon.config)).stillValid, true);
  assert.equal(soon.read().claudeAiOauth.accessToken, OLD.access, 'nothing was changed');

  const gone = world(t, { oauth: { expiresAt: Date.now() - MIN } });
  endpoint.url = server.url;
  await assert.rejects(refreshClaudeCodeLogin(gone.config), /HTTP 503 \(overloaded_error: try again later\)/);
});

test('an answer that is not a login is not stored', async (t) => {
  const server = await tokenServer(t, () => [200, { hello: 'world' }]);
  const w = world(t, { oauth: { expiresAt: Date.now() - MIN } });
  endpoint.url = server.url;
  const before = w.text();
  await assert.rejects(refreshClaudeCodeLogin(w.config), /not a login/);
  assert.equal(w.text(), before);
});

test('what the server says is shown without anything that looks like a token', async (t) => {
  const leaked = 'sk-ant-oat01-' + 'A1b2C3d4'.repeat(8);
  const server = await tokenServer(t, () => [400, { error: 'invalid_grant', error_description: `bad refresh token ${leaked}` }]);
  const w = world(t, { oauth: { expiresAt: Date.now() - MIN } });
  endpoint.url = server.url;
  await assert.rejects(refreshClaudeCodeLogin(w.config), (err) => {
    assert.ok(!err.message.includes(leaked) && !err.message.includes(leaked.slice(0, 30)));
    assert.ok(!err.message.includes(OLD.refresh) && !err.message.includes(OLD.access));
    return true;
  });
});

// ---------------------------------------------------------------- locks

test('it waits for the official client\'s lock, and takes what was renewed meanwhile instead of renewing again', async (t) => {
  quickLocks(t);
  const server = await tokenServer(t);
  const w = world(t);
  endpoint.url = server.url;
  const lock = path.join(w.dir, '.oauth_refresh.lock');
  fs.mkdirSync(lock); // another process is in the middle of renewing
  const run = refreshClaudeCodeLogin(w.config);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(server.seen.length, 0, 'nothing is sent while somebody else holds the lock');
  const json = w.read();
  json.claudeAiOauth = { ...json.claudeAiOauth, accessToken: 'their-access-token', refreshToken: 'their-refresh-token', expiresAt: Date.now() + 8 * HOUR };
  fs.writeFileSync(w.file, JSON.stringify(json, null, 2) + '\n');
  fs.rmdirSync(lock); // ...and is done
  assert.deepEqual(await run, { refreshed: false, reason: 'renewed by another process' });
  assert.equal(server.seen.length, 0);
  assert.equal(w.read().claudeAiOauth.accessToken, 'their-access-token');
  assert.deepEqual(leftovers(w.dir), []);
});

test('both locks are held while renewing and let go of afterwards, and the older <dir>.lock is respected too', async (t) => {
  quickLocks(t);
  const w = world(t);
  const held = [];
  const server = await tokenServer(t, () => {
    held.push([fs.existsSync(path.join(w.dir, '.oauth_refresh.lock')), fs.existsSync(`${w.dir}.lock`)]);
    return [200, grant()];
  });
  endpoint.url = server.url;
  const old = `${w.dir}.lock`;
  t.after(() => fs.rmSync(old, { recursive: true, force: true }));
  fs.mkdirSync(old);
  const run = refreshClaudeCodeLogin(w.config);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(server.seen.length, 0);
  fs.rmdirSync(old);
  assert.equal((await run).refreshed, true);
  assert.deepEqual(held, [[true, true]]);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(path.join(w.dir, '.oauth_refresh.lock')), false);
});

test('a lock whose holder died (not touched for a minute) is cleared', async (t) => {
  quickLocks(t);
  const server = await tokenServer(t);
  const w = world(t);
  endpoint.url = server.url;
  const stale = new Date(Date.now() - 2 * MIN);
  for (const lock of [path.join(w.dir, '.oauth_refresh.lock'), `${w.dir}.lock`]) {
    fs.mkdirSync(lock);
    fs.utimesSync(lock, stale, stale);
  }
  t.after(() => fs.rmSync(`${w.dir}.lock`, { recursive: true, force: true }));
  assert.equal((await refreshClaudeCodeLogin(w.config)).refreshed, true);
  assert.equal(server.seen.length, 1);
  assert.deepEqual(leftovers(w.dir), []);
  assert.equal(fs.existsSync(`${w.dir}.lock`), false);
});

test('a lock that stays taken is waited for half a minute and then reported', async (t) => {
  quickLocks(t, { virtual: true });
  const server = await tokenServer(t);
  const gone = world(t, { oauth: { expiresAt: Date.now() - MIN } });
  endpoint.url = server.url;
  fs.mkdirSync(path.join(gone.dir, '.oauth_refresh.lock'));
  await assert.rejects(refreshClaudeCodeLogin(gone.config), /has expired and could not be renewed: Another process has held .*oauth_refresh\.lock for 30 seconds/);
  assert.equal(server.seen.length, 0);
});

test('a lock that stays taken is ignored while the token still works, and is not removed', async (t) => {
  quickLocks(t, { virtual: true });
  const server = await tokenServer(t);
  const soon = world(t, { oauth: { expiresAt: Date.now() + 3 * MIN } });
  endpoint.url = server.url;
  fs.mkdirSync(path.join(soon.dir, '.oauth_refresh.lock'));
  assert.equal((await refreshClaudeCodeLogin(soon.config)).stillValid, true);
  assert.equal(server.seen.length, 0);
  assert.equal(fs.existsSync(path.join(soon.dir, '.oauth_refresh.lock')), true, 'a lock that is not ours is not removed');
});

test('if taking the second lock fails the first one is let go of', async (t) => {
  quickLocks(t, { virtual: true });
  const w = world(t, { oauth: { expiresAt: Date.now() - MIN } });
  const second = `${w.dir}.lock`;
  fs.mkdirSync(second);
  t.after(() => fs.rmSync(second, { recursive: true, force: true }));
  await assert.rejects(refreshClaudeCodeLogin(w.config), /could not be renewed/);
  assert.equal(fs.existsSync(path.join(w.dir, '.oauth_refresh.lock')), false);
});

// ---------------------------------------------------------------- the file

test('the file is read as the official client writes it: BOM, CRLF, tab indentation', async (t) => {
  const server = await tokenServer(t);
  const text = JSON.stringify({ claudeAiOauth: { accessToken: OLD.access, refreshToken: OLD.refresh, expiresAt: Date.now() + MIN, scopes: ['user:inference'] }, other: { keep: true } }, null, '\t').replace(/\n/g, '\r\n');
  const w = world(t, { raw: '\uFEFF' + text });
  endpoint.url = server.url;
  assert.equal((await refreshClaudeCodeLogin(w.config)).refreshed, true);
  const saved = JSON.parse(w.text().replace(/^\uFEFF/, ''));
  assert.equal(saved.claudeAiOauth.accessToken, 'new-access-token');
  assert.deepEqual(saved.other, { keep: true });
  assert.equal(readStoredLogin(w.file).oauth.refreshToken, 'new-refresh-token');
});

test('an unreadable credentials file means there is nothing to renew', async (t) => {
  const server = await tokenServer(t);
  const w = world(t, { raw: '{ not json' });
  endpoint.url = server.url;
  assert.deepEqual(await refreshClaudeCodeLogin(w.config), { refreshed: false, reason: 'no refresh token' });
  assert.equal(server.seen.length, 0);
  assert.equal(readStoredLogin(path.join(w.dir, 'missing.json')), null);
});

// ---------------------------------------------------------------- through streamMessage

function apiMock(t, { token, onApi }) {
  const original = globalThis.fetch;
  endpoint.url = 'http://token.test/v1/oauth/token';
  t.after(() => { endpoint.url = NOWHERE; });
  const calls = { token: [], api: [] };
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://token.test/')) {
      const body = JSON.parse(options.body);
      calls.token.push(body);
      const [status, json] = token(body, calls.token.length);
      return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    }
    const auth = new Headers(options.headers).get('authorization');
    calls.api.push(auth);
    return onApi(auth, calls.api.length);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function sse(events) {
  return new Response(events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const answer = (text) => sse([
  { type: 'message_start', message: { model: 'm', usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]);
const unauthorized = () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid bearer token' } }), { status: 401, headers: { 'content-type': 'application/json' } });
const ask = (config) => ({ model: config.mainModel, system: 's', messages: [{ role: 'user', content: 'hi' }] });
const TOKEN_ENV = {};

test('an expired token is renewed before the request, which then uses the new one', async (t) => {
  const w = world(t, { oauth: { expiresAt: Date.now() - 2 * HOUR }, env: TOKEN_ENV });
  const calls = apiMock(t, { token: () => [200, grant()], onApi: () => answer('hello') });
  const res = await streamMessage(w.config, ask(w.config));
  assert.equal(res.message.content[0].text, 'hello');
  assert.deepEqual(calls.api, ['Bearer new-access-token']);
  assert.equal(calls.token.length, 1);
  assert.equal(w.read().claudeAiOauth.refreshToken, 'new-refresh-token');
});

test('a token with a few minutes left is renewed ahead of time, and the next request does not renew again', async (t) => {
  const w = world(t, { oauth: { expiresAt: Date.now() + 3 * MIN }, env: TOKEN_ENV });
  const calls = apiMock(t, { token: () => [200, grant()], onApi: () => answer('ok') });
  await streamMessage(w.config, ask(w.config));
  await streamMessage(w.config, ask(w.config));
  assert.equal(calls.token.length, 1);
  assert.deepEqual(calls.api, ['Bearer new-access-token', 'Bearer new-access-token']);
});

test('a token that cannot be renewed stops the request with the reason, instead of "has expired"', async (t) => {
  const w = world(t, { oauth: { expiresAt: Date.now() - HOUR }, env: TOKEN_ENV });
  const calls = apiMock(t, { token: () => [400, { error: 'invalid_grant' }], onApi: () => answer('never') });
  await assert.rejects(streamMessage(w.config, ask(w.config)), /can no longer be renewed \(invalid_grant\).*run `claude` and use \/login/);
  assert.equal(calls.api.length, 0, 'no request goes out with a token known to be dead');
});

test('when renewing early fails but the token still works, the request goes ahead with it', async (t) => {
  const w = world(t, { oauth: { expiresAt: Date.now() + 3 * MIN }, env: TOKEN_ENV });
  const calls = apiMock(t, { token: () => [503, { error: 'overloaded_error' }], onApi: () => answer('fine') });
  const res = await streamMessage(w.config, ask(w.config));
  assert.equal(res.message.content[0].text, 'fine');
  assert.deepEqual(calls.api, [`Bearer ${OLD.access}`]);
});

test('a 401 on a token that looks valid renews it once and repeats the request with the new one', async (t) => {
  const w = world(t, { oauth: { expiresAt: Date.now() + 6 * HOUR }, env: TOKEN_ENV });
  const calls = apiMock(t, { token: () => [200, grant()], onApi: (auth) => (auth === `Bearer ${OLD.access}` ? unauthorized() : answer('second time')) });
  const res = await streamMessage(w.config, ask(w.config));
  assert.equal(res.message.content[0].text, 'second time');
  assert.deepEqual(calls.api, [`Bearer ${OLD.access}`, 'Bearer new-access-token']);
  assert.equal(calls.token.length, 1);
});

test('a 401 that renewing does not cure is reported once, not retried in a loop', async (t) => {
  const w = world(t, { oauth: { expiresAt: Date.now() + 6 * HOUR }, env: TOKEN_ENV });
  const calls = apiMock(t, { token: () => [400, { error: 'invalid_grant' }], onApi: () => unauthorized() });
  await assert.rejects(streamMessage(w.config, ask(w.config)), /Claude Code OAuth authentication failed/);
  assert.equal(calls.api.length, 1);
  assert.equal(calls.token.length, 1);
});

test('with refreshing switched off an expired token gives the plain error and sends nothing', async (t) => {
  const w = world(t, { oauth: { expiresAt: Date.now() - HOUR }, env: { ...TOKEN_ENV, CLAUDE_PRO_DISABLE_TOKEN_REFRESH: 'true' } });
  const calls = apiMock(t, { token: () => [200, grant()], onApi: () => answer('never') });
  await assert.rejects(streamMessage(w.config, ask(w.config)), /access token has expired/);
  assert.equal(calls.token.length + calls.api.length, 0);
});

test('a 401 because the token ran out during the request renews it and repeats the request', async (t) => {
  const w = world(t, { oauth: { expiresAt: Date.now() + 6 * HOUR }, env: TOKEN_ENV });
  const calls = apiMock(t, {
    token: () => [200, grant()],
    onApi: (auth, n) => {
      if (n > 1) return answer('after renewing');
      const json = w.read(); // the login's time runs out while the server is answering
      json.claudeAiOauth.expiresAt = Date.now() - 1000;
      fs.writeFileSync(w.file, JSON.stringify(json));
      return unauthorized();
    },
  });
  const res = await streamMessage(w.config, ask(w.config));
  assert.equal(res.message.content[0].text, 'after renewing');
  assert.deepEqual(calls.api, [`Bearer ${OLD.access}`, 'Bearer new-access-token']);
});

test('a 401 because the token ran out, with no way to renew it, reports why renewing failed rather than a bare 401', async (t) => {
  const w = world(t, { oauth: { expiresAt: Date.now() + 6 * HOUR }, env: TOKEN_ENV });
  apiMock(t, {
    token: () => [400, { error: 'invalid_grant' }],
    onApi: () => {
      const json = w.read();
      json.claudeAiOauth.expiresAt = Date.now() - 1000;
      fs.writeFileSync(w.file, JSON.stringify(json));
      return unauthorized();
    },
  });
  await assert.rejects(streamMessage(w.config, ask(w.config)), /can no longer be renewed \(invalid_grant\).*run `claude` and use \/login/);
});
