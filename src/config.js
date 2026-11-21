// Ordinary settings live at the top level of settings.json; optional advanced keys live in its env block.
// Sources, lowest precedence first:
//   1. built-in defaults
//   2. ~/.claude-pro/settings.json
//   3. <project>/.claude-pro/settings.json
//   4. <project>/.claude-pro/settings.local.json
//   5. process environment (advanced keys only)
//   6. command line flags (--model, --effort ...)
// The model and effort chosen with /model and /effort are remembered apart from these (see
// rememberChoice) and win over 1-5. The gateway key comes from /connect alone (gateway.json, see
// gatewayLogin): there is no variable for it, and no .env file is read.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeTtl } from './cache.js';
import { GATEWAY_PROVIDER, splitModelRef, providerModel, providerInfo, normalizeBaseUrl, connectedProviders, readConnections, knownModel } from './providers.js';

export const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A source checkout (a git clone, also when npm links to one), as opposed to a copy installed from npm: the agent
// edits its own code only in a checkout, since the next update replaces an installed copy.
export const SOURCE_CHECKOUT = fs.existsSync(path.join(INSTALL_DIR, '.git'));
export const CONFIG_DIR = process.env.CLAUDE_PRO_CONFIG_DIR || path.join(os.homedir(), '.claude-pro');
export const APP_NAME = 'claude-pro';
export const GATEWAY_DEFAULT_URL = 'https://7bit.fun';
// The gateway's earlier address (until 2026-11-19): a login or a setting saved with it means the same gateway, which
// answers there too, so it is read as the new one and no computer has to log in again.
const OLD_GATEWAY_URLS = new Set(['https://gw.predix.icu', 'http://gw.predix.icu']);
export function normalizeGatewayUrl(url) {
  const base = String(url || GATEWAY_DEFAULT_URL).trim().replace(/\/+$/, '');
  return OLD_GATEWAY_URLS.has(base.toLowerCase()) ? GATEWAY_DEFAULT_URL : base;
}
export const VERSION = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).version;

// The gateway key /connect saved (gateway.json): {url, apiKey, account, savedAt} for this gateway, or null. Read again
// at most once a second (the model is resolved at every frame of the footer), and at once after this process changed
// the file (forgetGatewayLogin). gateway.js's gatewayLogin is this.
let gatewayMemo = null; // {at, data}
export function readGatewayLogin(url) {
  if (!gatewayMemo || Date.now() - gatewayMemo.at >= 1000) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_PRO_CONFIG_DIR || CONFIG_DIR, 'gateway.json'), 'utf8')); } catch { /* none */ }
    gatewayMemo = { at: Date.now(), data };
  }
  const data = gatewayMemo.data;
  if (!data?.apiKey || (url && normalizeGatewayUrl(data.url) !== normalizeGatewayUrl(url))) return null;
  return { ...data, url: normalizeGatewayUrl(data.url) };
}
export function forgetGatewayLogin() { gatewayMemo = null; }

