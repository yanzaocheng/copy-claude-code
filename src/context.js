// Gathers the environment context that goes into the system prompt: platform, git
// status and memory files (CLAUDE.md / AGENTS.md), like Claude Code.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, runText } from './utils/shell.js';
import { CONFIG_DIR } from './config.js';

// The git facts of the system prompt, or null outside a git repository. Four commands give them all (status -b
// names the branch too); seven ran one after another before, about 55 ms each on Windows, blocking the program for
// 400 ms at each start, /clear and compaction. gitInfoAsync runs them at once without blocking (75 ms).
// quotepath=false: file names with non-ASCII characters (Chinese ones) are shown as they are, not as "\344\275\240".
const GIT_STATUS = ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-b'];
const GIT_MAIN = ['for-each-ref', '--format=%(refname:short)', 'refs/heads/main', 'refs/heads/master'];
const GIT_LOG = ['log', '--oneline', '-n', '5'];
const GIT_USER = ['config', 'user.name'];
const GIT_STATUS_MAX = 64 * 1024 * 1024;

export function gitInfo(cwd) {
  const status = run('git', GIT_STATUS, { cwd, maxBuffer: GIT_STATUS_MAX });
  if (status === null && run('git', ['rev-parse', '--is-inside-work-tree'], { cwd }) !== 'true') return null;
  const branch = status === null ? run('git', ['branch', '--show-current'], { cwd }) : null;
  return gitFacts(status, run('git', GIT_MAIN, { cwd }), run('git', GIT_LOG, { cwd }), run('git', GIT_USER, { cwd }), branch);
}

export async function gitInfoAsync(cwd) {
  const [status, main, log, user] = await Promise.all([GIT_STATUS, GIT_MAIN, GIT_LOG, GIT_USER].map((args) => runText('git', args, { cwd, maxChars: GIT_STATUS_MAX })));
  if (status === null && (await runText('git', ['rev-parse', '--is-inside-work-tree'], { cwd })) !== 'true') return null;
  const branch = status === null ? await runText('git', ['branch', '--show-current'], { cwd }) : null;
  return gitFacts(status, main, log, user, branch);
}

// `statusOut`: git status -b's output, null when it failed or took too long (a huge tree), which is not a clean
// tree (status null). `branch`: the branch when status gave none.
function gitFacts(statusOut, mainOut, log, user, branch) {
  let status = null;
  if (statusOut !== null) {
    const lines = statusOut.split('\n');
    const head = lines[0]?.startsWith('## ') ? lines.shift().slice(3) : '';
    // "main...origin/main [ahead 1]", "main", "No commits yet on main", "HEAD (no branch)"
    branch = /^HEAD \(no branch\)/.test(head) ? '' : /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.| \[|$)/.exec(head)?.[1] ?? '';
    const changes = lines.filter((l) => l.trim());
    status = changes.length > 40 ? changes.slice(0, 40).join('\n') + `\n... (${changes.length - 40} more lines, run "git status" for the rest)` : changes.join('\n');
  }
  const refs = (mainOut || '').split('\n').map((s) => s.trim());
  const main = refs.includes('main') ? 'main' : refs.includes('master') ? 'master' : null;
  return { branch: branch || '(detached)', main, status, log: log || '', user };
}

// Memory files, lowest priority first: user memory, then project files from the
// filesystem root down to cwd, then local (untracked) files.
export function memoryFiles(cwd) {
  const files = [];
  const add = (file, scope) => {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) files.push({ file, scope, text });
    } catch { /* missing */ }
  };
  add(path.join(CONFIG_DIR, 'CLAUDE.md'), 'user');
  const dirs = [];
  let dir = path.resolve(cwd);
  for (;;) {
    dirs.unshift(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of dirs) {
    if (d === os.homedir()) continue; // home is covered by the user memory
    const before = files.length;
    add(path.join(d, 'CLAUDE.md'), 'project');
    add(path.join(d, '.claude', 'CLAUDE.md'), 'project');
    // As in Claude Code, AGENTS.md stands in for a missing CLAUDE.md: where both exist they are usually copies of
    // each other (one for Claude, one for Codex), and loading both would send the instructions twice.
    if (files.length === before) add(path.join(d, 'AGENTS.md'), 'project');
    add(path.join(d, 'CLAUDE.local.md'), 'local');
  }
  return files;
}

const MEMORY_INDEX_MAX_LINES = 200;

// The auto-memory index (MEMORY.md) that is loaded into every session's system prompt.
export function loadAutoMemoryIndex(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').trim(); } catch { return ''; }
  const lines = text.split(/\r?\n/);
  if (lines.length <= MEMORY_INDEX_MAX_LINES) return text;
  return `${lines.slice(0, MEMORY_INDEX_MAX_LINES).join('\n')}\n(… ${lines.length - MEMORY_INDEX_MAX_LINES} more lines not loaded; MEMORY.md should stay under ${MEMORY_INDEX_MAX_LINES} lines — consolidate it.)`;
}

// Memory files (excluding the index) in the auto-memory directory.
export function listAutoMemories(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md'); } catch { return []; }
}

// The date where the user is (YYYY-MM-DD). toISOString() would give the UTC date, which for someone in
// UTC+8 is yesterday's between midnight and 8 o'clock.
export function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The date and the git state that a conversation starts with. They are taken once and then reused, by the main
// agent's system prompt and by the sub-agents' alike: a prompt that changes with every `git status` (or at
// midnight) cannot be read from the prompt cache, and the git status is labelled as a snapshot anyway.
export function takeEnvSnapshot(cwd) {
  return { date: localDate(), git: gitInfo(cwd) };
}

export async function takeEnvSnapshotAsync(cwd) {
  return { date: localDate(), git: await gitInfoAsync(cwd) };
}

export function environmentBlock(cwd, { model, shellName, snapshot = null }) {
  const { date, git } = snapshot || takeEnvSnapshot(cwd);
  const lines = [
    '<env>',
    `Working directory: ${cwd}`,
    `Is directory a git repo: ${git ? 'Yes' : 'No'}`,
    `Platform: ${process.platform}`,
    `Shell: ${shellName}`,
    `OS Version: ${os.type()} ${os.release()}`,
    `Today's date: ${date}`,
    '</env>',
    `You are powered by the model ${model.id}.`,
  ];
  if (git) {
    lines.push('', 'gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.');
    lines.push(`Current branch: ${git.branch}`);
    // Not Claude Code's wording ("Main branch (you will usually use this for PRs)"): the CodeBuddy channel behind the
    // gateway refuses requests carrying that exact line (code 11128, shown as a 529 "overloaded") for its models.
    if (git.main) lines.push(`Main branch: ${git.main}`);
    if (git.user) lines.push(`Git user: ${git.user}`);
    const status = git.status === null ? '(unknown: git status failed or timed out; run it to see)' : git.status || '(clean)';
    lines.push('', `Status:\n${status}`, '', `Recent commits:\n${git.log || '(none)'}`);
  }
  return lines.join('\n');
}
