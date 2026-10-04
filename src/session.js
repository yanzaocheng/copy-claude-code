// Transcript persistence: ~/.ccc/projects/<project>/<session-id>.jsonl
// Each line is {type:'message', message} or {type:'reset', messages} (after /clear or compaction)
// or {type:'meta', ...}.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config.js';

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

// Persistent, model-maintained memory for this project (MEMORY.md + topic files).
export function autoMemoryDir(cwd) {
  return path.join(projectDir(cwd), 'memory');
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
  reset(messages) { this.append({ type: 'reset', messages, at: Date.now() }); }

  static load(file) {
    const messages = [];
    let meta = {};
    let title = null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'meta') meta = { ...meta, ...e };
      else if (e.type === 'message') {
        messages.push(e.message);
        if (!title && e.message.role === 'user') title = firstUserText(e.message);
      } else if (e.type === 'reset') messages.splice(0, messages.length, ...e.messages);
    }
    return { messages, meta, title };
  }

  static list(cwd) {
    const dir = projectDir(cwd);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
    return files.map((f) => {
      const file = path.join(dir, f);
      const st = fs.statSync(file);
      let title = null, count = 0;
      try {
        const loaded = SessionStore.load(file);
        title = loaded.title;
        count = loaded.messages.length;
      } catch { /* ignore */ }
      return { id: f.slice(0, -6), file, mtime: st.mtimeMs, title: title || '(no prompt)', count };
    }).filter((s) => s.count > 0).sort((a, b) => b.mtime - a.mtime);
  }
}

export function firstUserText(message) {
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  const t = blocks.find((b) => b.type === 'text' && !b.text.startsWith('<system-reminder>') && !b.text.startsWith('['));
  return t ? t.text.replace(/\s+/g, ' ').trim().slice(0, 100) : null;
}
