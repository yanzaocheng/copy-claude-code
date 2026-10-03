#!/usr/bin/env node
// claude-pro: launches the official `claude` CLI so it authenticates with the local
// subscription login (`claude /login`), with this project's "pro" defaults on top:
//   - permission prompts off (--dangerously-skip-permissions), unless --safe is given
//   - an extra system prompt for autonomous, verify-before-done engineering work
//   - third-party endpoint settings (ANTHROPIC_BASE_URL / keys / model overrides) are removed
//     from the child environment so the CLI uses its own login instead (--keep-env to opt out)
// Everything else is passed straight through to `claude`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRO_SYSTEM_PROMPT } from '../src/pro-prompt.js';

const isWin = process.platform === 'win32';
const self = fs.realpathSync(fileURLToPath(import.meta.url));

const HELP = `Usage: claude-pro [claude-pro options] [claude options] [prompt]

Runs the official \`claude\` CLI with local subscription authentication and pro defaults.

claude-pro options:
  --safe        Keep the normal permission prompts (do not add --dangerously-skip-permissions)
  --keep-env    Do not remove ANTHROPIC_* endpoint/key/model variables from the environment
  --no-prompt   Do not append the pro system prompt
  --which       Print the claude executable that would be used and exit
  --pro-help    Show this help

All other arguments are forwarded to \`claude\` unchanged (see \`claude --help\`).
Extra instructions can be put in ${path.join(os.homedir(), '.ccc', 'claude-pro.md')}; they are appended to the system prompt.
`;

// Locate the real claude executable, skipping this script if it shows up on PATH.
function findClaude() {
  if (process.env.CLAUDE_PRO_BIN && fs.existsSync(process.env.CLAUDE_PRO_BIN)) return process.env.CLAUDE_PRO_BIN;
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
      if (fs.existsSync(exe)) return exe;
      return candidate;
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

const own = new Set(['--safe', '--keep-env', '--no-prompt', '--which', '--pro-help']);
const argv = process.argv.slice(2);
const opts = new Set(argv.filter((a) => own.has(a)));
const passthrough = argv.filter((a) => !own.has(a));

if (opts.has('--pro-help')) { process.stdout.write(HELP); process.exit(0); }

const claude = findClaude();
if (!claude) {
  process.stderr.write('claude-pro: could not find the `claude` CLI on PATH. Install it (npm i -g @anthropic-ai/claude-code) and log in with `claude`, or set CLAUDE_PRO_BIN.\n');
  process.exit(127);
}
if (opts.has('--which')) { process.stdout.write(claude + '\n'); process.exit(0); }

const has = (...flags) => passthrough.some((a) => flags.some((f) => a === f || a.startsWith(f + '=')));
const args = [];
if (!opts.has('--safe') && !has('--permission-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions')) {
  args.push('--dangerously-skip-permissions');
}
if (!opts.has('--no-prompt') && !has('--system-prompt', '--append-system-prompt')) {
  let prompt = PRO_SYSTEM_PROMPT;
  try {
    const extra = fs.readFileSync(path.join(os.homedir(), '.ccc', 'claude-pro.md'), 'utf8').trim();
    if (extra) prompt += `\n\n# User instructions for claude-pro\n${extra}`;
  } catch { /* optional */ }
  args.push('--append-system-prompt', prompt);
}
args.push(...passthrough);

const env = { ...process.env };
if (!opts.has('--keep-env')) {
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|SMALL_FAST_MODEL|DEFAULT_\w+_MODEL|CUSTOM_HEADERS)|CLAUDE_CODE_SUBAGENT_MODEL)$/.test(k)) delete env[k];
  }
}

const child = /\.(cmd|bat)$/i.test(claude)
  ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[claude, ...args].map(quoteWinArg).join(' ')}"`], { stdio: 'inherit', env, windowsVerbatimArguments: true })
  : spawn(claude, args, { stdio: 'inherit', env });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { /* the child handles Ctrl-C itself */ });
child.on('error', (e) => { process.stderr.write(`claude-pro: failed to start claude: ${e.message}\n`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
