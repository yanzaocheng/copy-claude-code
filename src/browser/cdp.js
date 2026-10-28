// One Chrome DevTools Protocol connection over Node's own WebSocket: commands with their replies, events, and the
// sessions of attached targets (flatten mode, one socket for all of them). No dependency.

export class CdpError extends Error {}

export const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

export class Cdp {
  // Opens the socket. A browser whose remote debugging was turned on in its settings (edge://inspect,
  // chrome://inspect, Chrome and Edge 144+) holds the handshake until the user allows it in a dialog: `onWaiting`
  // is called when it takes longer than a moment, so the user can be told what to click.
  static connect(url, { signal, timeoutMs = 120_000, onWaiting } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const ws = new WebSocket(url);
      let settled = false;
      const waiting = setTimeout(() => onWaiting?.(), 1500);
      const timer = setTimeout(() => fail(new CdpError(`the browser did not accept the connection within ${timeoutMs / 1000} s (nobody allowed remote debugging?)`)), timeoutMs);
      const onAbort = () => fail(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      function cleanup() { clearTimeout(waiting); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
      function fail(err) {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.close(); } catch { /* not open */ }
        reject(err);
      }
      ws.onopen = () => {
        if (settled) { try { ws.close(); } catch { /* gone */ } return; }
        settled = true;
        cleanup();
        resolve(new Cdp(ws));
      };
      ws.onerror = (e) => fail(new CdpError(`cannot connect to the browser: ${e?.message || e?.error?.message || 'connection refused or declined'}`));
      ws.onclose = (e) => fail(new CdpError(`the browser refused the connection${e?.code && e.code !== 1006 ? ` (${e.code}${e.reason ? ` ${e.reason}` : ''})` : ''}: remote debugging was declined or turned off`));
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, done, method}
    this.handlers = new Set(); // (method, params, sessionId) => void
    this.closed = false;
    this.closeReason = '';
    ws.onmessage = (m) => this.receive(m.data);
    ws.onclose = () => this.shutdown('the browser closed the connection');
    ws.onerror = () => {};
  }

  receive(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      p.done();
      if (msg.error) p.reject(new CdpError(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else p.resolve(msg.result || {});
      return;
    }
    for (const h of [...this.handlers]) {
      try { h(msg.method, msg.params || {}, msg.sessionId); } catch { /* one handler's bug must not stop the others */ }
    }
  }

  // A command; `sessionId` sends it to an attached target. Rejects when the reply does not come in `timeoutMs`
  // (0: no limit), when `signal` aborts, or when the connection closes.
  send(method, params = {}, { sessionId, timeoutMs = 30_000, signal } = {}) {
    if (this.closed) return Promise.reject(new CdpError(`${method}: ${this.closeReason}`));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => { this.pending.delete(id); done(); reject(abortError()); };
      const done = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      if (timeoutMs) timer = setTimeout(() => { this.pending.delete(id); done(); reject(new CdpError(`${method}: no reply within ${timeoutMs / 1000} s`)); }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, done, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (e) {
        this.pending.delete(id);
        done();
        reject(new CdpError(`${method}: ${e.message}`));
      }
    });
  }

  // Events of the browser and of every attached session; returns the function that removes the handler.
  // When the connection closes, handlers get ('Cdp.closed', {reason}).
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const p of this.pending.values()) { p.done(); p.reject(new CdpError(`${p.method}: ${reason}`)); }
    this.pending.clear();
    for (const h of [...this.handlers]) {
      try { h('Cdp.closed', { reason }); } catch { /* closing anyway */ }
    }
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
    this.shutdown('closed by claude-pro');
  }
}
