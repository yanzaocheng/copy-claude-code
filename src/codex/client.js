// The local Codex (ChatGPT) subscription login as a provider: Anthropic Messages requests from the SDK are
// translated to OpenAI Responses requests for the Codex backend, and the Responses stream back to Anthropic SSE,
// so that the rest of the program (api.js, the agent loop) works unchanged. Hooked in as the SDK's `fetch`.
// The login is the one `codex login` wrote to $CODEX_HOME/auth.json; its access token is renewed with the
// refresh token stored there, and the renewed tokens are written back for the Codex CLI to use too.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResponsesRequest, toolNameMap } from './translate-request.js';
import { ResponsesToAnthropic, parseSSE } from './translate-stream.js';

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const OAUTH_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_MARGIN_MS = 5 * 60_000;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const LOWER_EFFORT = { ultra: 'max', max: 'xhigh', xhigh: 'high', high: 'medium', minimal: 'low', none: 'low', low: 'medium' };

export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const codexAuthFile = (env = process.env) => path.join(codexHome(env), 'auth.json');

export function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const expiresSoon = (token) => {
  const exp = decodeJwt(token)?.exp;
  return !exp || exp * 1000 - Date.now() < REFRESH_MARGIN_MS;
};

function readAuth(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error(`No Codex login: ${file} does not exist. Run \`codex login\` (ChatGPT plan), then try again.`), { status: 401 });
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw Object.assign(new Error(`Cannot parse ${file}: ${e.message}`), { status: 401 });
  }
}

function writeAuth(file, data) {
  const body = JSON.stringify(data, null, 2);
  const tmp = `${file}.claude-pro-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* not there */ }
    fs.writeFileSync(file, body, { mode: 0o600 });
  }
}

const accountIdOf = (tokens) => tokens.account_id
  || decodeJwt(tokens.id_token)?.['https://api.openai.com/auth']?.chatgpt_account_id
  || decodeJwt(tokens.access_token)?.['https://api.openai.com/auth']?.chatgpt_account_id
  || '';

// What /status shows about the login (nothing secret).
export function codexLoginSummary(env = process.env) {
  const file = codexAuthFile(env);
  try {
    const data = readAuth(file);
    const claims = decodeJwt(data.tokens?.id_token)?.['https://api.openai.com/auth'] || {};
    const email = decodeJwt(data.tokens?.id_token)?.email || null;
    if (data.tokens?.access_token) return { ok: true, file, plan: claims.chatgpt_plan_type || null, email };
    if (data.OPENAI_API_KEY) return { ok: true, file, plan: 'api key' };
    return { ok: false, file, error: 'no tokens in it' };
  } catch (e) {
    return { ok: false, file, error: e.message };
  }
}

let refreshing = null;

async function refresh(file, stale, fetchImpl) {
  const data = readAuth(file);
  const tokens = data.tokens || {};
  // The Codex CLI or app may have renewed it already.
  if (tokens.access_token && tokens.access_token !== stale && !expiresSoon(tokens.access_token)) return;
  if (!tokens.refresh_token) throw Object.assign(new Error('The Codex login has no refresh token. Run `codex login` again.'), { status: 401 });
  const res = await fetchImpl(OAUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, scope: 'openid profile email' }),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason = text.slice(0, 200);
    try { const j = JSON.parse(text); reason = j.error_description || j.error?.message || j.error || reason; } catch { /* as it is */ }
    throw Object.assign(new Error(`Renewing the Codex login failed (HTTP ${res.status}: ${reason}). Run \`codex login\` again.`), { status: 401 });
  }
  const j = JSON.parse(text);
  const next = { ...data, tokens: { ...tokens } };
  for (const k of ['access_token', 'id_token', 'refresh_token']) if (j[k]) next.tokens[k] = j[k];
  next.last_refresh = new Date().toISOString();
  writeAuth(file, next);
}

export async function codexCredentials(file, { force = false, fetchImpl = globalThis.fetch } = {}) {
  const data = readAuth(file);
  const tokens = data.tokens;
  if (tokens?.access_token && data.auth_mode !== 'apikey') {
    if (force || expiresSoon(tokens.access_token)) {
      refreshing ??= refresh(file, tokens.access_token, fetchImpl).finally(() => { refreshing = null; });
      await refreshing;
      const fresh = readAuth(file).tokens;
      return { mode: 'chatgpt', accessToken: fresh.access_token, accountId: accountIdOf(fresh) };
    }
    return { mode: 'chatgpt', accessToken: tokens.access_token, accountId: accountIdOf(tokens) };
  }
  if (data.OPENAI_API_KEY) return { mode: 'apikey', apiKey: data.OPENAI_API_KEY };
  throw Object.assign(new Error(`No usable credentials in ${file}. Run \`codex login\`.`), { status: 401 });
}

