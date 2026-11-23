// Model providers besides the gateway, connected with /connect: built-in ones (DeepSeek, OpenAI, Kimi, ...) and the
// user's own endpoints. Several can be connected at once. A model of one is named provider/model
// (deepseek/deepseek-v4-pro); a name without a known provider in front is the gateway's, as before, so the remembered
// /model choices and the model setting (opus) mean what they did.
//
// A provider speaks one of two protocols: anthropic (the Messages API, which the SDK sends as it is) or openai (Chat
// Completions, which openai-chat.js translates to and from). A provider that offers both is given its Anthropic
// endpoint: thinking, tool calls and images go through without translation.
//
// The connections (key, address, the models the provider listed, with their windows and prices where models.dev knows
// them) are kept in providers.json in the config directory, readable by the user alone, as the gateway's key is in
// gateway.json. (No import of config.js, which reads this module: the config directory is found here as there.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GATEWAY_PROVIDER = '7bit';

// The built-in providers, in the order /connect lists them. All addresses answered 2026-11-19 (a wrong key: 401, 403,
// or 400 with "invalid key"). `modelsUrl`: an OpenAI-style list of models where the protocol's own has none (the
// Anthropic endpoints of DeepSeek, Kimi and GLM list nothing). `modelsDev`: the provider's id at models.dev, for the
// models' windows and prices.
export const PRESETS = [
  { id: 'anthropic', name: 'Anthropic (Claude)', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', keyPage: 'https://console.anthropic.com/settings/keys', modelsDev: 'anthropic' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', keyPage: 'https://platform.openai.com/api-keys', modelsDev: 'openai' },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', modelsUrl: 'https://api.deepseek.com/models', keyPage: 'https://platform.deepseek.com/api_keys', modelsDev: 'deepseek' },
  { id: 'kimi', name: 'Kimi (Moonshot)', protocol: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic', modelsUrl: 'https://api.moonshot.cn/v1/models', keyPage: 'https://platform.moonshot.cn/console/api-keys', modelsDev: 'moonshotai-cn' },
  { id: 'glm', name: 'GLM (Zhipu)', protocol: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models', keyPage: 'https://open.bigmodel.cn/usercenter/apikeys', modelsDev: 'zhipuai' },
  { id: 'minimax', name: 'MiniMax', protocol: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic', keyPage: 'https://platform.minimaxi.com', modelsDev: 'minimax-cn' },
  { id: 'qwen', name: 'Qwen (Alibaba Bailian)', protocol: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', modelsUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models', keyPage: 'https://bailian.console.aliyun.com', modelsDev: 'alibaba-cn' },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyPage: 'https://openrouter.ai/keys', modelsDev: 'openrouter' },
  { id: 'siliconflow', name: 'SiliconFlow', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', keyPage: 'https://cloud.siliconflow.cn/account/ak', modelsDev: 'siliconflow-cn' },
  { id: 'volcengine', name: 'Volcengine Ark', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', keyPage: 'https://console.volcengine.com/ark', modelsDev: 'volcengine' },
  { id: 'gemini', name: 'Google Gemini', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyPage: 'https://aistudio.google.com/apikey', modelsDev: 'google' },
  { id: 'xai', name: 'xAI (Grok)', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', keyPage: 'https://console.x.ai', modelsDev: 'xai' },
  { id: 'ollama', name: 'Ollama (this computer)', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', keyless: true },
];
const PRESET_IDS = new Set(PRESETS.map((p) => p.id));

const configDir = () => process.env.CLAUDE_PRO_CONFIG_DIR || path.join(os.homedir(), '.claude-pro');
export const providersFile = () => path.join(configDir(), 'providers.json');

// The address requests are sent to: what users paste often ends in a path the client adds itself.
export function normalizeBaseUrl(url, protocol) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  return protocol === 'openai' ? base.replace(/\/chat\/completions$/i, '') : base.replace(/\/v1(?:\/messages)?$/i, '').replace(/\/+$/, '');
}

export function validBaseUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.host);
  } catch {
    return false;
  }
}

// A name for a provider the user adds: what follows it in model names (myrelay/some-model), so letters, digits and -.
export const cleanProviderId = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
export const reservedProviderId = (id) => id === GATEWAY_PROVIDER || PRESET_IDS.has(id);

// The id of a new connection named after `base` that no other connection, built-in provider or the gateway has: the
// second DeepSeek is deepseek-2, the next deepseek-3.
export function nextInstanceId(base, connections = readConnections()) {
  const stem = cleanProviderId(base) || 'provider';
  const free = (id) => !connections[id] && !reservedProviderId(id);
  if (free(stem)) return stem;
  for (let n = 2; ; n++) if (free(`${stem}-${n}`)) return `${stem}-${n}`;
}

// {id: connection}. A connection: {apiKey, authHeader, model?, models: [{id, name?, window?, maxOutput?, price?}],
// savedAt, name?} (model: the one chosen at /connect; name: what the user called it, else the provider's own), and for
// the user's own providers also {custom: true, name, protocol, baseUrl}. A second account of a built-in provider (or of
// 7bit.fun) is a connection of its own under another id (deepseek-2, 7bit-2: see nextInstanceId) with {preset: the
// provider's id}, and for 7bit.fun's also {protocol, baseUrl}; its models are deepseek-2/<model>. The entry "7bit"
// holds at most the name given to the gateway's own login (gateway.json has its key). Read again at most once a second (the model is resolved at every frame of the footer), and at once after
// this process changed the file; another window's change is seen within the second. Not to be changed by callers.
const MEMO_MS = 1000;
let memo = null; // {at, data}
export function readConnections({ fresh = false } = {}) {
  if (!fresh && memo && Date.now() - memo.at < MEMO_MS) return memo.data;
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(providersFile(), 'utf8').replace(/^\uFEFF/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch { /* none yet, or unreadable */ }
  memo = { at: Date.now(), data };
  return data;
}

function writeConnections(all) {
  const file = providersFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  memo = null;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function saveConnection(id, connection) {
  const all = { ...readConnections({ fresh: true }) };
  all[id] = { ...connection, savedAt: new Date().toISOString() };
  writeConnections(all);
}

export function removeConnection(id) {
  const all = { ...readConnections({ fresh: true }) };
  if (!all[id]) return false;
  delete all[id];
  writeConnections(all);
  return true;
}

// What is known of a provider: the built-in entry with its connection, or the user's own from its connection. null for
// neither.
export function providerInfo(id, connections = readConnections()) {
  const connection = connections[id] || null;
  const preset = PRESETS.find((p) => p.id === id);
  if (preset) return { ...preset, name: connection?.name || preset.name, connection };
  // another account of a built-in provider, or of 7bit.fun (its address kept in the connection)
  if (connection?.preset) {
    const base = connection.preset === GATEWAY_PROVIDER ? { name: '7bit.fun', protocol: 'anthropic' } : PRESETS.find((p) => p.id === connection.preset);
    const baseUrl = connection.baseUrl || base?.baseUrl;
    if (base && baseUrl) return { ...base, id, name: connection.name || base.name, baseUrl, preset: connection.preset, connection };
  }
  if (connection?.custom && connection.baseUrl) {
    return { id, name: connection.name || id, protocol: connection.protocol === 'openai' ? 'openai' : 'anthropic', baseUrl: connection.baseUrl, custom: true, connection };
  }
  return null;
}

// The providers that are connected now, in the order /connect lists them (the gateway is not among them: see
// gatewayLogin).
export function connectedProviders(connections = readConnections()) {
  const rank = (id) => { const i = PRESETS.findIndex((p) => p.id === (connections[id]?.preset || id)); return i < 0 ? PRESETS.length : i; };
  return Object.keys(connections).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true }))
    .map((id) => providerInfo(id, connections)).filter((p) => p?.connection && (p.connection.apiKey || p.keyless || p.custom));
}

// "deepseek/deepseek-v4-pro" -> {provider: 'deepseek', model: 'deepseek-v4-pro'}. The part before the first / is a
// provider only when it names one (built in, or added by the user): model names have slashes of their own
// (openrouter/anthropic/claude-sonnet-4.5; the gateway's deepseek-ai/DeepSeek-V3 is no provider's). Anything else is
// the gateway's: {provider: '7bit', model}.
export function splitModelRef(spec, connections = null) {
  const name = String(spec || '').trim();
  const slash = name.indexOf('/');
  if (slash > 0) {
    const prefix = name.slice(0, slash).toLowerCase();
    const rest = name.slice(slash + 1);
    const conn = rest && !(prefix === GATEWAY_PROVIDER || PRESET_IDS.has(prefix)) ? (connections ?? readConnections())[prefix] : null;
    if (rest && (prefix === GATEWAY_PROVIDER || PRESET_IDS.has(prefix) || conn?.custom || conn?.preset)) return { provider: prefix, model: rest };
  }
  return { provider: GATEWAY_PROVIDER, model: name };
}

// What the provider listed for this model at /connect (its window, price), or null.
export function providerModel(providerId, modelId, connections = readConnections()) {
  return connections[providerId]?.models?.find((m) => m.id === modelId) || null;
}

// Models whose provider's list gives no window or output limit (DeepSeek's GET /models has neither), by the id they go
// by at DeepSeek and at 7bit.fun alike: {window, maxOutput}, from DeepSeek's API documentation (as codex-gateway's
// deepseek-models.mjs has them, checked 2026-11-06: 1M in, at most 384K out). What a list gives wins over these.
const KNOWN_MODELS = new Map([
  ...['deepseek-v4-pro', 'deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash']
    .map((id) => [id, { window: 1_000_000, maxOutput: 393_216 }]),
]);
export const knownModel = (modelId) => KNOWN_MODELS.get(String(modelId || '').toLowerCase()) || null;

// Where a provider's requests go, for api.js: {provider, name, protocol, baseURL, key, bearer}. Throws when it is not
// connected.
export function providerEndpoint(id) {
  const info = providerInfo(id);
  if (!info) throw Object.assign(new Error(`There is no provider "${id}". /connect lists them.`), { status: 401, notConnected: true });
  const c = info.connection;
  if (!c || (!c.apiKey && !info.keyless)) throw Object.assign(new Error(`${info.name} is not connected. Run /connect ${id}.`), { status: 401, notConnected: true });
  return {
    provider: id,
    name: info.name,
    protocol: info.protocol,
    baseURL: normalizeBaseUrl(c.baseUrl || info.baseUrl, info.protocol),
    key: c.apiKey || 'none',
    bearer: info.protocol === 'openai' || c.authHeader === 'bearer',
    quirks: c.quirks && typeof c.quirks === 'object' ? c.quirks : {},
  };
}

// ---------------------------------------------------------------- checking a key, listing models

const authHeaders = (key, kind) => (kind === 'bearer' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key });
const limitSignal = (ms, signal) => (signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms));
// A refused key: 401 and 403, and the 400 Gemini and xAI answer a wrong key with.
const refusedKey = (status, text) => status === 401 || status === 403 || (status === 400 && /api[ _-]?key|token|auth/i.test(text));

