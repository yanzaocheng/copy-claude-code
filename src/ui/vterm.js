// The terminal of a background session (claude-pro --headless, started by the computer service): no window, the
// screen it draws goes to whoever is attached (`claude-pro attach`, see attach.js), and what they type comes in as
// if typed into a terminal. Nobody attached: the drawing goes nowhere, and the session is used from the web page.
//
// `output` stands for process.stdout and `input` for process.stdin as the App uses them (a TTY in raw mode, its
// size, 'resize'). The size is the one of the client that attached or resized last.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export class VirtualTerminal {
  constructor({ columns = 120, rows = 40 } = {}) {
    this.clients = new Set();
    const out = new EventEmitter();
    out.isTTY = true;
    out.columns = columns;
    out.rows = rows;
    out.write = (data) => {
      for (const client of this.clients) {
        try { client.write(data); } catch { /* gone: its close removes it */ }
      }
      return true;
    };
    this.output = out;
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = true;
    input.setRawMode = () => input;
    this.input = input;
  }

  resize(columns, rows) {
    const c = Math.max(20, Math.min(1000, Math.floor(columns) || 0));
    const r = Math.max(10, Math.min(500, Math.floor(rows) || 0));
    if (!columns || !rows || (c === this.output.columns && r === this.output.rows)) return;
    this.output.columns = c;
    this.output.rows = r;
    this.output.emit('resize');
  }

  // client: {write(data), close()}
  attach(client, { cols, rows } = {}) {
    this.clients.add(client);
    this.resize(cols, rows);
  }

  detach(client) {
    this.clients.delete(client);
  }

  // Keys from a client, as a terminal would send them.
  type(data) {
    this.input.write(data);
  }

  closeAll() {
    for (const client of [...this.clients]) {
      try { client.close(); } catch { /* gone */ }
    }
    this.clients.clear();
  }
}