// A file's parsed contents, read again only when it changes (the footer asks for the model on every frame).
const fileCache = new Map();
function readCached(file, parse, fallback) {
  let st;
  try { st = fs.statSync(file); } catch { return fallback; }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let value;
  try { value = parse(fs.readFileSync(file, 'utf8')); } catch { value = fallback; }
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

// The models the local Codex install knows (models_cache.json): efforts, context window, base instructions.
export function codexModels(env = process.env) {
  return readCached(path.join(codexHome(env), 'models_cache.json'), parseModelsCache, { clientVersion: null, models: [] });
}

function parseModelsCache(text) {
  {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : j.models || [];
    return {
      clientVersion: /^\d+\.\d+\.\d+$/.test(String(j.client_version)) ? j.client_version : null,
      models: list.filter((m) => m && typeof m.slug === 'string').map((m) => ({
        slug: m.slug,
        hidden: /^hid/i.test(m.visibility || ''),
        efforts: (m.supported_reasoning_levels || []).map((r) => (typeof r === 'string' ? r : r?.effort)).filter(Boolean),
        defaultEffort: m.default_reasoning_level || null,
        contextWindow: m.context_window || null,
        baseInstructions: typeof m.base_instructions === 'string' ? m.base_instructions : null,
      })),
    };
  }
}

// The model and effort set in the Codex config.toml (top-level `model` / `model_reasoning_effort`).
export function codexConfigDefaults(env = process.env) {
  return readCached(path.join(codexHome(env), 'config.toml'), (text) => {
    const top = text.split(/^\s*\[/m)[0];
    const pick = (key) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(top)?.[1] || null;
    return { model: pick('model'), effort: pick('model_reasoning_effort') };
  }, { model: null, effort: null });
}

function clampEffort(effort, supported) {
  if (!effort || !supported?.length || supported.includes(effort)) return effort;
  const want = EFFORTS.indexOf(effort);
  return supported.reduce((best, s) => (Math.abs(EFFORTS.indexOf(s) - want) < Math.abs(EFFORTS.indexOf(best) - want) ? s : best), supported[0]);
}

// The effort levels a GPT model takes, from the local Codex models cache ([] when it is not listed there):
// gpt-6.1-sol takes low … ultra, but not none or minimal.
export const codexEfforts = (modelId, env = process.env) => codexModels(env).models.find((m) => m.slug === modelId)?.efforts || [];

// The level the Codex backend gets for a chosen one: the nearest the model takes.
export const codexEffort = (modelId, effort, env = process.env) => clampEffort(effort, codexEfforts(modelId, env));

// An Anthropic-shaped error response, which the SDK turns into an APIError with this status.
function errorResponse(status, type, message, headers = {}) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function upstreamError(status, text, headers) {
  let message = text.slice(0, 500) || `HTTP ${status}`;
  let code = '';
  let resetsIn = null;
  try {
    const j = JSON.parse(text);
    message = j.error?.message || j.detail || j.message || message;
    code = j.error?.type || j.error?.code || '';
    resetsIn = j.error?.resets_in_seconds ?? null;
  } catch { /* not JSON */ }
  const extra = {};
  if (resetsIn != null) extra['retry-after'] = String(resetsIn);
  else if (headers.get('retry-after')) extra['retry-after'] = headers.get('retry-after');
  if (status === 429 || /usage_limit|rate_limit/i.test(code)) return { status: 429, type: 'rate_limit_error', message: `Codex: ${message}`, headers: extra, upstreamMessage: message };
  if (status === 401 || status === 403) return { status, type: 'authentication_error', message: `Codex login refused (${status}): ${message}. Run \`codex login\` again if this persists.`, headers: extra, upstreamMessage: message };
  return { status, type: status >= 500 ? 'api_error' : 'invalid_request_error', message: `Codex: ${message}`, headers: extra, upstreamMessage: message };
}

// The SDK's fetch for the codex provider. `options.env` is the configuration's environment (CODEX_HOME).
export function createCodexFetch({ env = process.env, url = CODEX_RESPONSES_URL, fetchImpl = globalThis.fetch, sessionId = crypto.randomUUID() } = {}) {
  const sticky = { instructionsMode: 'custom', removedParams: new Set() };
  return async function codexFetch(input, init = {}) {
    const target = String(input?.url ?? input);
    const { pathname } = new URL(target);
    if (!/\/v1\/messages$/.test(pathname)) return errorResponse(404, 'not_found_error', `The codex provider does not support ${pathname}`);
    let anth;
    try { anth = JSON.parse(typeof init.body === 'string' ? init.body : await new Response(init.body).text()); } catch { return errorResponse(400, 'invalid_request_error', 'Request body is not valid JSON'); }
    const file = codexAuthFile(env);
    const known = codexModels(env);
    const model = String(anth.model || '').replace(/\[1m\]$/i, '');
    const info = known.models.find((m) => m.slug === model);
    // No effort sent ("auto", and side queries such as titles): the model's own default, as with Claude.
    const wanted = anth.output_config?.effort || info?.defaultEffort || null;
    const o = {
      model,
      effort: clampEffort(wanted, info?.efforts),
      summary: 'auto',
      sessionId,
      instructionsMode: sticky.instructionsMode,
      codexInstructions: sticky.instructionsMode === 'codex' ? info?.baseInstructions : null,
      removedParams: new Set(sticky.removedParams),
      dropReasoning: false,
      webSearch: false,
      parallelToolCalls: true,
    };
    const triedEfforts = new Set([o.effort]);
    let refreshed = false; // a 401 renews the token once
    let force = false;
    let res;
    for (let attempt = 0; ; attempt++) {
      let creds;
      try { creds = await codexCredentials(file, { force, fetchImpl }); } catch (e) { return errorResponse(e.status || 401, 'authentication_error', e.message); }
      force = false;
      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'openai-beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        version: known.clientVersion || '0.162.0',
        'user-agent': `codex_cli_rs/${known.clientVersion || '0.162.0'} (${os.type()} ${os.release()}; ${os.arch()}) claude-pro`,
        session_id: sessionId,
        authorization: `Bearer ${creds.mode === 'chatgpt' ? creds.accessToken : creds.apiKey}`,
      };
      if (creds.accountId) headers['chatgpt-account-id'] = creds.accountId;
      const payload = buildResponsesRequest(anth, o);
      res = await fetchImpl(creds.mode === 'chatgpt' ? url : 'https://api.openai.com/v1/responses', { method: 'POST', headers, body: JSON.stringify(payload), signal: init.signal });
      if (res.ok) break;
      const text = await res.text();
      const err = upstreamError(res.status, text, res.headers);
      if (attempt >= 5) return errorResponse(err.status, err.type, err.message, err.headers);
      if (res.status === 401 && !refreshed) { refreshed = force = true; continue; }
      if (res.status === 400) {
        const m = err.upstreamMessage;
        if (/instruction/i.test(m) && o.instructionsMode !== 'codex' && info?.baseInstructions) {
          o.instructionsMode = sticky.instructionsMode = 'codex';
          o.codexInstructions = info.baseInstructions;
          continue;
        }
        if (/encrypted|reasoning item|could not be (verified|decrypted)/i.test(m) && !o.dropReasoning) { o.dropReasoning = true; continue; }
        const param = m.match(/unsupported parameter:?\s*['"`]?([\w.]+)/i)?.[1];
        if (param && !o.removedParams.has(param) && !['model', 'input', 'stream'].includes(param)) {
          o.removedParams.add(param);
          sticky.removedParams.add(param);
          continue;
        }
        const lower = LOWER_EFFORT[o.effort];
        if (/effort/i.test(m) && lower && !triedEfforts.has(lower)) { o.effort = lower; triedEfforts.add(lower); continue; }
      }
      return errorResponse(err.status, err.type, err.message, err.headers);
    }

    const toolNames = toolNameMap(anth);
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        const conv = new ResponsesToAnthropic({
          model: anth.model,
          toolNames,
          emitThinking: true,
          onEvent: (name, data) => controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)),
        });
        conv.start();
        try {
          for await (const ev of parseSSE(res.body)) {
            conv.handle(ev);
            if (conv.done) break;
          }
          conv.end();
        } catch (e) {
          if (init.signal?.aborted) { controller.error(e); return; }
          conv.fail(`Codex stream error: ${e.message}`);
        }
        controller.close();
      },
      cancel() { res.body?.cancel?.().catch(() => {}); },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  };
}