async function errorText(res) {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text);
    const first = Array.isArray(body) ? body[0] : body;
    return first?.error?.message || first?.message || (typeof first?.error === 'string' ? first.error : '') || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

const listOf = (body) => (Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [])
  .map((m) => (typeof m === 'string' ? { id: m } : m))
  .filter((m) => typeof m?.id === 'string' && m.id)
  .map((m) => ({
    id: m.id,
    ...(typeof m.display_name === 'string' && m.display_name && m.display_name !== m.id ? { name: m.display_name } : {}),
    ...(Number.isInteger(m.max_input_tokens) && m.max_input_tokens > 0 ? { window: m.max_input_tokens } : Number.isInteger(m.context_length) && m.context_length > 0 ? { window: m.context_length } : {}),
  }));

// The models a provider lists, and the header its key goes in: {authHeader, models}. The protocol's own list first
// (GET /v1/models for anthropic, with x-api-key, then Bearer; GET /models for openai, with Bearer), then the
// provider's OpenAI-style list (modelsUrl). models is null when neither answers with one. Throws {status, refused} when
// the key is refused every way.
export async function listProviderModels({ protocol, baseUrl, modelsUrl, apiKey, keyless }, { fetchImpl = globalThis.fetch, timeoutMs = 15_000, signal, kinds } = {}) {
  const key = apiKey || (keyless ? 'none' : '');
  const base = normalizeBaseUrl(baseUrl, protocol);
  const tries = protocol === 'openai'
    ? [[`${base}/models`, 'bearer']]
    : (kinds || ['x-api-key', 'bearer']).map((kind) => [`${base}/v1/models`, kind]);
  if (modelsUrl) tries.push([modelsUrl, 'bearer']);
  let refusal = null;
  let authHeader = null;
  for (const [url, kind] of tries) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'anthropic-version': '2023-06-01', ...authHeaders(key, kind) }, signal: limitSignal(timeoutMs, signal) });
    } catch (e) {
      if (signal?.aborted) throw e;
      continue; // this list cannot be reached; another may be
    }
    if (res.ok) {
      const body = await res.json().catch(() => null);
      const models = body ? listOf(body) : [];
      // (the modelsUrl list proves the key, not the header the Anthropic endpoint takes: that is left to testModel)
      if (url !== modelsUrl) authHeader = kind;
      if (models.length) return { authHeader, models };
      continue;
    }
    const text = await errorText(res);
    if (refusedKey(res.status, text)) refusal = { status: res.status, message: text };
  }
  if (refusal && !authHeader) throw Object.assign(new Error(`the key was refused (HTTP ${refusal.status})${refusal.message ? `: ${refusal.message}` : ''}`), { status: refusal.status, refused: true });
  return { authHeader, models: null };
}

