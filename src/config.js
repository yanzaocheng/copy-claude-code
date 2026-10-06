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

export const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = process.env.CLAUDE_PRO_CONFIG_DIR || path.join(os.homedir(), '.claude-pro');
export const APP_NAME = 'claude-pro';
export const VERSION = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).version;

// Every key we understand, with a short description (shown by /config).
export const KNOWN_KEYS = {
  CLAUDE_PRO_PROVIDER: 'Authentication backend: api (default) or claude-code (direct HTTP with existing local OAuth login)',
  CLAUDE_PRO_CLAUDE_CONFIG_FILE: 'Existing Claude Code account metadata file (default: ~/.claude.json)',
  CLAUDE_PRO_CLAUDE_CREDENTIALS_FILE: 'Existing Claude Code OAuth credentials file (default: ~/.claude/.credentials.json)',
  CLAUDE_PRO_CLAUDE_CODE_VERSION: 'Claude Code version in the HTTP User-Agent (default: installed npm version)',
  CLAUDE_PRO_DISABLE_TOKEN_REFRESH: 'Set to 1 to stop this program renewing the Claude Code login by itself (it then only reads what the official client keeps up to date)',
  CLAUDE_PRO_AUTO_RESTART: 'Restart by itself when a turn ends and claude-pro\'s own source files changed (default 1; 0 = only on /restart or the Restart tool)',
  CLAUDE_PRO_CLAUDE_CODE_MODEL: 'Model for Claude Code OAuth (default: sonnet; independent of API model settings)',
  CLAUDE_CONFIG_DIR: 'Official Claude Code configuration directory, for selecting the locally signed-in account',
  ANTHROPIC_BASE_URL: 'API base URL (Anthropic compatible endpoint)',
  ANTHROPIC_AUTH_TOKEN: 'Bearer token sent as Authorization header',
  ANTHROPIC_API_KEY: 'API key sent as x-api-key header (used if no auth token)',
  ANTHROPIC_CUSTOM_HEADERS: 'Extra headers, "Name: Value" separated by newlines',
  ANTHROPIC_MODEL: 'Main model (name or alias opus/sonnet/haiku; suffix [1m] = 1M context)',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'Model used for the "opus" alias',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'Model used for the "sonnet" alias',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Small/fast model (web page summarising, titles)',
  ANTHROPIC_SMALL_FAST_MODEL: 'Deprecated alias of ANTHROPIC_DEFAULT_HAIKU_MODEL',
  CLAUDE_CODE_SUBAGENT_MODEL: 'Model used by Task sub-agents',
  CLAUDE_CODE_EFFORT_LEVEL: 'Reasoning effort: none|minimal|low|medium|high|xhigh|max (sent as output_config.effort)',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'Context size (tokens) used for auto-compaction calculations',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: 'Percentage (1-100) of the window at which auto-compaction triggers',
  DISABLE_AUTOCOMPACT: 'Set to 1 to disable auto-compaction',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: 'max_tokens for each model response (default 128000; lowered automatically if the API allows less)',
  MAX_THINKING_TOKENS: 'Thinking budget: 0 disables thinking, N enables with budget N',
  CLAUDE_CODE_PROMPT_CACHE_TTL: 'Prompt cache TTL of the conversation itself: 5m (default) or 1h (1h writes cost more; they pay off when you pause for more than 5 minutes). Also the promptCacheTtl setting',
  CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: 'Prompt cache TTL of everything else (sub-agents, compaction, side queries): 5m (default) or 1h. Also the subagentPromptCacheTtl setting',
  ENABLE_PROMPT_CACHING_1H: 'Set to 1 to request the 1-hour TTL for both (the two TTL variables above win over it)',
  FORCE_PROMPT_CACHING_5M: 'Set to 1 to force the 5-minute TTL for both, over every other TTL setting',
  DISABLE_PROMPT_CACHING: 'Set to 1 to send no cache_control markers at all (prompt caching off for every model)',
  DISABLE_PROMPT_CACHING_HAIKU: 'Set to 1 to turn prompt caching off for the model the haiku alias resolves to',
  DISABLE_PROMPT_CACHING_SONNET: 'Set to 1 to turn prompt caching off for the model the sonnet alias resolves to',
  DISABLE_PROMPT_CACHING_OPUS: 'Set to 1 to turn prompt caching off for the model the opus alias resolves to',
  DISABLE_PROMPT_CACHING_FABLE: 'Set to 1 to turn prompt caching off for Fable models',
  API_TIMEOUT_MS: 'Request timeout in milliseconds',
  CLAUDE_PRO_MAX_RETRIES: 'Retries for failed API requests (0 = no retries at all, which also turns off the rate limit wait)',
  CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS: 'Longest total time to wait for a rate limit (e.g. the 5-hour window) to reset before continuing by itself (default 21600000 = 6 hours; 0 = report the error instead of waiting)',
  CLAUDE_PRO_RATE_LIMIT_POLL_MS: 'When a rate limit does not say when it resets, try again at most this far apart (default 300000 = 5 minutes)',
  BASH_DEFAULT_TIMEOUT_MS: 'Default timeout for Bash commands (default 600000 = 10 minutes)',
  BASH_MAX_TIMEOUT_MS: 'Maximum timeout the model may request for Bash commands (default 3600000 = 1 hour)',
  BASH_MAX_OUTPUT_LENGTH: 'Max characters of Bash output returned to the model; the full text is saved to a file (default 60000)',
  CLAUDE_CODE_GIT_BASH_PATH: 'Windows: path to bash.exe (Git Bash)',
  CLAUDE_PRO_RIPGREP_PATH: 'Path to ripgrep (rg) for Grep and @-file suggestions; "off" forces the built-in JS scanner (default: rg from PATH, else the JS scanner)',
  CLAUDE_PRO_MAX_TOOL_RESULT_CHARS: 'Tool results longer than this are saved to a file and only a preview is sent (default 100000)',
  CLAUDE_PRO_MAX_SUBAGENT_DEPTH: 'How deep sub-agents may nest: agents below this depth can start their own sub-agents (default 2; 0 = no nesting)',
  CLAUDE_PRO_VERIFY_COMMAND: 'Command run after the agent edits files (e.g. "npm test"); failures are sent back to fix',
  CLAUDE_PRO_VERIFY_MAX_ROUNDS: 'How many times a failing verify command is sent back before giving up (default 3)',
  CLAUDE_PRO_DISABLE_AUTO_MEMORY: 'Set to 1 to turn off the persistent per-project memory',
  CLAUDE_PRO_DISABLE_TOPIC_TITLE: 'Set to 1 to stop asking the small model for the current topic after each message (the tab title then shows the first message of the session)',
};

