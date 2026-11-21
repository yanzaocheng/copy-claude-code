// Transcript persistence: ~/.claude-pro/projects/<project>/<session-id>.jsonl
// Each line is {type:'message', message} or {type:'reset', messages} (after /clear or compaction)
// or {type:'meta', ...}.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config.js';
import { PROMPT_CODE_VERSION } from './prompts.js';

// The directory of a project's state (conversations, memory, checkpoints, traces): its path with every character
// but a-z, A-Z and 0-9 made '-', as Claude Code names it. A path with characters beyond ASCII in it also gets a hash
// of the whole path: those all became '-', so that D:\d\node\聊天 and D:\d\node\共享 were one directory, their
// conversations and memory shared. The directory such a project had before is taken over the first time (adoptOldDir).
export function projectDir(cwd) {
  const abs = path.resolve(cwd);
  const name = abs.replace(/[^a-zA-Z0-9]/g, '-');
  const base = path.join(CONFIG_DIR, 'projects');
  if (!/[^\x00-\x7f]/.test(abs)) return path.join(base, name);
  return adoptOldDir(abs, path.join(base, name), path.join(base, `${name}-${pathHash(abs)}`));
}

// A path as the file system tells paths apart: in any case on Windows, and in one Unicode form (macOS gives NFD).
function pathKey(p) {
  const key = path.resolve(p).normalize('NFC');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function pathHash(abs) {
  return crypto.createHash('sha256').update(pathKey(abs)).digest('hex').slice(0, 8);
}

const adopted = new Map(); // a project's new directory -> the directory this process uses for it

// The directory to use for `abs` (see projectDir): `dir`, after what was this project's in `oldDir` (the name from
// before the hash) has moved there. Its conversations say which directory they ran in (their first line). When they
// are all this project's, so is the rest: the directory is renamed. Else it was shared: this project's conversations
// (with their traces) move, its memory is copied (it cannot be told apart), and the rest stays for the other
// project, which takes the directory over in its turn. With no conversation to tell, the memory is copied and the
// directory left. Once per process; when the rename is refused (a file in it held open on Windows), the old
// directory is used as it is, and moved another time.
function adoptOldDir(abs, oldDir, dir) {
  if (adopted.has(dir)) return adopted.get(dir);
  let use = dir;
  try {
    if (!fs.existsSync(dir) && fs.existsSync(oldDir)) {
      const key = pathKey(abs);
      const sessions = fs.readdirSync(oldDir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, cwd: sessionCwd(path.join(oldDir, f)) }));
      const mine = sessions.filter((s) => s.cwd && pathKey(s.cwd) === key);
      const others = sessions.filter((s) => s.cwd && pathKey(s.cwd) !== key);
      if (mine.length && !others.length) {
        try { fs.renameSync(oldDir, dir); } catch { use = fs.existsSync(dir) ? dir : oldDir; } // moved by another process first, or held open
      } else {
        fs.mkdirSync(dir, { recursive: true });
        const memory = path.join(oldDir, 'memory');
        if ((mine.length || !others.length) && fs.existsSync(memory)) fs.cpSync(memory, path.join(dir, 'memory'), { recursive: true });
        for (const { f } of mine) {
          const id = f.slice(0, -'.jsonl'.length);
          const moves = [[f, f], [path.join('traces', `${id}.jsonl`), path.join('traces', `${id}.jsonl`)], [path.join('traces', `${id}.jsonl.1`), path.join('traces', `${id}.jsonl.1`)]];
          for (const [from, to] of moves) {
            if (!fs.existsSync(path.join(oldDir, from))) continue;
            fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
            try { fs.renameSync(path.join(oldDir, from), path.join(dir, to)); } catch { /* left where it was */ }
          }
        }
      }
    }
  } catch { /* the new directory, as it is */ }
  adopted.set(dir, use);
  return use;
}

// The directory a conversation file ran in, from its first line (a meta line with cwd), or null.
function sessionCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    const meta = JSON.parse(first);
    return meta?.type === 'meta' && typeof meta.cwd === 'string' ? meta.cwd : null;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// Where oversized tool output is saved (see persistLargeOutput in agent.js).
export function toolResultsDir(cwd) {
  return path.join(projectDir(cwd), 'tool-results');
}

// Where /rewind keeps file snapshots: one sub-directory per run of the program.
export function checkpointsDir(cwd) {
  return path.join(projectDir(cwd), 'checkpoints');
}

