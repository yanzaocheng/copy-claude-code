// Two things: the transcript model that the local web console's live view uses (applyEvent, hydrate, transcriptItems,
// snapshotItems: a conversation as a list of items — user messages, assistant text, thinking, tool calls, other
// terminal output — that events update; the page, web/app.js, carries a copy of the reducer), and this session's
// connection to the gateway's session relay (RemoteControl), which carries the tasks of the account's sessions on
// other computers (`@公司 ...`, see peers.js) and of contacts. The session never listens on the network: it connects
// out to the gateway with the API key from /connect.

import os from 'node:os';
import crypto from 'node:crypto';
import { toolHeader, renderToolResult, bashModeLines } from './ui/render.js';
import { c } from './ui/ansi.js';
import { shownQuotes } from './ui/editor.js';

export const REMOTE_WIDTH = 100; // columns that tool headers and results are laid out for on the page
const SEED_ITEMS = 500;
const SNAPSHOT_ITEMS = 400; // sent in a snapshot
const SNAPSHOT_BYTES = 1_500_000; // ... at most: the gateway takes 2 MB a POST
const ITEM_CHARS = 60_000; // a longer text or output is cut down in a snapshot
const STATUS_MS = 500; // how often the status is compared with what the gateway has
const REQUEST_TIMEOUT_MS = 15_000;
const STREAM_SILENCE_MS = 50_000; // the gateway pings every 15 s: a command stream silent this long is dead

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

// ---------------------------------------------------------------- the connection to the gateway

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const newRemoteId = () => crypto.randomBytes(9).toString('base64url');

// Whether an interactive session logged in to the gateway goes online there (it does unless CLAUDE_PRO_ONLINE=0,
// which only the self-check and the tests set).
export const onlineEnabled = (env = process.env) => !/^(0|false|no|off)$/i.test(env.CLAUDE_PRO_ONLINE || '');

// This session at the gateway's session relay: registered while it runs, with a stream kept open on which the tasks
// of the account's sessions on other computers (and of contacts) and the 通讯录's news arrive, and its status (busy,
// name, title, directory, model: what the other sessions are shown of it). Nothing of the conversation goes there.
// (Until 2026-11-21 the transcript went there too, for the gateway's 远程控制 page, which is gone.)
export class RemoteControl {
  // gateway: {url, apiKey}. handlers: info() -> {name, title, cwd, model, version, machine, peerId}, status() -> object,
  // peerMessage(message) (false defers delivery), contactEvent(event), changed() (online changed), refused(status).
  constructor({ gateway, id, handlers, fetchImpl = globalThis.fetch }) {
    this.base = String(gateway.url).replace(/\/+$/, '');
    this.apiKey = gateway.apiKey;
    this.id = /^[\w-]{8,64}$/.test(id || '') ? id : newRemoteId();
    this.handlers = handlers;
    this.fetch = fetchImpl;
    this.online = false; // the stream is open
    this.closed = false;
    this.registered = false;
    this.refused = null; // the status (401/403) of the gateway refusing the key after the start: the connection ended
    this.seenPeer = new Set(); // ids of the messages from other sessions already handled (the gateway sends again what was not acknowledged)
    this.lastStatus = '';
    this.statusEpoch = 0;
    this.statusSending = false;
    this.statusTimer = null;
    this.streamAbort = null;
  }

  // `persistent`: keep trying when the gateway cannot be reached now (a restart); otherwise the first failure is thrown.
  async start({ persistent = false } = {}) {
    try {
      await this.register();
    } catch (e) {
      if (!persistent || e.status === 401 || e.status === 403) throw e;
    }
    this.loop();
    this.statusTimer = setInterval(() => this.flush(), STATUS_MS);
    this.statusTimer.unref?.();
    return this;
  }

  handoff() { return { id: this.id }; }

