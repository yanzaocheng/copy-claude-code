// The conversations kept on this computer (CONFIG_DIR/projects/<directory>/<id>.jsonl, see session.js), for the web
// page's history (the computer service's `history` command): newest first, searched by title and first message,
// a page at a time. A file is read once for as long as it does not change (a session file can be tens of MB): its
// messages are counted without parsing them, only the first prompt and the meta lines are.

import fs from 'node:fs';
import path from 'node:path';
import { firstUserText, projectDir } from './session.js';

const cache = new Map(); // file -> {mtimeMs, size, summary}

// {conversationId, cwd, title, firstPrompt, messages, updatedAt} of one session file, or null when it has none.
export function conversationSummary(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let cwd = null;
  let name = null;
  let topic = null;
  let first = null;
  let messages = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('{"type":"message"')) {
      messages++;
      if (!first && line.includes('"role":"user"')) {
        try { first = firstUserText(JSON.parse(line).message) || null; } catch { /* a broken line */ }
      }
      continue;
    }
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'meta') {
      if (cwd === null && typeof e.cwd === 'string') cwd = e.cwd;
      if ('name' in e) name = typeof e.name === 'string' && e.name.trim() ? e.name : null;
      if (typeof e.topic === 'string' && e.topic.trim()) topic = e.topic;
    } else if (e.type === 'reset' && Array.isArray(e.messages)) {
      messages = e.messages.length;
    } else if (e.type === 'message') {
      messages++;
      if (!first && e.message?.role === 'user') first = firstUserText(e.message) || null;
    }
  }
  const summary = messages ? {
    conversationId: path.basename(file, '.jsonl'),
    cwd,
    title: name || topic || first || '(no prompt)',
    firstPrompt: first || '',
    messages,
    updatedAt: new Date(st.mtimeMs).toISOString(),
  } : null;
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return summary;
}

// {items: [{conversationId, cwd, title, updatedAt, messages, sessionId?}], more}. `cwd`: only that directory's
// conversations. `before`: older than this time (ISO), for the next page. `open`: conversationId -> the id at the
// gateway of the session it is open in.
export function listConversations({ projects, query = '', cwd = null, limit = 50, before = null, open = new Map() } = {}) {
  const max = Math.max(1, Math.min(200, Number(limit) || 50));
  const until = before ? Date.parse(before) : Infinity;
  const q = String(query || '').trim().toLowerCase();
  const dirs = cwd ? [projectDir(cwd)] : (() => {
    try { return fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(projects, d.name)); } catch { return []; }
  })();
  const files = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of names) {
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs < until) files.push({ file, mtimeMs: st.mtimeMs });
      } catch { /* gone meanwhile */ }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const items = [];
  let more = false;
  for (const { file } of files) {
    const s = conversationSummary(file);
    if (!s) continue;
    if (q && !`${s.title}\n${s.firstPrompt}`.toLowerCase().includes(q)) continue;
    if (items.length === max) { more = true; break; }
    const sessionId = open.get(s.conversationId);
    items.push({ conversationId: s.conversationId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt, messages: s.messages, ...(sessionId ? { sessionId } : {}) });
  }
  return { items, more };
}

// A conversation's id as it may be used in a path: what SessionStore makes (a UUID), letters, digits, - and _ in
// any case. Anything else (a dot, a slash: "../x") is refused before it gets near a path.
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

// Delete what this computer keeps of the conversation `id` (the web page's "delete"): its session file (in every
// project it is in: /cd moves it), the tool results saved for it (the outputs too long for the conversation, named
// after its tool calls or referred to by path in it) and its checkpoints (the file snapshots of /rewind, tagged
// with the conversation they belong to). What belongs to the project stays: its memory, CLAUDE.md, the input
// history, the checkpoints of other conversations. `extra`: more files to delete (a background session's log).
// Returns {files, bytes}; throws when there is no such conversation.
export function deleteConversation({ projects, id, extra = [] }) {
  if (!CONVERSATION_ID.test(String(id || ''))) throw new Error('对话 id 不对');
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(projects, d.name)); } catch { /* none */ }
  const sessionFiles = dirs.map((d) => path.join(d, `${id}.jsonl`)).filter((f) => fs.existsSync(f));
  if (!sessionFiles.length) throw new Error('这台电脑上没有这段对话');
  // the tool results it saved: <tool call id>.txt (persistLargeOutput) and bash-<time>-<random>.txt (the Bash tool)
  const names = new Set();
  for (const file of sessionFiles) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/"(?:tool_use_id|id)":"([^"]{1,200})"/g)) names.add(`${m[1].replace(/[^\w-]/g, '_')}.txt`);
    for (const m of text.matchAll(/bash-\d+-[a-z0-9]+\.txt/g)) names.add(m[0]);
  }
  const doomed = [...sessionFiles, ...extra];
  const rewrites = []; // checkpoint indexes that keep other conversations' entries
  for (const dir of dirs) {
    const results = path.join(dir, 'tool-results');
    for (const name of names) {
      const f = path.join(results, name);
      if (fs.existsSync(f)) doomed.push(f);
    }
    let runs = [];
    try { runs = fs.readdirSync(path.join(dir, 'checkpoints')); } catch { continue; }
    for (const run of runs) {
      const runDir = path.join(dir, 'checkpoints', run);
      let entries;
      try { entries = JSON.parse(fs.readFileSync(path.join(runDir, 'index.json'), 'utf8')); } catch { continue; }
      if (!Array.isArray(entries) || !entries.some((e) => e?.conversation === id)) continue;
      const kept = entries.filter((e) => e?.conversation !== id);
      for (const e of entries) {
        if (e?.conversation !== id) continue;
        for (const f of e.files || []) if (f?.snap && /^[\w-]+$/.test(f.snap)) doomed.push(path.join(runDir, f.snap));
      }
      if (kept.length) rewrites.push({ file: path.join(runDir, 'index.json'), entries: kept });
      else doomed.push(path.join(runDir, 'index.json'), runDir);
    }
  }
  let files = 0;
  let bytes = 0;
  const failed = [];
  for (const f of doomed) {
    try {
      const st = fs.statSync(f);
      if (st.isDirectory()) { fs.rmSync(f, { recursive: true, force: true }); continue; }
      fs.rmSync(f);
      files++;
      bytes += st.size;
    } catch (e) {
      if (e.code !== 'ENOENT') failed.push(`${path.basename(f)}: ${e.code || e.message}`);
    }
  }
  for (const r of rewrites) {
    try { fs.writeFileSync(r.file, JSON.stringify(r.entries, null, 1)); } catch (e) { failed.push(`${r.file}: ${e.code || e.message}`); }
  }
  if (sessionFiles.some((f) => fs.existsSync(f))) throw new Error(`删除失败：${failed.join('；') || '会话文件还在'}`);
  return { files, bytes, ...(failed.length ? { failed } : {}) };
}
