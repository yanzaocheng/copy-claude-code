// Thin layer over the Anthropic SDK: builds request params from config and turns the
// raw SSE stream into a fully assembled assistant message while reporting progress.

import Anthropic from '@anthropic-ai/sdk';
import { readClaudeCodeLogin, claudeCodeHeaders, CLAUDE_CODE_API_URL, CLAUDE_CODE_SYSTEM } from './claude-code.js';
import { refreshClaudeCodeLogin, canRenewLogin } from './oauth.js';
import { humanDuration, parseRateLimit, parseRetryAfter, planRetry, sleepUntil, timing } from './ratelimit.js';
import { cacheControl, cachePlanOf, fingerprint } from './cache.js';
import { readGatewayLogin, fetchGatewayModels, cachedGatewayModel, gatewayEffort, gatewayDefaultEffort } from './gateway.js';
import { createCodexFetch, codexModels, codexEffort, nearestEffort } from './codex/client.js';
import { SIGNATURE_PREFIX } from './codex/translate-request.js';

let cached = null;

const LOGIN_POLL_MS = 15_000; // how often to look for a refreshed login after a pause
const LOGIN_RENEW_RETRY_MS = 5 * 60_000; // how often to try renewing it while waiting for one

// Renew the subscription login if it needs it. Returns true when the file now holds a new login. A login
// that cannot be renewed is an error with its reason, in place of the bare "token has expired" -- unless
// the caller has its own way of dealing with that: `onError` is told and the call returns false (the
// wait for a login), and so does `force` (a 401: the request is reported as it is).
async function renewLogin(config, signal, { force = false, onError } = {}) {
  try {
    return (await refreshClaudeCodeLogin(config, { signal, force })).refreshed;
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError', partial: [] });
    if (onError) { onError(err); return false; }
    if (force) return false;
    throw err;
  }
}

// The login expiry worth warning about before a long pause: none when this program renews it itself.
const loginExpiryToWarnAbout = (config, login) => (config.usesClaudeCode && !canRenewLogin(config) ? login?.expiresAt ?? null : null);

// The subscription login to use once a pause is over. Its access token lives 8 hours, so after hours of
// waiting it has most likely expired: it is renewed first, with the refresh token that is stored with it.
// If that is not possible (the refresh token was refused, the token server cannot be reached for the
// moment, renewing is switched off) the wait is not wasted by failing at its end: keep looking for a
// valid login for what is left of the waiting budget, renewing again every few minutes, and say so. A
// login done in the meantime (running `claude`) is picked up. The file may also be half written at this
// very moment by another process.
async function loginAfterPause(config, state, { signal, onEvent }) {
  let spent = 0;
  let renewedAt = 0;
  let renewError = null;
  for (;;) {
    if (!renewedAt || timing.now() - renewedAt >= LOGIN_RENEW_RETRY_MS) {
      renewedAt = timing.now();
      renewError = null;
      await renewLogin(config, signal, { onError: (err) => { renewError = err; } });
    }
    try {
      return readClaudeCodeLogin(config);
    } catch (err) {
      const left = config.rateLimitMaxWait - state.waitedMs;
      if (left < LOGIN_POLL_MS) {
        if (renewError && /access token has expired/.test(err.message)) err.message = renewError.message; // the reason, not just the fact
        if (spent) err.message += ` (Waited ${humanDuration(spent)} for it after the limit reset.)`;
        throw err;
      }
      const now = timing.now();
      onEvent({
        type: 'rate_limit_wait', error: err, delayMs: LOGIN_POLL_MS, resumeAt: now + LOGIN_POLL_MS, resetAt: null, label: 'login',
        polling: true, waitingForLogin: true, giveUpAt: now + left, waitedMs: state.waitedMs, maxWaitMs: config.rateLimitMaxWait,
        renewError: renewError?.message || null,
      });
      state.waitedMs += LOGIN_POLL_MS;
      spent += LOGIN_POLL_MS;
      await sleepUntil(now + LOGIN_POLL_MS, signal);
    }
  }
}

let codexFetch = null;

