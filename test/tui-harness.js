// Drives the interactive App inside a headless xterm so UI behaviour can be tested
// without a real terminal. Usage:
//   const t = await startTui({ cwd });
//   t.send('hello\r'); await t.waitFor('⏺'); console.log(t.snapshot());

import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import xterm from '@xterm/headless';
import { App } from '../src/ui/repl.js';

const { Terminal } = xterm;

export async function startTui({ cwd, cols = 100, rows = 40, flags = {} } = {}) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  let raw = '';
  const stdout = new Writable({
    write(chunk, enc, cb) {
      raw += chunk.toString();
      term.write(chunk.toString(), cb);
    },
  });
  Object.assign(stdout, { isTTY: true, columns: cols, rows, getColorDepth: () => 24 });
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {} });
  const app = new App({ flags, cwd, stdin, stdout, noProcessExit: true });
  const exited = app.start('');
  await new Promise((r) => setTimeout(r, 300));

  const flush = () => new Promise((r) => term.write('', r));
  const snapshot = async ({ all = false } = {}) => {
    await flush();
    const buf = term.buffer.active;
    const lines = [];
    const start = all ? 0 : buf.baseY;
    const end = all ? buf.length : buf.baseY + rows;
    for (let i = start; i < end; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
  };
  const cursor = async () => { await flush(); return { x: term.buffer.active.cursorX, y: term.buffer.active.cursorY }; };
  const t = {
    app,
    term,
    exited,
    raw: () => raw,
    send(s) { stdin.write(s); },
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    snapshot,
    cursor,
    async waitFor(pred, { timeout = 120_000, all = true } = {}) {
      const start = Date.now();
      for (;;) {
        const snap = await snapshot({ all });
        if (typeof pred === 'string' ? snap.includes(pred) : pred.test ? pred.test(snap) : pred(snap)) return snap;
        if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${pred}\n--- screen ---\n${snap}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    // Wait until the agent is idle. If `answer` is given, dialogs are answered with it
    // (a string key, or a function (snapshot) => key) and their snapshots collected.
    async waitIdle({ timeout = 300_000, answer } = {}) {
      const start = Date.now();
      const dialogs = [];
      await new Promise((r) => setTimeout(r, 200));
      while (app.busy || app.dialogs.length) {
        if (Date.now() - start > timeout) throw new Error(`waitIdle timed out\n--- screen ---\n${await snapshot()}`);
        if (answer && app.dialogs.length) {
          const snap = await snapshot();
          dialogs.push(snap);
          stdin.write(typeof answer === 'function' ? answer(snap) : answer);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      await new Promise((r) => setTimeout(r, 100));
      return dialogs;
    },
    resize(c, r) {
      term.resize(c, r);
      stdout.columns = c;
      stdout.rows = r;
      stdout.emit('resize');
    },
    async close() { app.exit(0); await exited; },
  };
  return t;
}

export { EventEmitter };