// 归档 (archived) conversations: put away from the web console's workspace, kept whole, and never deleted by age
// (sweepOldData). A mark in CONFIG_DIR/archived.json ({id: {at}}); the conversation's file stays where it is, so
// /resume and --resume still find it.
const archivedFile = () => path.join(CONFIG_DIR, 'archived.json');
export function archivedSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(archivedFile(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
export function setArchived(ids, archived = true) {
  const data = archivedSessions();
  const at = Date.now();
  for (const id of ids) {
    if (typeof id !== 'string' || !id) continue;
    if (archived) data[id] = { at };
    else delete data[id];
  }
  fs.mkdirSync(path.dirname(archivedFile()), { recursive: true });
  const tmp = `${archivedFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, archivedFile());
  return data;
}

// Delete what is older than `days` (the cleanupPeriodDays setting, as in Claude Code: 30 by default), in every
// project: conversations not written to since (they no longer appear in /resume), their traces, saved tool outputs
// (at most 7 days) and /rewind snapshots (at most 14 days). The memory is never touched. Conversations were kept
// for good before: 646 MB in 176 files in a month (2026-11-11), of which only the current project's tool outputs,
// snapshots and traces were deleted, and only when a session started there. Runs in the background, at most once
// an hour on the machine (`marker`); `keep`: conversation ids not to delete whatever their age (and the archived
// ones are never deleted). Returns what went.
export async function sweepOldData({ days, keep = [], root = path.join(CONFIG_DIR, 'projects'), now = Date.now() } = {}) {
  const done = { conversations: 0, files: 0, bytes: 0 };
  if (!(days >= 1)) return done;
  const marker = path.join(root, '.last-sweep');
  try { if (now - fs.statSync(marker).mtimeMs < 3600_000) return done; } catch { /* never swept */ }
  try { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(marker, ''); } catch { return done; }
  const day = 24 * 3600_000;
  const keepIds = new Set([...keep.filter(Boolean), ...Object.keys(archivedSessions())]);
  const fsp = fs.promises;
  const list = async (dir) => { try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; } };
  const old = async (file, maxAgeMs) => { try { return now - (await fsp.stat(file)).mtimeMs > maxAgeMs; } catch { return false; } };
  const remove = async (file, isDir = false) => {
    try {
      const size = isDir ? 0 : (await fsp.stat(file)).size;
      await fsp.rm(file, { recursive: isDir, force: true });
      done.files++;
      done.bytes += size;
      return true;
    } catch { return false; }
  };
  for (const project of await list(root)) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    for (const e of await list(dir)) {
      const id = e.name.replace(/\.jsonl$/, '');
      if (!e.isFile() || id === e.name || keepIds.has(id)) continue;
      if (await old(path.join(dir, e.name), days * day) && (await remove(path.join(dir, e.name)))) done.conversations++;
    }
    for (const e of await list(path.join(dir, 'traces'))) { // a conversation's trace is written with it
      const f = path.join(dir, 'traces', e.name);
      if (!keepIds.has(e.name.replace(/\.jsonl(\.\d+)?$/, '')) && (await old(f, days * day))) await remove(f);
    }
    for (const e of await list(path.join(dir, 'tool-results'))) {
      const f = path.join(dir, 'tool-results', e.name);
      if (await old(f, Math.min(days, 7) * day)) await remove(f);
    }
    for (const e of await list(path.join(dir, 'checkpoints'))) { // one directory per run of the program
      const f = path.join(dir, 'checkpoints', e.name);
      if (await old(f, Math.min(days, 14) * day)) await remove(f, true);
    }
  }
  return done;
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
  static onError = null; // (error, store): a write of the conversation failed (the first time for a store)
  onError = null; // the same for this store alone (its session's: the web console runs several in one process)

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
    } catch (e) {
      // Best effort, but a message that did not get in leaves the file without it, and a restart or /resume would go
      // on from a conversation that lacks it: noted (`lost`, see App.restartNow), and said once (SessionStore.onError).
      this.lost = true;
      if (!this.warned) { this.warned = true; try { (this.onError || SessionStore.onError)?.(e, this); } catch { /* ignore */ } }
    }
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
  if (!t) return null;
  // a command of bash mode (!cmd): the command, as it was typed
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(t.text);
  return (bash ? `! ${bash[1]}` : t.text).replace(/\s+/g, ' ').trim().slice(0, 100);
}