// The gateway provider's key, from /login. Without one the request fails the way a refused key does.
function gatewayKey(config) {
  const login = readGatewayLogin(config.gatewayUrl);
  if (!login) throw new APIError(`Not logged in to the gateway ${config.gatewayUrl}. Run /login and choose the gateway.`, { status: 401, retryable: false });
  return login.apiKey;
}

export function getClient(config, login = null) {
  if (config.usesGateway || config.usesCodex) {
    const gateway = config.usesGateway;
    const baseURL = gateway ? config.gatewayUrl : 'https://codex.invalid';
    const authToken = gateway ? gatewayKey(config) : 'codex-login';
    if (!gateway) codexFetch ||= createCodexFetch({ env: { ...process.env, ...config.env } });
    const key = `${config.provider}|${baseURL}|${authToken}|${config.apiTimeout}`;
    if (cached?.key === key && cached.fetch === globalThis.fetch) return cached.client;
    const client = new Anthropic({
      baseURL,
      authToken,
      apiKey: null,
      timeout: config.apiTimeout,
      maxRetries: 0,
      ...(gateway ? {} : { fetch: codexFetch }),
    });
    cached = { key, client, fetch: globalThis.fetch };
    return client;
  }
  if (config.usesClaudeCode) login ||= readClaudeCodeLogin(config);
  // Subscription credentials must only go to Anthropic, regardless of an API
  // endpoint or custom auth headers left over from .env (e.g. DeepSeek).
  const baseURL = login ? CLAUDE_CODE_API_URL : config.baseURL;
  const authToken = login ? login.accessToken : config.authToken;
  const apiKey = login || authToken ? null : (config.apiKey || null);
  const headers = login ? claudeCodeHeaders(login) : config.customHeaders;
  const key = `${baseURL}|${authToken}|${apiKey}|${JSON.stringify(headers)}|${config.apiTimeout}`;
  if (cached?.key === key && cached.fetch === globalThis.fetch) return cached.client;
  const client = new Anthropic({
    baseURL,
    // Prefer the bearer token; pass null explicitly so the SDK never falls back to env vars.
    authToken,
    apiKey,
    defaultHeaders: headers,
    defaultQuery: login ? { beta: 'true' } : undefined,
    timeout: config.apiTimeout,
    maxRetries: 0, // retries are handled in streamMessage so the UI can report them

    dangerouslyAllowBrowser: false,
  });
  cached = { key, client, fetch: globalThis.fetch };
  return client;
}

// Mark the last block of the latest user message as cacheable (`mark` is the cache_control to put there; null
// leaves the messages alone). With the markers on the system prompt and the last tool this makes three of the
// four breakpoints a request may have. Endpoints that don't support prompt caching (e.g. DeepSeek, which caches
// automatically) ignore them.
function withCacheControl(messages, mark) {
  if (!mark || !messages.length) return messages;
  const out = messages.slice();
  const idx = out.length - 1;
  const last = out[idx];
  if (last.role !== 'user') return out;
  const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.slice();
  if (!content.length) return out;
  const tail = content.length - 1;
  content[tail] = { ...content[tail], cache_control: mark };
  out[idx] = { ...last, content };
  return out;
}

// What an endpoint refused (a gateway that does not know cache_control, say), by endpoint and model: the
// places (system, tools, messages) it was refused on, and "ttl" when the 1-hour TTL was. Learned from its 400
// errors. Claude Code carries on without the marker instead of failing the request, and so does this: the
// marker is left off from then on, so the endpoint is not asked the same thing again.
const cacheRefused = new Map();
const cacheKey = (config, modelId, login) => `${login ? 'claude-code' : config.baseURL}|${modelId}`;

