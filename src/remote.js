// Remote control: watch and steer an interactive session from a browser (a phone, another computer), as Claude
// Code's /remote-control does with claude.ai; here every session of a computer logged in to the gateway is online
// there, without a command. The session never listens on the network: it connects out to the
// codex-gateway the user is logged in to (with the gateway API key of /login), which relays between it and the
// gateway's user pages ("远程控制", for the same account only). See the protocol in ARCHITECTURE.md (3.1.2).
// The same connection carries the messages of the account's sessions on other computers (`@公司 ...`, see peers.js).
//
// The page is told what happens as a list of transcript items (user messages, assistant text, thinking, tool
// calls, other terminal output) that events update. The same reducer (applyEvent) runs here, to send a snapshot
// when one is needed, and in the page, which carries a copy of it.

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { stripAnsi } from './ui/ansi.js';
import { toolHeader, renderToolResult } from './ui/render.js';
import { uploadFile, downloadFile } from './transfer.js';

export const REMOTE_WIDTH = 100; // columns that tool headers and results are laid out for on the page
const MAX_ITEMS = 800; // kept for a snapshot; the oldest are dropped beyond that
const SEED_ITEMS = 500;
const SNAPSHOT_ITEMS = 400; // sent in a snapshot
const SNAPSHOT_BYTES = 1_500_000; // ... at most: the gateway takes 2 MB a POST
const ITEM_CHARS = 60_000; // a longer text or output is cut down in a snapshot
const SNAPSHOT_EVERY = 500; // events after which a fresh snapshot replaces them on the gateway
const FLUSH_MS = 150;
const STATUS_MS = 500; // how often the status is compared with what the gateway has
const IDLE_STATUS_MS = 3000; // ... and sent at most this often while nobody watches
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

// What a user message of the conversation looks like on the page: without the notes for the model.
function shownUserText(text) {
  return String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<peer-message from="([^"]*)" kind="(task|reply)">\n?/g, (_, from, kind) => `✉ ${kind === 'reply' ? 'answer from' : 'task from'} &${from}: `)
    .replace(/\n?<\/peer-message>/g, '')
    .trim();
}

