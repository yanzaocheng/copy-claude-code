// The connection to the gateway's device relay (the gateway's device-relay.mjs), through which the computers paired with
// this one (devices.js) reach its sessions. No account and no key of the gateway: every request is signed with this
// computer's own key, and what goes through is sealed for the computer it is for. The session never listens on the
// network: it connects out.
//
// A session's connection (`session`: its id at the relay) receives the messages for it and publishes its status, sealed
// once for each paired computer (what their @ lists show of it); a computer's own connection (no session) is the one a
// pairing uses (pairing.js).

import crypto from 'node:crypto';
import { relayAuth, pairedIds, seal, unseal, pendingUnpairs, unpairSent } from './devices.js';
import { GATEWAY_DEFAULT_URL } from './config.js';

const REQUEST_TIMEOUT_MS = 15_000;
const STATUS_MS = 500; // how often the status is compared with what the relay has
const STREAM_SILENCE_MS = 50_000; // the relay pings every 15 s: a stream silent this long is dead

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const newSessionId = () => crypto.randomBytes(9).toString('base64url');

// Where the relay is: the 7bit.fun gateway (it needs no account there), or CLAUDE_PRO_RELAY_URL (one's own gateway, the
// tests).
export const relayUrl = (env = process.env) => String(env.CLAUDE_PRO_RELAY_URL || GATEWAY_DEFAULT_URL).replace(/\/+$/, '');

// Whether an interactive session connects to the relay (when this computer is paired with another) at all: it does
// unless CLAUDE_PRO_ONLINE=0, which the self-check and the tests set.
export const onlineEnabled = (env = process.env) => !/^(0|false|no|off)$/i.test(env.CLAUDE_PRO_ONLINE || '');

export class RelayClient {
  // handlers: message(frame) (false: not now, it is sent again on the next stream), pair(frame), status() -> object,
  // changed() (online changed).
  constructor({ url = relayUrl(), session = null, handlers = {}, fetchImpl = globalThis.fetch } = {}) {
    this.base = String(url).replace(/\/+$/, '');
    this.session = session === null ? null : (/^[\w-]{8,64}$/.test(session || '') ? session : newSessionId());
    this.handlers = handlers;
    this.fetch = fetchImpl;
    this.online = false;
    this.closed = false;
    this.seen = new Set(); // relay message ids handled (a stream that reconnects gets the unacknowledged ones again)
    this.lastStatus = '';
    this.statusSending = false;
    this.statusTimer = null;
    this.streamAbort = null;
    this.allowSent = '';
    this.readyWaiters = [];
  }

  // Keeps the stream open (and opens it again) until close(). Resolves at once; ready() waits for the stream.
  start() {
    this.loop();
    if (this.session) {
      this.statusTimer = setInterval(() => this.flush(), STATUS_MS);
      this.statusTimer.unref?.();
    }
    return this;
  }