const PLACES = ['system', 'tools', 'messages'];
const blocksAt = (params, place) => {
  if (place === 'system') return params.system || [];
  if (place === 'tools') return params.tools || [];
  return (params.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
};
const hasMark = (params, place) => blocksAt(params, place).some((b) => b.cache_control);

// What an endpoint has refused so far, for /status: the places (system, tools, messages) and "ttl".
export function cacheRefusals(config, modelId) {
  return [...(cacheRefused.get(cacheKey(config, modelId, config.usesClaudeCode)) || [])];
}

// Take cache_control (or only its ttl) off a request after the endpoint refused it. Returns what was taken off
// (a set of places, or "ttl"), empty when there was nothing left to take off: then the caller must give up on
// the request. The refusal is only remembered once a request has got through without it (see streamMessage):
// an error that merely mentions cache_control must not switch caching off for good.
function refuseCache(params, message) {
  const text = String(message || '').toLowerCase();
  const taken = new Set();
  if (/\bttl\b/.test(text) && cachePlanOf(params).ttl === '1h') {
    // "a ttl='1h' cache_control block must occur before ...", "ttl: Extra inputs are not permitted": the 5-minute default
    for (const place of PLACES) for (const b of blocksAt(params, place)) if (b.cache_control?.ttl) b.cache_control = { type: 'ephemeral' };
    taken.add('ttl');
    return taken;
  }
  const marked = PLACES.filter((p) => hasMark(params, p));
  const named = marked.filter((p) => new RegExp(`\\b${p}\\b`).test(text));
  // An error that says where is believed. One that does not ("a maximum of 4 blocks ... may be provided") loses
  // one place at a time, the newest first, so that as much of the caching as possible is kept.
  const places = named.length ? named : ['messages', 'tools', 'system'].filter((p) => marked.includes(p)).slice(0, 1);
  for (const place of places) {
    for (const b of blocksAt(params, place)) delete b.cache_control;
    taken.add(place);
  }
  return taken;
}

// Output ceilings the API has told us about, by model id (learned from "max_tokens too large" errors).
const outputCaps = new Map();
// Models that refused the effort parameter (Haiku does): it is left out for them from then on.
const noEffort = new Set();
export const effortSupported = (modelId) => !noEffort.has(modelId);

// The effort a model uses when none is sent (docs.claude.com, "Effort"): medium on Opus 5.5 and Haiku 5.5, high on
// the other models that take one; for a GPT model, the gateway's metadata or the local Codex models cache. null for
// a model that takes none or is not known.
// The environment that says where the Codex install is: CODEX_HOME may be set in the shell only.
const codexEnv = (config) => ({ ...process.env, ...(config?.env || {}) });
const gatewayModelInfo = (config, id) => (config?.usesGateway ? cachedGatewayModel(readGatewayLogin(config.gatewayUrl), id) : null);

export function defaultEffort(modelId, config = null) {
  const id = String(modelId || '');
  if (!effortSupported(id)) return null;
  if (/^gpt-/i.test(id)) {
    return gatewayDefaultEffort(gatewayModelInfo(config, id)) || codexModels(codexEnv(config)).models.find((m) => m.slug === id)?.defaultEffort || null;
  }
  if (/^claude-(?:opus|haiku)-5-5(?:-|$)/i.test(id)) return 'medium';
  if (/^claude-(?:fable|mythos|opus-(?:5|4-[5-8])|sonnet-(?:5|4-6))(?:-|$)/i.test(id)) return 'high';
  return null;
}

// The effort levels Claude takes, as Claude Code's /effort offers them. OpenAI's none and minimal and the ultra of
// some GPT models are not among them; a level chosen on a GPT model stays chosen after a switch to Claude.
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// The level a request for this model carries when `effort` is chosen: the nearest one the model takes. A GPT model
// lists its own (the gateway's /v1/models, else the local Codex models cache); Claude takes CLAUDE_EFFORTS.
export function effortToSend(config, modelId, effort) {
  if (!effort) return effort;
  if (/^claude-/i.test(modelId)) return nearestEffort(effort, CLAUDE_EFFORTS);
  if (!/^gpt-/i.test(modelId)) return effort === 'ultra' ? 'max' : effort;
  const info = gatewayModelInfo(config, modelId);
  return info ? gatewayEffort(info, effort) : codexEffort(modelId, effort, codexEnv(config));
}

// Pull the allowed maximum out of an error such as
//   "max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-..."
//   "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]"
export function parseMaxTokensLimit(message) {
  const text = String(message || '');
  if (!/max_tokens|output tokens/i.test(text)) return null;
  const m = /max_tokens:\s*\d+\s*>\s*(\d+)/i.exec(text)
    || /range of max_tokens is \[\s*\d+\s*,\s*(\d+)\s*\]/i.exec(text)
    || /(?:maximum|at most|limit(?:ed)? (?:of|to)|<=|less than or equal to)[^\d]{0,40}(\d{3,7})/i.exec(text);
  const n = m ? parseInt(m[1], 10) : 0;
  return n >= 256 ? n : null;
}

// Thinking blocks made from Codex reasoning (a GPT model's turns, signed "cgw1:...") replay that reasoning on the
// Codex backend only: Anthropic refuses their signatures ("Invalid `signature` in `thinking` block"), so a
// conversation that moves from a GPT model to Claude, or to another provider, sends them without those blocks.
// The session keeps them, for a later switch back. `inTurn`: blocks were taken out of the turn in progress (the
// tool loop since the last prompt), whose assistant messages Anthropic wants to start with thinking when thinking
// is on; such a turn goes on without thinking until the next prompt.
const isCodexThinking = (b) => b?.type === 'thinking' && typeof b.signature === 'string' && b.signature.startsWith(SIGNATURE_PREFIX);
const isPrompt = (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
function withoutCodexThinking(messages) {
  const prompt = messages.findLastIndex(isPrompt);
  let inTurn = false;
  const out = messages.flatMap((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content) || !m.content.some(isCodexThinking)) return [m];
    if (i > prompt) inTurn = true;
    const content = m.content.filter((b) => !isCodexThinking(b));
    return content.length ? [{ ...m, content }] : [];
  });
  return { messages: out, inTurn };
}