// Transcript items for a conversation (agent.messages), as the page shows them when it connects.
export function transcriptItems(messages, { tools = [], ctx, cwd, width = REMOTE_WIDTH } = {}) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const items = [];
  const calls = new Map();
  for (const m of messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
    for (const b of blocks) {
      if (m.role === 'user') {
        if (b.type === 'text') {
          const raw = String(b.text || '');
          if (raw.startsWith('This session is being continued')) { items.push({ k: 'summary', text: raw }); continue; }
          const text = raw.startsWith('<system-reminder>') ? '' : shownUserText(raw);
          if (text) items.push({ k: 'user', text });
        } else if (b.type === 'image') {
          items.push({ k: 'user', text: '[image]' });
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
  return items.slice(-SEED_ITEMS);
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

// The last lines of a running tool's output, for the page.
function progressTail(text) {
  const lines = String(text || '').slice(-6000).replace(/\r\n/g, '\n').trimEnd().split('\n');
  return lines.slice(-8).map((l) => l.replace(/^.*\r/, '').slice(0, 400)).join('\n');
}

// ---------------------------------------------------------------- the connection to the gateway

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const newRemoteId = () => crypto.randomBytes(9).toString('base64url');

// Whether an interactive session logged in to the gateway goes online there (it does unless CLAUDE_PRO_ONLINE=0,
// which only the self-check and the tests set).
export const onlineEnabled = (env = process.env) => !/^(0|false|no|off)$/i.test(env.CLAUDE_PRO_ONLINE || '');

export class RemoteControl {
  // gateway: {url, apiKey}. handlers: info() -> {name, title, cwd, model}, seed() -> items, status() -> object,
  // send(text, images), interrupt(), answer(body), options(body), suggest(body), list(body) (each returns an object
  // or a promise of one, or throws), changed() (online or viewers changed).
  constructor({ gateway, id, handlers, fetchImpl = globalThis.fetch }) {
    this.base = String(gateway.url).replace(/\/+$/, '');
    this.apiKey = gateway.apiKey;
    this.id = /^[\w-]{8,64}$/.test(id || '') ? id : newRemoteId();
    this.handlers = handlers;
    this.fetch = fetchImpl;
    this.url = null; // the session's page on the gateway
    this.online = false; // the command stream is open
    this.viewers = null; // pages watching, as the gateway counts them (null: not told yet)
    this.closed = false;
    this.seq = 0;
    this.state = hydrate(handlers.seed?.() || []);
    this.events = []; // waiting to be uploaded
    this.progress = new Map(); // tool id -> its live entry, whose output goes out at the next flush
    this.outbox = []; // messages for the next POST /events
    this.sending = false;
    this.needSnapshot = true;
    this.sinceSnapshot = 0;
    this.lastStatus = '';
    this.lastStatusAt = 0;
    this.flushTimer = null;
    this.streamAbort = null;
    this.registered = false;
    this.seenPeer = new Set(); // ids of the messages from other sessions already handled (the gateway sends again what was not acknowledged)
    this.peerPending = new Set(); // messages being handled now, acknowledged when done
    this.replying = new Set(); // answers to the page's commands on their way
  }

  get viewing() { return this.viewers !== 0; } // nobody watching: events are not uploaded (a snapshot follows when someone comes)

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
    // Once more when the connection failed before any answer (a kept-alive socket the server had just closed):
    // every request here can be repeated (registering is idempotent, the pages drop events they already have).
    try { res = await send(); } catch (e) { if (!retry || e.name === 'TimeoutError' || this.closed) throw e; res = await send(); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || (typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`);
      throw Object.assign(new Error(res.status === 404 && route === '/v1/remote/sessions' ? `the gateway ${this.base} does not offer remote control (yet)` : String(message)), { status: res.status });
    }
    return data;
  }

  async register() {
    const info = this.handlers.info?.() || {};
    const data = await this.request('POST', '/v1/remote/sessions', { id: this.id, host: os.hostname(), version: info.version, ...info });
    if (data.id) this.id = data.id;
    this.url = data.url || this.url || `${this.base}/user`;
    this.registered = true;
    this.needSnapshot = true;
  }

  // The command stream, kept open (and opened again) until close(): while it is open the session is online.
  async loop() {
    let wait = 1000;
    while (!this.closed) {
      try {
        if (!this.registered) await this.register();
        await this.listen();
        wait = 1000;
      } catch (e) {
        if (e.status === 404) this.registered = false; // the gateway forgot the session (restarted): register again
      }
      if (this.online) { this.online = false; this.handlers.changed?.(); }
      if (this.closed) break;
      await sleep(wait);
      wait = Math.min(wait * 2, 30_000);
    }
  }

  async listen() {
    const abort = new AbortController();
    this.streamAbort = abort;
    const res = await this.fetch(`${this.base}/v1/remote/sessions/${encodeURIComponent(this.id)}/commands`, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    this.online = true;
    this.needSnapshot = true; // the gateway may have been restarted: it gets the whole conversation again
    this.handlers.changed?.();
    this.scheduleFlush(0);
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
          let cmd;
          try { cmd = JSON.parse(data); } catch { continue; }
          this.command(cmd);
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) throw e;
    } finally {
      clearInterval(watchdog);
    }
  }

  command(cmd) {
    if (cmd.type === 'viewers') {
      const was = this.viewers;
      this.viewers = Math.max(0, Number(cmd.count) || 0);
      if (!was && this.viewers) this.needSnapshot = true; // someone came: what they see starts from now
      this.handlers.changed?.();
      this.scheduleFlush(0);
      return;
    }
    if (cmd.type === 'snapshot') { this.needSnapshot = true; this.scheduleFlush(0); return; }
    if (!cmd.cid) return;
    if (cmd.type === 'peer') { this.peerMessage(cmd); return; }
    // close() waits for it: a /cd from the page restarts the session before its answer goes out
    const reply = (result) => {
      const sent = this.request('POST', `/v1/remote/sessions/${encodeURIComponent(this.id)}/results`, result).catch(() => { /* the page times out */ });
      this.replying.add(sent);
      sent.finally(() => this.replying.delete(sent));
      this.scheduleFlush(30);
    };
    const failed = (e) => reply({ cid: cmd.cid, ok: false, error: e?.message || String(e) });
    let r;
    try {
      const body = cmd.body && typeof cmd.body === 'object' ? cmd.body : {};
      // send, interrupt and dialog act; options, suggest and list only look (and are answered while it works)
      if (cmd.type === 'send') r = this.handlers.send(String(body.text ?? ''), body.images);
      else if (cmd.type === 'interrupt') r = this.handlers.interrupt();
      else if (cmd.type === 'dialog') r = this.handlers.answer(body);
      else if (cmd.type === 'options' && this.handlers.options) r = this.handlers.options(body);
      else if (cmd.type === 'suggest' && this.handlers.suggest) r = this.handlers.suggest(body);
      else if (cmd.type === 'list' && this.handlers.list) r = this.handlers.list(body);
      else if (cmd.type === 'output' && this.handlers.output) r = this.handlers.output(body);
      else throw new Error(`Unknown command: ${cmd.type}`);
    } catch (e) {
      failed(e);
      return;
    }
    // an answer that takes a while (a list of models from the gateway, a directory) is sent when it is there
    if (typeof r?.then === 'function') r.then((v) => reply({ cid: cmd.cid, ok: true, ...(v || {}) }), failed);
    else reply({ cid: cmd.cid, ok: true, ...(r || {}) });
  }

  // ------------------------------------------------------------ messages of the account's other sessions

  // A message from a session on another computer: handed to the App once, then acknowledged, so that the gateway
  // drops it from the session's mailbox (it sends what was not acknowledged again when the stream reconnects).
  peerMessage(cmd) {
    if (this.peerPending.has(cmd.cid)) return; // still being handled (files on their way): acknowledged when done
    const ack = () => this.request('POST', `/v1/remote/sessions/${encodeURIComponent(this.id)}/results`, { cid: cmd.cid, ok: true }).catch(() => { /* sent again on reconnect, and dropped here as seen */ });
    let handling = null;
    try {
      if (this.seenPeer.has(cmd.cid)) return;
      this.seenPeer.add(cmd.cid);
      if (this.seenPeer.size > 500) this.seenPeer.delete(this.seenPeer.values().next().value);
      const f = cmd.from || {};
      const machine = f.machine || f.host || 'computer';
      const files = (Array.isArray(cmd.files) ? cmd.files : [])
        .filter((x) => x && typeof x.id === 'string')
        .map((x) => ({ id: x.id, name: String(x.name || 'file'), size: Number(x.size) || 0, sha256: typeof x.sha256 === 'string' ? x.sha256 : null }));
      handling = this.handlers.peerMessage?.({
        id: cmd.cid,
        kind: cmd.kind === 'reply' ? 'reply' : 'task',
        text: String(cmd.text ?? ''),
        inReplyTo: cmd.inReplyTo || null,
        from: { id: f.id, name: `${machine}/${f.name || 'session'}`, cwd: f.cwd || '', machine, remote: true },
        ...(files.length ? { files } : {}),
      });
    } catch { /* the App's problem: the message is acknowledged anyway, or it would come back forever */ } finally {
      if (typeof handling?.then === 'function') {
        // until it is done the gateway keeps it: a session that ends meanwhile gets it again, and continues
        this.peerPending.add(cmd.cid);
        handling.catch(() => {}).finally(() => { this.peerPending.delete(cmd.cid); if (!this.closed) ack(); });
      } else {
        ack();
      }
    }
  }

  // The sessions of this gateway account, on every computer, as the gateway lists them (this one included).
  async sessions() {
    const data = await this.request('GET', '/v1/remote/sessions');
    return Array.isArray(data?.data) ? data.data : [];
  }

  // A message to another session of the account: resolves with {id} (the message's id, which a reply names).
  // `files`: uploaded ones ({id}, see uploadFile), which the gateway hands over with the message.
  async sendPeer(targetId, { kind = 'task', text, inReplyTo = null, files = [] }) {
    if (!this.registered) await this.register();
    const body = { from: this.id, kind, text, ...(inReplyTo ? { inReplyTo } : {}), ...(files.length ? { files: files.map((x) => ({ id: x.id })) } : {}) };
    const data = await this.request('POST', `/v1/remote/sessions/${encodeURIComponent(targetId)}/messages`, body, { retry: false });
    return { id: data.id, delivered: data.delivered !== false };
  }

  // ------------------------------------------------------------ files (for another computer's session)

  get client() { return { base: this.base, apiKey: this.apiKey, fetch: this.fetch }; }

  // A file of this computer (`{path, name, size}`) onto the gateway, resumably (see transfer.js): resolves with
  // {id, name, size, sha256}, which a message's files refer to.
  uploadFile(file, options) { return uploadFile(this.client, file, options); }

  // A file another session sent (`{id, name, size, sha256}`) into `dir`: resolves with the path it got.
  downloadFile(file, dir, options) { return downloadFile(this.client, file, dir, options); }

  deleteFile(id) {
    return this.fetch(`${this.base}/v1/remote/files/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).then(() => {}, () => {});
  }

  // ------------------------------------------------------------ events

  emit(ev) {
    ev.seq = ++this.seq;
    applyEvent(this.state, ev);
    if (this.state.items.length > MAX_ITEMS) this.state.items.splice(0, this.state.items.length - MAX_ITEMS + 100);
    if (this.viewing && !this.needSnapshot) {
      this.events.push(ev);
      this.scheduleFlush();
    }
  }

  // Lines the terminal printed that no other event stands for (command output, notices, errors).
  output(lines) {
    const last = this.state.items[this.state.items.length - 1];
    if (!lines.length || (last?.k !== 'output' && lines.every((l) => !stripAnsi(l).trim()))) return;
    this.emit({ t: 'output', lines });
  }

  toolProgress(id, entry) {
    if (!id) return;
    this.progress.set(id, entry);
    if (this.viewing) this.scheduleFlush();
  }

  // The conversation was replaced (/clear, /resume, /rewind): the pages start again from it.
  resync() {
    this.progress.clear();
    this.events = [];
    this.state = hydrate(this.handlers.seed?.() || []);
    this.seq++;
    this.needSnapshot = true;
    this.scheduleFlush(0);
  }

  scheduleFlush(ms = FLUSH_MS) {
    if (this.closed) return;
    if (this.flushTimer && ms > 0) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, ms);
  }

  takeProgress() {
    for (const [id, entry] of this.progress) {
      const ev = { t: 'progress', id, text: progressTail(entry.progress), seq: ++this.seq };
      if (applyEvent(this.state, ev) && this.viewing && !this.needSnapshot) this.events.push(ev);
    }
    this.progress.clear();
  }

  status() {
    try { return this.handlers.status?.() || {}; } catch (e) { return { error: e.message }; }
  }

  // What decides whether the status is sent again: all of it while a page watches; while none does, only what
  // the gateway's session list shows (the token count of a busy session would otherwise go out every few seconds).
  // `asking` (a question waits) is in it too: the gateway tells the user about it even with no page open.
  statusKey(status) {
    if (this.viewing) return JSON.stringify({ ...status, elapsed: 0 });
    const { busy, asking, title, model, cwd, name } = status;
    return JSON.stringify({ busy, asking, title, model, cwd, name });
  }

  // What is sent at once, without the wait between statuses of an unwatched session: a task that started or ended,
  // a question that came or was answered.
  urgentKey(status) { return `${Boolean(status.busy)}|${Boolean(status.asking)}`; }

  // What has changed goes into the next upload: a snapshot when one is due, else the events; and the status.
  flush() {
    if (this.closed || !this.registered) return;
    this.takeProgress();
    const status = this.status();
    if (this.needSnapshot || this.sinceSnapshot > SNAPSHOT_EVERY) {
      this.needSnapshot = false;
      this.events = [];
      this.sinceSnapshot = 0;
      this.lastStatus = this.statusKey(status);
      this.lastUrgent = this.urgentKey(status);
      this.lastStatusAt = Date.now();
      this.outbox.push({ t: 'snapshot', seq: this.seq, items: snapshotItems(this.state.items), status });
    } else if (this.events.length) {
      this.sinceSnapshot += this.events.length;
      this.outbox.push({ t: 'batch', events: this.events });
      this.events = [];
    }
    const key = this.statusKey(status);
    const urgent = this.urgentKey(status);
    if (key !== this.lastStatus && (urgent !== this.lastUrgent || Date.now() - this.lastStatusAt >= (this.viewing ? 0 : IDLE_STATUS_MS))) {
      this.lastStatus = key;
      this.lastUrgent = urgent;
      this.lastStatusAt = Date.now();
      this.outbox.push({ t: 'status', status });
    }
    this.pump();
  }

  // One POST at a time, so that the gateway gets the messages in order. A failed one is not sent again: the
  // next upload is a snapshot, which stands for everything that was lost.
  async pump() {
    if (this.sending || this.closing || !this.outbox.length) return;
    this.sending = true;
    const messages = this.outbox.splice(0);
    try {
      await this.request('POST', `/v1/remote/sessions/${encodeURIComponent(this.id)}/events`, { messages });
    } catch (e) {
      this.needSnapshot = true;
      this.events = [];
      if (e.status === 404) { this.registered = false; this.streamAbort?.abort(); }
    } finally {
      this.sending = false;
    }
    if (this.outbox.length) this.pump();
  }

  // Ends the connection; resolves once the gateway was told (or gave up waiting). `restarting`: the session comes
  // back at once with the same id, and the pages wait for it.
  close({ restarting = false } = {}) {
    this.closeDone ??= this.shutdown(restarting);
    return this.closeDone;
  }

  async shutdown(restarting) {
    // First the answers on their way, while the command stream is still open (the gateway fails what is still
    // waiting once it closes). Among them the answer to the command that ends the session: a /cd or /exit from the
    // page closes it from inside that command, and its answer is sent when the command returns, hence the wait for
    // the current call to finish first.
    await null;
    if (this.replying.size) await Promise.race([Promise.allSettled([...this.replying]), new Promise((r) => setTimeout(r, 1500).unref?.())]);
    this.closing = true; // what flush() collects now goes out with the last message, not on its own
    this.flush();
    this.closed = true;
    clearTimeout(this.flushTimer);
    clearInterval(this.statusTimer);
    this.streamAbort?.abort();
    if (!this.registered) return;
    const messages = [...this.outbox.splice(0), { t: 'bye', restarting }];
    await this.request('POST', `/v1/remote/sessions/${encodeURIComponent(this.id)}/events`, { messages }, { timeout: 1500 }).catch(() => {});
  }
}
