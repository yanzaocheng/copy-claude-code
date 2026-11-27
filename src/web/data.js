// What the local web console (see server.js) reads and changes on disk: the conversations of every project, the
// trash they go to, the running sessions (their peer servers), memory files, and the usage the traces recorded.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CONFIG_DIR, loadConfig } from '../config.js';
import { SessionStore, firstUserText, archivedSessions, historyFile } from '../session.js';
import { transcriptItems } from '../remote.js';
import { buildTools } from '../tools/index.js';
import { loadAgents, loadSkills } from '../agents.js';
import { listPeers } from '../peers.js';
import { costOf } from '../pricing.js';
import { stripAnsi } from '../ui/ansi.js';
import { ripgrepPath } from '../utils/shell.js';
import { spawn } from '../utils/proc.js';

export const projectsRoot = () => path.join(CONFIG_DIR, 'projects');
export const trashRoot = () => path.join(CONFIG_DIR, 'trash', 'sessions');
const TRASH_DAYS = 7;
const ID = /^[\w-]{8,80}$/;
const DIR = /^[\w.-]{1,250}$/;

// ---------------------------------------------------------------- conversations

// What the list shows of a conversation file, read without parsing every message (a conversation with screenshots
// is tens of MB): the messages are counted, only the first prompt and the meta lines are parsed. Kept on disk by
// file, size and time (cache/web-sessions.json), so that only the files that changed are read again, and of a file
// that grew (the conversation of a session at work, looked at every few seconds by the page) only what was added:
// `state` is where the reading stopped ({ino, offset, count, firstPrompt, meta, lastAt}), good for as long as the
// file is the same one (a compaction writes a new file) and has not shrunk.
const META_KEPT = ['cwd', 'created', 'name', 'topic', 'cost', 'firstPrompt'];
function summarize(file, st = fs.statSync(file), prev = null) {
  const same = `${st.ino}:${Math.round(st.birthtimeMs)}`; // (the file itself: a compacted one is a new file)
  const go = prev && prev.ino === same && prev.offset > 0 && prev.offset <= st.size;
  let count = go ? prev.count : 0;
  let firstPrompt = go ? prev.firstPrompt : null;
  let meta = go ? { ...prev.meta } : {};
  let lastAt = go ? prev.lastAt : 0;
  let offset = go ? prev.offset : 0;
  let buf;
  if (!offset) buf = fs.readFileSync(file);
  else {
    buf = Buffer.alloc(Math.max(0, st.size - offset));
    const fd = fs.openSync(file, 'r');
    try { buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, offset)); } finally { fs.closeSync(fd); }
  }
  // whole lines only: one being written is read the next time
  const whole = buf.lastIndexOf(10) + 1;
  const text = buf.toString('utf8', 0, whole);
  offset += whole;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (line.startsWith('{"type":"message"')) {
      count++;
      const at = /"at":(\d+)\}\s*$/.exec(line);
      if (at) lastAt = Math.max(lastAt, Number(at[1]));
      if (!firstPrompt && line.includes('"role":"user"')) {
        try { firstPrompt = firstUserText(JSON.parse(line).message); } catch { /* skip */ }
      }
    } else if (line.startsWith('{"type":"reset"')) {
      try {
        const e = JSON.parse(line);
        count = e.messages.length;
        lastAt = Math.max(lastAt, e.at || 0);
        if (!firstPrompt) for (const m of e.messages) if (m.role === 'user' && (firstPrompt = firstUserText(m))) break;
      } catch { /* skip */ }
    } else if (line.startsWith('{"type":"meta"')) {
      try {
        const e = JSON.parse(line);
        for (const k of META_KEPT) if (k in e) meta[k] = e[k];
      } catch { /* skip */ }
    }
  }
  const state = { ino: same, offset, count, firstPrompt: firstPrompt ? String(firstPrompt).slice(0, 500) : null, meta, lastAt };
  const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name : null;
  const topic = typeof meta.topic === 'string' && meta.topic.trim() ? meta.topic : null;
  if (typeof meta.firstPrompt === 'string' && meta.firstPrompt) firstPrompt = meta.firstPrompt; // (a compacted file: see compactSession)
  return {
    data: {
      cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
      created: meta.created || null,
      name, topic, firstPrompt, count,
      cost: Number(meta.cost) > 0 ? Number(meta.cost) : 0,
      lastAt,
    },
    state,
  };
}