// One small request to `model`: that the provider speaks the protocol, takes the key and has the model (an endpoint
// that only lists models passes listProviderModels and fails here). Resolves with the header that worked and what the
// provider was found to want ({authHeader, quirks}: quirks.maxCompletionTokens, kept with the connection so that its
// requests do not learn it again from a refusal). Throws with the provider's own words.
export async function testProviderModel({ protocol, baseUrl, apiKey, keyless, authHeader = null, model }, { fetchImpl = globalThis.fetch, timeoutMs = 60_000, signal } = {}) {
  const key = apiKey || (keyless ? 'none' : '');
  const base = normalizeBaseUrl(baseUrl, protocol);
  const openai = protocol === 'openai';
  const kinds = openai ? ['bearer'] : authHeader ? [authHeader, ...['x-api-key', 'bearer'].filter((k) => k !== authHeader)] : ['x-api-key', 'bearer'];
  let refusal = null;
  for (const kind of kinds) {
    for (const tokensField of openai ? ['max_tokens', 'max_completion_tokens'] : ['max_tokens']) {
      const body = openai
        ? { model, messages: [{ role: 'user', content: 'Reply with OK.' }], [tokensField]: 32 }
        : { model, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with OK.' }] };
      const res = await fetchImpl(openai ? `${base}/chat/completions` : `${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...authHeaders(key, kind) },
        body: JSON.stringify(body),
        signal: limitSignal(timeoutMs, signal),
      });
      if (res.ok) {
        await res.body?.cancel?.().catch(() => {});
        return { authHeader: kind, quirks: tokensField === 'max_completion_tokens' ? { maxCompletionTokens: true } : {} };
      }
      const text = await errorText(res);
      // OpenAI's newer models take max_completion_tokens only: asked again with it
      if (openai && res.status === 400 && /max_completion_tokens/i.test(text) && tokensField === 'max_tokens') continue;
      if (refusedKey(res.status, text)) { refusal = { status: res.status, message: text }; break; }
      const hint = res.status === 404 || res.status === 405 ? ` (the address has no ${openai ? 'POST /chat/completions' : 'POST /v1/messages'}: is it the right one, and the right protocol?)` : '';
      throw Object.assign(new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}${hint}`), { status: res.status });
    }
  }
  throw Object.assign(new Error(`the key was refused (HTTP ${refusal.status})${refusal.message ? `: ${refusal.message}` : ''}`), { status: refusal.status, refused: true });
}