// The ordinary settings /config shows. `legacy`: the old spelling accepted in settings.json.env and by config
// commands, but no longer read from the process environment. Writes use only the ordinary spelling.
export const BASIC_SETTINGS = {
  // (unset: see Config.defaultModelSpec, which follows the providers connected)
  model: { default: 'opus', legacy: 'CLAUDE_PRO_GATEWAY_MODEL', description: 'Default model, provider/model (unset: opus where Claude is connected, else a model of the first connected provider); /model and --model override it' },
  effort: { default: 'auto', legacy: 'CLAUDE_CODE_EFFORT_LEVEL', description: 'Reasoning effort; /effort and --effort override it' },
  promptCacheTtl: { default: '1h', legacy: 'CLAUDE_CODE_PROMPT_CACHE_TTL', description: 'Conversation prompt cache: 5m or 1h' },
  subagentPromptCacheTtl: { default: '5m', legacy: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', description: 'Sub-agent, compaction and side-query prompt cache: 5m or 1h' },
  // `userOnly`: read from ~/.claude-pro/settings.json only. It deletes the data of every project, so a project's
  // settings file (it comes with the repository) must not lower it.
  cleanupPeriodDays: { default: 30, userOnly: true, description: 'Days a conversation is kept after it was last used (then deleted with its traces, as in Claude Code; at least 1)' },
};

// Advanced keys, shown only by /config advanced (or config list --advanced). Settings files may also carry
// unrelated env entries; those are left alone, but are not advertised as configuration of this program.
export const KNOWN_KEYS = {
  CLAUDE_PRO_GATEWAY_URL: `Gateway address (default ${GATEWAY_DEFAULT_URL})`,
  CLAUDE_PRO_ONLINE: 'Set to 0 to keep interactive sessions off the gateway. Otherwise a session is online at the gateway whenever this computer is logged in, and sessions on your other computers (@computer/name) and your contacts can send it tasks',
  CLAUDE_PRO_MACHINE_NAME: 'This computer\'s name for sessions on your other computers (@公司 ...; default: the host name)',

  CLAUDE_CODE_MAX_OUTPUT_TOKENS: 'max_tokens for each model response (default 48000; lowered automatically if the gateway allows less)',
  MAX_THINKING_TOKENS: 'Thinking budget: 0 disables thinking, N enables with budget N',
  CLAUDE_PRO_CACHE_KEEPALIVE_HOURS: 'Claude models with the 1-hour TTL: while you are away, refresh the conversation\'s prompt cache shortly before it runs out (a read costs 1/40 of a rewrite), for a pause of up to this many hours (default 8; 0 turns it off)',
  DISABLE_PROMPT_CACHING: 'Set to 1 to send no cache_control markers at all (prompt caching off for every model)',
  API_TIMEOUT_MS: 'Request timeout in milliseconds',
  CLAUDE_PRO_MAX_RETRIES: 'Retries for failed API requests (0 = no retries at all, which also turns off the rate limit wait)',
  CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS: 'Longest total time to wait for a rate limit (e.g. the 5-hour window) to reset before continuing by itself (default 21600000 = 6 hours; 0 = report the error instead of waiting)',
  CLAUDE_CODE_GIT_BASH_PATH: 'Windows: path to bash.exe (Git Bash)',
  CLAUDE_PRO_RIPGREP_PATH: 'Path to ripgrep (rg) for Grep and @-file suggestions; "off" forces the built-in JS scanner (default: rg from PATH, else the JS scanner)',
  CLAUDE_PRO_BROWSER: 'The browser the Browser tool drives: auto (default: the first of Edge, Chrome, Brave, Chromium whose remote debugging is turned on, at edge://inspect/#remote-debugging and the like), edge, chrome, brave, chromium, own (claude-pro\'s own Chrome profile, nothing to allow), a DevTools address (ws://…, http://host:port, a port), or off (no Browser tool)',
  CLAUDE_PRO_PYTHON: 'The Python interpreter the REPL tool runs (default: python on Windows, python3 elsewhere, from PATH)',
  CLAUDE_PRO_VERIFY_COMMAND: 'Command run after the agent edits files (e.g. "npm test"); failures are sent back to fix',
  CLAUDE_PRO_DISABLE_AUTO_MEMORY: 'Set to 1 to turn off the persistent per-project memory',
  CLAUDE_PRO_DISABLE_TOPIC_TITLE: 'Set to 1 to stop asking the current model for the current topic after each message (the tab title then shows the first message of the session)',
  CLAUDE_PRO_TRACE: 'Set to 0 to disable the privacy-preserving runtime JSONL trace (enabled by default)',
};

function basicValue(key, value) {
  if (key === 'cleanupPeriodDays') {
    const days = typeof value === 'number' ? value : /^\s*\d+\s*$/.test(String(value)) ? Number(value) : NaN;
    if (Number.isInteger(days) && days >= 1) return days;
    throw new Error(`Invalid ${key}: ${value}. A whole number of days, at least 1 (e.g. 3650 to keep conversations for years).`);
  }
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  const text = value.trim();
  if (key === 'model') {
    if (!text) throw new Error('model must not be empty.');
    return text;
  }
  const normalized = text.toLowerCase();
  if (key === 'effort' && ['auto', 'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(normalized)) return normalized;
  if ((key === 'promptCacheTtl' || key === 'subagentPromptCacheTtl') && normalizeTtl(normalized)) return normalized;
  throw new Error(`Invalid ${key}: ${text}. ${BASIC_SETTINGS[key].description}.`);
}

// The supported spelling, or an error instead of saving a setting that will do nothing.
export function configKey(key) {
  if (Object.hasOwn(BASIC_SETTINGS, key) || Object.hasOwn(KNOWN_KEYS, key)) return key;
  const alias = Object.entries(BASIC_SETTINGS).find(([, spec]) => spec.legacy === key);
  if (alias) return alias[0];
  throw new Error(`Unknown setting: ${key}. Use /config for ordinary settings or /config advanced for advanced settings.`);
}

// Shared by the terminal and slash commands, so both list and write the same settings.
export function configEntries(config, { advanced = false } = {}) {
  const keys = [...Object.keys(BASIC_SETTINGS), ...(advanced ? Object.keys(KNOWN_KEYS) : [])];
  return keys.map((key) => ({ key, value: config.setting(key), source: config.sources[key] || 'default', description: BASIC_SETTINGS[key]?.description || KNOWN_KEYS[key] }));
}

export function writeConfigSetting(file, key, value) {
  key = configKey(key);
  const basic = BASIC_SETTINGS[key];
  const normalized = basic ? basicValue(key, value) : String(value);
  if (basic?.userOnly && path.resolve(file) !== path.resolve(userSettingsFile())) throw new Error(`${key} is read from ${userSettingsFile()} only.`);
  updateSettingsFile(file, (json) => {
    if (basic) {
      json[key] = normalized;
      if (json.env) { delete json.env[basic.legacy]; if (!Object.keys(json.env).length) delete json.env; }
    } else json.env = { ...(json.env || {}), [key]: normalized };
  });
  return key;
}

export function unsetConfigSetting(file, key) {
  // Unknown env names may still be removed, including settings that this program no longer reads.
  try { key = configKey(key); } catch { /* old or unrelated env name */ }
  updateSettingsFile(file, (json) => {
    const basic = Object.hasOwn(BASIC_SETTINGS, key) ? BASIC_SETTINGS[key] : null;
    if (basic) delete json[key];
    if (json.env) {
      delete json.env[basic?.legacy || key];
      if (!Object.keys(json.env).length) delete json.env;
    }
  });
  return key;
}

function readJson(file) {
  try {
    // a BOM in front (Windows PowerShell's Set-Content -Encoding UTF8 writes one) made the whole file unreadable
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (e.code !== 'ENOENT') process.stderr.write(`warning: could not parse ${file}: ${e.message}\n`);
    return null;
  }
}

export function settingsFiles(cwd) {
  return {
    user: path.join(CONFIG_DIR, 'settings.json'),
    project: path.join(cwd, '.claude-pro', 'settings.json'),
    local: path.join(cwd, '.claude-pro', 'settings.local.json'),
  };
}


export function loadConfig({ cwd = process.cwd(), flags = {} } = {}) {
  const env = {};
  const sources = {};
  const set = (obj, source) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v === undefined || v === null) continue;
      env[k] = String(v);
      sources[k] = source;
    }
  };

  const files = settingsFiles(cwd);
  // Settings files can still carry "permissions" from other tools; there are no permission rules here, so they are ignored.
  const settings = { mcpServers: {}, hooks: {} };
  for (const [scope, file] of Object.entries(files)) {
    const json = readJson(file);
    if (!json) continue;
    set(json.env, file);
    for (const [key, spec] of Object.entries(BASIC_SETTINGS)) {
      if (spec.userOnly && scope !== 'user') continue;
      // A top-level field wins over its legacy spelling in the same file; later files win over earlier ones.
      const value = json[key] ?? (spec.legacy ? json.env?.[spec.legacy] : undefined);
      if (value == null) continue;
      try { settings[key] = basicValue(key, value); sources[key] = file; } catch { /* invalid: use the earlier value or default */ }
    }
    if (json.mcpServers) Object.assign(settings.mcpServers, json.mcpServers);
    for (const [event, entries] of Object.entries(json.hooks || {})) {
      if (Array.isArray(entries)) (settings.hooks[event] ||= []).push(...entries);
    }
    settings[scope] = json;
  }
  // Project level .mcp.json, same format as Claude Code.
  const mcpJson = readJson(path.join(cwd, '.mcp.json'));
  if (mcpJson?.mcpServers) Object.assign(settings.mcpServers, mcpJson.mcpServers);

  const fromProcess = {};
  for (const k of Object.keys(KNOWN_KEYS)) if (process.env[k] !== undefined && process.env[k] !== '') fromProcess[k] = process.env[k];
  set(fromProcess, 'process environment');

  for (const key of ['model', 'effort']) {
    if (flags[key]) { settings[key] = basicValue(key, flags[key]); sources[key] = `--${key} flag`; }
  }

  return new Config(env, sources, settings, cwd);
}

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const isOn = (v) => /^(1|true|yes)$/i.test(String(v ?? '').trim());

