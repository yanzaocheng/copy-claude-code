// The transcript model that the local web console's live view uses (applyEvent, hydrate, transcriptItems,
// snapshotItems): a conversation as a list of items — user messages, assistant text, thinking, tool calls, other
// terminal output — that events update; the page, web/js/transcript.js, carries a copy of the reducer. (Until
// 2026-11-26 this file also held the session's connection to the gateway's session relay, by account: the paired
// computers of relay.js and devices.js took its place.)

import { toolHeader, renderToolResult, bashModeLines } from './ui/render.js';
import { c } from './ui/ansi.js';
import { shownQuotes } from './ui/editor.js';

export const REMOTE_WIDTH = 100; // columns that tool headers and results are laid out for on the page
const SEED_ITEMS = 500;
const SNAPSHOT_ITEMS = 400; // sent in a snapshot
const SNAPSHOT_BYTES = 1_500_000; // ... at most: the gateway takes 2 MB a POST
const ITEM_CHARS = 60_000; // a longer text or output is cut down in a snapshot

// ---------------------------------------------------------------- the transcript model (shared with the page)

// state = {items, open, tools}: `open` is the text or thinking item being streamed, `tools` the running tool items by id.
// Returns the item the event changed (null when none). Self-contained: its source is sent to the page as it is.
export function applyEvent(state, ev) {
  const items = state.items;
  const push = (item) => { items.push(item); return item; };
  switch (ev.t) {
    case 'user': return push({ k: 'user', text: ev.text });
    case 'image': return push({ k: 'image', n: ev.n }); // (the local web console's: the gateway's page is not sent these)
    case 'output': {
      const last = items[items.length - 1];
      if (last && last.k === 'output') { last.lines.push(...ev.lines); return last; }
      return push({ k: 'output', lines: ev.lines.slice() });
    }
    case 'start':
      if (state.open) state.open.open = false;
      state.open = push({ k: ev.kind === 'thinking' ? 'thinking' : 'text', text: '', open: true });
      return state.open;
    case 'delta':
      if (!state.open) state.open = push({ k: ev.kind === 'thinking' ? 'thinking' : 'text', text: '', open: true });
      state.open.text += ev.text;
      return state.open;
    case 'stop': {
      const it = state.open;
      if (!it) return null;
      it.open = false;
      state.open = null;
      return it;
    }
    case 'tool': {
      const it = push({ k: 'tool', id: ev.id, head: ev.head, status: 'running', progress: '', sub: [], subCount: 0, lines: [] });
      state.tools[ev.id] = it;
      return it;
    }
    case 'progress': {
      const it = state.tools[ev.id];
      if (!it || it.status !== 'running') return null;
      it.progress = ev.text;
      return it;
    }
    case 'sub': {
      const it = state.tools[ev.id];
      if (!it || it.status !== 'running') return null;
      it.sub.push(ev.head);
      if (it.sub.length > 3) it.sub.shift();
      it.subCount++;
      return it;
    }
    case 'done': {
      const it = state.tools[ev.id] || push({ k: 'tool', id: ev.id, sub: [], subCount: 0 });
      it.head = ev.head ?? it.head;
      it.status = ev.status;
      it.lines = ev.lines || [];
      it.progress = '';
      delete state.tools[ev.id];
      return it;
    }
    default: return null;
  }
}

export function hydrate(items) {
  const state = { items, open: null, tools: {} };
  for (const it of items) {
    if (it.open) state.open = it;
    if (it.k === 'tool' && it.status === 'running') state.tools[it.id] = it;
  }
  return state;
}

// What a user message of the conversation looks like on the page: without the notes for the model, a quote as its
// first lines (see Editor.insertQuote).
function shownUserText(text) {
  return shownQuotes(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<peer-message from="([^"]*)" kind="(task|reply)">\n?/g, (_, from, kind) => `✉ ${kind === 'reply' ? 'answer from' : 'task from'} @${from}: `)
    .replace(/\n?<\/peer-message>/g, '')
    .trim();
}