  // `retry: false`: not again after a failed connection (a task sent twice would be done twice).
  async request(method, route, body, { timeout = REQUEST_TIMEOUT_MS, retry = true } = {}) {
    const send = () => this.fetch(`${this.base}${route}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    let res;
    // Once more when the connection failed before any answer (a kept-alive socket the server had just closed).
    try { res = await send(); } catch (e) { if (!retry || e.name === 'TimeoutError' || this.closed) throw e; res = await send(); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || (typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`);
      throw Object.assign(new Error(res.status === 404 && route === '/v1/remote/sessions' ? `the gateway ${this.base} has no session relay (yet)` : String(message)), { status: res.status });
    }
    return data;
  }

  async register() {
    const info = this.handlers.info?.() || {};
    const data = await this.request('POST', '/v1/remote/sessions', { id: this.id, host: os.hostname(), ...info });
    if (data.id) this.id = data.id;
    this.registered = true;
    this.lastStatus = '';
    this.statusEpoch++;
  }

  // The stream, kept open (and opened again) until close(): while it is open the session is online.
  async loop() {
    let wait = 1000;
    while (!this.closed) {
      const began = Date.now();
      try {
        if (!this.registered) {
          await this.register();
          // closed while it registered (/disconnect, another account): the registration that just went through gets
          // the bye that close() could not send yet
          if (this.closed) {
            this.request('POST', `/v1/remote/sessions/${encodeURIComponent(this.id)}/events`, { messages: [{ t: 'bye', restarting: false }] }, { timeout: 1500 }).catch(() => {});
            break;
          }
        }
        await this.listen();
      } catch (e) {
        if (e.status === 404) this.registered = false; // the gateway forgot the session (restarted): register again
        if (e.status === 401 || e.status === 403) { this.refuse(e.status); break; }
      }
      if (this.online) {
        this.online = false;
        this.handlers.changed?.();
      }
      if (this.closed) break;
      // The backoff starts afresh only after a stream that held: one the gateway closes at once is not a recovery.
      if (Date.now() - began > 30_000) wait = 1000;
      await sleep(wait);
      wait = Math.min(wait * 2, 30_000);
    }
  }

  // The gateway refused the key (401/403: the key was revoked, the account changed): that does not get better by
  // retrying, so the connection ends and the App leaves this key alone until the login changes (handlers.refused).
  refuse(status) {
    if (this.closed) return;
    this.refused = status;
    this.closed = true;
    this.registered = false; // no bye with a key the gateway refuses
    this.online = false;
    clearInterval(this.statusTimer);
    this.streamAbort?.abort();
    try { this.handlers.refused?.(status); } catch { /* the App's problem */ }
    this.handlers.changed?.();
  }

  async listen() {
    if (this.closed) return;
    const abort = new AbortController();
    this.streamAbort = abort;
    const res = await this.fetch(`${this.base}/v1/remote/sessions/${encodeURIComponent(this.id)}/commands`, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (!res.ok) {
      res.body?.cancel?.().catch(() => {}); // or its socket stays open until garbage collection
      throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    }
    this.online = true;
    this.lastStatus = ''; // the gateway may have been restarted: it gets the status again
    this.statusEpoch++;
    this.handlers.changed?.();
    this.flush();
    let last = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - last > STREAM_SILENCE_MS) abort.abort(); }, 5000);
    watchdog.unref?.();
    try {
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        last = Date.now();
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let frame;
          try { frame = JSON.parse(data); } catch { continue; }
          this.frame(frame);
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) throw e;
    } finally {
      clearInterval(watchdog);
    }
  }

  frame(frame) {
    if (this.closed) return;
    // 通讯录: someone asked this account to be a contact, or accepted its request
    if (frame.type === 'contact') { try { this.handlers.contactEvent?.(frame); } catch { /* the App's problem */ } return; }
    if (frame.type === 'peer' && frame.cid) this.peerMessage(frame);
    // (anything else, such as an older gateway's page commands, is not this session's any more)
  }

  // ------------------------------------------------------------ messages of other sessions

  // A message from a session on another computer: handed to the App once, then acknowledged, so that the gateway
  // drops it from the session's mailbox (it sends what was not acknowledged again when the stream reconnects).
  peerMessage(cmd) {
    const ack = () => this.request('POST', `/v1/remote/sessions/${encodeURIComponent(this.id)}/results`, { cid: cmd.cid, ok: true }).catch(() => { /* sent again on reconnect, and dropped here as seen */ });
    if (this.seenPeer.has(cmd.cid)) { ack(); return; }
    try {
      const f = cmd.from || {};
      const machine = f.machine || f.host || 'computer';
      // a contact's session (another person's account): its 通讯号 and how this account takes its tasks
      const account = typeof f.account === 'string' && f.account ? f.account : null;
      const accepted = this.handlers.peerMessage?.({
        id: cmd.cid,
        kind: cmd.kind === 'reply' ? 'reply' : 'task',
        text: String(cmd.text ?? ''),
        inReplyTo: cmd.inReplyTo || null,
        from: {
          id: f.id, name: `${account ? `${account}:` : ''}${machine}/${f.name || 'session'}`, cwd: account ? '' : (f.cwd || ''), machine, remote: true,
          ...(account ? { account, trust: f.trust === 'auto' ? 'auto' : 'confirm' } : {}),
        },
      });
      if (accepted === false) {
        // A session moving into the console cannot take new work. Leave it in the mailbox for the next stream.
        this.streamAbort?.abort();
        return;
      }
    } catch { /* the App's problem: the message is acknowledged anyway, or it would come back forever */ }
    this.seenPeer.add(cmd.cid);
    if (this.seenPeer.size > 500) this.seenPeer.delete(this.seenPeer.values().next().value);
    ack();
  }

  // The sessions of this gateway account, on every computer, as the gateway lists them (this one included), and
  // the online sessions of the account's contacts (each with `account`, the contact's 通讯号).
  async sessions() {
    const data = await this.request('GET', '/v1/remote/sessions');
    return { own: Array.isArray(data?.data) ? data.data : [], contacts: Array.isArray(data?.contacts) ? data.contacts : [] };
  }

  // 通讯录 at the gateway: no action lists them ({handle, contacts: [{handle, status, trust, online}]}); handle,
  // add, accept, reject, remove, block, trust act ({handle[, trust]}) and answer with the list as it is then.
  async contacts(action = '', body = {}) {
    if (!action) return await this.request('GET', '/v1/remote/contacts');
    return await this.request('POST', `/v1/remote/contacts/${action}`, body, { retry: false });
  }

  // A message to another session of the account: resolves with {id} (the message's id, which a reply names).
  async sendPeer(targetId, { kind = 'task', text, inReplyTo = null }) {
    if (!this.registered) await this.register();
    const body = { from: this.id, kind, text, ...(inReplyTo ? { inReplyTo } : {}) };
    const data = await this.request('POST', `/v1/remote/sessions/${encodeURIComponent(targetId)}/messages`, body, { retry: false });
    return { id: data.id, delivered: data.delivered !== false };
  }

  // ------------------------------------------------------------ status

  // What the other sessions are shown of this one, sent when it changed (and again after the stream reopened).
  status() {
    let status = {};
    try { status = this.handlers.status?.() || {}; } catch { /* the basics stay as they were */ }
    const { busy, name, title, cwd, model } = status;
    return { busy: Boolean(busy), name, title, cwd, model };
  }

  async flush() {
    if (this.closed || !this.registered || !this.online || this.statusSending) return;
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    const epoch = this.statusEpoch;
    this.statusSending = true; // one POST at a time: an older status must not overtake a newer one
    try {
      await this.request('POST', `/v1/remote/sessions/${encodeURIComponent(this.id)}/events`, { messages: [{ t: 'status', status }] });
      if (!this.closed && epoch === this.statusEpoch) this.lastStatus = key;
    } catch (e) {
      if (this.closed || epoch !== this.statusEpoch) return;
      this.lastStatus = ''; // the gateway may or may not have received the POST; send the current status again
      if (e.status === 404) { this.registered = false; this.streamAbort?.abort(); }
      if (e.status === 401 || e.status === 403) this.refuse(e.status);
    } finally {
      this.statusSending = false;
    }
  }

  // Ends the connection; resolves once the gateway was told (or gave up waiting). `restarting`: the session comes
  // back at once with the same id.
  close({ restarting = false } = {}) {
    this.closeDone ??= this.shutdown(restarting);
    return this.closeDone;
  }

  async shutdown(restarting) {
    await null;
    this.closed = true;
    clearInterval(this.statusTimer);
    this.streamAbort?.abort();
    if (!this.registered) return;
    await this.request('POST', `/v1/remote/sessions/${encodeURIComponent(this.id)}/events`, { messages: [{ t: 'bye', restarting }] }, { timeout: 1500 }).catch(() => {});
  }
}
