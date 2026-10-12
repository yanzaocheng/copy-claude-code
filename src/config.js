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
import { codexModels, codexConfigDefaults } from './codex/client.js';

export const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A source checkout (a git clone, also when npm links to one), as opposed to a copy installed from npm: the agent
// edits its own code only in a checkout, since the next update replaces an installed copy.
export const SOURCE_CHECKOUT = fs.existsSync(path.join(INSTALL_DIR, '.git'));
export const CONFIG_DIR = process.env.CLAUDE_PRO_CONFIG_DIR || path.join(os.homedir(), '.claude-pro');
export const APP_NAME = 'claude-pro';
export const PROVIDERS = ['api', 'claude-code', 'gateway', 'codex'];
export const GATEWAY_DEFAULT_URL = 'https://gw.predix.icu';
// The codex provider's model when neither CLAUDE_PRO_CODEX_MODEL nor the Codex config.toml names one.
export const CODEX_DEFAULT_MODEL = 'gpt-6.1-sol';
export const VERSION = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).version;

// Every key we understand, with a short description (shown by /config).
export const KNOWN_KEYS = {
  CLAUDE_PRO_PROVIDER: 'Authentication backend: gateway (default; api when an API endpoint or key is configured), api, claude-code (local Claude subscription login), gateway (codex-gateway account, /login) or codex (local Codex/ChatGPT subscription login)',
  CLAUDE_PRO_GATEWAY_URL: `codex-gateway address for the gateway provider (default https://gw.predix.icu)`,
  CLAUDE_PRO_GATEWAY_MODEL: 'Model with the gateway provider (default: opus; also sonnet, haiku, gpt-6.1-sol)',
  CLAUDE_PRO_CODEX_MODEL: 'Model with the codex provider (default: the model in ~/.codex/config.toml, else gpt-6.1-sol)',
  CLAUDE_PRO_CLAUDE_CONFIG_FILE: 'Existing Claude Code account metadata file (default: ~/.claude.json)',
  CLAUDE_PRO_CLAUDE_CREDENTIALS_FILE: 'Existing Claude Code OAuth credentials file (default: ~/.claude/.credentials.json)',
  CLAUDE_PRO_CLAUDE_CODE_VERSION: 'Claude Code version in the HTTP User-Agent (default: installed npm version)',
  CLAUDE_PRO_DISABLE_TOKEN_REFRESH: 'Set to 1 to stop this program renewing the Claude Code login by itself (it then only reads what the official client keeps up to date)',
  CLAUDE_PRO_ONLINE: 'Internal (the self-check and the tests set it): 0 keeps interactive sessions off the gateway. Otherwise a session is online there whenever this computer is logged in to the gateway: its 远程控制 page shows it, and sessions on your other computers can send it tasks (&computer/name)',
  CLAUDE_PRO_HOST: 'Set to 0 so that sessions do not start the computer service (claude-pro host) by themselves; the service lets the gateway\'s 远程控制 page open new sessions on this computer',
  CLAUDE_PRO_DOWNLOAD_DIR: 'Where files that other sessions send this one are saved (default: the Downloads folder)',
  CLAUDE_PRO_MACHINE_NAME: 'This computer\'s name for sessions on your other computers (@公司 ...; default: the host name)',
  CLAUDE_PRO_TUI: 'fullscreen (default: the input box fixed at the bottom, the conversation scrolled inside, like Claude Code\'s /tui fullscreen) or default (classic: it scrolls in the terminal); /tui switches',
  CLAUDE_PRO_SCROLL_SPEED: 'Fullscreen: rows the mouse wheel scrolls a notch (default 3, at most 20)',
  CLAUDE_PRO_PIN_INPUT: 'Set to 0 to show the input box right below the output instead of on the last rows of the window',
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
  CLAUDE_CODE_SUBAGENT_MODEL: 'Model used by Task sub-agents (API providers; default: the main model)',
  CLAUDE_PRO_CLAUDE_CODE_SUBAGENT_MODEL: 'Model used by Task sub-agents with the claude-code provider (default: sonnet)',
  CLAUDE_CODE_EFFORT_LEVEL: 'Reasoning effort: none|minimal|low|medium|high|xhigh|max (sent as output_config.effort)',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'Context size (tokens) used for auto-compaction calculations',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: 'Percentage (1-100) of the window at which auto-compaction triggers',
  DISABLE_AUTOCOMPACT: 'Set to 1 to disable auto-compaction',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: 'max_tokens for each model response (default 128000, 48000 with the gateway; lowered automatically if the API allows less)',
  MAX_THINKING_TOKENS: 'Thinking budget: 0 disables thinking, N enables with budget N',
  CLAUDE_CODE_PROMPT_CACHE_TTL: 'Prompt cache TTL of the conversation itself: 5m or 1h (default: 1h with the subscription login, as in Claude Code, and with the gateway, else 5m; 1h writes cost more, they pay off when you pause for more than 5 minutes). Also the promptCacheTtl setting',
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
  CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS: 'First wait before retrying a request refused as overloaded (529); doubled at each retry (default 1000)',
  CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS: 'Longest wait between retries of an overloaded (529) request (default 32000)',
  CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: 'How long to keep retrying an overloaded (529) API once the usual retries are used up, before reporting the error (default: CLAUDE_PRO_RATE_LIMIT_MAX_WAIT_MS, 6 hours; 0 = give up after the retries)',
  BASH_DEFAULT_TIMEOUT_MS: 'Default timeout for Bash commands (default 600000 = 10 minutes)',
  BASH_MAX_TIMEOUT_MS: 'Maximum timeout the model may request for Bash commands (default 3600000 = 1 hour)',
  BASH_MAX_OUTPUT_LENGTH: 'Max characters of Bash output returned to the model; the full text is saved to a file (default 60000)',
  CLAUDE_CODE_GIT_BASH_PATH: 'Windows: path to bash.exe (Git Bash)',
  CLAUDE_PRO_RIPGREP_PATH: 'Path to ripgrep (rg) for Grep and @-file suggestions; "off" forces the built-in JS scanner (default: rg from PATH, else the JS scanner)',
  CLAUDE_PRO_MAX_TOOL_RESULT_CHARS: 'Tool results longer than this are saved to a file and only a preview is sent (default 100000)',
  CLAUDE_PRO_CLEAR_AFTER_IDLE: 'Back after more than 65 minutes away (the prompt cache has expired): clear old tool results and thinking, keeping the last 5 results, as Claude Code does. 1 = on, 0 = off (default: on for the Claude Code login and api.anthropic.com, off for other endpoints, whose cache may last for hours)',
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

// What the install's .env holds is, by its own template, the API provider's setup: an endpoint, its token and
// models, and how hard and how long that model works. The subscription provider (claude-code) does not take that
// tuning over: it starts from Claude Code's own defaults (the model's default effort, the model's whole context
// window), which is what makes it work without any setting. The same keys in a settings file, in the shell, as a
// flag, or chosen with /effort do apply there.
export const API_ONLY_DOTENV_KEYS = ['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'MAX_THINKING_TOKENS'];

// The variable that holds the model, per provider.
const MODEL_KEYS = { api: 'ANTHROPIC_MODEL', 'claude-code': 'CLAUDE_PRO_CLAUDE_CODE_MODEL', gateway: 'CLAUDE_PRO_GATEWAY_MODEL', codex: 'CLAUDE_PRO_CODEX_MODEL' };

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
    const key = MODEL_KEYS[(env.CLAUDE_PRO_PROVIDER || '').trim().toLowerCase()] || 'ANTHROPIC_MODEL';
    env[key] = flags.model;
    sources[key] = '--model flag';
  }
  if (flags.effort) { env.CLAUDE_CODE_EFFORT_LEVEL = flags.effort; sources.CLAUDE_CODE_EFFORT_LEVEL = '--effort flag'; }

  const ignoredFromDotEnv = [];
  if (!['', 'api'].includes((env.CLAUDE_PRO_PROVIDER || '').trim().toLowerCase())) {
    for (const key of API_ONLY_DOTENV_KEYS) {
      if (sources[key] !== dotEnvFile) continue;
      delete env[key];
      delete sources[key];
      ignoredFromDotEnv.push(key);
    }
  }
  const config = new Config(env, sources, settings, cwd);
  config.ignoredFromDotEnv = ignoredFromDotEnv; // shown by /config
  return config;
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
    this.ignoredFromDotEnv = []; // .env keys that are not applied because of the provider (see API_ONLY_DOTENV_KEYS)
  }

  // Not set: an API endpoint, key or model that is configured (.env, settings) means the api provider, as before;
  // otherwise the gateway, where /login gets an account in the browser.
  get provider() {
    const configuredApi = this.env.ANTHROPIC_AUTH_TOKEN || this.env.ANTHROPIC_API_KEY || this.env.ANTHROPIC_BASE_URL || this.env.ANTHROPIC_MODEL;
    const value = (this.env.CLAUDE_PRO_PROVIDER || (configuredApi ? 'api' : 'gateway')).trim().toLowerCase();
    if (!PROVIDERS.includes(value)) throw new Error(`Unknown CLAUDE_PRO_PROVIDER: ${value}. Use ${PROVIDERS.join(', ')}.`);
    return value;
  }
  get usesClaudeCode() { return this.provider === 'claude-code'; }
  get usesGateway() { return this.provider === 'gateway'; }
  get usesCodex() { return this.provider === 'codex'; }
  get gatewayUrl() { return (this.env.CLAUDE_PRO_GATEWAY_URL || GATEWAY_DEFAULT_URL).trim().replace(/\/+$/, ''); }
  // Claude's own model names and context windows apply: the subscription login, or the gateway (which serves
  // Claude through a subscription login too).
  get claudeIds() { return this.usesClaudeCode || this.usesGateway; }
  get claudeCodeConfigFile() { return path.resolve(this.cwd, this.env.CLAUDE_PRO_CLAUDE_CONFIG_FILE || path.join(os.homedir(), '.claude.json')); }
  get claudeCodeCredentialsFile() {
    return path.resolve(this.cwd, this.env.CLAUDE_PRO_CLAUDE_CREDENTIALS_FILE || path.join(
      this.env.CLAUDE_CONFIG_DIR || path.join(path.dirname(this.claudeCodeConfigFile), '.claude'), '.credentials.json'));
  }
  get endpointLabel() {
    if (this.usesClaudeCode) return 'https://api.anthropic.com (Claude Code OAuth)';
    if (this.usesGateway) return `${this.gatewayUrl} (codex-gateway)`;
    if (this.usesCodex) return 'https://chatgpt.com/backend-api/codex (Codex login)';
    return this.baseURL;
  }
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
      return { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }[alias] || null;
    }
    // The gateway prices models by their undated names.
    if (this.usesGateway) return { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }[alias] || null;
    if (this.usesCodex) {
      // No Claude here: the big aliases mean the Codex model, haiku the small one when the Codex install has it.
      if (alias === 'haiku') return codexModels(this.env).models.some((m) => m.slug === 'gpt-6-luna') ? 'gpt-6-luna' : this.codexModelSpec;
      return alias === 'opus' || alias === 'sonnet' ? this.codexModelSpec : null;
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
    const nativeOneM = this.claudeIds && /^claude-(?:(?:sonnet|haiku)-5(?:-|$)|opus-(?:5(?:-|$)|4-[78](?:-|$)))/i.test(name);
    // OpenAI models (the codex provider, gpt-6.1-sol on the gateway): the window the Codex install reports,
    // else the 272K of the current GPT models.
    if (/^gpt-/i.test(name)) {
      const known = codexModels(this.env).models.find((m) => m.slug === name)?.contextWindow;
      return { id: name, contextWindow: known || 272_000, label: name };
    }
    return { id: name, contextWindow: oneM || nativeOneM ? 1_000_000 : 200_000, label: `${name}${oneM ? '[1m]' : ''}` };
  }

  // The model the active provider is configured with, before any /model override.
  get configuredModelSpec() {
    if (this.usesGateway) return this.env.CLAUDE_PRO_GATEWAY_MODEL || 'opus';
    if (this.usesCodex) return this.codexModelSpec;
    return (this.usesClaudeCode ? this.env.CLAUDE_PRO_CLAUDE_CODE_MODEL : this.env.ANTHROPIC_MODEL) || 'sonnet';
  }
  get codexModelSpec() { return this.env.CLAUDE_PRO_CODEX_MODEL || codexConfigDefaults(this.env).model || CODEX_DEFAULT_MODEL; }
  get mainModelSpec() { return this.modelOverride || this.configuredModelSpec; }
  get mainModel() { return this.resolveModel(this.mainModelSpec); }
  get subagentModel() {
    // With the subscription login sub-agents run on Sonnet: much cheaper than Opus, and good at the searching and
    // well-specified subtasks they are given. CLAUDE_PRO_CLAUDE_CODE_SUBAGENT_MODEL (or a sub-agent's own model) changes it.
    if (this.usesClaudeCode) return this.resolveModel(this.env.CLAUDE_PRO_CLAUDE_CODE_SUBAGENT_MODEL || 'sonnet');
    // The gateway: no fixed sub-agent model. Under a Claude main model the main agent picks one for each Task by how
    // hard the task is (see subagentModelChosen and the Task tool's description); this is what an agent runs on when
    // it was not given one: the main model. A GPT main model keeps its own.
    if (this.usesGateway) return this.mainModel;
    if (this.usesCodex) return this.mainModel;
    return this.env.CLAUDE_CODE_SUBAGENT_MODEL ? this.resolveModel(this.env.CLAUDE_CODE_SUBAGENT_MODEL) : this.mainModel;
  }
  // The main agent chooses each sub-agent's model (haiku, sonnet, opus) by the task, rather than one being set.
  get subagentModelChosen() { return this.usesGateway && /^claude-/i.test(this.mainModel.id); }
  get smallModel() { return this.resolveModel('haiku'); }

  get effort() {
    const v = (this.effortBoost ?? this.effortOverride ?? this.env.CLAUDE_CODE_EFFORT_LEVEL ?? '').trim().toLowerCase();
    return v && v !== 'auto' && v !== 'default' ? v : null;
  }

  // Generous by default so large files can be written in one go; if the API turns out to allow
  // less, streamMessage learns the real limit from the error and clamps (see api.js).
  // The gateway holds back balance for max_tokens of output before each request, so a smaller default there keeps a
  // modest balance usable. 48K: in 812 Opus requests through it (2026-10-12) p99 was 14K, three went over 24K (the
  // longest that finished: 27K) and one was cut off at the old 32K; the hold is $0.96 on Opus instead of $0.64.
  get maxOutputTokens() { return int(this.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, this.usesGateway ? 48_000 : 128_000); }
  get thinkingBudget() {
    return this.env.MAX_THINKING_TOKENS === undefined ? null : int(this.env.MAX_THINKING_TOKENS, null);
  }
  // Prompt cache TTL for a request bucket, by Claude Code's rules: "main" is the conversation itself, "other"
  // is everything else (sub-agents, compaction, side queries). In order: FORCE_PROMPT_CACHING_5M; the bucket's
  // own variable or setting; ENABLE_PROMPT_CACHING_1H; then the default: with the subscription login the
  // conversation's own requests use 1 hour, which is what Claude Code asks for there (within the plan's
  // usage); with an API key or another endpoint, and for everything else, 5 minutes.
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
    return bucket === 'main' && (this.usesClaudeCode || this.usesGateway) ? '1h' : '5m';
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
  // An overloaded API (529): the backoff, and how long to keep trying once the retries are used up (see planRetry).
  get overloadedRetryBaseDelay() { return Math.max(100, int(this.env.CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS, 1000)); }
  get overloadedRetryMaxDelay() { return Math.max(this.overloadedRetryBaseDelay, int(this.env.CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS, 32_000)); }
  get overloadedMaxWait() { return Math.max(0, int(this.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS, this.rateLimitMaxWait)); }

  // Effective window for compaction: the configured auto-compact window capped by the model window. `own`: a
  // sub-agent's autoCompactWindow, which takes the place of the configured one.
  compactWindow(model = this.mainModel, own = 0) {
    const configured = own > 0 ? own : int(this.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 0);
    return configured > 0 ? Math.min(configured, model.contextWindow) : model.contextWindow;
  }
  get autoCompactEnabled() { return !/^(1|true|yes)$/i.test(this.env.DISABLE_AUTOCOMPACT || ''); }
  autoCompactThreshold(model = this.mainModel, own = 0) {
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
  get maxToolResultChars() { return int(this.env.CLAUDE_PRO_MAX_TOOL_RESULT_CHARS, 100_000); }
  // Clearing old tool results after a long pause (see Agent.clearAfterIdle): on where the cache is Anthropic's,
  // which has expired by then. Another endpoint may keep its cache for hours, and clearing would make it miss.
  get clearAfterIdle() {
    const v = String(this.env.CLAUDE_PRO_CLEAR_AFTER_IDLE ?? '').trim();
    if (v) return isOn(v);
    return this.usesClaudeCode || this.usesGateway || /^https:\/\/api\.anthropic\.com\/?$/i.test(this.baseURL);
  }
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
