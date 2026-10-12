// Sub-agent definitions: built-ins plus custom agents from markdown files with
// frontmatter (same format as Claude Code's .claude/agents/*.md).

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const READ_ONLY_TOOLS = ['Glob', 'Grep', 'Read', 'Bash', 'WebFetch', 'WebSearch', 'BashOutput'];
// The effort levels a Task call or an agent definition may ask for (as Claude Code's Agent tool takes them).
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const BUILTIN_AGENTS = [
  {
    name: 'general-purpose',
    description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.',
    tools: '*',
    prompt: 'You are an agent for a command line coding assistant. Given the user\'s message, use the tools available to complete the task. Do what has been asked; nothing more, nothing less. When you complete the task, respond with a detailed writeup.\n\nStrengths: searching for code and configuration across large codebases, analyzing multiple files to understand architecture, investigating complex questions, performing multi-step research.\n\nGuidelines: for file searches use Grep or Glob; start broad and narrow down; be thorough, check multiple locations and naming conventions. Create files whenever the task needs them (code, tests, scripts), but prefer editing an existing file when that is the natural place for a change, and do not create documentation files unless asked.',
  },
  {
    name: 'Explore',
    description: 'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick", "medium", or "very thorough".',
    tools: READ_ONLY_TOOLS,
    prompt: 'You are a file search specialist. You excel at thoroughly navigating and exploring codebases.\n\nThis is a READ-ONLY exploration task. You must not create, modify or delete files, and must only run Bash commands that change nothing (such as ls, find, git status, git log, git diff, git show, git blame, or a script that only prints).\n\nUse Glob for broad file pattern matching, Grep for searching file contents with regex, and Read when you know the specific file path. Adapt your search approach to the thoroughness level specified by the caller. Make parallel tool calls wherever possible. Return file paths as absolute paths and report your findings clearly.',
  },
  {
    name: 'Plan',
    description: 'Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.',
    tools: READ_ONLY_TOOLS,
    prompt: 'You are a software architect and planning specialist. Explore the codebase with read-only tools and design an implementation plan.\n\nThis is a READ-ONLY task: do not create, modify or delete files, and only run read-only Bash commands.\n\nProcess: understand the requirements; explore thoroughly (existing patterns, similar features, architecture); design the solution with trade-offs; detail the plan step by step with sequencing and dependencies. End your response with a "Critical Files for Implementation" list of 3-5 files, with a brief reason for each.',
  },
];

function unquote(value) {
  const m = /^(["'])([\s\S]*)\1$/.exec(value);
  if (!m) return value;
  // Only a double-quoted YAML string has escapes; agent descriptions often hold "\n" for line breaks.
  return m[1] === '"' ? m[2].replace(/\\(n|"|\\)/g, (all, c) => (c === 'n' ? '\n' : c)) : m[2];
}

// Frontmatter as Claude Code agent, skill and command files write it: `key: value` lines, where the
// value may be quoted, continue on indented lines, be a block scalar (`|` or `>`) or a list (`[a, b]`
// or `- a` lines). A byte order mark, which Windows editors like to add, is ignored.
export function parseFrontmatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    const block = /^([|>])[+-]?$/.exec(value);
    if (block || value === '') {
      // The indented lines after `key: |` (or after a bare `key:`) belong to the value.
      const parts = [];
      while (i + 1 < lines.length && !/^[\w-]+\s*:/.test(lines[i + 1])) parts.push(lines[++i].trim());
      const items = parts.filter(Boolean);
      value = items.length && items.every((p) => /^-\s+/.test(p))
        ? items.map((p) => p.replace(/^-\s+/, '')).join(', ')
        : items.join(block && block[1] === '|' ? '\n' : ' ');
    } else {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) value += ` ${lines[++i].trim()}`;
    }
    meta[kv[1]] = unquote(value);
  }
  return { meta, body: (m[2] || '').trim() };
}

// "Read, Grep", "[Read, Grep]" and "- Read" lists all give ['Read', 'Grep'].
function toolList(value) {
  return String(value).replace(/^\[|\]$/g, '').split(/\s*,\s*/).map((t) => unquote(t.trim())).filter(Boolean);
}

export function loadAgents(cwd) {
  const agents = new Map(BUILTIN_AGENTS.map((a) => [a.name, { ...a, source: 'built-in' }]));
  const dirs = [
    path.join(CONFIG_DIR, 'agents'),
    path.join(cwd, '.claude', 'agents'),
    path.join(cwd, '.claude-pro', 'agents'),
  ];
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of entries) {
      try {
        const parsed = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!parsed?.meta.name || !parsed.meta.description) continue;
        const window = parseInt(parsed.meta.autoCompactWindow, 10);
        agents.set(parsed.meta.name, {
          name: parsed.meta.name,
          description: parsed.meta.description,
          tools: parsed.meta.tools ? toolList(parsed.meta.tools) : '*',
          model: parsed.meta.model && parsed.meta.model !== 'inherit' ? parsed.meta.model : null,
          effort: EFFORTS.includes(parsed.meta.effort?.toLowerCase()) ? parsed.meta.effort.toLowerCase() : null,
          autoCompactWindow: window > 0 ? window : 0,
          prompt: parsed.body,
          source: path.join(dir, f),
        });
      } catch { /* skip malformed */ }
    }
  }
  return agents;
}