const SECRET_KEYS = new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS']);

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

  const dotEnvFile = path.join(INSTALL_DIR, '.env');
  if (fs.existsSync(dotEnvFile)) set(parseDotEnv(fs.readFileSync(dotEnvFile, 'utf8')), dotEnvFile);

  const files = settingsFiles(cwd);
  // Settings files can still carry "permissions" from other tools; there are no permission rules here, so they are ignored.
  const settings = { mcpServers: {}, hooks: {} };
  for (const [scope, file] of Object.entries(files)) {
    const json = readJson(file);
    if (!json) continue;
    // Claude Code's settings for the prompt cache TTL; the same variables in "env" win over them.
    if (json.promptCacheTtl !== undefined) set({ CLAUDE_CODE_PROMPT_CACHE_TTL: json.promptCacheTtl }, `${file} (promptCacheTtl)`);
    if (json.subagentPromptCacheTtl !== undefined) set({ CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: json.subagentPromptCacheTtl }, `${file} (subagentPromptCacheTtl)`);
    set(json.env, file);
    if (json.mcpServers) Object.assign(settings.mcpServers, json.mcpServers);
    for (const [event, entries] of Object.entries(json.hooks || {})) {
      if (Array.isArray(entries)) (settings.hooks[event] ||= []).push(...entries);
    }
    if (json.model) { env.ANTHROPIC_MODEL = json.model; sources.ANTHROPIC_MODEL = `${file} (model)`; }
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
    const key = (env.CLAUDE_PRO_PROVIDER || '').trim().toLowerCase() === 'claude-code' ? 'CLAUDE_PRO_CLAUDE_CODE_MODEL' : 'ANTHROPIC_MODEL';
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
    this.verifyOverride = null; // set by /verify or --verify during a session
  }

  get provider() {
    const value = (this.env.CLAUDE_PRO_PROVIDER || 'api').trim().toLowerCase();
    if (!['api', 'claude-code'].includes(value)) throw new Error(`Unknown CLAUDE_PRO_PROVIDER: ${value}. Use api or claude-code.`);
    return value;
  }
  get usesClaudeCode() { return this.provider === 'claude-code'; }
  get claudeCodeConfigFile() { return path.resolve(this.cwd, this.env.CLAUDE_PRO_CLAUDE_CONFIG_FILE || path.join(os.homedir(), '.claude.json')); }
  get claudeCodeCredentialsFile() {
    return path.resolve(this.cwd, this.env.CLAUDE_PRO_CLAUDE_CREDENTIALS_FILE || path.join(
      this.env.CLAUDE_CONFIG_DIR || path.join(path.dirname(this.claudeCodeConfigFile), '.claude'), '.credentials.json'));
  }
  get endpointLabel() { return this.usesClaudeCode ? 'https://api.anthropic.com (Claude Code OAuth)' : this.baseURL; }
  get baseURL() { return this.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'; }
  get authToken() { return this.env.ANTHROPIC_AUTH_TOKEN || null; }
  get apiKey() { return this.env.ANTHROPIC_API_KEY || null; }
  get customHeaders() {
    const headers = {};
    for (const line of (this.env.ANTHROPIC_CUSTOM_HEADERS || '').split(/\n/)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return headers;
  }

  aliasTarget(alias) {
    if (this.usesClaudeCode) {
      return { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5-20251001' }[alias] || null;
    }
    switch (alias) {
      case 'opus': return this.env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'claude-opus-4-5';
      case 'sonnet': return this.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-5';
      case 'haiku': return this.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || this.env.ANTHROPIC_SMALL_FAST_MODEL || 'claude-haiku-4-5';
      default: return null;
    }
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
    const nativeOneM = this.usesClaudeCode && /^claude-(?:sonnet-5(?:-|$)|opus-(?:5(?:-|$)|4-[78](?:-|$)))/i.test(name);
    return { id: name, contextWindow: oneM || nativeOneM ? 1_000_000 : 200_000, label: `${name}${oneM ? '[1m]' : ''}` };
  }

  // The model the active provider is configured with, before any /model override.
  get configuredModelSpec() {
    return (this.usesClaudeCode ? this.env.CLAUDE_PRO_CLAUDE_CODE_MODEL : this.env.ANTHROPIC_MODEL) || 'sonnet';
  }
  get mainModelSpec() { return this.modelOverride || this.configuredModelSpec; }
  get mainModel() { return this.resolveModel(this.mainModelSpec); }
  get subagentModel() {
    if (this.usesClaudeCode) return this.mainModel;
    return this.env.CLAUDE_CODE_SUBAGENT_MODEL ? this.resolveModel(this.env.CLAUDE_CODE_SUBAGENT_MODEL) : this.mainModel;
  }
  get smallModel() { return this.resolveModel('haiku'); }

  get effort() {
    const v = (this.effortOverride ?? this.env.CLAUDE_CODE_EFFORT_LEVEL ?? '').trim().toLowerCase();
    return v && v !== 'auto' && v !== 'default' ? v : null;
  }

  // Generous by default so large files can be written in one go; if the API turns out to allow
  // less, streamMessage learns the real limit from the error and clamps (see api.js).
  get maxOutputTokens() { return int(this.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, 128_000); }
  get thinkingBudget() {
    return this.env.MAX_THINKING_TOKENS === undefined ? null : int(this.env.MAX_THINKING_TOKENS, null);
  }
  // Prompt cache TTL for a request bucket, by Claude Code's rules: "main" is the conversation itself, "other"
  // is everything else (sub-agents, compaction, side queries). In order: FORCE_PROMPT_CACHING_5M; the bucket's
  // own variable or setting; ENABLE_PROMPT_CACHING_1H; 5 minutes.
  cacheTtl(bucket = 'main') {
    if (isOn(this.env.FORCE_PROMPT_CACHING_5M)) return '5m';
    const own = normalizeTtl(bucket === 'main' ? this.env.CLAUDE_CODE_PROMPT_CACHE_TTL : this.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL);
    if (own) return own;
    return isOn(this.env.ENABLE_PROMPT_CACHING_1H) ? '1h' : '5m';
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
  get rateLimitPoll() { return Math.max(1000, int(this.env.CLAUDE_PRO_RATE_LIMIT_POLL_MS, 300_000)); }

  // Effective window for compaction: the configured auto-compact window capped by the model window.
  compactWindow(model = this.mainModel) {
    const configured = int(this.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 0);
    return configured > 0 ? Math.min(configured, model.contextWindow) : model.contextWindow;
  }
  get autoCompactEnabled() { return !/^(1|true|yes)$/i.test(this.env.DISABLE_AUTOCOMPACT || ''); }
  autoCompactThreshold(model = this.mainModel) {
    const window = this.compactWindow(model);
    const pct = int(this.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, 0);
    if (pct > 0 && pct <= 100) return Math.floor(window * pct / 100);
    // Leave room for the summary itself and the next response (replies rarely come close to the
    // max_tokens ceiling, so the reserve is capped; an overflow is handled by compacting on the error).
    return Math.floor(window - Math.min(window * 0.2, Math.max(20_000, Math.min(this.maxOutputTokens, 64_000))));
  }

  get bashDefaultTimeout() { return int(this.env.BASH_DEFAULT_TIMEOUT_MS, 600_000); }
  get bashMaxTimeout() { return int(this.env.BASH_MAX_TIMEOUT_MS, 3_600_000); }
  get bashMaxOutput() { return int(this.env.BASH_MAX_OUTPUT_LENGTH, 60_000); }
  get maxToolResultChars() { return int(this.env.CLAUDE_PRO_MAX_TOOL_RESULT_CHARS, 100_000); }
  // How deep sub-agents may nest: the main agent is depth 0; an agent below this depth gets the Task tool.
  get maxSubagentDepth() { return Math.max(0, int(this.env.CLAUDE_PRO_MAX_SUBAGENT_DEPTH, 2)); }

  // Verification after edits: session override (/verify, --verify) wins over the env setting.
  get verifyCommand() {
    const v = this.verifyOverride ?? this.env.CLAUDE_PRO_VERIFY_COMMAND ?? '';
    return v.trim() && v.trim() !== 'off' ? v.trim() : null;
  }
  get verifyMaxRounds() { return Math.max(1, int(this.env.CLAUDE_PRO_VERIFY_MAX_ROUNDS, 3)); }
  get autoMemoryEnabled() { return !/^(1|true|yes)$/i.test(this.env.CLAUDE_PRO_DISABLE_AUTO_MEMORY || ''); }

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
