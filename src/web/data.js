// What the local web console (see server.js) reads and changes on disk: the conversations of every project, the
// trash they go to, the running sessions (their peer servers), memory files, and the usage the traces recorded.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CONFIG_DIR, loadConfig } from '../config.js';
import { SessionStore, firstUserText } from '../session.js';
import { transcriptItems } from '../remote.js';
import { buildTools } from '../tools/index.js';
import { loadAgents, loadSkills } from '../agents.js';
import { listPeers } from '../peers.js';
import { costOf } from '../pricing.js';
import { stripAnsi } from '../ui/ansi.js';

export const projectsRoot = () => path.join(CONFIG_DIR, 'projects');
export const trashRoot = () => path.join(CONFIG_DIR, 'trash', 'sessions');
const TRASH_DAYS = 7;
const ID = /^[\w-]{8,80}$/;
const DIR = /^[\w.-]{1,250}$/;

// ---------------------------------------------------------------- conversations

// What the list shows of a conversation file, read without parsing every message (a conversation with screenshots
// is tens of MB): the messages are counted, only the first prompt and the meta lines are parsed. Kept on disk by
// file, size and time (cache/web-sessions.json), so that only the files that changed are read again.
function summarize(file) {
  let count = 0;
  let firstPrompt = null;
  let meta = {};
  let lastAt = 0;
  const text = fs.readFileSync(file, 'utf8');
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
        const { systemPrompt, cacheState, ...e } = JSON.parse(line);
        meta = { ...meta, ...e };
      } catch { /* skip */ }
    }
  }
  const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name : null;
  const topic = typeof meta.topic === 'string' && meta.topic.trim() ? meta.topic : null;
  return {
    cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
    created: meta.created || null,
    name, topic, firstPrompt, count,
    cost: Number(meta.cost) > 0 ? Number(meta.cost) : 0,
    lastAt,
  };
}

const cacheFile = () => path.join(CONFIG_DIR, 'cache', 'web-sessions.json');
let summaries = null; // file -> {mtime, size, data}

function readSummaries() {
  if (summaries) return summaries;
  try { summaries = new Map(Object.entries(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')))); } catch { summaries = new Map(); }
  return summaries;
}

function saveSummaries() {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    const tmp = `${cacheFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(summaries)));
    fs.renameSync(tmp, cacheFile());
  } catch { /* read again next time */ }
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
        try { e = { mtime: st.mtimeMs, size: st.size, data: summarize(file) }; } catch { continue; }
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
  return out.sort((a, b) => b.mtime - a.mtime);
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

// A conversation as the console shows it: its items (as the live view has them, images as {k: 'image', n}), with
// what the list knows of it.
export function sessionDetail(dir, id) {
  const file = sessionFile(dir, id);
  const loaded = SessionStore.load(file);
  const cwd = summarize(file).cwd;
  const ctx = { cwd: cwd || os.homedir(), projectRoot: cwd || os.homedir() };
  const items = transcriptItems(loaded.messages, { tools: toolsFor(cwd), ctx, cwd: ctx.cwd, limit: Infinity, images: true });
  const st = fs.statSync(file);
  return {
    id, dir, cwd, title: loaded.name || loaded.topic || loaded.title || '(no prompt)', name: loaded.name, topic: loaded.topic,
    count: loaded.messages.length, size: st.size, mtime: st.mtimeMs, cost: loaded.cost, created: loaded.meta.created || null,
    items,
  };
}

// The n-th image of a conversation's user messages: {mediaType, data (Buffer)} or null.
export function sessionImage(dir, id, n) {
  const loaded = SessionStore.load(sessionFile(dir, id));
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
  const loaded = SessionStore.load(sessionFile(dir, id));
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
export function renameSession(dir, id, name) {
  const file = sessionFile(dir, id);
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'meta', name: clean || null, at: Date.now() })}\n`);
  return clean;
}

// Deleting moves a conversation (with its trace) into the trash, kept TRASH_DAYS days.
export function trashSession(dir, id) {
  const file = sessionFile(dir, id);
  const info = summarize(file);
  const stamp = Date.now();
  const base = path.join(trashRoot(), `${stamp}__${dir}__${id}`);
  fs.mkdirSync(base, { recursive: true });
  fs.renameSync(file, path.join(base, `${id}.jsonl`));
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
    rows.push({ day: localDay(e.time), model: e.model || '?', session: e.session_id, input: e.input_tokens || 0, output: e.output_tokens || 0, cacheRead: e.cache_read_tokens || 0, cacheWrite: e.cache_write_tokens || 0, cost: costOf(e.model, usage) });
  }
  usageMemo.set(file, { mtime: st.mtimeMs, size: st.size, rows });
  return rows;
}

// Tokens and (where the model has a price here) cost by day, model and project, from every project's traces; and
// each conversation's own total (its meta), which covers what the traces do not price.
export function usageReport({ days = 30 } = {}) {
  const since = localDay(new Date(Date.now() - (days - 1) * 86_400_000).toISOString());
  const byDay = new Map();
  const byModel = new Map();
  const byProject = new Map();
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
      }
    }
  }
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = localDay(new Date(Date.now() - i * 86_400_000).toISOString());
    dayList.push(byDay.get(key) || { key, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 });
  }
  const sortCost = (a, b) => b.cost - a.cost || b.requests - a.requests;
  return {
    days: dayList,
    models: [...byModel.values()].sort(sortCost),
    projects: [...byProject.values()].sort(sortCost),
    sessions: sessions.filter((s) => s.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, 30)
      .map(({ id, dir, cwd, title, cost, mtime }) => ({ id, dir, cwd, title, cost, mtime })),
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
