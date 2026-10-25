// Transcript persistence: ~/.claude-pro/projects/<project>/<session-id>.jsonl
// Each line is {type:'message', message} or {type:'reset', messages} (after /clear or compaction)
// or {type:'meta', ...}.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config.js';
import { PROMPT_CODE_VERSION } from './prompts.js';

export function projectDir(cwd) {
  const name = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(CONFIG_DIR, 'projects', name);
}

// Where oversized tool output is saved (see persistLargeOutput in agent.js).
export function toolResultsDir(cwd) {
  return path.join(projectDir(cwd), 'tool-results');
}

// Delete saved tool output older than maxAgeMs (best effort, run at startup).
export function pruneToolResults(cwd, maxAgeMs = 7 * 24 * 3600_000) {
  const dir = toolResultsDir(cwd);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const file = path.join(dir, name);
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
}

// Where /rewind keeps file snapshots: one sub-directory per run of the program.
export function checkpointsDir(cwd) {
  return path.join(projectDir(cwd), 'checkpoints');
}

// Delete snapshot directories of old runs (best effort, run at startup).
export function pruneCheckpoints(cwd, maxAgeMs = 14 * 24 * 3600_000) {
  const dir = checkpointsDir(cwd);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const sub = path.join(dir, name);
    try { if (fs.statSync(sub).mtimeMs < cutoff) fs.rmSync(sub, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// Persistent, model-maintained memory for this project (MEMORY.md + topic files).
export function autoMemoryDir(cwd) {
  return path.join(projectDir(cwd), 'memory');
}

// /cd: the conversation in `file` goes on in another working directory, so its file goes to that directory's project
// (where /resume there finds it, and where a SessionStore(cwd, id) appends), with the new directory in its first
// line. The copy is written now; commit() removes the old file, undo() the copy. {file, commit, undo}.
export function moveSession(file, id, cwd) {
  const target = path.join(projectDir(cwd), `${id}.jsonl`);
  const none = { file: target, commit() {}, undo() {} };
  if (path.resolve(target) === path.resolve(file)) return none;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return none; throw e; } // nothing written yet
  const nl = text.indexOf('\n');
  let first = nl >= 0 ? text.slice(0, nl) : text;
  try {
    const meta = JSON.parse(first);
    if (meta?.type === 'meta') first = JSON.stringify({ ...meta, cwd });
  } catch { /* not a meta line: kept as it is */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, first + (nl >= 0 ? text.slice(nl) : '\n'));
  return {
    file: target,
    commit() { try { fs.rmSync(file, { force: true }); } catch { /* two copies: /resume shows it in both places */ } },
    undo() { try { fs.rmSync(target, { force: true }); } catch { /* left behind */ } },
  };
}

export class SessionStore {
  constructor(cwd, id = crypto.randomUUID()) {
    this.cwd = cwd;
    this.id = id;
    this.dir = projectDir(cwd);
    this.file = path.join(this.dir, `${id}.jsonl`);
    this.started = false;
  }

  append(entry) {
    try {
      if (!this.started) {
        fs.mkdirSync(this.dir, { recursive: true });
        this.started = true;
        if (!fs.existsSync(this.file)) fs.appendFileSync(this.file, JSON.stringify({ type: 'meta', cwd: this.cwd, created: new Date().toISOString() }) + '\n');
      }
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    } catch { /* persistence is best effort */ }
  }

  message(message) { this.append({ type: 'message', message, at: Date.now() }); }
  // What the conversation is about now (the tab title); the newest one wins when the session is loaded.
  setTopic(topic) { this.append({ type: 'meta', topic, at: Date.now() }); }
  // The name the user gave the conversation with /rename (null: none again); it wins over the topic.
  setName(name) { this.append({ type: 'meta', name, at: Date.now() }); }
  reset(messages) { this.append({ type: 'reset', messages, at: Date.now() }); }
  // What the conversation's requests have cost so far (USD, see pricing.js), written after each one; the newest wins.
  setCost(usd) { this.append({ type: 'meta', cost: usd, at: Date.now() }); }
  // Until when the conversation's prompt cache lasts (ms since epoch; 0: cold), for the footer's clock of a
  // resumed conversation (see CacheStats.clock), and what the cache holds (Agent.cacheState; null: nothing warm),
  // so that a restarted conversation goes on refreshing it (keepalive.js). Written after each of its requests and
  // compactions.
  setCacheUntil(until, state = null) {
    const json = JSON.stringify(state);
    const clock = until != null && until !== this.cacheUntil;
    if (!clock && json === (this.cacheStateJson ?? 'null')) return;
    if (clock) this.cacheUntil = until;
    this.cacheStateJson = json;
    this.append({ type: 'meta', ...(clock ? { cacheUntil: until } : {}), cacheState: state, at: Date.now() });
  }
  // The system prompt this conversation runs behind, kept so that a resumed one continues behind the same prompt
  // and so with the prompt cache it already has (see runtime.resumeSystemPrompt). Written when it first appears
  // and whenever it changes (after a compaction); the newest one wins when the session is loaded. With it goes the
  // fingerprint of the code that built it: after that code changes, a resumed conversation gets a new prompt.
  setSystemPrompt(text) {
    if (!text || text === this.systemPrompt) return;
    this.systemPrompt = text;
    this.append({ type: 'meta', systemPrompt: text, promptCode: PROMPT_CODE_VERSION, at: Date.now() });
  }

  static load(file) {
    const messages = [];
    const times = []; // when each message was stored (ms since epoch), parallel to `messages`; 0 = unknown
    let meta = {};
    let title = null;
    let lastAt = 0; // when the conversation last changed: the latest message or reset (0: unknown)
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'message' || e.type === 'reset') lastAt = Math.max(lastAt, e.at || 0);
      if (e.type === 'reset') meta = { ...meta, cacheState: null }; // what was cached is not the new messages' prefix
      if (e.type === 'meta') meta = { ...meta, ...e };
      else if (e.type === 'message') {
        messages.push(e.message);
        times.push(e.at || 0);
        if (!title && e.message.role === 'user') title = firstUserText(e.message);
      } else if (e.type === 'reset') {
        // The messages of a reset (after /clear, compaction or a rewind) were not stored one by one,
        // so their own times are unknown.
        messages.splice(0, messages.length, ...e.messages);
        times.splice(0, times.length, ...e.messages.map(() => 0));
      }
    }
    return {
      messages, times, lastAt, meta, title,
      topic: typeof meta.topic === 'string' && meta.topic.trim() ? meta.topic : null,
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name : null,
      systemPrompt: typeof meta.systemPrompt === 'string' && meta.systemPrompt.trim() ? meta.systemPrompt : null,
      promptCode: typeof meta.promptCode === 'string' ? meta.promptCode : null,
      cost: Number(meta.cost) > 0 ? Number(meta.cost) : 0,
      cacheUntil: Number.isFinite(meta.cacheUntil) && meta.cacheUntil >= 0 ? meta.cacheUntil : null,
      cacheState: meta.cacheState && typeof meta.cacheState === 'object' ? meta.cacheState : null,
    };
  }

  // The conversations of the project, newest first: {id, file, mtime, title, count}. Each file's title and message
  // count are kept in sessions-index.json by its size and time, so that only the files that changed since are
  // parsed (parsing all of them, tens of MB with screenshots, made -c and /resume wait a third of a second and
  // more as conversations piled up).
  static list(cwd) {
    const dir = projectDir(cwd);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
    const indexFile = path.join(dir, SESSION_INDEX);
    let index = {};
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) || {}; } catch { /* none yet, or damaged: rebuilt */ }
    const next = {};
    let changed = false;
    const sessions = files.map((f) => {
      const file = path.join(dir, f);
      let st;
      try { st = fs.statSync(file); } catch { return null; }
      let e = index[f];
      if (!e || e.mtime !== st.mtimeMs || e.size !== st.size) {
        let title = null, count = 0;
        try {
          const loaded = SessionStore.load(file);
          title = loaded.name || loaded.topic || loaded.title; // its name, else what it was about last, else its first message
          count = loaded.messages.length;
        } catch { /* ignore */ }
        e = { mtime: st.mtimeMs, size: st.size, title, count };
        changed = true;
      }
      next[f] = e;
      return { id: f.slice(0, -6), file, mtime: st.mtimeMs, title: e.title || '(no prompt)', count: e.count };
    }).filter((s) => s && s.count > 0).sort((a, b) => b.mtime - a.mtime);
    if (changed || Object.keys(index).length !== Object.keys(next).length) {
      try { // whole or not at all: another window may list at the same time (a lost update is only a re-parse)
        const tmp = `${indexFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next));
        fs.renameSync(tmp, indexFile);
      } catch { /* parsed again next time */ }
    }
    return sessions;
  }
}

const SESSION_INDEX = 'sessions-index.json';

export function firstUserText(message) {
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  const t = blocks.find((b) => b.type === 'text' && !b.text.startsWith('<system-reminder>') && !b.text.startsWith('['));
  return t ? t.text.replace(/\s+/g, ' ').trim().slice(0, 100) : null;
}
