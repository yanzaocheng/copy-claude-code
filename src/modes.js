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

// Commands that read only, whatever their arguments (the ones whose arguments can make them write or run
// something have their own check in COMMAND_CHECKS below). No pagers: `less +!cmd` runs a command.
const READ_ONLY_SIMPLE = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'which', 'whoami', 'stat', 'du', 'df',
  'uname', 'printenv', 'type', 'realpath', 'basename', 'dirname', 'cut', 'tr', 'diff',
  'grep', 'egrep', 'fgrep', 'true', 'false', 'test', 'nproc', 'id', 'cd', 'column', 'jq', 'md5sum', 'sha256sum',
]);
const READ_ONLY_PREFIXES = [
  'git status', 'git rev-parse', 'git ls-files', 'git blame', 'git describe', 'git stash list',
  'git config --get', 'git config -l', 'git config --list',
  'node --version', 'node -v', 'npm --version', 'npm -v', 'npm ls', 'npm list', 'npm view', 'npm outdated', 'pnpm --version',
  'yarn --version', 'python --version', 'python3 --version', 'pip list', 'pip show', 'pip --version', 'go version',
  'cargo --version', 'rustc --version', 'java -version', 'dotnet --version', 'docker ps', 'docker images', 'where',
];

// `git branch` only lists with these flags; a name, -d/-D, -m/-M, -c/-C, -u ... would create, delete or rename.
const GIT_BRANCH_FLAGS = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '-l', '--list', '--show-current', '--no-color', '--color', '--no-column', '--column']);
const GIT_BRANCH_VALUE_FLAGS = /^--(?:contains|no-contains|merged|no-merged|points-at|sort|format|abbrev)(?:=.*)?$/;
function gitBranchReads(args) {
  let listing = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (GIT_BRANCH_FLAGS.has(a)) { if (a === '-l' || a === '--list') listing = true; continue; }
    if (GIT_BRANCH_VALUE_FLAGS.test(a)) { if (!a.includes('=') && !/^--abbrev$/.test(a)) i++; continue; }
    if (listing && !a.startsWith('-')) continue; // a pattern to list
    return false;
  }
  return true;
}

// `git tag` likewise: listing is fine, anything that makes or removes a tag is not.
function gitTagReads(args) {
  if (!args.some((a) => a === '-l' || a === '--list')) return false;
  return args.every((a) => !a.startsWith('-') || /^(?:-l|--list|-n\d*|--sort=.*|--column|--no-column|--contains|--no-contains|--merged|--no-merged|--points-at|--format=.*|--color|--no-color)$/.test(a));
}

const positional = (args) => args.filter((a) => !a.startsWith('-') && !a.startsWith('+'));

// Commands that are read-only only with certain arguments: args => true when this call reads only.
const COMMAND_CHECKS = {
  // -exec and -delete run or remove things, -fprint* and -fls write files
  find: (args) => !args.some((a) => /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(a)),
  // -o FILE and --output FILE (GNU getopt accepts any unambiguous prefix of it)
  sort: (args) => !args.some((a) => /^-[a-zA-Z]*o/.test(a) || /^--o/.test(a)),
  // `uniq INPUT OUTPUT` writes OUTPUT
  uniq: (args) => positional(args).length <= 1,
  tree: (args) => !args.some((a) => /^-[a-zA-Z]*o/.test(a) || /^--output/.test(a)),
  // setting the clock or the host name changes the machine
  date: (args) => !args.some((a) => /^-[a-zA-Z]*s/.test(a) || /^--set/.test(a)) && positional(args).length === 0,
  hostname: (args) => args.length === 0 || args.every((a) => /^(?:-[fsiIdAy]|--(?:fqdn|short|ip-address|domain|all-ip-addresses))$/.test(a)),
  // --pre runs a command on every file
  rg: (args) => !args.some((a) => /^--(?:pre|hostname-bin)(?:=|$)/.test(a)),
  file: (args) => !args.some((a) => /^-[a-zA-Z]*C/.test(a) || a === '--compile'),
  // `git log --output=FILE` and friends write the result to a file
  git: (args, part) => {
    const sub = args.find((a) => !a.startsWith('-'));
    const rest = args.slice(args.indexOf(sub) + 1);
    if (args[0] !== sub) return null; // options before the subcommand (-C dir, -c key=value): not classified
    if (sub === 'diff' || sub === 'log' || sub === 'show') return !rest.some((a) => /^--output(?:=|$)/.test(a));
    if (sub === 'branch') return gitBranchReads(rest);
    if (sub === 'tag') return gitTagReads(rest);
    if (sub === 'remote') return part === 'git remote' || part === 'git remote -v';
    return null;
  },
  // `go env -w` and `-u` change the Go settings
  go: (args) => (args[0] === 'env' ? !args.some((a) => a === '-w' || a === '-u') : args[0] === 'version'),
};

// True when every part of the command only reads (used to let research commands run in plan mode).
export function isReadOnlyCommand(cmd) {
  if (hasUnclassifiableSyntax(cmd)) return false;
  return splitCommand(cmd).every((part) => {
    const words = part.split(/\s+/);
    const first = words[0];
    if (/^\w+=/.test(first)) return false; // env assignment prefix
    // hasOwn: a command called `constructor` or `toString` must not find a function on the prototype.
    if (Object.hasOwn(COMMAND_CHECKS, first)) {
      const verdict = COMMAND_CHECKS[first](words.slice(1), part);
      if (verdict !== null) return verdict;
    }
    if (READ_ONLY_SIMPLE.has(first)) return true;
    // A command that has an argument check is only ever read-only through that check, except where it
    // is also in the simple list (above); the rest is matched by prefix.
    return READ_ONLY_PREFIXES.some((p) => part === p || part.startsWith(`${p} `));
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
