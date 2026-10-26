// Configuration loading. Mirrors Claude Code's environment variables so the same
// settings work here. Sources, lowest precedence first:
//   1. built-in defaults
//   2. <install dir>/.env
//   3. ~/.claude-pro/settings.json            ("env" block)
//   4. <project>/.claude-pro/settings.json    ("env" block)
//   5. <project>/.claude-pro/settings.local.json
//   6. process environment
//   7. command line flags (--model, --effort ...)
// The model and effort chosen with /model and /effort are remembered apart from these (see
// rememberChoice) and win over 1-6.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeTtl } from './cache.js';
import { discoverVerifyCommand } from './verify.js';

export const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A source checkout (a git clone, also when npm links to one), as opposed to a copy installed from npm: the agent
// edits its own code only in a checkout, since the next update replaces an installed copy.
export const SOURCE_CHECKOUT = fs.existsSync(path.join(INSTALL_DIR, '.git'));
export const CONFIG_DIR = process.env.CLAUDE_PRO_CONFIG_DIR || path.join(os.homedir(), '.claude-pro');
export const APP_NAME = 'claude-pro';
export const PROVIDERS = ['gateway'];
export const GATEWAY_DEFAULT_URL = 'https://gw.predix.icu';
export const VERSION = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).version;

// Every key we understand, with a short description (shown by /config).
export const KNOWN_KEYS = {
  CLAUDE_PRO_PROVIDER: 'Authentication backend: gateway only (codex-gateway account, /login)',
  CLAUDE_PRO_GATEWAY_URL: `codex-gateway address (default https://gw.predix.icu)`,
  CLAUDE_PRO_GATEWAY_API_KEY: 'Gateway API key (normally saved by /login in gateway.json)',
  CLAUDE_PRO_GATEWAY_MODEL: 'Model with the gateway provider (default: opus; also sonnet, haiku, gpt-6.1-sol)',
  CLAUDE_PRO_SEARCH_MODEL: 'Model that runs WebSearch\'s searches on the gateway (default: haiku, fast and cheap; gpt-6.1-sol is tried next when it fails)',
  CLAUDE_PRO_ONLINE: 'Set to 0 to keep interactive sessions off the gateway. Otherwise a session is online on the gateway\'s web page whenever this computer is logged in, and sessions on your other computers can send it tasks (@computer/name)',
  CLAUDE_PRO_REMOTE_COMMANDS: 'Set to 0 to make this computer\'s sessions read-only on the gateway\'s web page: it can watch them, but not send them messages, answer their questions, stop them, switch model or effort, or change their directory (default: on; read when a session goes online)',
  CLAUDE_PRO_MACHINE_NAME: 'This computer\'s name for sessions on your other computers (@公司 ...; default: the host name)',
  CLAUDE_PRO_TUI: 'fullscreen (default: the input box fixed at the bottom, the conversation scrolled inside) or default (classic: it scrolls in the terminal); /tui switches',
  CLAUDE_PRO_AUTO_RESTART: 'Restart by itself when a turn ends and claude-pro\'s own source files changed (default 1; 0 = only on /restart or the Restart tool)',

  CLAUDE_CODE_EFFORT_LEVEL: 'Reasoning effort: none|minimal|low|medium|high|xhigh|max (sent as output_config.effort)',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'Context size (tokens) used for auto-compaction calculations',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: 'Percentage (1-100) of the window at which auto-compaction triggers',
  DISABLE_AUTOCOMPACT: 'Set to 1 to disable auto-compaction',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: 'max_tokens for each model response (default 48000; lowered automatically if the gateway allows less)',
  MAX_THINKING_TOKENS: 'Thinking budget: 0 disables thinking, N enables with budget N',
  CLAUDE_CODE_PROMPT_CACHE_TTL: 'Prompt cache TTL of the conversation itself: 5m or 1h (default: 1h with the gateway; 1h writes cost more, they pay off when you pause for more than 5 minutes). Also the promptCacheTtl setting',
  CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: 'Prompt cache TTL of everything else (sub-agents, compaction, side queries): 5m (default) or 1h. Also the subagentPromptCacheTtl setting',
  ENABLE_PROMPT_CACHING_1H: 'Set to 1 to request the 1-hour TTL for both (the two TTL variables above win over it)',
  FORCE_PROMPT_CACHING_5M: 'Set to 1 to force the 5-minute TTL for both, over every other TTL setting',
  CLAUDE_PRO_CACHE_KEEPALIVE_HOURS: 'Claude models with the 1-hour TTL: while you are away, refresh the conversation\'s prompt cache shortly before it runs out (a read costs 1/40 of a rewrite), for a pause of up to this many hours (default 8; 0 turns it off)',
  DISABLE_PROMPT_CACHING: 'Set to 1 to send no cache_control markers at all (prompt caching off for every model)',
  DISABLE_PROMPT_CACHING_HAIKU: 'Set to 1 to turn prompt caching off for the model the haiku alias resolves to',
  DISABLE_PROMPT_CACHING_SONNET: 'Set to 1 to turn prompt caching off for the model the sonnet alias resolves to',
  DISABLE_PROMPT_CACHING_OPUS: 'Set to 1 to turn prompt caching off for the model the opus alias resolves to',
  DISABLE_PROMPT_CACHING_FABLE: 'Set to 1 to turn prompt caching off for Fable models',
  API_TIMEOUT_MS: 'Request timeout in milliseconds',
  CLAUDE_PRO_MAX_RETRIES: 'Retries for failed API requests (0 = no retries at all, which also turns off the rate limit wait)',
  CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS: 'Longest total time to wait for a rate limit (e.g. the 5-hour window) to reset before continuing by itself (default 21600000 = 6 hours; 0 = report the error instead of waiting)',
  CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS: 'First wait before retrying a request refused as overloaded (529); doubled at each retry (default 1000)',
  CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS: 'Longest wait between retries of an overloaded (529) request (default 32000)',
  CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: 'How long to keep retrying an overloaded (529) API once the usual retries are used up, before reporting the error (default: CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS, 6 hours; 0 = give up after the retries)',
  BASH_DEFAULT_TIMEOUT_MS: 'Default timeout for Bash commands (default 600000 = 10 minutes)',
  BASH_MAX_TIMEOUT_MS: 'Maximum timeout the model may request for Bash commands (default 3600000 = 1 hour)',
  BASH_MAX_OUTPUT_LENGTH: 'Max characters of Bash output returned to the model; the full text is saved to a file (default 60000)',
  CLAUDE_CODE_GIT_BASH_PATH: 'Windows: path to bash.exe (Git Bash)',
  CLAUDE_PRO_RIPGREP_PATH: 'Path to ripgrep (rg) for Grep and @-file suggestions; "off" forces the built-in JS scanner (default: rg from PATH, else the JS scanner)',
  CLAUDE_PRO_VERIFY_COMMAND: 'Command run after the agent edits files (e.g. "npm test"); failures are sent back to fix',
  CLAUDE_PRO_DISABLE_AUTO_MEMORY: 'Set to 1 to turn off the persistent per-project memory',
  CLAUDE_PRO_DISABLE_TOPIC_TITLE: 'Set to 1 to stop asking the current model for the current topic after each message (the tab title then shows the first message of the session)',
  CLAUDE_PRO_TRACE: 'Set to 0 to disable the privacy-preserving runtime JSONL trace (enabled by default)',
  CLAUDE_PRO_TRACE_DIR: 'Directory for runtime trace files (default: the project session directory)',
  CLAUDE_PRO_TRACE_MAX_SIZE: 'Maximum size of one runtime trace file in bytes before rotating it (default 20 MB)',
};

