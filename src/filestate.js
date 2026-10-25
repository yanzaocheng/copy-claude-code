// Rebuild the "files the model has read" map from a restored transcript.
//
// Edit and Write refuse a file the model has not read in this process. A resumed conversation
// starts with an empty map, so the first edit of every file the model remembers reading (it is in
// the transcript) would be refused with "File has not been read yet", costing a wasted tool call.
//
// A file counts as known only if it has not changed on disk since the tool call that showed it
// (or wrote it) finished. Anything modified afterwards, for example by the user while the session
// was closed, has to be read again, so the model never overwrites changes it has not seen.
// Whether a read covered the whole file is restored too: Write refuses a partly read file.

import fs from 'node:fs';
import { resolvePath } from './utils/paths.js';

const TRACKED = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SLACK_MS = 2000; // file timestamps can be coarser than the clock that stamped the message

const resultText = (content) => (typeof content === 'string' ? content : '');

// Did this Read leave part of the file unseen? (Mirrors what ReadTool records as `partial`.)
function readWasPartial(input, text) {
  return Number(input?.offset) > 1
    || /\(File has \d+ lines total; showing lines /.test(text)
    || /\[output cut at \d+ characters/.test(text);
}

// messages: the restored conversation. times: when each message was stored (ms since epoch,
// parallel to `messages`; 0 or missing means unknown, which is never trusted).
export function rebuildFileState(messages, times = [], cwd = process.cwd()) {
  const calls = new Map(); // tool_use id -> {name, input, file}
  const seen = new Map(); // path -> {at: time of the latest successful call, partial}
  messages.forEach((m, i) => {
    if (!Array.isArray(m?.content)) return;
    for (const b of m.content) {
      if (m.role === 'assistant' && b.type === 'tool_use' && TRACKED.has(b.name)) {
        const p = b.input?.file_path ?? b.input?.notebook_path;
        if (typeof p === 'string' && p.trim()) calls.set(b.id, { name: b.name, input: b.input, file: resolvePath(p, cwd) });
      } else if (m.role === 'user' && b.type === 'tool_result' && !b.is_error && calls.has(b.tool_use_id)) {
        const { name, input, file } = calls.get(b.tool_use_id);
        const text = resultText(b.content);
        const prior = seen.get(file);
        let partial;
        if (name === 'Read') partial = readWasPartial(input, text);
        else if (name === 'Write' || /File created successfully/.test(text)) partial = false;
        else partial = prior?.partial ?? true; // an edit shows nothing beyond the text it replaced
        seen.set(file, { at: Math.max(prior?.at ?? 0, times[i] || 0), partial });
      }
    }
  });
  const state = new Map();
  for (const [file, { at, partial }] of seen) {
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    if (at > 0 && mtimeMs <= at + SLACK_MS) state.set(file, { mtimeMs, partial });
  }
  return state;
}
