// Session mode. There are no permission prompts or rules: every tool call runs right away.
// The only switch is plan mode, an opt-in read-only phase for investigating and proposing a
// plan before changing anything (shift+tab or --plan turns it on; ExitPlanMode turns it off).

export const MODES = ['full', 'plan'];

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

// Syntax we can't classify: command substitution, redirection to files, etc.
function hasUnclassifiableSyntax(cmd) {
  const s = stripQuotedStrings(cmd);
  if (/\$\(|`|<\(|>\(/.test(s)) return true;
  // Redirections other than to /dev/null or fd duplication.
  const redir = s.replace(/\d?>&\d/g, '').replace(/&?>>?\s*\/dev\/null/g, '').replace(/\d?>>?\s*\/dev\/null/g, '');
  return /[<>]/.test(redir);
}

const READ_ONLY_SIMPLE = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'which', 'whoami', 'date', 'tree', 'file', 'stat', 'du', 'df',
  'uname', 'hostname', 'printenv', 'type', 'realpath', 'basename', 'dirname', 'sort', 'uniq', 'cut', 'tr', 'diff',
  'grep', 'egrep', 'fgrep', 'rg', 'true', 'false', 'test', 'nproc', 'id', 'cd', 'less', 'more', 'column', 'jq', 'md5sum', 'sha256sum',
]);
const READ_ONLY_PREFIXES = [
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git remote -v', 'git rev-parse', 'git ls-files',
  'git blame', 'git describe', 'git tag -l', 'git stash list', 'git config --get', 'git config -l', 'git config --list',
  'node --version', 'node -v', 'npm --version', 'npm -v', 'npm ls', 'npm list', 'npm view', 'npm outdated', 'pnpm --version',
  'yarn --version', 'python --version', 'python3 --version', 'pip list', 'pip show', 'pip --version', 'go version', 'go env',
  'cargo --version', 'rustc --version', 'java -version', 'dotnet --version', 'docker ps', 'docker images', 'where',
];

// True when every part of the command only reads (used to let research commands run in plan mode).
export function isReadOnlyCommand(cmd) {
  if (hasUnclassifiableSyntax(cmd)) return false;
  return splitCommand(cmd).every((part) => {
    const words = part.split(/\s+/);
    const first = words[0];
    if (/^\w+=/.test(first)) return false; // env assignment prefix
    if (first === 'find') return !/\s-(exec|execdir|delete|ok|okdir|fprint|fls|fprintf)\b/.test(part);
    if (first === 'sort' && /\s-o\b/.test(part)) return false;
    if (READ_ONLY_SIMPLE.has(first)) return true;
    return READ_ONLY_PREFIXES.some((p) => part === p || part.startsWith(p + ' '));
  });
}

export class ModeManager {
  constructor(mode = 'full') {
    this.mode = MODES.includes(mode) ? mode : 'full';
    this.listeners = new Set();
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return;
    this.mode = mode;
    for (const l of this.listeners) l(mode);
  }

  toggle() {
    this.setMode(this.mode === 'plan' ? 'full' : 'plan');
    return this.mode;
  }

  // {behavior: 'allow'} or, in plan mode for anything that changes state, {behavior: 'deny', message}.
  check(tool, input = {}) {
    if (this.mode !== 'plan' || tool.readOnly) return { behavior: 'allow' };
    if (tool.name === 'Bash' && isReadOnlyCommand(String(input.command || ''))) return { behavior: 'allow' };
    return { behavior: 'deny', message: 'Plan mode is active: do not make changes or run commands that modify anything yet. Keep researching with read-only tools, then present your plan with ExitPlanMode.' };
  }
}
