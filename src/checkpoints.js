// Checkpoints: before the agent edits a file (Write / Edit / NotebookEdit), the file's
// previous content is saved, grouped by the user prompt that led to the edit. /rewind can
// then put files back, rewind the conversation, or both. Changes made by shell commands
// (Bash) are not tracked.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { estimateTokens } from './agent.js';

const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;
const keyOf = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

export class CheckpointStore {
  // dir: where snapshot files are kept (created lazily).
  constructor(dir) {
    this.dir = dir;
    // {id, label, time, messageIndex, conversationValid, orphaned, files: [{path, existed, snap, skipped}]}
    this.entries = [];
    this.counter = 0;
    this.current = null;
  }

  // Start a checkpoint for a new user prompt. messageIndex is where its message will sit in
  // the conversation, so rewinding the conversation can cut it off there.
  beginTurn({ label, messageIndex }) {
    const entry = {
      id: ++this.counter,
      label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      time: Date.now(),
      messageIndex,
      conversationValid: true,
      orphaned: false,
      files: [],
    };
    this.entries.push(entry);
    this.current = entry;
    return entry;
  }

  // Record `file` as it is now, once per checkpoint. Call before the file is changed.
  track(file) {
    const entry = this.current;
    if (!entry) return;
    const abs = path.resolve(file);
    if (entry.files.some((f) => keyOf(f.path) === keyOf(abs))) return;
    let stat = null;
    try { stat = fs.statSync(abs); } catch { /* does not exist yet */ }
    if (!stat) { entry.files.push({ path: abs, existed: false }); this.writeIndex(); return; }
    if (!stat.isFile()) return;
    if (stat.size > MAX_SNAPSHOT_BYTES) { entry.files.push({ path: abs, existed: true, skipped: true }); return; }
    const snap = `${entry.id}-${crypto.createHash('sha1').update(abs).digest('hex').slice(0, 12)}`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.copyFileSync(abs, path.join(this.dir, snap));
      entry.files.push({ path: abs, existed: true, snap });
      this.writeIndex();
    } catch {
      entry.files.push({ path: abs, existed: true, skipped: true });
    }
  }

  // Checkpoints that are part of the current conversation, newest first.
  list() { return this.entries.filter((e) => !e.orphaned).reverse(); }
  get(id) { return this.entries.find((e) => e.id === id); }

  // Files that rewinding to `id` would put back: every file touched by that checkpoint or a later one.
  filesSince(id) {
    const seen = new Map();
    for (const e of this.entries) {
      if (e.id < id) continue;
      for (const f of e.files) if (!seen.has(keyOf(f.path))) seen.set(keyOf(f.path), f.path);
    }
    return [...seen.values()];
  }

  // Put every file touched since `id` back to how it was before that checkpoint.
  // The oldest snapshot of each file decides its final state. Returns {restored, removed, skipped}.
  restoreCode(id) {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) throw new Error(`No checkpoint ${id}`);
    const oldest = new Map();
    for (let i = idx; i < this.entries.length; i++) {
      for (const f of this.entries[i].files) if (!oldest.has(keyOf(f.path))) oldest.set(keyOf(f.path), f);
    }
    const result = { restored: [], removed: [], skipped: [] };
    for (const f of oldest.values()) {
      try {
        if (f.skipped) { result.skipped.push(f.path); continue; }
        if (f.existed) {
          fs.mkdirSync(path.dirname(f.path), { recursive: true });
          fs.copyFileSync(path.join(this.dir, f.snap), f.path);
          result.restored.push(f.path);
        } else {
          fs.rmSync(f.path, { force: true });
          result.removed.push(f.path);
        }
      } catch (e) {
        result.skipped.push(`${f.path} (${e.message})`);
      }
    }
    // Those changes no longer exist on disk, so later checkpoints have nothing left to undo.
    for (let i = idx; i < this.entries.length; i++) this.entries[i].files = [];
    this.writeIndex();
    return result;
  }

  // Forget checkpoint `id` and everything after it (their turns were removed from the conversation).
  discardFrom(id) {
    this.entries = this.entries.filter((e) => e.id < id);
    this.current = this.entries[this.entries.length - 1] || null;
    this.writeIndex();
  }

  // The conversation was rewound to before `id` but the files were left alone: keep the
  // snapshots (the edits are still on disk) but stop listing those turns.
  orphanFrom(id) {
    for (const e of this.entries) if (e.id >= id) e.orphaned = true;
    this.writeIndex();
  }

  // The conversation was compacted or replaced: it can no longer be rewound to older points,
  // but file snapshots remain valid.
  markConversationStale() {
    for (const e of this.entries) e.conversationValid = false;
  }

  reset() {
    this.entries = [];
    this.current = null;
    this.writeIndex();
  }

  writeIndex() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(this.entries, null, 1));
    } catch { /* best effort: the index only helps manual recovery */ }
  }
}

// Apply a rewind to a running agent. mode: 'both' | 'code' | 'conversation'.
// Returns {restore, prompt, conversation}: what was restored, the prompt text (so the UI can put it
// back in the input box) and whether the conversation was cut.
export function rewind(agent, store, id, mode = 'both') {
  const entry = store.get(id);
  if (!entry) throw new Error(`No checkpoint ${id}`);
  if (mode !== 'code' && !entry.conversationValid) {
    throw new Error('The conversation was compacted after this point, so it can no longer be rewound to it. You can still restore the code.');
  }
  const out = { restore: null, prompt: entry.label, conversation: false };
  if (mode !== 'conversation') {
    out.restore = store.restoreCode(id);
    // Files changed behind the agent's back: make it read them again before editing.
    agent.fileState.clear();
  }
  if (mode !== 'code') {
    agent.replaceMessages(agent.messages.slice(0, entry.messageIndex));
    agent.todos = [];
    agent.lastContextTokens = estimateTokens(agent.messages);
    agent.tokensSinceUsage = 0;
    if (mode === 'both') store.discardFrom(id); else store.orphanFrom(id);
    out.conversation = true;
  } else {
    agent.pushMessage({
      role: 'user',
      content: [{ type: 'text', text: `<system-reminder>The user rewound the code: ${out.restore.restored.length} file(s) were restored to their state before the prompt "${entry.label}" and ${out.restore.removed.length} file(s) created since then were deleted. Files may differ from what you last read; read them again before editing.</system-reminder>` }],
    });
  }
  return out;
}
