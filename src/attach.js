// A terminal attached to the web console's process (CLAUDE_PRO_ATTACH=1): the session runs there, with the console's
// other sessions, and this process only carries the window's keys, size and output, as tmux's client does. One
// process holds every session (about 90 MB less for each), and new code (an update, an edit of the source) is taken
// up by that one process when its sessions are idle: the window attaches again to the same session, which goes on.
//
// The connection is an HTTP upgrade to /api/attach on 127.0.0.1 with the console's secret (web.json), then frames
// both ways: [type: 1 byte][length: 4 bytes, big-endian][payload]. The client sends HELLO first (JSON: where, the
// flags, the first prompt, the environment, the window's size, its cursor row and measured widths); the console
// answers READY {peerId} once the session runs, or ERROR {message} (the client then runs the session itself); then
// INPUT (the keys) and RESIZE ({columns, rows}) one way, OUTPUT (what to draw) and EXIT ({code}) the other. A
// connection that closes without EXIT is the console restarting: the client attaches again (HELLO with
// `reattach`, the session's peer id) and the session, taken up by the new process, carries on in the same window.

import http from 'node:http';
import fs from 'node:fs';

export const FRAME = { HELLO: 1, INPUT: 2, RESIZE: 3, OUTPUT: 4, READY: 5, EXIT: 6, ERROR: 7 };
const PROTOCOL = 'claude-pro-attach';
const MAX_FRAME = 64 * 1024 * 1024;

export function frame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

// Calls onFrame(type, payload: Buffer) for each whole frame of what `push(chunk)` is given.
export function frameReader(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const len = buf.readUInt32BE(1);
      if (len > MAX_FRAME) throw new Error('frame too large');
      if (buf.length < 5 + len) break;
      const type = buf[0];
      const payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      onFrame(type, payload);
    }
  };
}

export const json = (payload) => { try { return JSON.parse(payload.toString('utf8')); } catch { return null; } };

export const attachWanted = (env) => /^(1|true|yes|on)$/i.test(String(env?.CLAUDE_PRO_ATTACH || ''));

// The upgraded connection to the console at `port`, or null when it does not take terminals (an older console).
function connect(port, token) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/attach', method: 'GET',
      headers: { connection: 'Upgrade', upgrade: PROTOCOL, authorization: `Bearer ${token}` },
    });
    req.on('upgrade', (res, socket, head) => {
      if (head?.length) socket.unshift(head);
      socket.setNoDelay(true);
      resolve(socket);
    });
    req.on('response', (res) => { res.resume(); resolve(null); });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run the session in the console with this window as its terminal. Resolves with the session's exit code, or null
