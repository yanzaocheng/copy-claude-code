// The live view of a session for the local web console (claude-pro web, see web/server.js): the same transcript
// model as the gateway's page (applyEvent in remote.js), served by the session's own peer server on 127.0.0.1
// (see PeerNode) as a stream of server-sent events. Nothing is kept while nobody watches: the first viewer gets a
// snapshot built from the conversation, and the events after it.

import { applyEvent, hydrate, snapshotItems } from './remote.js';
import { stripAnsi } from './ui/ansi.js';

const MAX_ITEMS = 800;
const FLUSH_MS = 100;
const STATUS_MS = 500;
const PING_MS = 15_000;

function progressTail(text) {
  const lines = String(text || '').slice(-6000).replace(/\r\n/g, '\n').trimEnd().split('\n');
  return lines.slice(-8).map((l) => l.replace(/^.*\r/, '').slice(0, 400)).join('\n');
}

// (the time a turn has run changes all the time: the page counts it on from when the status came)
const statusKey = (status) => JSON.stringify({ ...status, elapsed: 0 });

export class LiveFeed {
  // seed(): the transcript items of the conversation as it is; status(): what the page shows below it.
  constructor({ seed, status }) {
    this.seed = seed;
    this.statusOf = status;
    this.clients = new Set();
    this.state = null; // only while someone watches
    this.events = [];
    this.progress = new Map();
    this.flushTimer = null;
    this.statusTimer = null;
    this.pingTimer = null;
    this.lastStatus = '';
  }

  get active() { return this.clients.size > 0; }

  status() {
    try { return this.statusOf?.() || {}; } catch (e) { return { error: e.message }; }
  }

  // A response that stays open: a snapshot, then batches of events and the status whenever it changes.
  attach(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.socket?.setNoDelay?.(true);
    if (!this.state) this.state = hydrate(this.items());
    this.clients.add(res);
    const status = this.status();
    this.lastStatus = statusKey(status);
    this.write(res, { t: 'snapshot', items: snapshotItems(this.state.items), status });
    res.on('close', () => this.detach(res));
    this.statusTimer ??= setInterval(() => this.checkStatus(), STATUS_MS);
    this.pingTimer ??= setInterval(() => { for (const r of this.clients) r.write(': ping\n\n'); }, PING_MS);
    this.statusTimer.unref?.();
    this.pingTimer.unref?.();
  }

  detach(res) {
    this.clients.delete(res);
    if (this.clients.size) return;
    clearInterval(this.statusTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.flushTimer);
    this.statusTimer = this.pingTimer = this.flushTimer = null;
    this.state = null;
    this.events = [];
    this.progress.clear();
  }

  items() {
    try { return this.seed?.() || []; } catch { return []; }
  }

  write(res, message) {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 8 * 1024 * 1024) { res.destroy(); return; }
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  broadcast(message) { for (const res of this.clients) this.write(res, message); }

  emit(ev) {
    if (!this.state) return;
    applyEvent(this.state, ev);
    if (ev.t === 'done') this.progress.delete(ev.id);
    if (this.state.items.length > MAX_ITEMS) this.state.items.splice(0, this.state.items.length - MAX_ITEMS + 100);
    const last = this.events[this.events.length - 1];
    if (ev.t === 'delta' && last?.t === 'delta' && last.kind === ev.kind) last.text += ev.text;
    else this.events.push({ ...ev });
    this.scheduleFlush();
  }

  // Lines the terminal printed that no other event stands for.
  output(lines) {
    if (!this.state) return;
    const last = this.state.items[this.state.items.length - 1];
    if (!lines.length || (last?.k !== 'output' && lines.every((l) => !stripAnsi(l).trim()))) return;
    this.emit({ t: 'output', lines });
  }

  toolProgress(id, entry) {
    if (!this.state || !id) return;
    this.progress.set(id, entry);
    this.scheduleFlush();
  }

  // The conversation was replaced (/clear, /resume, /rewind): the pages start again from it.
  resync() {
    if (!this.state) return;
    this.state = hydrate(this.items());
    this.events = [];
    this.progress.clear();
    this.broadcast({ t: 'snapshot', items: snapshotItems(this.state.items), status: this.status() });
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, FLUSH_MS);
  }

  flush() {
    if (!this.state) return;
    for (const [id, entry] of this.progress) {
      const ev = { t: 'progress', id, text: progressTail(entry.progress) };
      if (applyEvent(this.state, ev)) this.events.push(ev);
    }
    this.progress.clear();
    if (this.events.length) this.broadcast({ t: 'batch', events: this.events.splice(0) });
    this.checkStatus();
  }

  checkStatus() {
    if (!this.clients.size) return;
    const status = this.status();
    const key = statusKey(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.broadcast({ t: 'status', status });
  }

  close() {
    const open = [...this.clients];
    this.clients.clear();
    this.detach(null);
    for (const res of open) { try { res.end(); } catch { /* gone */ } }
  }
}