// Transcript items for a conversation (agent.messages), as the page shows them when it connects.
// `limit`: the newest items kept (the web console's history view takes them all); `images`: an image is {k: 'image', n}
// (the n-th image of the conversation) instead of the text [image]; `turns`: the lines shown where turns ended
// ([{after, text}], see SessionStore.turnEnd), each put back after its message as the terminal printed it.
export function transcriptItems(messages, { tools = [], ctx, cwd, width = REMOTE_WIDTH, limit = SEED_ITEMS, images = false, turns = [] } = {}) {
  let imageCount = 0;
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const items = [];
  const calls = new Map();
  const ends = new Map();
  for (const t of turns || []) if (t?.text && Number.isInteger(t.after)) ends.set(t.after, [...(ends.get(t.after) || []), t.text]);
  const list = messages || [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    for (const text of ends.get(i) || []) items.push({ k: 'output', lines: [c.dim(text), ''] }); // (after the first i messages)
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
    for (const b of blocks) {
      if (m.role === 'user') {
        if (b.type === 'text') {
          const raw = String(b.text || '');
          if (raw.startsWith('This session is being continued')) { items.push({ k: 'summary', text: raw }); continue; }
          const bash = bashModeLines(raw); // `!command`: as it was shown when it ran
          if (bash) { items.push({ k: 'output', lines: [...bash, ''] }); continue; }
          const text = raw.startsWith('<system-reminder>') ? '' : shownUserText(raw);
          if (text) items.push({ k: 'user', text });
        } else if (b.type === 'image') {
          items.push(images ? { k: 'image', n: imageCount++ } : { k: 'user', text: '[image]' });
        } else if (b.type === 'tool_result') {
          const call = calls.get(b.tool_use_id);
          if (!call) continue;
          let lines = [];
          try { lines = renderToolResult({ tool: call.tool, input: call.input, result: { content: b.content, isError: Boolean(b.is_error) } }, { width, cwd }); } catch { /* shown without */ }
          Object.assign(call.item, { status: b.is_error ? 'error' : 'done', lines });
        }
      } else if (m.role === 'assistant') {
        if (b.type === 'text' && b.text?.trim()) items.push({ k: 'text', text: b.text });
        else if (b.type === 'thinking' && b.thinking?.trim()) items.push({ k: 'thinking', text: b.thinking });
        else if (b.type === 'tool_use') {
          const tool = toolMap.get(b.name) || { name: b.name };
          let head = b.name;
          try { head = toolHeader(tool, b.input, ctx, { width, dot: false }); } catch { /* the name will do */ }
          const item = { k: 'tool', id: b.id, head, status: 'done', sub: [], subCount: 0, lines: [] };
          calls.set(b.id, { item, tool, input: b.input });
          items.push(item);
        }
      }
    }
  }
  for (const text of ends.get(list.length) || []) items.push({ k: 'output', lines: [c.dim(text), ''] });
  return Number.isFinite(limit) ? items.slice(-limit) : items;
}

// The newest items that fit in a snapshot the gateway takes, as copies (the POST may be serialized later, when
// the live items have moved on, and the events after the snapshot's seq would then be applied twice). Very long
// texts and outputs are cut down, and the oldest items are left out until it fits.
export function snapshotItems(items, { max = SNAPSHOT_ITEMS, bytes = SNAPSHOT_BYTES } = {}) {
  const half = ITEM_CHARS / 2;
  const clip = (it) => {
    const out = { ...it };
    if (typeof out.text === 'string' && out.text.length > ITEM_CHARS) out.text = `${out.text.slice(0, half)}\n…\n${out.text.slice(-half)}`;
    if (Array.isArray(out.lines)) {
      let lines = out.lines.map((l) => (String(l).length > 2000 ? `${String(l).slice(0, 2000)}…` : l));
      if (lines.length > 300) lines = [...lines.slice(0, 100), `… ${lines.length - 300} lines …`, ...lines.slice(-200)];
      out.lines = lines;
    }
    return out;
  };
  const picked = [];
  let size = 0;
  for (let i = items.length - 1; i >= 0 && picked.length < max; i--) {
    const json = JSON.stringify(clip(items[i]));
    size += Buffer.byteLength(json) + 1;
    if (size > bytes) break;
    picked.push(JSON.parse(json));
  }
  return picked.reverse();
}