const cacheFile = () => path.join(CONFIG_DIR, 'cache', 'web-sessions.json');
let summaries = null; // file -> {mtime, size, data}

function readSummaries() {
  if (summaries) return summaries;
  try { summaries = new Map(Object.entries(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')))); } catch { summaries = new Map(); }
  return summaries;
}

// (written a while after a change, not at every look of the page at a session that is working)
let saving = null;
function saveSummaries() {
  saving ??= setTimeout(() => {
    saving = null;
    try {
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
      const tmp = `${cacheFile()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(summaries)));
      fs.renameSync(tmp, cacheFile());
    } catch { /* read again next time */ }
  }, 15_000);
  saving.unref?.();
}

// A conversation as loaded, kept for a moment: its view asks for it, then for each of its pictures and long tool
// outputs, and loading parses the whole file.
let lastLoaded = null;
function loadSession(file) {
  const st = fs.statSync(file);
  if (lastLoaded?.file === file && lastLoaded.mtime === st.mtimeMs && lastLoaded.size === st.size) return lastLoaded.loaded;
  const loaded = SessionStore.load(file);
  clearTimeout(lastLoaded?.timer);
  const mine = lastLoaded = { file, mtime: st.mtimeMs, size: st.size, loaded, timer: setTimeout(() => { if (lastLoaded === mine) lastLoaded = null; }, 30_000) };
  mine.timer.unref?.();
  return loaded;
}

// Every conversation of every project, newest first: {id, dir, file, cwd, title, name, topic, firstPrompt, count,
// size, mtime, created, cost}.
export function listAllSessions() {
  const cache = readSummaries();
  const seen = new Set();
  let changed = false;
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  for (const d of dirs) {
    const dir = path.join(projectsRoot(), d.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      seen.add(file);
      let e = cache.get(file);
      if (!e || e.mtime !== st.mtimeMs || e.size !== st.size) {
        try { e = { mtime: st.mtimeMs, size: st.size, ...summarize(file, st, e?.state) }; } catch { continue; }
        cache.set(file, e);
        changed = true;
      }
      if (!e.data.count) continue;
      const s = e.data;
      out.push({
        id: f.slice(0, -6), dir: d.name, file, cwd: s.cwd, title: s.name || s.topic || s.firstPrompt || '(no prompt)',
        name: s.name, topic: s.topic, firstPrompt: s.firstPrompt, count: s.count, size: st.size, mtime: st.mtimeMs,
        created: s.created, cost: s.cost,
      });
    }
  }
  for (const file of cache.keys()) if (!seen.has(file)) { cache.delete(file); changed = true; }
  if (changed) saveSummaries();
  const archived = archivedSessions();
  for (const s of out) if (archived[s.id]) s.archived = archived[s.id].at || true;
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------- finding words in conversations

// The conversations (not archived) where `query` (case aside) is in what the user wrote or in an answer of the model,
// newest first, each with a piece of that text around the first place: {hits: [{id, dir, snippet}], more}. ripgrep
// first picks the files the words are in at all (a tenth of a second for the whole store); those are then read newest
// first, for a limited time, and the messages of the lines the words are in parsed (see searchableTexts).
const SEARCH_BUDGET_MS = 2500;
const reEscape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function filesWith(needle) {
  const rg = ripgrepPath();
  if (!rg) return Promise.resolve(null);
  return new Promise((resolve) => {
    const out = [];
    let child;
    try {
      child = spawn(rg, ['-l', '-i', '-F', '--no-ignore', '--hidden', '--null', '-g', '*.jsonl', '-e', needle, projectsRoot()], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', (d) => out.push(d));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(new Set(Buffer.concat(out).toString('utf8').split('\0').filter(Boolean).map((p) => path.resolve(p).toLowerCase())));
    });
  });
}

// What is searched in a message: what the user wrote (without the notes added for the model) and the model's answers,
// the text of its messages without a tool call; not the steps between (tool calls and their output, thinking, what
// was said between the calls), as the console folds them under 执行过程. The user asked for it (2026-11-27): a word
// found only in a tool's output led to a conversation where it was nowhere to be seen.
export function searchableTexts(message) {
  const content = message?.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  if (message?.role === 'assistant') return blocks.some((b) => b?.type === 'tool_use') ? [] : texts;
  if (message?.role !== 'user') return [];
  const out = [];
  for (const raw of texts) {
    if (raw.startsWith('This session is being continued') || raw.startsWith('<system-reminder>')) continue;
    const bash = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(raw); // `!command`: the command, not its output
    if (bash) { out.push(`!${bash[1]}`); continue; }
    const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<\/?peer-message[^>]*>/g, '').trim();
    if (text) out.push(text);
  }
  return out;
}

// The first place in a conversation file the words are in what is searched: a piece of that text around them.
// `raw`: the words as the file writes them (only the lines they are in are parsed), `re`: as they are.
function snippetIn(text, raw, re) {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const isMessage = text.startsWith('{"type":"message"', start) || text.startsWith('{"type":"reset"', start);
    const line = isMessage ? text.slice(start, end) : '';
    if (line && raw.test(line)) {
      let e = null;
      try { e = JSON.parse(line); } catch { /* a torn line */ }
      for (const message of e?.type === 'reset' ? (Array.isArray(e.messages) ? e.messages : []) : [e?.message]) {
        for (const t of searchableTexts(message)) {
          const m = re.exec(t);
          if (!m) continue;
          const before = t.slice(Math.max(0, m.index - 160), m.index).replace(/\s+/g, ' ');
          const after = t.slice(m.index + m[0].length, m.index + m[0].length + 240).replace(/\s+/g, ' ');
          return { snippet: (before.length > 40 ? `…${before.slice(-40)}` : before) + m[0] + (after.length > 80 ? `${after.slice(0, 80)}…` : after) };
        }
      }
    }
    start = end + 1;
  }
  return null;
}

export async function searchSessionContent(query, { limit = 100 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return { hits: [], more: false };
  const needle = JSON.stringify(q).slice(1, -1); // (as the files write it)
  const raw = new RegExp(reEscape(needle), 'i'), re = new RegExp(reEscape(q), 'i');
  const inFiles = await filesWith(needle);
  const until = Date.now() + SEARCH_BUDGET_MS;
  const hits = [];
  let more = false;
  for (const s of listAllSessions()) {
    if (s.archived) continue;
    if (inFiles && !inFiles.has(path.resolve(s.file).toLowerCase())) continue;
    if (hits.length >= limit || Date.now() > until) { more = true; break; }
    let text;
    try { text = await fs.promises.readFile(s.file, 'utf8'); } catch { continue; }
    const found = snippetIn(text, raw, re);
    if (found) hits.push({ id: s.id, dir: s.dir, snippet: found.snippet });
  }
  return { hits, more };
}

export function sessionFile(dir, id) {
  if (!DIR.test(dir || '') || !ID.test(id || '')) throw httpError(400, 'bad session reference');
  const file = path.join(projectsRoot(), dir, `${id}.jsonl`);
  if (!fs.existsSync(file)) throw httpError(404, '会话不存在');
  return file;
}

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// The tools of a project, for the tool calls' headers (their summaries) in a conversation's view.
const toolsMemo = new Map();
function toolsFor(cwd) {
  const key = cwd || '';
  if (toolsMemo.has(key)) return toolsMemo.get(key);
  let tools = [];
  try {
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const config = loadConfig({ cwd: dir });
    tools = buildTools(config, { agents: loadAgents(dir), skills: loadSkills(dir), peers: true });
  } catch { /* headers with the tools' names only */ }
  toolsMemo.set(key, tools);
  return tools;
}

// The built-in tools a session of the project sends the model (扩展's 内置工具): {name, description}.
export const builtinTools = (cwd) => toolsFor(cwd).map((t) => ({ name: t.name, description: String(t.description || '') }));

// A conversation as the console shows it: its items (as the live view has them, images as {k: 'image', n}), with
// what the list knows of it.
export function sessionDetail(dir, id) {
  const file = sessionFile(dir, id);
  const loaded = loadSession(file);
  const cwd = typeof loaded.meta.cwd === 'string' ? loaded.meta.cwd : null;
  const ctx = { cwd: cwd || os.homedir(), projectRoot: cwd || os.homedir() };
  const items = transcriptItems(loaded.messages, { tools: toolsFor(cwd), ctx, cwd: ctx.cwd, limit: Infinity, images: true, turns: loaded.turns });
  const st = fs.statSync(file);
  return {
    id, dir, cwd, title: loaded.name || loaded.topic || loaded.title || '(no prompt)', name: loaded.name, topic: loaded.topic,
    count: loaded.messages.length, size: st.size, mtime: st.mtimeMs, cost: loaded.cost, created: loaded.meta.created || null,
    items,
  };
}

// The n-th image of a conversation's user messages: {mediaType, data (Buffer)} or null.
export function sessionImage(dir, id, n) {
  const loaded = loadSession(sessionFile(dir, id));
  let i = 0;
  for (const m of loaded.messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content || []) {
      if (b.type !== 'image') continue;
      if (i++ === n) return b.source?.type === 'base64' ? { mediaType: b.source.media_type, data: Buffer.from(b.source.data, 'base64') } : null;
    }
  }
  return null;
}

// The whole output of a tool call of a conversation (as the session's own remoteOutput gives it): the result's text,
// or the file a large one was saved to; at most 1 MB.
export function sessionToolOutput(dir, id, toolId) {
  const loaded = loadSession(sessionFile(dir, id));
  let result = null;
  for (const m of loaded.messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === 'tool_result' && b.tool_use_id === toolId) result = b;
  }
  if (!result) throw httpError(404, 'no such tool call');
  let text = typeof result.content === 'string' ? result.content
    : (Array.isArray(result.content) ? result.content : []).map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
  const saved = /(?:saved to:?|saved at)\s+(\S+?\.txt)\b/.exec(text)?.[1];
  if (saved && path.resolve(saved).startsWith(projectsRoot() + path.sep) && path.resolve(saved).includes(`${path.sep}tool-results${path.sep}`)) {
    try { text = fs.readFileSync(saved, 'utf8'); } catch { /* the reference is what there is */ }
  }
  const MAX = 1024 * 1024;
  const buf = Buffer.from(text, 'utf8');
  return buf.length > MAX ? { text: buf.subarray(0, MAX).toString('utf8').replace(/\ufffd$/, ''), truncated: true } : { text };
}

// A conversation as Markdown: what was said, the tool calls as one line each (their results left out).
export function sessionMarkdown(dir, id) {
  const d = sessionDetail(dir, id);
  const out = [`# ${d.title}`, '', `- 会话 id：${d.id}`, `- 目录：${d.cwd || '未知'}`, `- 消息：${d.count} 条${d.cost ? ` · 花费 $${d.cost.toFixed(4)}` : ''}`, ''];
  for (const it of d.items) {
    if (it.k === 'user') out.push('## 用户', '', it.text, '');
    else if (it.k === 'text') out.push('## claude-pro', '', it.text, '');
    else if (it.k === 'tool') out.push(`> 🔧 ${stripAnsi(it.head || '')}${it.status === 'error' ? '（失败）' : ''}`, '');
    else if (it.k === 'summary') out.push('## 压缩后的摘要', '', it.text, '');
    else if (it.k === 'image') out.push('*[图片]*', '');
    else if (it.k === 'output') {
      const lines = it.lines.map((l) => stripAnsi(l)).join('\n').trim();
      if (lines) out.push('```', lines, '```', '');
    }
  }
  return out.join('\n');
}

// /rename for a conversation that is not running: its name, appended as the session does it.
// 在新对话中分支: a new conversation with what this one had when one of its turns ended, in the same folder: its
// messages up to there (with their times), the done lines under them, and the system prompt it ran behind (so that
// the branch goes on from the same prompt cache), named after it. `turn`: that done line as the page shows it
// ("✻ Done at 17:37 · worked …"); `nth`: which of the lines that read the same, counted from the last (0).
export function forkSession(id, { turn, nth = 0 } = {}) {
  const s = listAllSessions().find((x) => x.id === id);
  if (!s) throw httpError(404, '会话不存在');
  const loaded = SessionStore.load(s.file);
  const want = stripAnsi(String(turn || '')).trim();
  const same = loaded.turns.filter((t) => stripAnsi(t.text).trim() === want);
  const mark = same[same.length - 1 - Math.max(0, Number(nth) | 0)];
  if (!mark) throw httpError(409, '在会话记录里找不到这一轮（可能是压缩之前的内容）');
  const cwd = s.cwd || loaded.meta.cwd;
  if (!cwd) throw httpError(409, '这个会话没有记下它的目录');
  const store = new SessionStore(cwd);
  const name = String(s.title || '会话').replace(/^分支：/, '').slice(0, 60);
  store.append({ type: 'meta', name: `分支：${name}`, forkedFrom: { id, after: mark.after }, at: Date.now() });
  if (loaded.systemPrompt) store.append({ type: 'meta', systemPrompt: loaded.systemPrompt, promptCode: loaded.promptCode, at: Date.now() });
  for (let i = 0; i < mark.after; i++) store.append({ type: 'message', message: loaded.messages[i], at: loaded.times[i] || Date.now() });
  store.setTurns(loaded.turns.filter((t) => t.after <= mark.after));
  if (store.lost) throw httpError(500, '分支没能写下来（磁盘满了？）');
  return { id: store.id, dir: path.basename(store.dir), file: store.file, cwd };
}

export function renameSession(dir, id, name) {
  const file = sessionFile(dir, id);
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'meta', name: clean || null, at: Date.now() })}\n`);
  return clean;
}

// Deleting moves a conversation (with its trace) into the trash, kept TRASH_DAYS days.
export function trashSession(dir, id) {
  const file = sessionFile(dir, id);
  const info = summarize(file).data;
  const stamp = Date.now();
  const base = path.join(trashRoot(), `${stamp}__${dir}__${id}`);
  fs.mkdirSync(base, { recursive: true });
  fs.renameSync(file, path.join(base, `${id}.jsonl`));
  try { fs.renameSync(historyFile(file), path.join(base, `${id}.history.jsonl.gz`)); } catch { /* none */ }
  for (const suffix of ['.jsonl', '.jsonl.1']) {
    const trace = path.join(projectsRoot(), dir, 'traces', `${id}${suffix}`);
    try { fs.renameSync(trace, path.join(base, `trace${suffix}`)); } catch { /* none */ }
  }
  fs.writeFileSync(path.join(base, 'info.json'), JSON.stringify({ dir, id, cwd: info.cwd, title: info.name || info.topic || info.firstPrompt || '(no prompt)', count: info.count, deletedAt: stamp }));
  return { trashId: path.basename(base) };
}

export function listTrash() {
  purgeTrash();
  let entries = [];
  try { entries = fs.readdirSync(trashRoot()); } catch { return []; }
  return entries.map((name) => {
    try { return { trashId: name, ...JSON.parse(fs.readFileSync(path.join(trashRoot(), name, 'info.json'), 'utf8')) }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.deletedAt - a.deletedAt);
}

function trashEntry(trashId) {
  if (!/^\d+__[\w.-]+__[\w-]+$/.test(trashId || '')) throw httpError(400, 'bad trash reference');
  const base = path.join(trashRoot(), trashId);
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(base, 'info.json'), 'utf8')); } catch { throw httpError(404, '回收站里没有它了'); }
  return { base, info };
}

export function restoreSession(trashId) {
  const { base, info } = trashEntry(trashId);
  const dir = path.join(projectsRoot(), info.dir);
  const target = path.join(dir, `${info.id}.jsonl`);
  if (fs.existsSync(target)) throw httpError(409, '同一个会话已经存在');
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(path.join(base, `${info.id}.jsonl`), target);
  try { fs.renameSync(path.join(base, `${info.id}.history.jsonl.gz`), historyFile(target)); } catch { /* none */ }
  for (const suffix of ['.jsonl', '.jsonl.1']) {
    const from = path.join(base, `trace${suffix}`);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.join(dir, 'traces'), { recursive: true });
    try { fs.renameSync(from, path.join(dir, 'traces', `${info.id}${suffix}`)); } catch { /* left in the trash */ }
  }
  fs.rmSync(base, { recursive: true, force: true });
  return info;
}

export function purgeTrash({ all = false, trashId = null } = {}) {
  let entries = [];
  try { entries = fs.readdirSync(trashRoot()); } catch { return 0; }
  let n = 0;
  for (const name of entries) {
    const at = Number(name.split('__')[0]);
    if (trashId ? name !== trashId : !(all || !Number.isFinite(at) || Date.now() - at > TRASH_DAYS * 86_400_000)) continue;
    try { fs.rmSync(path.join(trashRoot(), name), { recursive: true, force: true }); n++; } catch { /* next time */ }
  }
  return n;
}

// ---------------------------------------------------------------- running sessions

// GET or POST to a session's peer server (see PeerNode): resolves with {status, body}.
export function peerRequest(peer, method, route, body = undefined, { timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: peer.port, path: route, method, timeout,
      headers: { authorization: `Bearer ${peer.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('the session did not answer')));
    req.on('error', reject);
    req.end(data);
  });
}