// The input window of each model a gateway serves (max_input_tokens in its GET /v1/models, which fetchGatewayModels
// passes on here), by gateway and model id: what resolveModel takes. Kept on disk too (cache/gateway-models.json, the
// last list of each gateway), so that a new process has them before its first list arrives, and while the gateway
// does not answer: until then a model the gateway serves with 1M showed 200k (2026-11-20).
const servedWindows = new Map();
const servedFile = () => path.join(CONFIG_DIR, 'cache', 'gateway-models.json');
let servedOnDisk = null; // {url: {id: tokens}}, read once
function readServed() {
  if (servedOnDisk) return servedOnDisk;
  try { servedOnDisk = JSON.parse(fs.readFileSync(servedFile(), 'utf8')); } catch { /* none kept yet */ }
  if (!servedOnDisk || typeof servedOnDisk !== 'object') servedOnDisk = {};
  for (const [url, models] of Object.entries(servedOnDisk)) {
    for (const [id, tokens] of Object.entries(models || {})) {
      if (Number.isInteger(tokens) && tokens > 0 && !servedWindows.has(`${url}\n${id}`)) servedWindows.set(`${url}\n${id}`, tokens);
    }
  }
  return servedOnDisk;
}
export function noteServedModels(url, models) {
  const kept = readServed();
  const windows = {};
  for (const m of models || []) {
    const tokens = Number(m?.max_input_tokens);
    if (typeof m?.id === 'string' && Number.isInteger(tokens) && tokens > 0) {
      servedWindows.set(`${url}\n${m.id}`, tokens);
      windows[m.id] = tokens;
    }
  }
  // (written only when the list changed: it comes again every 10 minutes)
  if (!Object.keys(windows).length || JSON.stringify(kept[url]) === JSON.stringify(windows)) return;
  kept[url] = windows;
  try {
    fs.mkdirSync(path.dirname(servedFile()), { recursive: true });
    const tmp = `${servedFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(kept));
    fs.renameSync(tmp, servedFile());
  } catch { /* kept in memory only */ }
}
const servedWindow = (url, id) => { readServed(); return servedWindows.get(`${url}\n${id}`); };

export class Config {
  constructor(env, sources, settings, cwd) {
    this.env = env;
    this.sources = sources;
    this.settings = settings;
    this.cwd = cwd;
    this.modelOverride = null; // set by /model during a session
    this.effortOverride = null; // set by /effort during a session
    this.effortBoost = null; // set by the model with the Effort tool, for the rest of the user's current request
    this.effortBoostKeepNext = false; // a restart continues the request: the next turn keeps the boost
    this.verifyOverride = null; // set by /verify or --verify during a session
  }

  get gatewayUrl() { return normalizeGatewayUrl(this.env.CLAUDE_PRO_GATEWAY_URL); }
  // The gateway is one provider among the others (7bit in model names), connected when its key is saved.
  get gatewayConnected() { return Boolean(readGatewayLogin(this.gatewayUrl)); }
  providerConnected(id) { return id === GATEWAY_PROVIDER ? this.gatewayConnected : connectedProviders().some((p) => p.id === id); }
  providerName(id) { return id === GATEWAY_PROVIDER ? '7bit.fun' : providerInfo(id)?.name || id; }
  // Whether any provider is connected at all.
  get anyProviderConnected() { return this.gatewayConnected || connectedProviders().length > 0; }

  // Where the current model's requests go, for /status and the welcome box.
  get endpointLabel() {
    const provider = this.model.provider;
    const connected = this.providerConnected(provider) ? '' : ', not connected: /connect';
    if (provider === GATEWAY_PROVIDER) return `${this.gatewayUrl} (7bit.fun${connected})`;
    const info = providerInfo(provider);
    if (!info) return `${provider} (no such provider: /connect lists them)`;
    return `${normalizeBaseUrl(info.connection?.baseUrl || info.baseUrl, info.protocol)} (${info.name}${connected})`;
  }

  // The connected provider the Claude aliases (opus, sonnet, haiku) go to: the first of 7bit.fun and Anthropic that is
  // connected, in /connect's order; null with neither.
  claudeProvider() {
    if (this.gatewayConnected) return GATEWAY_PROVIDER;
    if (connectedProviders().some((p) => p.id === 'anthropic')) return 'anthropic';
    return null;
  }

  // What an alias names: the model of the provider that serves Claude here (Anthropic's newest of the family in the
  // list it gave, else the same id); 7bit.fun's when it is that provider, when neither is connected (the models
  // then cannot be reached: /connect is said), and with `gateway` (7bit/opus).
  aliasTarget(alias, { gateway = false } = {}) {
    const id = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }[alias];
    if (!id) return null;
    if (!gateway && this.claudeProvider() === 'anthropic') {
      const listed = readConnections().anthropic?.models?.find((m) => m.id.includes(alias));
      return `anthropic/${listed?.id || id}`;
    }
    return `${GATEWAY_PROVIDER}/${id}`;
  }

  // The model when the settings name none: opus where a provider of Claude is connected, else the model chosen when the
  // first connected provider was connected (or the first it listed); opus when nothing is connected.
  defaultModelSpec() {
    if (this.claudeProvider()) return 'opus';
    for (const p of connectedProviders()) {
      const model = p.connection.model || p.connection.models?.[0]?.id;
      if (model) return `${p.id}/${model}`;
    }
    return 'opus';
  }

  // Resolve a model spec (alias or name, maybe with [1m]) to {id, provider, contextWindow, label}. The window is the
  // model's max_input_tokens from the gateway's model list, once loaded, else what is known of it here; [1m] asks for
  // 1M. A provider's model (deepseek/deepseek-v4-pro, see providers.js) is sent as its own id to its provider, with
  // the window, output limit and price it was listed with at /connect.
  resolveModel(spec) {
    let name = (spec || '').trim() || 'sonnet';
    let oneM = false;
    if (/\[1m\]$/i.test(name)) { oneM = true; name = name.replace(/\[1m\]$/i, ''); }
    const ref = splitModelRef(name);
    if (ref.provider !== GATEWAY_PROVIDER) {
      const listed = providerModel(ref.provider, ref.model);
      // (a list without windows, as DeepSeek's: what is known of the model here)
      const known = { ...knownModel(ref.model), ...Object.fromEntries(Object.entries(listed || {}).filter(([, v]) => v != null)) };
      const claudeOneM = /^claude-(?:(?:sonnet|haiku)-5(?:-|$)|opus-(?:5(?:-|$)|4-[78](?:-|$)))/i.test(ref.model);
      return {
        id: ref.model,
        provider: ref.provider,
        contextWindow: oneM ? 1_000_000 : known.window || (claudeOneM ? 1_000_000 : 200_000),
        label: `${ref.provider}/${ref.model}${oneM ? '[1m]' : ''}`,
        ...(known.maxOutput ? { maxOutput: known.maxOutput } : {}),
        ...(known.price ? { price: known.price } : {}),
      };
    }
    // A name without a provider is 7bit.fun's (as before there were others), and an alias goes where Claude is (see
    // aliasTarget); 7bit/<name> is 7bit.fun's in any case.
    const explicit = /^7bit\//i.test(name);
    name = ref.model;
    const aliased = this.aliasTarget(name.toLowerCase(), { gateway: explicit });
    if (aliased) {
      const inner = this.resolveModel(aliased);
      return { ...inner, contextWindow: oneM ? 1_000_000 : inner.contextWindow, label: `${explicit ? '7bit/' : ''}${name}${oneM ? '[1m]' : ''} (${inner.label})` };
    }
    // (the gateway's list, else the last one kept, else what is known of the model here)
    const served = servedWindow(this.gatewayUrl, name) || knownModel(name)?.window;
    const label = `${GATEWAY_PROVIDER}/${name}${oneM ? '[1m]' : ''}`;
    // GPT models are served by the gateway's Codex backend, whose standard window is 272k. A request above 272k costs
    // twice as much (see pricing.js), but the user wants the gateway's window here too (2026-10-27).
    if (/^gpt-/i.test(name)) return { id: name, provider: GATEWAY_PROVIDER, contextWindow: served || 272_000, label };
    const nativeOneM = /^claude-(?:(?:sonnet|haiku)-5(?:-|$)|opus-(?:5(?:-|$)|4-[78](?:-|$)))/i.test(name);
    return { id: name, provider: GATEWAY_PROVIDER, contextWindow: oneM ? 1_000_000 : served || (nativeOneM ? 1_000_000 : 200_000), label };
  }

  // The selected model: the configured default unless /model has overridden it for this session.
  get configuredModelSpec() { return this.setting('model'); }
  get configuredEffort() { return this.setting('effort'); }

  setting(key) {
    const spec = BASIC_SETTINGS[key];
    if (key === 'model' && this.settings.model == null) return this.defaultModelSpec();
    return spec ? this.settings[key] ?? spec.default : this.env[key];
  }
  get modelSpec() { return this.modelOverride || this.configuredModelSpec; }
  get model() { return this.resolveModel(this.modelSpec); }

  get effort() {
    const v = (this.effortBoost ?? this.effortOverride ?? this.configuredEffort).trim().toLowerCase();
    return v && v !== 'auto' && v !== 'default' ? v : null;
  }

  // Generous by default so large files can be written in one go; if the API turns out to allow
  // less, streamMessage learns the real limit from the error and clamps (see api.js).
  // The gateway holds back balance for max_tokens of output before each request, so a smaller default there keeps a
  // modest balance usable. 48K: in 812 Opus requests through it (2026-10-12) p99 was 14K, three went over 24K (the
  // longest that finished: 27K) and one was cut off at the old 32K; the hold is $0.96 on Opus instead of $0.64.
  get maxOutputTokens() { return int(this.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, 48_000); }
  get thinkingBudget() {
    return this.env.MAX_THINKING_TOKENS === undefined ? null : int(this.env.MAX_THINKING_TOKENS, null);
  }
  // The conversation uses the main TTL (default 1h); sub-agents, compaction and side queries use the other (5m).
  cacheTtl(bucket = 'main') {
    const own = normalizeTtl(this.setting(bucket === 'main' ? 'promptCacheTtl' : 'subagentPromptCacheTtl'));
    if (own) return own;
    // The gateway too: measured on its usage records (533 Opus requests), pauses of 5 to 60 minutes rewrote the whole
    // conversation 9 times at 1.25x, $14.77; writing every turn at 2x instead costs $2.80 more.
    return bucket === 'main' ? '1h' : '5m';
  }
  promptCachingDisabled() { return isOn(this.env.DISABLE_PROMPT_CACHING); }
  get apiTimeout() { return int(this.env.API_TIMEOUT_MS, 600_000); }
  get maxRetries() { return int(this.env.CLAUDE_PRO_MAX_RETRIES, 6); }
  get rateLimitMaxWait() { return Math.max(0, int(this.env.CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS, 6 * 3_600_000)); }
  // A rate limit that does not say when it resets is tried again at most this far apart.
  get rateLimitPoll() { return 300_000; }
  // An overloaded API (529): the backoff, and how long to keep trying once the retries are used up (see planRetry).
  get overloadedRetryBaseDelay() { return 1000; }
  get overloadedRetryMaxDelay() { return 32_000; }
  get overloadedMaxWait() { return this.rateLimitMaxWait; }

  // At the model's input window (only sub-agent definitions may ask for a smaller one), less the room the compaction
  // itself takes: its request is the conversation with the instruction at its end, and its reply (the summary and
  // the thinking before it) counts against the window too. With no room left, the summary request of a
  // conversation at the window was refused as too long and the conversation sent again without its cache (895k
  // tokens of plain input on Opus, 2026-11-02; a request that fits reads them from the cache at a twentieth).
  compactWindow(model = this.model, own = 0) {
    const window = own > 0 ? Math.min(own, model.contextWindow) : model.contextWindow;
    return window - Math.min(40_000, Math.round(window * 0.05));
  }

  get bashDefaultTimeout() { return 600_000; }
  get bashMaxTimeout() { return 3_600_000; }
  get bashMaxOutput() { return 60_000; }
  // Tool results longer than this are saved to a file and only a preview is sent.
  get maxToolResultChars() { return 100_000; }
  // Clearing old tool results after a long pause (see Agent.clearAfterIdle): the gateway prompt cache has
  // expired by then, so retaining old tool payloads would only make the next request larger.
  get clearAfterIdle() { return true; }
  // How long a pause the conversation's prompt cache is kept warm for (hours; 0: not at all), see keepalive.js.
  get cacheKeepAliveHours() {
    const v = Number(String(this.env.CLAUDE_PRO_CACHE_KEEPALIVE_HOURS ?? '').trim() || NaN);
    return Number.isFinite(v) && v >= 0 ? v : 8;
  }
  // How deep sub-agents may nest: the main agent is depth 0; an agent below this depth gets the Task tool.
  get maxSubagentDepth() { return 2; }

  // Verification after edits, only when asked for: the session's own (/verify, --verify) wins over the setting.
  // With neither there is none. (Until 2026-11-11 the project's test or check script was found and run by itself:
  // a step after every edit that nobody had asked for, minutes long where the tests are; how to verify is the
  // model's choice, in proportion to the change.)
  get verifyCommand() {
    const v = this.verifyOverride ?? this.env.CLAUDE_PRO_VERIFY_COMMAND ?? '';
    return v.trim() && v.trim() !== 'off' ? v.trim() : null;
  }
  // How many times a failing verify command is sent back before giving up.
  get verifyMaxRounds() { return 3; }
  get autoMemoryEnabled() { return !/^(1|true|yes)$/i.test(this.env.CLAUDE_PRO_DISABLE_AUTO_MEMORY || ''); }
  get traceEnabled() {
    const value = this.env.CLAUDE_PRO_TRACE;
    return value === undefined || !/^(0|false|no|off)$/i.test(String(value).trim());
  }

}

// Update the "env" block (or another top level key) of a settings file. A file that is there but is not
// valid JSON is an error, not an empty file: writing it back would throw away everything in it.
export function updateSettingsFile(file, mutate) {
  let json = {};
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (text !== null && text.trim()) {
    try { json = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error(`${file} is not valid JSON (left as it is; fix it by hand)`); }
  }
  mutate(json);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // written aside and renamed over it, so that a crash or a full disk does not leave half a settings file; when the
  // rename is refused (Windows: the file held open by another program), written in place as before
  const text2 = JSON.stringify(json, null, 2) + '\n';
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text2);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    fs.writeFileSync(file, text2);
  }
}

// What /model and /effort chose, kept per provider in the "remembered" block of the user settings so that
// the choice is still the one in use at the next start (interactive or -p). It is applied as the session's
// override (applyRememberedChoices), so it wins over every configured value; only --model / --effort on
// the command line win over it, for that run. "/model default" and "/effort default" forget it.
const userSettingsFile = () => path.join(CONFIG_DIR, 'settings.json');

// Kept under the name of the provider they were made with, from when there were others: the gateway's.
const REMEMBERED_KEY = 'gateway';

function rememberedChoices() {
  const entry = readJson(userSettingsFile())?.remembered?.[REMEMBERED_KEY];
  return entry && typeof entry === 'object' ? entry : {};
}

// patch: {model?, effort?}; null or '' forgets that one. Returns whether the file changed.
export function rememberChoice(patch) {
  const before = rememberedChoices();
  const after = { ...before };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || value === '') delete after[key];
    else after[key] = String(value);
  }
  if (JSON.stringify(after) === JSON.stringify(before)) return false;
  updateSettingsFile(userSettingsFile(), (json) => {
    const all = json.remembered && typeof json.remembered === 'object' ? json.remembered : {};
    if (Object.keys(after).length) all[REMEMBERED_KEY] = after;
    else delete all[REMEMBERED_KEY];
    if (Object.keys(all).length) json.remembered = all;
    else delete json.remembered;
  });
  return true;
}

export function applyRememberedChoices(config, flags = {}) {
  const remembered = rememberedChoices();
  if (!flags.model && typeof remembered.model === 'string' && remembered.model.trim()) config.modelOverride = remembered.model.trim();
  if (!flags.effort && typeof remembered.effort === 'string' && remembered.effort.trim()) config.effortOverride = remembered.effort.trim().toLowerCase();
  return remembered;
}