// `cacheBucket` says which prompt cache TTL applies: "main" for the conversation itself (the default), "other"
// for sub-agents, compaction and side queries (see Config.cacheTtl). `cacheMessages: false` leaves the messages
// unmarked: for a request whose messages are never sent twice, writing them to the cache only costs more.
export function buildParams(config, { model, system, messages, tools, maxTokens, effort, cacheBucket = 'main', cacheMessages = true }, login = null) {
  if (config.usesClaudeCode) login ||= readClaudeCodeLogin(config);
  const wanted = maxTokens || config.maxOutputTokens;
  const refused = cacheRefused.get(cacheKey(config, model.id, login));
  const caching = !config.promptCachingDisabled(model.id);
  const ttl = refused?.has('ttl') ? '5m' : config.cacheTtl(cacheBucket);
  const mark = (place) => (caching && !refused?.has(place) ? { ...cacheControl(ttl) } : null);
  const systemMark = mark('system');
  // The codex provider, and the gateway for a GPT model, take the request to the Codex backend.
  const toCodex = config.usesCodex || /^gpt-/i.test(model.id);
  let turnLostThinking = false;
  if (!toCodex) ({ messages, inTurn: turnLostThinking } = withoutCodexThinking(messages));
  const params = {
    model: model.id,
    max_tokens: outputCaps.has(model.id) ? Math.min(wanted, outputCaps.get(model.id)) : wanted,
    system: [{ type: 'text', text: system, ...(systemMark ? { cache_control: systemMark } : {}) }],
    messages: withCacheControl(messages, cacheMessages ? mark('messages') : null),
    stream: true,
  };
  if (login) {
    params.system.unshift({ type: 'text', text: CLAUDE_CODE_SYSTEM });
    params.metadata = { user_id: login.userId };
  }
  if (tools?.length) {
    const toolMark = mark('tools');
    params.tools = tools.map((t, i) => (i === tools.length - 1 && toolMark ? { ...t, cache_control: toolMark } : t));
  }
  // A GPT model with no effort set gets its default from the gateway's model metadata (or the local Codex cache
  // when using the Codex provider), sent explicitly so that the footer and backend use the same level.
  const eff = effortToSend(config, model.id, (effort === undefined ? config.effort : effort) || (/^gpt-/i.test(model.id) ? defaultEffort(model.id, config) : null));
  if (eff && !noEffort.has(model.id)) params.output_config = { effort: eff };
  const budget = config.thinkingBudget;
  if (budget === 0) params.thinking = { type: 'disabled' };
  else if (budget > 0) params.thinking = { type: 'enabled', budget_tokens: Math.min(budget, params.max_tokens - 1) };
  if (turnLostThinking) params.thinking = { type: 'disabled' };
  return params;
}