  // Resolves once the stream is open (rejects after `timeoutMs`).
  ready(timeoutMs = 15_000) {
    if (this.online) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the relay ${this.base} cannot be reached`)), timeoutMs);
      this.readyWaiters.push(() => { clearTimeout(timer); resolve(this); });
    });
  }

  handoff() { return { id: this.session }; }

  // `retry: false`: not again after a failed connection (a message sent twice would be done twice).
  async request(method, route, body, { timeout = REQUEST_TIMEOUT_MS, retry = true } = {}) {
    const url = `/v1/relay${route}`;
    const text = body === undefined ? '' : JSON.stringify(body);
    const send = () => this.fetch(`${this.base}${url}`, {
      method,
      headers: { 'x-cp-device': relayAuth(method, url, text), ...(text ? { 'content-type': 'application/json' } : {}) },
      body: text || undefined,
      signal: AbortSignal.timeout(timeout),
    });
    let res;
    try { res = await send(); } catch (e) { if (!retry || e.name === 'TimeoutError' || this.closed) throw e; res = await send(); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || (typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`);
      throw Object.assign(new Error(res.status === 404 && route === '/stream' ? `the gateway ${this.base} has no device relay (yet)` : String(message)), { status: res.status });
    }
    return data;
  }

  async loop() {
    let wait = 1000;
    while (!this.closed) {
      const began = Date.now();
      try { await this.listen(); } catch { /* tried again */ }
      if (this.online) {
        this.online = false;
        this.handlers.changed?.();
      }
      if (this.closed) break;
      if (Date.now() - began > 30_000) wait = 1000; // (a stream that held: the backoff starts afresh)
      await sleep(wait);
      wait = Math.min(wait * 2, 30_000);
    }
  }

  async listen() {
    const abort = new AbortController();
    this.streamAbort = abort;
    const url = `/v1/relay/stream${this.session ? `?session=${encodeURIComponent(this.session)}` : ''}`;
    const res = await this.fetch(`${this.base}${url}`, { headers: { 'x-cp-device': relayAuth('GET', url), accept: 'text/event-stream' }, signal: abort.signal });
    if (!res.ok) {
      res.body?.cancel?.().catch(() => {});
      throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    }
    if (this.closed) { abort.abort(); return; }
    this.online = true;
    this.lastStatus = ''; // the relay may have been restarted: it gets the list and the status again
    this.allowSent = '';
    this.syncAllow().catch(() => {});
    for (const go of this.readyWaiters.splice(0)) go();
    this.handlers.changed?.();
    this.flush();
    this.tellUnpaired();
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
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
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
    if (frame.type === 'pair') { try { this.handlers.pair?.(frame); } catch { /* the pairing's problem */ } return; }
    if (frame.type !== 'msg' || typeof frame.id !== 'string') return;
    const ack = () => this.request('POST', '/ack', { id: frame.id }).catch(() => { /* sent again on reconnect, dropped here as seen */ });
    if (this.seen.has(frame.id)) { ack(); return; }
    let taken = true;
    try { taken = this.handlers.message?.(frame) !== false; } catch { /* the App's problem: acknowledged anyway, or it would come back forever */ }
    if (!taken) { this.streamAbort?.abort(); return; } // (a session moving into the console: for the next stream)
    this.seen.add(frame.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    ack();
  }

  // The relay passes a message to this computer only from the computers in this list: the paired ones.
  async syncAllow() {
    const ids = pairedIds();
    const key = ids.join(',');
    if (key === this.allowSent || !this.online) return;
    await this.request('POST', '/allow', { devices: ids });
    this.allowSent = key;
    this.lastStatus = ''; // (a computer paired since gets the status too)
  }

  // The computers this one stopped pairing with are told, so that they drop it too (when they can be reached).
  async tellUnpaired() {
    for (const u of pendingUnpairs()) {
      try {
        const data = seal(u.id, { t: 'unpair', id: newSessionId(), at: Date.now() }, u.xkey);
        await this.request('POST', '/send', { to: u.id, data, queue: true }, { retry: false });
        unpairSent(u.id);
      } catch (e) { if (e.status === 403) unpairSent(u.id); /* (it does not list this one any more either) */ }
    }
  }

  // ------------------------------------------------------------ the sessions of the paired computers

  // The open sessions of the paired computers: [{device, session, status (what it sealed for this one, or null)}].
  async sessions() {
    const data = await this.request('GET', '/sessions');
    return (Array.isArray(data?.data) ? data.data : []).map((s) => ({ device: s.device, session: s.session, status: s.data ? unseal(s.device, s.data) : null }));
  }

  // `payload` sealed for the computer `device` (its session `session`): resolves {id, delivered}. `queue`: it may wait
  // for a session that is not connected now (an answer to one that is restarting).
  async send(device, session, payload, { queue = false } = {}) {
    const data = seal(device, payload);
    return await this.request('POST', '/send', { to: device, ...(session ? { session } : {}), data, queue }, { retry: false });
  }

  // ------------------------------------------------------------ status

  status() {
    let status = {};
    try { status = this.handlers.status?.() || {}; } catch { /* the basics stay as they were */ }
    const { busy, name, title, cwd, model, machine } = status;
    return { busy: Boolean(busy), name, title, cwd, model, machine };
  }

  async flush() {
    if (this.closed || !this.online || !this.session || this.statusSending) return;
    const status = this.status();
    const ids = pairedIds();
    const key = JSON.stringify([status, ids]);
    if (key === this.lastStatus) return;
    this.statusSending = true; // one POST at a time: an older status must not overtake a newer one
    try {
      await this.syncAllow();
      const sealed = {};
      for (const id of ids) { try { sealed[id] = seal(id, { t: 'status', ...status, at: Date.now() }); } catch { /* unpaired meanwhile */ } }
      await this.request('POST', '/status', { session: this.session, sealed });
      this.lastStatus = key;
    } catch {
      this.lastStatus = ''; // sent again
    } finally {
      this.statusSending = false;
    }
  }

  close() {
    this.closed = true;
    this.online = false;
    clearInterval(this.statusTimer);
    this.streamAbort?.abort();
    return Promise.resolve();
  }
}