// ---------------------------------------------------------------- models.dev

// models.dev (anomalyco/models.dev, the catalogue OpenCode uses): each model's window, output limit and price, which
// providers' own lists mostly leave out. Fetched at /connect, kept a day in the config directory's cache (about 6 MB).
const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_MAX_AGE_MS = 24 * 3_600_000;
let modelsDevMemo = null;

export async function modelsDevCatalogue({ fetchImpl = globalThis.fetch, signal, timeoutMs = 20_000 } = {}) {
  if (modelsDevMemo) return modelsDevMemo;
  const file = path.join(configDir(), 'cache', 'models-dev.json');
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < MODELS_DEV_MAX_AGE_MS) return (modelsDevMemo = JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch { /* not kept yet */ }
  try {
    const res = await fetchImpl(MODELS_DEV_URL, { signal: limitSignal(timeoutMs, signal) });
    if (!res.ok) return null;
    const data = await res.json();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    } catch { /* kept in memory only */ }
    return (modelsDevMemo = data);
  } catch {
    try { return (modelsDevMemo = JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; } // an older copy beats none
  }
}

// models.dev's entry for a model as a connection keeps it: {id, name?, window?, maxOutput?, price?} (price per million
// tokens: input, output, cacheRead, cacheWrite).
function modelFromCatalogue(id, entry) {
  const out = { id };
  if (entry?.name && entry.name !== id) out.name = entry.name;
  const window = Number(entry?.limit?.input || entry?.limit?.context);
  if (Number.isInteger(window) && window > 0) out.window = window;
  const maxOutput = Number(entry?.limit?.output);
  if (Number.isInteger(maxOutput) && maxOutput > 0) out.maxOutput = maxOutput;
  const cost = entry?.cost;
  if (cost && Number.isFinite(Number(cost.input)) && Number.isFinite(Number(cost.output))) {
    out.price = { input: Number(cost.input), output: Number(cost.output), cacheRead: Number(cost.cache_read ?? cost.input), cacheWrite: Number(cost.cache_write ?? cost.input) };
  }
  return out;
}

// The models to offer for a provider: those it listed, with what models.dev knows of them; when it listed none, the
// models.dev models of the provider that call tools (an agent needs them). [] when neither is known.
export function enrichModels(listed, catalogue, modelsDevId) {
  const known = (modelsDevId && catalogue?.[modelsDevId]?.models) || {};
  if (listed?.length) {
    return listed.map((m) => {
      const fromCatalogue = known[m.id] ? modelFromCatalogue(m.id, known[m.id]) : { id: m.id };
      return { ...knownModel(m.id), ...fromCatalogue, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) };
    });
  }
  return Object.entries(known).filter(([, e]) => e?.tool_call !== false).map(([id, e]) => modelFromCatalogue(id, e));
}

// USD for a request's usage at a provider model's price (per million tokens), or null without one.
export function priceCost(price, usage = {}) {
  if (!price) return null;
  const n = (v) => Math.max(0, Number(v) || 0);
  return (n(usage.input_tokens) * price.input + n(usage.output_tokens) * price.output + n(usage.cache_read_input_tokens) * price.cacheRead + n(usage.cache_creation_input_tokens) * price.cacheWrite) / 1e6;
}
