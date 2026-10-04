// claude-pro: launches the official `claude` CLI so it authenticates with the local
// subscription login (`claude` → /login), with "pro" defaults on top:
//   - permission prompts off (--dangerously-skip-permissions), unless --safe is given
//   - an extra system prompt for autonomous, verify-before-done engineering work
//   - third-party endpoint settings (ANTHROPIC_BASE_URL / keys / model overrides) are removed
//     from the child environment so the CLI uses its own login (--keep-env to opt out)
// Everything else is passed straight through to `claude`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PRO_SYSTEM_PROMPT } from './pro-prompt.js';

const isWin = process.platform === 'win32';

export const USER_PROMPT_FILE = path.join(os.homedir(), '.claude-pro.md');

export const HELP = `Usage: claude-pro [claude-pro options] [claude options] [prompt]

Runs the official \`claude\` CLI with local subscription authentication and pro defaults.

claude-pro options:
  --safe        Keep the normal permission prompts (do not add --dangerously-skip-permissions)
  --keep-env    Do not remove ANTHROPIC_* endpoint/key/model variables from the environment
  --no-prompt   Do not append the pro system prompt
  --which       Print the claude executable that would be used and exit
  --pro-help    Show this help

All other arguments are forwarded to \`claude\` unchanged (see \`claude --help\`).
Personal instructions in ${USER_PROMPT_FILE} are appended to the system prompt.
`;

const OWN_FLAGS = new Set(['--safe', '--keep-env', '--no-prompt', '--which', '--pro-help']);
const STRIPPED_ENV = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|SMALL_FAST_MODEL|DEFAULT_\w+_MODEL|CUSTOM_HEADERS)|CLAUDE_CODE_SUBAGENT_MODEL)$/;

// Split argv into claude-pro's own flags and the arguments forwarded to claude.
export function parseArgs(argv) {
  return { opts: new Set(argv.filter((a) => OWN_FLAGS.has(a))), passthrough: argv.filter((a) => !OWN_FLAGS.has(a)) };
}

// Arguments for claude: pro defaults first, unless the user already chose those settings.
export function buildArgs(passthrough, opts, { extraPrompt = '' } = {}) {
  const has = (...flags) => passthrough.some((a) => flags.some((f) => a === f || a.startsWith(f + '=')));
  const args = [];
  if (!opts.has('--safe') && !has('--permission-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions')) {
    args.push('--dangerously-skip-permissions');
  }
  if (!opts.has('--no-prompt') && !has('--system-prompt', '--append-system-prompt')) {
    const extra = extraPrompt.trim();
    args.push('--append-system-prompt', extra ? `${PRO_SYSTEM_PROMPT}\n\n# User instructions for claude-pro\n${extra}` : PRO_SYSTEM_PROMPT);
  }
  return [...args, ...passthrough];
}

// Environment for claude: drop third-party endpoint/key/model overrides so it uses its own login.
export function cleanEnv(env, { keep = false } = {}) {
  if (keep) return { ...env };
  return Object.fromEntries(Object.entries(env).filter(([k]) => !STRIPPED_ENV.test(k)));
}

export function readUserPrompt(file = USER_PROMPT_FILE) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// Locate the real claude executable, skipping claude-pro itself if it shows up on PATH.
export function findClaude({ self, env = process.env } = {}) {
  if (env.CLAUDE_PRO_BIN && fs.existsSync(env.CLAUDE_PRO_BIN)) return env.CLAUDE_PRO_BIN;
  const finder = isWin ? ['where', ['claude']] : ['which', ['-a', 'claude']];
  const r = spawnSync(finder[0], finder[1], { encoding: 'utf8', windowsHide: true });
  const found = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const candidate of found) {
    let real;
    try { real = fs.realpathSync(candidate); } catch { continue; }
    if (real === self || path.basename(real).startsWith('claude-pro')) continue;
    if (isWin && /\.cmd$/i.test(candidate)) {
      // npm shim: ...\claude.cmd -> ...\node_modules\@anthropic-ai\claude-code\bin\claude.exe
      const exe = path.join(path.dirname(candidate), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      return fs.existsSync(exe) ? exe : candidate;
    }
    if (isWin && !/\.(exe|cmd|bat)$/i.test(candidate)) continue;
    return candidate;
  }
  return null;
}

function quoteWinArg(a) {
  if (a === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

export function main(argv, { self } = {}) {
  const { opts, passthrough } = parseArgs(argv);
  if (opts.has('--pro-help')) { process.stdout.write(HELP); process.exit(0); }

  const claude = findClaude({ self });
  if (!claude) {
    process.stderr.write('claude-pro: could not find the `claude` CLI on PATH. Install it (npm i -g @anthropic-ai/claude-code) and log in by running `claude`, or set CLAUDE_PRO_BIN.\n');
    process.exit(127);
  }
  if (opts.has('--which')) { process.stdout.write(claude + '\n'); process.exit(0); }

  const args = buildArgs(passthrough, opts, { extraPrompt: readUserPrompt() });
  const env = cleanEnv(process.env, { keep: opts.has('--keep-env') });
  const child = /\.(cmd|bat)$/i.test(claude)
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[claude, ...args].map(quoteWinArg).join(' ')}"`], { stdio: 'inherit', env, windowsVerbatimArguments: true })
    : spawn(claude, args, { stdio: 'inherit', env });

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { /* the child handles Ctrl-C itself */ });
  child.on('error', (e) => { process.stderr.write(`claude-pro: failed to start claude: ${e.message}\n`); process.exit(1); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
