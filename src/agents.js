// Sub-agent definitions: built-ins plus custom agents from markdown files with
// frontmatter (same format as Claude Code's .claude/agents/*.md).

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const READ_ONLY_TOOLS = ['Glob', 'Grep', 'Read', 'Bash', 'WebFetch', 'WebSearch', 'BashOutput'];

export const BUILTIN_AGENTS = [
  {
    name: 'general-purpose',
    description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.',
    tools: '*',
    prompt: 'You are an agent for a command line coding assistant. Given the user\'s message, use the tools available to complete the task. Do what has been asked; nothing more, nothing less. When you complete the task, respond with a detailed writeup.\n\nStrengths: searching for code and configuration across large codebases, analyzing multiple files to understand architecture, investigating complex questions, performing multi-step research.\n\nGuidelines: for file searches use Grep or Glob; start broad and narrow down; be thorough, check multiple locations and naming conventions. NEVER create files unless absolutely necessary; ALWAYS prefer editing existing files. NEVER proactively create documentation files.',
  },
  {
    name: 'Explore',
    description: 'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick", "medium", or "very thorough".',
    tools: READ_ONLY_TOOLS,
    prompt: 'You are a file search specialist. You excel at thoroughly navigating and exploring codebases.\n\nThis is a READ-ONLY exploration task. You must not create, modify or delete files, and must only run read-only Bash commands (ls, git status, git log, git diff, find, cat, head, tail).\n\nUse Glob for broad file pattern matching, Grep for searching file contents with regex, and Read when you know the specific file path. Adapt your search approach to the thoroughness level specified by the caller. Make parallel tool calls wherever possible. Return file paths as absolute paths and report your findings clearly.',
  },
  {
    name: 'Plan',
    description: 'Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.',
    tools: READ_ONLY_TOOLS,
    prompt: 'You are a software architect and planning specialist. Explore the codebase with read-only tools and design an implementation plan.\n\nThis is a READ-ONLY task: do not create, modify or delete files, and only run read-only Bash commands.\n\nProcess: understand the requirements; explore thoroughly (existing patterns, similar features, architecture); design the solution with trade-offs; detail the plan step by step with sequencing and dependencies. End your response with a "Critical Files for Implementation" list of 3-5 files, with a brief reason for each.',
  },
];

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2].trim() };
}

export function loadAgents(cwd) {
  const agents = new Map(BUILTIN_AGENTS.map((a) => [a.name, { ...a, source: 'built-in' }]));
  const dirs = [
    path.join(CONFIG_DIR, 'agents'),
    path.join(cwd, '.claude', 'agents'),
    path.join(cwd, '.ccc', 'agents'),
  ];
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of entries) {
      try {
        const parsed = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!parsed?.meta.name || !parsed.meta.description) continue;
        agents.set(parsed.meta.name, {
          name: parsed.meta.name,
          description: parsed.meta.description,
          tools: parsed.meta.tools ? parsed.meta.tools.split(/\s*,\s*/).filter(Boolean) : '*',
          model: parsed.meta.model && parsed.meta.model !== 'inherit' ? parsed.meta.model : null,
          prompt: parsed.body,
          source: path.join(dir, f),
        });
      } catch { /* skip malformed */ }
    }
  }
  return agents;
}

// Custom slash commands: .claude/commands/*.md, .ccc/commands/*.md, ~/.ccc/commands/*.md
export function loadCustomCommands(cwd) {
  const commands = new Map();
  const dirs = [
    [path.join(CONFIG_DIR, 'commands'), 'user'],
    [path.join(cwd, '.claude', 'commands'), 'project'],
    [path.join(cwd, '.ccc', 'commands'), 'project'],
  ];
  const walk = (dir, prefix, scope) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { walk(path.join(dir, e.name), `${prefix}${e.name}:`, scope); continue; }
      if (!e.name.endsWith('.md')) continue;
      const file = path.join(dir, e.name);
      const text = fs.readFileSync(file, 'utf8');
      const parsed = parseFrontmatter(text);
      const body = parsed ? parsed.body : text;
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
