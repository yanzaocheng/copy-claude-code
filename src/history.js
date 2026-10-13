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
