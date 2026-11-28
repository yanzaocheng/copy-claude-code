// Sub-agent definitions: built-ins plus custom agents from markdown files with
// frontmatter (same format as Claude Code's .claude/agents/*.md).

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { CLAUDE_EFFORTS } from './api.js';

const READ_ONLY_TOOLS = ['Glob', 'Grep', 'Read', 'Bash', 'WebFetch', 'WebSearch', 'BashOutput'];
// The effort levels a Task call or an agent definition may ask for (as Claude Code's Agent tool takes them): Claude's.
export const EFFORTS = CLAUDE_EFFORTS;

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
    readOnly: true, // its prompt forbids changes: no boundaries or project instructions in its system prompt
    prompt: 'You are a file search specialist. You excel at thoroughly navigating and exploring codebases.\n\nThis is a READ-ONLY exploration task. You must not create, modify or delete files, and must only run Bash commands that change nothing (such as ls, find, git status, git log, git diff, git show, git blame, or a script that only prints).\n\nUse Glob for broad file pattern matching, Grep for searching file contents with regex, and Read when you know the specific file path. Adapt your search approach to the thoroughness level specified by the caller. Make parallel tool calls wherever possible. Return file paths as absolute paths and report your findings clearly.',
  },
  {
    name: 'Plan',
    description: 'Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.',
    tools: READ_ONLY_TOOLS,
    readOnly: true,
    model: 'decision',
    prompt: 'You are a software architect and planning specialist. Explore the codebase with read-only tools and design an implementation plan.\n\nThis is a READ-ONLY task: do not create, modify or delete files, and only run read-only Bash commands.\n\nProcess: understand the requirements; explore thoroughly (existing patterns, similar features, architecture); design the solution with trade-offs; detail the plan step by step with sequencing and dependencies. End your response with a "Critical Files for Implementation" list of 3-5 files, with a brief reason for each.',
  },
];