export class APIError extends Error {
  constructor(message, { status, retryable, promptTooLong, retryAfterMs = null, rateLimit = null } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.promptTooLong = promptTooLong;
    this.retryAfterMs = retryAfterMs; // what the server's Retry-After header asked for
    this.rateLimit = rateLimit; // what the rate limit headers say (see ratelimit.js)
  }
}

function describeError(err, config) {
  if (err?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) return err;
  const status = err?.status;
  let msg = err?.error?.error?.message || err?.error?.message || err?.message || String(err);
  const promptTooLong = /prompt is too long|context length|maximum context|too many tokens|context_length_exceeded/i.test(msg);
  if (err instanceof APIError) return err;
  if (status === 401) msg = config?.usesClaudeCode
    ? `Claude Code OAuth authentication failed (401). Check the existing local subscription credentials in ${config.claudeCodeCredentialsFile}. ${msg}`
    : config?.usesGateway ? `The gateway refused the login (401). Run /login to log in again. ${msg}`
      : config?.usesCodex ? msg
        : `Authentication failed (401). Check ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY. ${msg}`;
  if (status === 402 && config?.usesGateway) msg = `The gateway account's balance is too low for this request. Top up at ${config.gatewayUrl}/user (or run /login to check the balance). ${msg}`;
  const retryable = !status || status === 408 || status === 409 || status === 429 || status >= 500;
  const header = typeof err?.headers?.get === 'function' ? err.headers.get('retry-after') : err?.headers?.['retry-after'];
  return new APIError(msg, { status, retryable, promptTooLong, retryAfterMs: parseRetryAfter(header), rateLimit: parseRateLimit(err?.headers, timing.now()) });
}

// Our own aborts are named AbortError and the SDK's is an APIUserAbortError. The message test only
// accepts the bare "aborted" wording: a server error that merely mentions "aborted" is not the user.
export function isAbort(err) {
  return err?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError || /^(?:request was )?aborted\.?$/i.test(err?.message || '');
}