// Skills: <root>/skills/<name>/SKILL.md with frontmatter (name, description), the same layout as
// Claude Code skills. Later roots win: user skills, then project skills.
export function loadSkills(cwd) {
  const skills = new Map();
  const roots = [
    [path.join(CONFIG_DIR, 'skills'), 'user'],
    [path.join(cwd, '.claude', 'skills'), 'project'],
    [path.join(cwd, '.claude-pro', 'skills'), 'project'],
  ];
  for (const [root, scope] of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
    for (const d of dirs) {
      const dir = path.join(root, d.name);
      const file = path.join(dir, 'SKILL.md');
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const parsed = parseFrontmatter(text);
      const body = (parsed ? parsed.body : text.replace(/^\uFEFF/, '')).trim();
      const name = (parsed?.meta.name || d.name).trim();
      if (!body || !/^[\w.:-]+$/.test(name)) continue;
      const description = parsed?.meta.description || body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 160) || name;
      skills.set(name, { name, description, body, dir, scope, file });
    }
  }
  return skills;
}

// The text a skill expands to: its instructions with $ARGUMENTS filled in.
export function renderSkill(skill, args = '') {
  // A function, not a string: in a replacement string `$&` and `$$` in the arguments would be expanded.
  let body = skill.body.replace(/\$ARGUMENTS/g, () => args);
  if (args && !skill.body.includes('$ARGUMENTS')) body += `\n\nARGUMENTS: ${args}`;
  return `Base directory for this skill: ${skill.dir}\n\n${body}`;
}

// The text a custom command expands to: $ARGUMENTS and $1..$9 filled in. One pass with a function, so
// what the arguments contain (`$1`, `$&`, `$$`) is neither interpreted nor expanded a second time.
export function expandCommandBody(body, args = '') {
  const argv = args.split(/\s+/).filter(Boolean);
  let out = body.replace(/\$ARGUMENTS|\$(\d)/g, (m, n) => (n === undefined ? args : (argv[+n - 1] ?? '')));
  if (!body.includes('$ARGUMENTS') && args) out += `\n\nARGUMENTS: ${args}`;
  return out;
}

// !`command` in a command file is replaced by what `command` prints (run(command) -> text).
export async function expandShellEmbeds(body, run) {
  let out = body;
  for (const m of [...body.matchAll(/!`([^`]+)`/g)]) {
    const output = await run(m[1]);
    out = out.replace(m[0], () => output); // a function: the output may contain `$&` or `$$` (shell scripts do)
  }
  return out;
}

// Custom slash commands: .claude/commands/*.md, .claude-pro/commands/*.md, ~/.claude-pro/commands/*.md
export function loadCustomCommands(cwd) {
  const commands = new Map();
  const dirs = [
    [path.join(CONFIG_DIR, 'commands'), 'user'],
    [path.join(cwd, '.claude', 'commands'), 'project'],
    [path.join(cwd, '.claude-pro', 'commands'), 'project'],
  ];
  const walk = (dir, prefix, scope) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { walk(path.join(dir, e.name), `${prefix}${e.name}:`, scope); continue; }
      if (!e.name.endsWith('.md')) continue;
      const file = path.join(dir, e.name);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; } // a broken link or a locked file must not stop the others
      const parsed = parseFrontmatter(text);
      const body = parsed ? parsed.body : text.replace(/^\uFEFF/, '');
      const name = prefix + e.name.slice(0, -3);
      commands.set(name, {
        name,
        description: parsed?.meta.description || body.split('\n').find((l) => l.trim())?.slice(0, 80) || `(${scope})`,
        argumentHint: parsed?.meta['argument-hint'] || '',
        body,
        scope,
      });
    }
  };
  for (const [dir, scope] of dirs) walk(dir, '', scope);
  return commands;
}