const SECRET_KEYS = new Set(['CLAUDE_PRO_GATEWAY_API_KEY']);

export function parseDotEnv(text) {
  const env = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7);
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
      if (line[eq + 1] === '"') val = val.replace(/\\n/g, '\n');
    } else {
      val = val.replace(/\s+#.*$/, '');
    }
    env[key] = val;
  }
  return env;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
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

const MODEL_KEYS = { gateway: 'CLAUDE_PRO_GATEWAY_MODEL' };

export function loadConfig({ cwd = process.cwd(), flags = {}, dotEnvFile = path.join(INSTALL_DIR, '.env') } = {}) {
  const env = {};
  const sources = {};
  const set = (obj, source) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v === undefined || v === null) continue;
      env[k] = String(v);
      sources[k] = source;
    }
  };

  if (fs.existsSync(dotEnvFile)) set(parseDotEnv(fs.readFileSync(dotEnvFile, 'utf8')), dotEnvFile);

  const files = settingsFiles(cwd);
  // Settings files can still carry "permissions" from other tools; there are no permission rules here, so they are ignored.
  const settings = { mcpServers: {}, hooks: {} };
  for (const [scope, file] of Object.entries(files)) {
    const json = readJson(file);
    if (!json) continue;
    // Claude Code's settings for the prompt cache TTL. They stay settings (the variables rank above them, whichever
    // file they come from; see Config.cacheTtl); a later file's setting replaces an earlier one's.
    if (json.promptCacheTtl !== undefined) settings.promptCacheTtl = json.promptCacheTtl;
    if (json.subagentPromptCacheTtl !== undefined) settings.subagentPromptCacheTtl = json.subagentPromptCacheTtl;
    set(json.env, file);
    if (json.mcpServers) Object.assign(settings.mcpServers, json.mcpServers);
    for (const [event, entries] of Object.entries(json.hooks || {})) {
      if (Array.isArray(entries)) (settings.hooks[event] ||= []).push(...entries);
    }
    if (json.model) { env.CLAUDE_PRO_GATEWAY_MODEL = json.model; sources.CLAUDE_PRO_GATEWAY_MODEL = `${file} (model)`; }
    settings[scope] = json;
  }
  // Project level .mcp.json, same format as Claude Code.
  const mcpJson = readJson(path.join(cwd, '.mcp.json'));
  if (mcpJson?.mcpServers) Object.assign(settings.mcpServers, mcpJson.mcpServers);

  const fromProcess = {};
  for (const k of Object.keys(KNOWN_KEYS)) if (process.env[k] !== undefined && process.env[k] !== '') fromProcess[k] = process.env[k];
  set(fromProcess, 'process environment');

  if (flags.provider) { env.CLAUDE_PRO_PROVIDER = flags.provider; sources.CLAUDE_PRO_PROVIDER = '--provider flag'; }
  if (flags.model) {
    const key = MODEL_KEYS[(env.CLAUDE_PRO_PROVIDER || 'gateway').trim().toLowerCase()] || 'CLAUDE_PRO_GATEWAY_MODEL';
    env[key] = flags.model;
    sources[key] = '--model flag';
  }
  if (flags.effort) { env.CLAUDE_CODE_EFFORT_LEVEL = flags.effort; sources.CLAUDE_CODE_EFFORT_LEVEL = '--effort flag'; }

  return new Config(env, sources, settings, cwd);
}

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const isOn = (v) => /^(1|true|yes)$/i.test(String(v ?? '').trim());

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

  get provider() {
    const value = (this.env.CLAUDE_PRO_PROVIDER || 'gateway').trim().toLowerCase();
    if (value !== 'gateway') throw new Error(`Only the gateway provider is supported. Set CLAUDE_PRO_PROVIDER=gateway (received ${value}).`);
    return 'gateway';
  }
  get usesGateway() { return true; }
  get gatewayUrl() { return (this.env.CLAUDE_PRO_GATEWAY_URL || GATEWAY_DEFAULT_URL).trim().replace(/\/+$/, ''); }
  get endpointLabel() { return `${this.gatewayUrl} (codex-gateway)`; }

  aliasTarget(alias) {
    return { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }[alias] || null;
  }

  // Resolve a model spec (alias or name, maybe with [1m]) to {id, contextWindow, label}.
  resolveModel(spec) {
    let name = (spec || '').trim() || 'sonnet';
    let oneM = false;
    if (/\[1m\]$/i.test(name)) { oneM = true; name = name.replace(/\[1m\]$/i, ''); }
    const aliased = this.aliasTarget(name.toLowerCase());
    if (aliased) {
      const inner = this.resolveModel(aliased);
      return { ...inner, contextWindow: oneM ? 1_000_000 : inner.contextWindow, label: `${name}${oneM ? '[1m]' : ''} (${inner.label})` };
    }
    const nativeOneM = /^claude-(?:(?:sonnet|haiku)-5(?:-|$)|opus-(?:5(?:-|$)|4-[78](?:-|$)))/i.test(name);
    // GPT models are served by the gateway's Codex backend and use its standard context window.
    if (/^gpt-/i.test(name)) return { id: name, contextWindow: 272_000, label: name };
    return { id: name, contextWindow: oneM || nativeOneM ? 1_000_000 : 200_000, label: `${name}${oneM ? '[1m]' : ''}` };
  }

  // The selected model: the configured default unless /model has overridden it for this session.
  get configuredModelSpec() { return this.env.CLAUDE_PRO_GATEWAY_MODEL || 'opus'; }
  get modelSpec() { return this.modelOverride || this.configuredModelSpec; }
  get model() { return this.resolveModel(this.modelSpec); }

  get effort() {
    const v = (this.effortBoost ?? this.effortOverride ?? this.env.CLAUDE_CODE_EFFORT_LEVEL ?? '').trim().toLowerCase();
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
  // Prompt cache TTL for a request bucket, by Claude Code's rules: "main" is the conversation itself, "other"
  // is everything else (sub-agents, compaction, side queries). In order: FORCE_PROMPT_CACHING_5M; the bucket's
  // own variable or setting; ENABLE_PROMPT_CACHING_1H; then the gateway default: the conversation's own
  // requests use 1 hour and everything else uses 5 minutes.
  cacheTtl(bucket = 'main') {
    if (isOn(this.env.FORCE_PROMPT_CACHING_5M)) return '5m';
    // an invalid value is ignored, and the next rule applies (as in Claude Code)
    const own = bucket === 'main'
      ? normalizeTtl(this.env.CLAUDE_CODE_PROMPT_CACHE_TTL) || normalizeTtl(this.settings?.promptCacheTtl)
      : normalizeTtl(this.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL) || normalizeTtl(this.settings?.subagentPromptCacheTtl);
    if (own) return own;
    if (isOn(this.env.ENABLE_PROMPT_CACHING_1H)) return '1h';
    // The gateway too: measured on its usage records (533 Opus requests), pauses of 5 to 60 minutes rewrote the whole
    // conversation 9 times at 1.25x, $14.77; writing every turn at 2x instead costs $2.80 more.
    return bucket === 'main' && this.usesGateway ? '1h' : '5m';
  }
  // DISABLE_PROMPT_CACHING turns it off for everything; the per-model variables only for the model that
  // their alias resolves to (a different version pinned as the model keeps its caching), wherever it runs.
  promptCachingDisabled(modelId) {
    if (isOn(this.env.DISABLE_PROMPT_CACHING)) return true;
    for (const alias of ['haiku', 'sonnet', 'opus']) {
      if (!isOn(this.env[`DISABLE_PROMPT_CACHING_${alias.toUpperCase()}`])) continue;
      const target = this.aliasTarget(alias);
      if (target && this.resolveModel(target).id === modelId) return true;
    }
    return isOn(this.env.DISABLE_PROMPT_CACHING_FABLE) && /fable/i.test(modelId || '');
  }
  get apiTimeout() { return int(this.env.API_TIMEOUT_MS, 600_000); }
  get maxRetries() { return int(this.env.CLAUDE_PRO_MAX_RETRIES, 6); }
  get rateLimitMaxWait() { return Math.max(0, int(this.env.CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS, 6 * 3_600_000)); }
  // A rate limit that does not say when it resets is tried again at most this far apart.
  get rateLimitPoll() { return 300_000; }
  // An overloaded API (529): the backoff, and how long to keep trying once the retries are used up (see planRetry).
  get overloadedRetryBaseDelay() { return Math.max(100, int(this.env.CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS, 1000)); }
  get overloadedRetryMaxDelay() { return Math.max(this.overloadedRetryBaseDelay, int(this.env.CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS, 32_000)); }
  get overloadedMaxWait() { return Math.max(0, int(this.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS, this.rateLimitMaxWait)); }

  // Effective window for compaction: the configured auto-compact window capped by the model window. `own`: a
  // sub-agent's autoCompactWindow, which takes the place of the configured one.
  compactWindow(model = this.model, own = 0) {
    const configured = own > 0 ? own : int(this.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 0);
    return configured > 0 ? Math.min(configured, model.contextWindow) : model.contextWindow;
  }
  get autoCompactEnabled() { return !/^(1|true|yes)$/i.test(this.env.DISABLE_AUTOCOMPACT || ''); }
  autoCompactThreshold(model = this.model, own = 0) {
    const window = this.compactWindow(model, own);
    const pct = int(this.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, 0);
    if (pct > 0 && pct <= 100) return Math.floor(window * pct / 100);
    // Leave room for the summary itself and the next response (replies rarely come close to the
    // max_tokens ceiling, so the reserve is capped; an overflow is handled by compacting on the error).
    return Math.floor(window - Math.min(window * 0.2, Math.max(20_000, Math.min(this.maxOutputTokens, 64_000))));
  }

  get bashDefaultTimeout() { return int(this.env.BASH_DEFAULT_TIMEOUT_MS, 600_000); }
  get bashMaxTimeout() { return int(this.env.BASH_MAX_TIMEOUT_MS, 3_600_000); }
  get bashMaxOutput() { return int(this.env.BASH_MAX_OUTPUT_LENGTH, 60_000); }
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

  // Verification after edits: session override (/verify, --verify) wins over the env setting. With neither set,
  // use a conventional project test/check command when one is unambiguous; /verify off remains the opt-out.
  get verifyCommand() {
    const explicit = this.verifyOverride != null || Object.prototype.hasOwnProperty.call(this.env, 'CLAUDE_PRO_VERIFY_COMMAND');
    if (!explicit) return this.autoVerifyCommand;
    const v = this.verifyOverride ?? this.env.CLAUDE_PRO_VERIFY_COMMAND ?? '';
    return v.trim() && v.trim() !== 'off' ? v.trim() : null;
  }
  get autoVerifyCommand() { return discoverVerifyCommand(this.cwd); }
  get verifyCommandAuto() {
    return this.verifyOverride == null && !Object.prototype.hasOwnProperty.call(this.env, 'CLAUDE_PRO_VERIFY_COMMAND') && Boolean(this.autoVerifyCommand);
  }
  // How many times a failing verify command is sent back before giving up.
  get verifyMaxRounds() { return 3; }
  get autoMemoryEnabled() { return !/^(1|true|yes)$/i.test(this.env.CLAUDE_PRO_DISABLE_AUTO_MEMORY || ''); }
  get traceEnabled() {
    const value = this.env.CLAUDE_PRO_TRACE;
    return value === undefined || !/^(0|false|no|off)$/i.test(String(value).trim());
  }
  get traceDir() {
    const value = String(this.env.CLAUDE_PRO_TRACE_DIR || '').trim();
    return value ? path.resolve(this.cwd, value) : null;
  }
  get traceMaxBytes() { return Math.max(100_000, int(this.env.CLAUDE_PRO_TRACE_MAX_SIZE, 20 * 1024 * 1024)); }

  display(key) {
    const v = this.env[key];
    if (v === undefined) return undefined;
    if (SECRET_KEYS.has(key)) return v.length > 10 ? `${v.slice(0, 5)}…${v.slice(-4)}` : '****';
    return v;
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
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

// What /model and /effort chose, kept per provider in the "remembered" block of the user settings so that
// the choice is still the one in use at the next start (interactive or -p). It is applied as the session's
// override (applyRememberedChoices), so it wins over every configured value; only --model / --effort on
// the command line win over it, for that run. "/model default" and "/effort default" forget it.
const userSettingsFile = () => path.join(CONFIG_DIR, 'settings.json');

export function rememberedChoices(provider) {
  const entry = readJson(userSettingsFile())?.remembered?.[provider];
  return entry && typeof entry === 'object' ? entry : {};
}

// patch: {model?, effort?}; null or '' forgets that one. Returns whether the file changed.
export function rememberChoice(provider, patch) {
  const before = rememberedChoices(provider);
  const after = { ...before };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || value === '') delete after[key];
    else after[key] = String(value);
  }
  if (JSON.stringify(after) === JSON.stringify(before)) return false;
  updateSettingsFile(userSettingsFile(), (json) => {
    const all = json.remembered && typeof json.remembered === 'object' ? json.remembered : {};
    if (Object.keys(after).length) all[provider] = after;
    else delete all[provider];
    if (Object.keys(all).length) json.remembered = all;
    else delete json.remembered;
  });
  return true;
}

export function applyRememberedChoices(config, flags = {}) {
  const remembered = rememberedChoices(config.provider);
  if (!flags.model && typeof remembered.model === 'string' && remembered.model.trim()) config.modelOverride = remembered.model.trim();
  if (!flags.effort && typeof remembered.effort === 'string' && remembered.effort.trim()) config.effortOverride = remembered.effort.trim().toLowerCase();
  return remembered;
}