// The sessions running on this computer now, each with what it says of itself (GET /status).
export async function runningSessions() {
  const peers = listPeers();
  return await Promise.all(peers.map(async (p) => {
    let status = {};
    try { status = (await peerRequest(p, 'GET', '/status', undefined, { timeout: 2000 })).body || {}; } catch { /* busy or gone: listed with what its file says */ }
    return { peerId: p.id, name: p.name, cwd: p.cwd, pid: p.pid, startedAt: p.startedAt, status };
  }));
}

export function findPeerById(peerId) {
  const peer = listPeers().find((p) => p.id === peerId);
  if (!peer) throw httpError(404, '这个会话已经不在运行');
  return peer;
}

// ---------------------------------------------------------------- usage (from the traces)

const usageMemo = new Map(); // trace file -> {mtime, size, rows}
const localDay = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function traceRows(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const kept = usageMemo.get(file);
  if (kept && kept.mtime === st.mtimeMs && kept.size === st.size) return kept.rows;
  const rows = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"request_end"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e.ok && !e.output_tokens) continue;
    const usage = { input_tokens: e.input_tokens, output_tokens: e.output_tokens, cache_read_input_tokens: e.cache_read_tokens, cache_creation_input_tokens: e.cache_write_tokens };
    rows.push({ day: localDay(e.time), hour: new Date(e.time).getHours(), model: e.model || '?', session: e.session_id, input: e.input_tokens || 0, output: e.output_tokens || 0, cacheRead: e.cache_read_tokens || 0, cacheWrite: e.cache_write_tokens || 0, cost: costOf(e.model, usage) });
  }
  usageMemo.set(file, { mtime: st.mtimeMs, size: st.size, rows });
  return rows;
}