// when it cannot be attached (no console, an older one, a terminal whose widths the console cannot draw for): the
// caller runs the session itself then, as without attaching.
export async function attachSession({ flags, cwd, prompt, stdin = process.stdin, stdout = process.stdout, env = process.env }) {
  const web = await import('./web/server.js');
  const { queryCursorRow } = await import('./ui/screen.js');
  const { terminalWidthList, ESC } = await import('./ui/ansi.js');
  const server = () => { try { return JSON.parse(fs.readFileSync(web.stateFile(), 'utf8')); } catch { return null; } };
  try { await web.ensureWebServer(); } catch { return null; }

  stdin.setRawMode(true);
  // Asked here, where the window is: its cursor row (the session's input box is pinned from there) and, on Windows,
  // the widths it gives the interface's symbols and the ambiguous characters (see queryCursorRow).
  const ask = async () => ({ row: await queryCursorRow(stdin, stdout), widths: terminalWidthList() });
  const size = () => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const hello = (extra) => ({
    v: 1, cwd, flags, prompt, env: { ...env }, ...size(),
    colorDepth: typeof stdout.getColorDepth === 'function' ? stdout.getColorDepth() : 8,
    ...extra,
  });

  let socket = null;
  let peerId = null;
  let exitCode = null;
  let ready = false;
  const pending = []; // keys typed while (re)attaching
  const send = (type, payload) => { if (socket && !socket.destroyed) socket.write(frame(type, payload)); };
  let waiting = false; // for the console to come back: Ctrl+C gives up
  let gaveUp = false;
  const onKeys = (d) => {
    if (ready && socket && !socket.destroyed) send(FRAME.INPUT, Buffer.from(d));
    else if (waiting && Buffer.from(d).includes(3)) gaveUp = true;
    else pending.push(Buffer.from(d));
  };
  const onResize = () => send(FRAME.RESIZE, size());

  // One connection: resolves 'exit', 'closed' (the console went away: attach again) or 'refused' (before READY).
  const run = (sock, first) => new Promise((resolve) => {
    socket = sock;
    ready = false;
    let settled = false;
    const end = (why) => { if (!settled) { settled = true; resolve(why); } };
    const read = frameReader((type, payload) => {
      if (type === FRAME.OUTPUT) stdout.write(payload);
      else if (type === FRAME.READY) {
        const r = json(payload) || {};
        peerId = r.peerId || peerId;
        ready = true;
        for (const d of pending.splice(0)) send(FRAME.INPUT, d);
      } else if (type === FRAME.EXIT) {
        exitCode = Number.isInteger(json(payload)?.code) ? json(payload).code : 0;
        end('exit');
        sock.end();
      } else if (type === FRAME.ERROR) {
        const r = json(payload) || {};
        if (!ready) { stdout.write(r.message && !first ? `\r\n${r.message}\r\n` : ''); end(first ? 'refused' : 'gone'); sock.destroy(); }
      }
    });
    sock.on('data', (d) => { try { read(d); } catch { sock.destroy(); } });
    sock.on('close', () => end(ready || !first ? 'closed' : 'refused'));
    sock.on('error', () => {});
  });

  const first = await ask();
  // (the secret goes only to the console that holds it: see consoleIsOurs)
  let sock = await (async () => { const s = server(); return s?.port && (await web.consoleIsOurs(s)) ? connect(s.port, s.token) : null; })();
  if (!sock) { stdin.setRawMode(false); return null; }
  stdin.on('data', onKeys);
  stdin.resume();
  if (typeof stdout.on === 'function') stdout.on('resize', onResize);
  const cleanup = () => {
    stdin.off('data', onKeys);
    if (typeof stdout.off === 'function') stdout.off('resize', onResize);
    try { stdin.setRawMode(false); } catch { /* gone */ }
    stdin.pause();
  };

  sock.write(frame(FRAME.HELLO, hello({ row: first.row, widths: first.widths, restart: flags.restart || null })));
  let why = await run(sock, true);
  if (why === 'refused' && !peerId) { cleanup(); return null; }
  // The console restarted (new code): attach again, to the session it took up, for a minute at most.
  while (why === 'closed') {
    ready = false;
    let again = null;
    const since = Date.now();
    let started = 0;
    waiting = true;
    for (const until = since + 60_000; !again && !gaveUp && Date.now() < until;) {
      await sleep(400);
      // a console that went away without starting the next one (a crash, a kill) is started from here: it takes up
      // what it was running from its list (web-running.json)
      if (Date.now() - since > 12_000 && Date.now() - started > 15_000) { started = Date.now(); web.ensureWebServer().catch(() => {}); }
      const s = server();
      if (s?.port && (await web.consoleIsOurs(s))) again = await connect(s.port, s.token);
    }
    waiting = false;
    if (!again) {
      stdout.write(`${ESC.bracketedPasteOff}${ESC.showCursor}\r\n${gaveUp ? 'Stopped waiting for the web console' : 'The web console did not come back'}: the session goes on there (claude-pro web) once it starts again.\r\n`);
      exitCode = 1;
      break;
    }
    stdin.off('data', onKeys); // (the cursor row is asked before keys are taken again)
    const where = await ask();
    stdin.on('data', onKeys);
    stdin.resume();
    again.write(frame(FRAME.HELLO, hello({ row: where.row, widths: where.widths, reattach: peerId })));
    why = await run(again, false);
    if (why === 'gone') { exitCode = 1; break; }
  }
  cleanup();
  return exitCode ?? 0;
}