// The agents of the decision model (settings: decisionModel), there only when the user set one: a stronger model than
// the session's decides the questions that are expensive to get wrong and reviews what was built, while the session's
// model does the work. They run in a fresh context, so their cost does not grow with the conversation (a consult
// that reads the whole conversation cost $1.7 to $3.5 in a 130k-290k context, 2026-11-28), and they read the code
// themselves. Their descriptions say when each is worth its cost: that is where the main agent reads the rule.
// Not readOnly: they get the project's instructions, which say what the project's constraints and conventions are.
export const DECISION_AGENTS = [
  {
    name: 'architect',
    description: 'Decides an architecture or design question from the code, in a fresh context. Use it at a decision that is expensive to get wrong or to undo and that you are not sure of: a data format, protocol, public interface or schema, a framework or dependency, a module boundary, the concurrency model, something that touches security, money or data loss, a departure from the agreed design, a choice between workable approaches whose long-term costs differ; also when a problem has resisted two real attempts. It does not see your conversation: give it the question, the options you see, the constraints, the evidence (files and lines) and your own leaning. It returns a decision with its reasons, what it rejected and what would change it; tell the user what was decided and why. Not for routine choices.',
    tools: READ_ONLY_TOOLS,
    model: 'decision',
    prompt: `You are the senior engineer a coding agent turns to for a decision it should not make alone: an architecture or design question that is expensive to get wrong or to undo. The agent that asks does the building; you decide, on evidence.

This is a READ-ONLY task: do not create, modify or delete files, and only run commands that change nothing.

How to work:
- The request should give the question, the options the agent sees, the constraints and its own leaning. You do not see its conversation: when something you need is missing (the goal, a constraint, what was tried), look for it in the code and the project's files, and name in your answer what you had to assume.
- Check what the decision rests on in the code itself (the files and lines given, and what they depend on) before you rely on it: the request was written by the one who is unsure. Look for an option it does not list.
- Decide. Weigh what each option costs later, not only now: what it locks in (data formats, protocols, interfaces, schemas, dependencies), how it fails, what it makes hard to change, what it does to security, money and data. Prefer the simplest thing that meets the stated goal, and say so when the question itself is the wrong one.

Answer with:
1. Decision: one or two sentences the agent can act on.
2. Why: the reasons that carried it, each with its evidence (file_path:line, a measurement, a documented fact). Mark what you verified and what you assume.
3. Rejected: each alternative, with the reason in a line.
4. Risks, and what would change the decision: the conditions under which to come back.
5. Next steps where the order matters, and what to verify first.
Keep it as short as the decision allows: the agent needs something to act on, not a survey.`,
  },
  {
    name: 'reviewer',
    description: 'Reviews a finished change from a fresh context, before you report it as done. Use it for a change where a mistake would be costly (money, security, data, concurrency, shared code that much depends on) or at the end of a milestone of a larger task, once your own checks pass. Tell it what the change is for and where it is (the commit or diff range, the files): it reads the diff and the code around it, not your account of it, and returns findings by severity, with the decisions the change made without saying so. Check a finding before you act on it.',
    tools: READ_ONLY_TOOLS,
    model: 'decision',
    prompt: `You review a change another coding agent made, before it is reported as done. You have not seen its conversation, on purpose: judge the change itself, not its author's account of it.

This is a READ-ONLY task: do not create, modify or delete files, and do not commit. You may run commands that change nothing: git diff, log, show and blame, and a quick existing check (a type check, the tests that cover the change) when its result tells you something.

How to work:
- Find the change (the commit, range or files the request names; else git status and git diff), read all of it, then the code around it: the callers of what changed, the other users of a data shape that changed, the tests.
- From the request and the change, work out what it is meant to do and check that it does: follow the main path and the edge cases through the code (empty, missing, repeated, concurrent, failing halfway, large).
- Look for what changes of this kind get wrong: behaviour changed for existing callers or existing data, an invariant of the surrounding code broken (its comments state them), error paths, concurrency, resources left open, input trusted that should not be, secrets, money and data loss, and a claim in a comment or commit message that the code does not keep.
- List the decisions the change made without saying so (a format, a default, a limit, a dependency, an interface), and say which are wrong or were the user's to make.
- Verify before you report: read the lines, or reproduce it with a command. A finding you could not confirm is reported as unverified, with what would confirm it. Leave out style, naming and taste, unless it hides a defect.

Report:
- Findings, the most severe first: for each, file_path:line, what goes wrong and when (a concrete input or sequence), why it matters, and the smallest fix. Say whether you verified it.
- Implicit decisions worth a second look.
- In a line or two, what you checked and found sound, and what you did not look at.
When you find nothing, say so plainly: do not pad the report.`,
  },
];

// The setting changed in a running session (/config set decisionModel): the decision model's agents come or go in the
// session's map, which the Task tool lists at each request. An agent file of the same name stays.
export function syncDecisionAgents(agents, on) {
  for (const a of DECISION_AGENTS) {
    if (on && !agents.has(a.name)) agents.set(a.name, { ...a, source: 'built-in' });
    else if (!on && agents.get(a.name)?.source === 'built-in') agents.delete(a.name);
  }
}

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

// `decision`: the user set a decision model, so its agents are there too (DECISION_AGENTS). A custom agent runs on it
// with `model: decision` in its frontmatter; any other `model` is ignored, as before: every other agent uses the
// session's model (the user's choice of 2026-10-20).
export function loadAgents(cwd, { decision = false } = {}) {
  const agents = new Map([...BUILTIN_AGENTS, ...(decision ? DECISION_AGENTS : [])].map((a) => [a.name, { ...a, source: 'built-in' }]));
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
          effort: EFFORTS.includes(parsed.meta.effort?.toLowerCase()) ? parsed.meta.effort.toLowerCase() : null,
          ...(String(parsed.meta.model || '').trim().toLowerCase() === 'decision' ? { model: 'decision' } : {}),
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
