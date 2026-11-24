// The console's side of attached terminals (see attach.js): a window's connection becomes the stdin and stdout of a
// session the host runs, with the window's size, cursor row and measured widths (its terminal profile, so that what
// is drawn for it fits it even where another window measured other widths). The session's end is the window's: its
// exit code goes back and the window's process ends with it; the window closing ends the session as closing its
// window ended a session of its own. The console restarting (new code) ends neither: the session leaves its state
// (attached: true) and the next console waits for the window to attach again (SessionHost.pendingAttach).

import { PassThrough, Writable } from 'node:stream';
import { FRAME, frame, frameReader, json } from '../attach.js';
import { newTerminalProfile, inTerminal } from '../ui/ansi.js';

const GRACE_MS = 1500; // a window gone: the session ends after this (a reattach in between keeps it)

// What the session is given for its terminal, writing to `socket`. A new pair for each App (a /cd starts another one
// in the same window): the one before stops drawing once replaced.
function terminalStreams(link) {
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, isRaw: true, setRawMode() { return stdin; } });
  const stdout = new Writable({
    write(chunk, enc, cb) {
      if (link.streams?.stdout === stdout && !link.socket.destroyed) link.socket.write(frame(FRAME.OUTPUT, Buffer.from(chunk, enc === 'buffer' ? undefined : enc)));
      cb();
    },
  });
  Object.assign(stdout, {
    isTTY: true, columns: link.columns, rows: link.rows,
    getColorDepth: () => link.colorDepth,
    hasColors: (n = 16) => 2 ** link.colorDepth >= n,
    getWindowSize: () => [stdout.columns, stdout.rows],
  });
  return { stdin, stdout };
}

// A window attached: `hello` is its first frame. Ends the socket when nothing can be run for it.
export function acceptTerminal(host, socket, firstFrames) {
  const link = { socket, app: null, streams: null, columns: 80, rows: 24, colorDepth: 8, profile: null, closed: false };
  let started = false;
  const fail = (message) => {
    try { socket.end(frame(FRAME.ERROR, { message })); } catch { /* gone */ }
  };
  const input = (payload) => {
    const s = link.streams;
    if (s && link.app && !link.app.exiting) inTerminal(link.profile, () => s.stdin.write(payload));
  };
  const resize = (r) => {
    if (!Number.isInteger(r?.columns) || !Number.isInteger(r?.rows)) return;
    link.columns = Math.max(10, r.columns);
    link.rows = Math.max(4, r.rows);
    const out = link.streams?.stdout;
    if (!out) return;
    out.columns = link.columns;
    out.rows = link.rows;
    inTerminal(link.profile, () => out.emit('resize'));
  };
  const onHello = async (h) => {
    if (!h || h.v !== 1 || typeof h.cwd !== 'string') return fail('This claude-pro does not speak the console\'s attach protocol.');
    link.columns = Math.max(10, Number(h.columns) || 80);
    link.rows = Math.max(4, Number(h.rows) || 24);
    link.colorDepth = [1, 4, 8, 24].includes(h.colorDepth) ? h.colorDepth : 8;
    // the window's widths, and its shell's environment for what the session runs (see childEnv)
    const env = h.env && typeof h.env === 'object' && !Array.isArray(h.env) ? Object.fromEntries(Object.entries(h.env).filter(([, v]) => typeof v === 'string')) : null;
    link.profile = newTerminalProfile(Array.isArray(h.widths) ? h.widths.filter((w) => Array.isArray(w) && typeof w[0] === 'string') : [], env ? { env } : {});
    link.row = Number.isInteger(h.row) ? h.row : null;
    try {
      const app = await host.attachTerminal(link, h);
      if (!app) return fail(h.reattach ? 'The session is no longer there (it went on in the web console, or ended).' : 'The web console could not start the session.');
    } catch (e) {
      host.log(e, 'attach');
      return fail(`The web console could not start the session: ${e.message}`);
    }
  };
  const read = frameReader((type, payload) => {
    if (!started) {
      if (type !== FRAME.HELLO) { socket.destroy(); return; }
      started = true;
      onHello(json(payload));
      return;
    }
    if (type === FRAME.INPUT) input(payload);
    else if (type === FRAME.RESIZE) resize(json(payload));
  });
  socket.setNoDelay(true);
  socket.on('data', (d) => { try { read(d); } catch { socket.destroy(); } });
  socket.on('error', () => {});
  socket.on('close', () => {
    link.closed = true;
    const app = link.app;
    // the window is gone (closed, or its process killed): the session ends, unless the console is going away itself
    if (app && !app.exiting && !host.restarting) setTimeout(() => { if (link.app === app && !app.exiting && !host.restarting) app.exit(129); }, GRACE_MS).unref?.();
  });
  if (firstFrames?.length) socket.emit('data', firstFrames);
  return link;
}

// The pair of streams for the next App of this window, made current.
export function nextStreams(link) {
  link.streams = terminalStreams(link);
  return link.streams;
}

// The App of this window ended with `code`: the window is told, unless the App went on in another (a /cd, a restart of
// the console, which the window attaches to again).
export function terminalEnded(link, app, code, { goesOn = false } = {}) {
  if (link.app !== app || goesOn || link.closed) return;
  try { link.socket.end(frame(FRAME.EXIT, { code: Number.isInteger(code) ? code : 0 })); } catch { /* gone */ }
}

export function terminalReady(link, app) {
  link.app = app;
  try { link.socket.write(frame(FRAME.READY, { peerId: app.peers?.id || null, sessionId: app.store?.id || null })); } catch { /* gone */ }
}
