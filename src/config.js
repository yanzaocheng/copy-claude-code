// Configuration loading. Mirrors Claude Code's environment variables so the same
// settings work here. Sources, lowest precedence first:
//   1. built-in defaults
//   2. <install dir>/.env
//   3. ~/.ccc/settings.json            ("env" block)
//   4. <project>/.ccc/settings.json    ("env" block)
//   5. <project>/.ccc/settings.local.json
//   6. process environment
//   7. command line flags (--model, --effort ...)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = process.env.CCC_CONFIG_DIR || path.join(os.homedir(), '.ccc');
export const APP_NAME = 'ccc';
export const VERSION = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).version;

// Every key we understand, with a short description (shown by /config).
export const KNOWN_KEYS = {
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
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: 'max_tokens for each model response',
  MAX_THINKING_TOKENS: 'Thinking budget: 0 disables thinking, N enables with budget N',
  API_TIMEOUT_MS: 'Request timeout in milliseconds',
  CCC_MAX_RETRIES: 'Retries for failed API requests',
  BASH_DEFAULT_TIMEOUT_MS: 'Default timeout for Bash commands',
  BASH_MAX_TIMEOUT_MS: 'Maximum timeout the model may request for Bash commands',
  BASH_MAX_OUTPUT_LENGTH: 'Max characters of Bash output returned to the model',
  CLAUDE_CODE_GIT_BASH_PATH: 'Windows: path to bash.exe (Git Bash)',
  CCC_MAX_TOOL_RESULT_CHARS: 'Tool results longer than this are saved to a file and only a preview is sent (default 50000)',
  CCC_VERIFY_COMMAND: 'Command run after the agent edits files (e.g. "npm test"); failures are sent back to fix',
  CCC_VERIFY_MAX_ROUNDS: 'How many times a failing verify command is sent back before giving up (default 3)',
  CCC_DISABLE_AUTO_MEMORY: 'Set to 1 to turn off the persistent per-project memory',
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
    project: path.join(cwd, '.ccc', 'settings.json'),
    local: path.join(cwd, '.ccc', 'settings.local.json'),
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
  const settings = { permissions: { allow: [], deny: [] }, mcpServers: {}, hooks: {} };
  for (const [scope, file] of Object.entries(files)) {
    const json = readJson(file);
    if (!json) continue;
    set(json.env, file);
    if (json.permissions) {
      settings.permissions.allow.push(...(json.permissions.allow || []));
      settings.permissions.deny.push(...(json.permissions.deny || []));
      if (json.permissions.defaultMode) settings.defaultMode = json.permissions.defaultMode;
    }
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

  if (flags.model) { env.ANTHROPIC_MODEL = flags.model; sources.ANTHROPIC_MODEL = '--model flag'; }
  if (flags.effort) { env.CLAUDE_CODE_EFFORT_LEVEL = flags.effort; sources.CLAUDE_CODE_EFFORT_LEVEL = '--effort flag'; }

  return new Config(env, sources, settings, cwd);
}

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

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
    return { id: name, contextWindow: oneM ? 1_000_000 : 200_000, label: `${name}${oneM ? '[1m]' : ''}` };
  }

  get mainModelSpec() { return this.modelOverride || this.env.ANTHROPIC_MODEL || 'sonnet'; }
  get mainModel() { return this.resolveModel(this.mainModelSpec); }
  get subagentModel() {
    return this.env.CLAUDE_CODE_SUBAGENT_MODEL ? this.resolveModel(this.env.CLAUDE_CODE_SUBAGENT_MODEL) : this.mainModel;
  }
  get smallModel() { return this.resolveModel('haiku'); }

  get effort() {
    const v = (this.effortOverride ?? this.env.CLAUDE_CODE_EFFORT_LEVEL ?? '').trim().toLowerCase();
    return v && v !== 'auto' && v !== 'default' ? v : null;
  }

  get maxOutputTokens() { return int(this.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, 32000); }
  get thinkingBudget() {
    return this.env.MAX_THINKING_TOKENS === undefined ? null : int(this.env.MAX_THINKING_TOKENS, null);
  }
  get apiTimeout() { return int(this.env.API_TIMEOUT_MS, 600_000); }
  get maxRetries() { return int(this.env.CCC_MAX_RETRIES, 6); }

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
    // Leave room for the summary itself and the next response.
    return Math.floor(window - Math.min(window * 0.2, Math.max(20_000, this.maxOutputTokens)));
  }

  get bashDefaultTimeout() { return int(this.env.BASH_DEFAULT_TIMEOUT_MS, 120_000); }
  get bashMaxTimeout() { return int(this.env.BASH_MAX_TIMEOUT_MS, 600_000); }
  get bashMaxOutput() { return int(this.env.BASH_MAX_OUTPUT_LENGTH, 30_000); }
  get maxToolResultChars() { return int(this.env.CCC_MAX_TOOL_RESULT_CHARS, 50_000); }

  // Verification after edits: session override (/verify, --verify) wins over the env setting.
  get verifyCommand() {
    const v = this.verifyOverride ?? this.env.CCC_VERIFY_COMMAND ?? '';
    return v.trim() && v.trim() !== 'off' ? v.trim() : null;
  }
  get verifyMaxRounds() { return Math.max(1, int(this.env.CCC_VERIFY_MAX_ROUNDS, 3)); }
  get autoMemoryEnabled() { return !/^(1|true|yes)$/i.test(this.env.CCC_DISABLE_AUTO_MEMORY || ''); }

  display(key) {
    const v = this.env[key];
    if (v === undefined) return undefined;
    if (SECRET_KEYS.has(key)) return v.length > 10 ? `${v.slice(0, 5)}…${v.slice(-4)}` : '****';
    return v;
  }
}

// Update the "env" block (or another top level key) of a settings file.
export function updateSettingsFile(file, mutate) {
  let json = {};
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  mutate(json);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}
