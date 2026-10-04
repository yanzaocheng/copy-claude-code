// Permission rules and modes, modelled on Claude Code:
//   modes:  default | acceptEdits | plan | bypassPermissions
//   rules:  "Bash", "Bash(npm test)", "Bash(npm run test:*)", "Bash(git * main)",
//           "Edit(src/**)", "Read(./.env)", "WebFetch(domain:example.com)", "mcp__server", "mcp__server__tool"

import path from 'node:path';
import os from 'node:os';
import { settingsFiles, updateSettingsFile } from './config.js';
import { isInside } from './utils/paths.js';

export const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export function parseRule(rule) {
  const m = /^([\w-]+)(?:\((.*)\))?$/s.exec(String(rule).trim());
  if (!m) return null;
  return { tool: m[1], content: m[2] ?? null, raw: rule };
}

// Split a shell command into simple commands on && || ; | and newlines (quote aware).
export function splitCommand(cmd) {
  const parts = [];
  let cur = '', quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { cur += ch + cmd[++i]; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') { parts.push(cur); cur = ''; i++; continue; }
    if (ch === ';' || ch === '|' || ch === '\n') { parts.push(cur); cur = ''; continue; }
    if (ch === '&' && cmd[i + 1] !== '>' && cmd[i - 1] !== '>') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function stripQuotedStrings(s) {
  return s.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
}

// Something we can't reason about safely: command substitution, redirection to files, etc.
function hasDangerousSyntax(cmd) {
  const s = stripQuotedStrings(cmd);
  if (/\$\(|`|<\(|>\(/.test(s)) return true;
  // Redirections other than to /dev/null or fd duplication.
  const redir = s.replace(/\d?>&\d/g, '').replace(/&?>>?\s*\/dev\/null/g, '').replace(/\d?>>?\s*\/dev\/null/g, '');
  return /[<>]/.test(redir);
}

const SAFE_SIMPLE = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'which', 'whoami', 'date', 'tree', 'file', 'stat', 'du', 'df',
  'uname', 'hostname', 'printenv', 'type', 'realpath', 'basename', 'dirname', 'sort', 'uniq', 'cut', 'tr', 'diff',
  'grep', 'egrep', 'fgrep', 'rg', 'true', 'false', 'test', 'nproc', 'id', 'cd', 'less', 'more', 'column', 'jq', 'md5sum', 'sha256sum',
]);
const SAFE_PREFIXES = [
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git remote -v', 'git rev-parse', 'git ls-files',
  'git blame', 'git describe', 'git tag -l', 'git stash list', 'git config --get', 'git config -l', 'git config --list',
  'node --version', 'node -v', 'npm --version', 'npm -v', 'npm ls', 'npm list', 'npm view', 'npm outdated', 'pnpm --version',
  'yarn --version', 'python --version', 'python3 --version', 'pip list', 'pip show', 'pip --version', 'go version', 'go env',
  'cargo --version', 'rustc --version', 'java -version', 'dotnet --version', 'docker ps', 'docker images', 'where',
];

export function isReadOnlyCommand(cmd) {
  if (hasDangerousSyntax(cmd)) return false;
  return splitCommand(cmd).every((part) => {
    const words = part.split(/\s+/);
    const first = words[0];
    if (/^\w+=/.test(first)) return false; // env assignment prefix
    if (first === 'find') return !/\s-(exec|execdir|delete|ok|okdir|fprint|fls|fprintf)\b/.test(part);
    if (first === 'sort' && /\s-o\b/.test(part)) return false;
    if (SAFE_SIMPLE.has(first)) return true;
    return SAFE_PREFIXES.some((p) => part === p || part.startsWith(p + ' '));
  });
}

const ACCEPT_EDITS_COMMANDS = new Set(['mkdir', 'touch', 'mv', 'cp']);

function wildcardToRegex(pattern) {
  return new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's');
}

function bashRuleMatches(content, cmd) {
  if (content === null || content === '*') return true;
  if (content.endsWith(':*')) {
    const prefix = content.slice(0, -2).trim();
    return cmd === prefix || cmd.startsWith(prefix + ' ');
  }
  if (content.includes('*')) return wildcardToRegex(content).test(cmd);
  return cmd === content.trim();
}

function pathRuleMatches(content, file, root) {
  if (content === null) return true;
  let pattern = content;
  if (pattern.startsWith('~/')) pattern = path.join(os.homedir(), pattern.slice(2));
  else if (pattern.startsWith('//')) pattern = pattern.slice(1);
  const abs = path.isAbsolute(pattern);
  const target = (abs ? file : path.relative(root, file)).replace(/\\/g, '/');
  pattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!abs && target.startsWith('..')) return false;
  if (path.matchesGlob(target, pattern)) return true;
  // "src" should also match everything under src.
  return path.matchesGlob(target, pattern.replace(/\/$/, '') + '/**');
}

// Suggest reusable prefix rules for a bash command, e.g. ["npm run test"] for
// `cd app && npm run test -- --watch | tail`. Read-only parts (cd, ls, tail…) need no rule.
export function suggestBashPrefixes(cmd) {
  if (hasDangerousSyntax(cmd)) return [];
  const parts = splitCommand(cmd);
  const needing = parts.filter((p) => !isReadOnlyCommand(p));
  const prefixes = [...new Set(needing.map(commandPrefix))];
  return prefixes.length <= 3 ? prefixes : [];
}

export function suggestBashPrefix(cmd) {
  const prefixes = suggestBashPrefixes(cmd);
  return prefixes.length === 1 ? prefixes[0] : null;
}

// Prefix for one simple command: "npm run test" for "npm run test -- --watch".
function commandPrefix(part) {
  const words = part.split(/\s+/);
  const twoWord = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'kubectl', 'pip', 'pip3', 'poetry', 'uv', 'dotnet', 'mvn', 'gradle', 'make', 'npx', 'deno', 'gh', 'brew', 'apt', 'python', 'python3', 'node']);
  let n = 1;
  if (twoWord.has(words[0]) && words[1] && !words[1].startsWith('-')) n = 2;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(words[0]) && words[1] === 'run' && words[2]) n = 3;
  if ((words[0] === 'python' || words[0] === 'python3') && words[1] === '-m' && words[2]) n = 3;
  if ((words[0] === 'node' || words[0] === 'python' || words[0] === 'python3') && n === 2 && !words[1].includes('.')) n = 1;
  return words.slice(0, n).join(' ');
}

export class PermissionManager {
  constructor(config, { mode } = {}) {
    this.config = config;
    this.root = config.cwd;
    this.mode = mode || config.settings.defaultMode || 'default';
    if (!MODES.includes(this.mode)) this.mode = 'default';
    // Like Claude Code, bypass mode is only reachable via shift+tab when the session was
    // started with it (--dangerously-skip-permissions or "defaultMode": "bypassPermissions").
    this.bypassAvailable = this.mode === 'bypassPermissions';
    this.allow = [...config.settings.permissions.allow];
    this.deny = [...config.settings.permissions.deny];
    this.listeners = new Set();
    this.autoAllowDirs = []; // file edits inside these never ask (e.g. the auto-memory directory)
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return;
    if (mode === 'bypassPermissions') this.bypassAvailable = true;
    this.mode = mode;
    for (const l of this.listeners) l(mode);
  }

  cycleMode() {
    // shift+tab: default -> acceptEdits -> plan (-> bypassPermissions when enabled at startup)
    const cycle = ['default', 'acceptEdits', 'plan', ...(this.bypassAvailable ? ['bypassPermissions'] : [])];
    const i = cycle.indexOf(this.mode);
    this.setMode(cycle[(i + 1) % cycle.length]);
    return this.mode;
  }

  ruleMatches(rule, tool, input, ctx) {
    const r = typeof rule === 'string' ? parseRule(rule) : rule;
    if (!r) return false;
    const name = tool.name;
    if (r.tool.startsWith('mcp__')) {
      return name === r.tool || (r.content === null && name.startsWith(r.tool + '__'));
    }
    if (r.tool === 'Bash') return name === 'Bash' && bashRuleMatches(r.content, String(input.command || '').trim());
    if (r.tool === 'WebFetch') {
      if (name !== 'WebFetch') return false;
      if (r.content === null) return true;
      const m = /^domain:(.+)$/.exec(r.content);
      const host = tool.domain?.(input);
      return !!(m && host && (host === m[1] || host.endsWith('.' + m[1])));
    }
    const fileTools = { Edit: ['Edit', 'Write', 'NotebookEdit'], Write: ['Write'], Read: ['Read'] };
    if (fileTools[r.tool]) {
      if (!fileTools[r.tool].includes(name)) return false;
      const file = tool.filePath?.(input, ctx);
      return file ? pathRuleMatches(r.content, file, this.root) : r.content === null;
    }
    return r.tool === name && r.content === null;
  }

  // For Bash: every sub command must be covered by an allow rule (or be read-only).
  bashAllowed(input, ctx, tool) {
    const cmd = String(input.command || '').trim();
    if (this.allow.some((r) => { const p = parseRule(r); return p?.tool === 'Bash' && p.content !== null && !p.content.endsWith(':*') && !p.content.includes('*') && p.content.trim() === cmd; })) return true;
    if (hasDangerousSyntax(cmd)) return this.allow.some((r) => { const p = parseRule(r); return p?.tool === 'Bash' && p.content === null; });
    return splitCommand(cmd).every((part) => {
      if (isReadOnlyCommand(part)) return true;
      if (this.mode === 'acceptEdits' && ACCEPT_EDITS_COMMANDS.has(part.split(/\s+/)[0])) return true;
      return this.allow.some((r) => this.ruleMatches(r, tool, { command: part }, ctx));
    });
  }

  // Returns {behavior: 'allow'|'deny'|'ask', message?}
  check(tool, input, ctx) {
    const cmdParts = tool.name === 'Bash' ? splitCommand(String(input.command || '')) : null;
    const denied = this.deny.find((r) => (cmdParts
      ? cmdParts.some((part) => this.ruleMatches(r, tool, { command: part }, ctx)) || this.ruleMatches(r, tool, input, ctx)
      : this.ruleMatches(r, tool, input, ctx)));
    if (denied) return { behavior: 'deny', message: `Permission to use ${tool.name} has been denied by the rule "${denied}".` };

    if (this.mode === 'plan' && !tool.readOnly) {
      if (tool.name === 'Bash' && isReadOnlyCommand(String(input.command || ''))) return { behavior: 'allow' };
      return { behavior: 'deny', message: 'Plan mode is active: you must not make changes or run non-read-only tools. Continue researching, then present your plan with ExitPlanMode.' };
    }
    if (this.mode === 'bypassPermissions') return { behavior: 'allow' };

    if (tool.name === 'Bash') return this.bashAllowed(input, ctx, tool) ? { behavior: 'allow' } : { behavior: 'ask' };
    if (this.allow.some((r) => this.ruleMatches(r, tool, input, ctx))) return { behavior: 'allow' };
    if (tool.editsFiles) {
      const file = tool.filePath?.(input, ctx);
      if (file && this.autoAllowDirs.some((d) => isInside(file, d))) return { behavior: 'allow' };
      if (this.mode === 'acceptEdits' && file && isInside(file, this.root)) return { behavior: 'allow' };
      return { behavior: 'ask' };
    }
    if (tool.askByDefault) return { behavior: 'ask' };
    if (tool.readOnly) return { behavior: 'allow' };
    return { behavior: 'ask' };
  }

  // Options offered in the permission dialog: the "don't ask again" rule for this call.
  suggestion(tool, input) {
    if (tool.name === 'Bash') {
      const prefixes = suggestBashPrefixes(String(input.command || '').trim());
      if (!prefixes.length) return null;
      const names = prefixes.map((p) => `${p}:*`).join(', ');
      return { rules: prefixes.map((p) => `Bash(${p}:*)`), label: `Yes, and don't ask again for ${names} commands in ${this.root}` };
    }
    if (tool.editsFiles) return { mode: 'acceptEdits', label: 'Yes, allow all edits during this session (shift+tab)' };
    if (tool.name === 'WebFetch') {
      const host = tool.domain?.(input);
      return host ? { rules: [`WebFetch(domain:${host})`], label: `Yes, and don't ask again for ${host}` } : null;
    }
    return { rules: [tool.name], label: `Yes, and don't ask again for ${tool.name} in ${this.root}` };
  }

  addRule(rule, { persist = true } = {}) {
    if (!this.allow.includes(rule)) this.allow.push(rule);
    if (!persist) return;
    const file = settingsFiles(this.root).local;
    updateSettingsFile(file, (json) => {
      json.permissions = json.permissions || {};
      json.permissions.allow = json.permissions.allow || [];
      if (!json.permissions.allow.includes(rule)) json.permissions.allow.push(rule);
    });
  }
}