// Stream a message. `onEvent` receives:
//   {type:'block_start', index, block}
//   {type:'text', index, text}          text delta
//   {type:'thinking', index, text}      thinking delta
//   {type:'tool_input', index, partial} partial JSON of a tool call
//   {type:'block_stop', index, block}   finished block (tool_use input parsed)
//   {type:'retry', attempt, error, delayMs, maxRetries}   a quick retry is about to wait delayMs
//   {type:'rate_limit_wait', error, delayMs, resumeAt, resetAt, label, polling, waitedMs, maxWaitMs, loginExpiresAt}
//                                       a rate limit was hit: paused until resumeAt, then the request is repeated
//   {type:'rate_limit_resume', waitedMs}   the repeated request was accepted: the pause is over
//   {type:'reset'}                      partial output from a failed attempt must be discarded
// `waitForRateLimit: false` reports a rate limit as an error instead of waiting for it (side queries
// where nobody wants to sit through a pause). Returns {message, usage, stopReason}.
export async function streamMessage(config, request, { signal, onEvent = () => {}, waitForRateLimit = true } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError', partial: [] });
  // A token that has expired (or is about to) is renewed first, as the official client does.
  if (config.usesClaudeCode) await renewLogin(config, signal);
  let login = config.usesClaudeCode ? readClaudeCodeLogin(config) : null;
  // Load gateway model metadata before the synchronous parameter builder; the cache is keyed by gateway and key,
  // so changing accounts or gateway URLs cannot leak a model's effort levels into another context.
  if (config.usesGateway && /^gpt-/i.test(request.model?.id)) {
    const gatewayLogin = readGatewayLogin(config.gatewayUrl);
    if (gatewayLogin) {
      // A gateway that does not answer costs at most a few seconds once (see fetchGatewayModels), not the request.
      try { await fetchGatewayModels(gatewayLogin, { signal }); } catch { if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError', partial: [] }); }
    }
  }
  let client = getClient(config, login);
  const params = buildParams(config, request, login);
  let authReloaded = false;
  const refused = new Set(); // what the endpoint refused for this request: remembered once a request got through
  const retryState = { attempt: 0, rateLimitHits: 0, waitedMs: 0 };
  let paused = false;
  for (;;) {
    let emitted = false;
    const startedAt = Date.now(); // the cache TTL counts from the start of the request, not from the end of the reply
    try {
      const stream = await client.messages.create(params, { signal });
      if (paused) {
        paused = false;
        onEvent({ type: 'rate_limit_resume', waitedMs: retryState.waitedMs });
      }
      const blocks = [];
      const jsonBufs = [];
      let usage = {};
      let stopReason = null;
      let model = params.model;
      let stopped = false;
      for await (const ev of stream) {
        switch (ev.type) {
          case 'message_stop':
            stopped = true;
            break;
          case 'message_start':
            usage = { ...ev.message.usage };
            model = ev.message.model || model;
            break;
          case 'content_block_start': {
            const b = { ...ev.content_block };
            if (b.type === 'tool_use') { b.input = {}; jsonBufs[ev.index] = ''; }
            if (b.type === 'text') b.text = b.text || '';
            if (b.type === 'thinking') { b.thinking = b.thinking || ''; b.signature = b.signature || ''; }
            blocks[ev.index] = b;
            emitted = true;
            onEvent({ type: 'block_start', index: ev.index, block: b });
            break;
          }
          case 'content_block_delta': {
            const b = blocks[ev.index];
            const d = ev.delta;
            if (!b) break;
            if (d.type === 'text_delta') { b.text += d.text; onEvent({ type: 'text', index: ev.index, text: d.text }); }
            else if (d.type === 'thinking_delta') { b.thinking += d.thinking; onEvent({ type: 'thinking', index: ev.index, text: d.thinking }); }
            else if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
            else if (d.type === 'input_json_delta') {
              jsonBufs[ev.index] += d.partial_json;
              onEvent({ type: 'tool_input', index: ev.index, partial: jsonBufs[ev.index], block: b });
            }
            break;
          }
          case 'content_block_stop': {
            const b = blocks[ev.index];
            if (b?.type === 'tool_use') {
              const raw = jsonBufs[ev.index];
              try { b.input = raw ? JSON.parse(raw) : {}; } catch { b.input = { __invalid_json: raw }; }
            }
            if (b) onEvent({ type: 'block_stop', index: ev.index, block: b });
            break;
          }
          case 'message_delta':
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            if (ev.usage) usage = { ...usage, ...Object.fromEntries(Object.entries(ev.usage).filter(([, v]) => v != null)) };
            break;
          case 'error':
            throw Object.assign(new Error(ev.error?.message || 'stream error'), { status: ev.error?.type === 'rate_limit_error' ? 429 : 500 });
          default:
            break;
        }
      }
      // The SDK ends the iterator quietly when aborted; a stream without message_stop was cut off.
      if (signal?.aborted) {
        const partial = blocks.filter((b) => b?.type === 'text' && b.text.trim()).map((b) => ({ type: 'text', text: b.text }));
        throw Object.assign(new Error('aborted'), { name: 'AbortError', partial });
      }
      if (!stopped && !stopReason) throw Object.assign(new Error('The response stream ended unexpectedly'), { status: 503 });
      const content = blocks.filter(Boolean).filter((b) => !(b.type === 'text' && !b.text));
      if (refused.size) { // it got through without what the endpoint refused: leave that off from now on
        const key = cacheKey(config, params.model, login);
        cacheRefused.set(key, new Set([...(cacheRefused.get(key) || []), ...refused]));
      }
      return { message: { role: 'assistant', content }, usage, stopReason, model, cache: { ...cachePlanOf(params), fingerprint: fingerprint(params), at: startedAt } };
    } catch (raw) {
      if (signal?.aborted || isAbort(raw)) throw Object.assign(new Error('aborted'), { name: 'AbortError', partial: raw?.partial || [] });
      const err = describeError(raw, config);
      // The token was refused. A running native Claude Code session may have renewed the shared token
      // while this request was in flight: read it again. If it is the same one, it may have been revoked
      // early or the local clock may be off: renew it once and try again.
      if (login && err.status === 401 && !authReloaded) {
        authReloaded = true;
        const readValid = () => { try { return readClaudeCodeLogin(config); } catch { return null; } };
        let updated = readValid();
        if (!updated || updated.accessToken === login.accessToken) {
          let failure = null;
          if (await renewLogin(config, signal, { force: true, onError: (e) => { failure = e; } })) updated = readValid();
          else if (!updated && failure) throw failure; // the token ran out meanwhile and cannot be renewed: say why, not just "401"
        }
        if (updated && updated.accessToken !== login.accessToken) {
          login = updated;
          client = getClient(config, login);
          params.metadata = { user_id: login.userId };
          if (emitted) onEvent({ type: 'reset' });
          continue;
        }
      }
      // Not every model takes an effort level. Leave it out for this one, and for the rest of the session.
      if (err.status === 400 && params.output_config && /does not support the effort parameter/i.test(err.message)) {
        noEffort.add(params.model);
        delete params.output_config;
        continue;
      }
      // The endpoint does not take cache_control (or the 1-hour ttl) where it was sent: carry on without it
      // instead of failing the request, and do not send it there again (see refuseCache).
      if (err.status === 400 && /cache_control|\bttl\b/i.test(err.message)) {
        const taken = refuseCache(params, err.message);
        if (taken.size) {
          for (const item of taken) refused.add(item);
          continue;
        }
      }
      // The default max_tokens is generous: if this API allows less, learn its limit and retry at once.
      const limit = err.status === 400 ? parseMaxTokensLimit(err.message) : null;
      if (limit && limit < params.max_tokens) {
        outputCaps.set(params.model, limit);
        params.max_tokens = limit;
        if (params.thinking?.budget_tokens) params.thinking.budget_tokens = Math.min(params.thinking.budget_tokens, limit - 1);
        continue;
      }
      const plan = planRetry(err, retryState, config, { now: timing.now(), allowWait: waitForRateLimit });
      if (plan.action === 'throw') {
        if (plan.message) err.message = plan.message;
        throw err;
      }
      if (emitted) onEvent({ type: 'reset' });
      if (plan.kind === 'rate_limit') {
        paused = true;
        onEvent({
          type: 'rate_limit_wait', error: err, delayMs: plan.delayMs, resumeAt: plan.resumeAt, resetAt: plan.resetAt,
          label: plan.label, polling: plan.polling, waitedMs: retryState.waitedMs, maxWaitMs: config.rateLimitMaxWait,
          loginExpiresAt: loginExpiryToWarnAbout(config, login),
        });
        await sleepUntil(plan.resumeAt, signal);
        // Hours may have passed: pick up the login again, the local Claude Code may have refreshed
        // the token (and if it has expired, wait for that rather than fail with a 401).
        if (config.usesClaudeCode) {
          login = await loginAfterPause(config, retryState, { signal, onEvent });
          client = getClient(config, login);
          params.metadata = { user_id: login.userId };
        }
        retryState.attempt = 0; // the pause is a fresh start: quick retries made before it do not count after it
      } else {
        onEvent({ type: 'retry', attempt: plan.attempt, error: err, delayMs: plan.delayMs, maxRetries: plan.maxRetries });
        await sleepUntil(plan.resumeAt, signal);
      }
    }
  }
}

// One-shot, non-streaming helper for small side queries (summaries, titles, web page extraction).
// Nothing here can tell the user that it is paused, so a rate limit is reported as an error by default
// instead of being waited for out of sight; waitForRateLimit: true is for a caller that accepts that.
export async function quickQuery(config, { model, system, prompt, maxTokens = 4096, signal, waitForRateLimit = false }) {
  const res = await streamMessage(config, {
    model,
    system,
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    effort: null,
    cacheBucket: 'other',
    cacheMessages: false, // one-off content (a whole web page, say): caching it would only cost the write premium
  }, { signal, waitForRateLimit });
  return res.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

export function contextTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
}