// Tokens and (where the model has a price here) cost by day (by hour too for today alone, `days` 1), model, project
// and conversation, from every project's traces; and each conversation's own total (its meta), which covers what
// the traces do not price.
export function usageReport({ days = 30 } = {}) {
  const since = localDay(new Date(Date.now() - (days - 1) * 86_400_000).toISOString());
  const byDay = new Map();
  const byModel = new Map();
  const byProject = new Map();
  const bySession = new Map();
  const byHour = new Map();
  const add = (map, key, r) => {
    const e = map.get(key) || { key, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 };
    e.requests++;
    e.input += r.input; e.output += r.output; e.cacheRead += r.cacheRead; e.cacheWrite += r.cacheWrite;
    if (r.cost == null) e.unpriced++; else e.cost += r.cost;
    map.set(key, e);
  };
  const sessions = listAllSessions();
  const cwdOfDir = new Map(sessions.filter((s) => s.cwd).map((s) => [s.dir, s.cwd]));
  let dirs = [];
  try { dirs = fs.readdirSync(projectsRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* none */ }
  for (const d of dirs) {
    const traces = path.join(projectsRoot(), d.name, 'traces');
    let files = [];
    try { files = fs.readdirSync(traces).filter((f) => /\.jsonl(\.\d+)?$/.test(f)); } catch { continue; }
    for (const f of files) {
      for (const r of traceRows(path.join(traces, f))) {
        if (r.day < since) continue;
        add(byDay, r.day, r);
        add(byModel, r.model, r);
        add(byProject, cwdOfDir.get(d.name) || d.name, r);
        if (r.session) add(bySession, r.session, r);
        if (days === 1) add(byHour, r.hour, r);
      }
    }
  }
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = localDay(new Date(Date.now() - i * 86_400_000).toISOString());
    dayList.push(byDay.get(key) || { key, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 });
  }
  const sortCost = (a, b) => b.cost - a.cost || b.requests - a.requests;
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const empty = (key) => ({ key, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 });
  return {
    days: dayList,
    // today, hour by hour up to now
    ...(days === 1 ? { hours: Array.from({ length: new Date().getHours() + 1 }, (_, h) => ({ ...(byHour.get(h) || empty(h)), key: `${String(h).padStart(2, '0')}:00` })) } : {}),
    models: [...byModel.values()].sort(sortCost),
    projects: [...byProject.values()].sort(sortCost),
    // the conversations that cost most in this period (a deleted one has no title, nor a page to open)
    sessions: [...bySession.values()].sort(sortCost).slice(0, 30).map((e) => {
      const s = sessionById.get(e.key);
      return { id: e.key, dir: s?.dir || null, cwd: s?.cwd || null, title: s?.title || null, mtime: s?.mtime || null, cost: e.cost, requests: e.requests, unpriced: e.unpriced };
    }),
    totalSessionCost: sessions.reduce((sum, s) => sum + s.cost, 0),
  };
}

// ---------------------------------------------------------------- disk

export function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* gone */ } }
    }
  };
  walk(dir);
  return total;
}
