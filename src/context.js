// Gathers the environment context that goes into the system prompt: platform, git
// status and memory files (CLAUDE.md / AGENTS.md), like Claude Code.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './utils/shell.js';
import { CONFIG_DIR } from './config.js';

export function gitInfo(cwd) {
  const inside = run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (inside !== 'true') return null;
  const branch = run('git', ['branch', '--show-current'], { cwd }) || '(detached)';
  let main = null;
  for (const b of ['main', 'master']) if (run('git', ['rev-parse', '--verify', '--quiet', b], { cwd }) !== null) { main = b; break; }
  // quotepath=false: file names with non-ASCII characters (Chinese ones) are shown as they are, not as "\344\275\240".
  // null: git status failed or took too long (a huge tree), which is not a clean one
  let status = run('git', ['-c', 'core.quotepath=false', 'status', '--short'], { cwd, maxBuffer: 64 * 1024 * 1024 });
  const statusLines = status ? status.split('\n') : [];
  if (statusLines.length > 40) status = statusLines.slice(0, 40).join('\n') + `\n... (${statusLines.length - 40} more lines, run "git status" for the rest)`;
  const log = run('git', ['log', '--oneline', '-n', '5'], { cwd }) || '';
  const user = run('git', ['config', 'user.name'], { cwd });
  return { branch, main, status, log, user };
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

export function projectMemoryFile(cwd) {
  return path.join(cwd, 'CLAUDE.md');
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
