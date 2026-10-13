// `claude-pro attach [name]`: a background session of this computer (claude-pro --headless, see vterm.js), used
// here in this terminal with its whole interface, as tmux attach does. It goes through the session's own server on
// 127.0.0.1 (peers.js), not the gateway: GET /attach upgraded to a connection of its own, the screen coming down as
// it is drawn, the keys and the size of this terminal going up as JSON lines ({keys: base64}, {resize: [cols,
// rows]}). ctrl+] detaches; the session goes on. Several terminals can be attached at once (the last one to attach
// or resize sets the size), and the web page at the same time.
//
// A restart of the session (an update, /restart, /cd) ends the connection: this waits for the session to come back
// under the same registry id and attaches again.

import http from 'node:http';
import readline from 'node:readline';
import { listPeers } from './peers.js';

const DETACH = '\x1d'; // ctrl+]
const RESET = '\x1b[?1002l\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?1049l\x1b[?25h';
const BACK_WITHIN_MS = 20_000; // a restart brings the session back within this

const backgroundSessions = () => listPeers().filter((p) => p.kind === 'background');

// The session `ref` names: its name, its id at the gateway, or the start of its registry id.
export function findBackground(ref, sessions = backgroundSessions()) {
  const q = String(ref || '').replace(/^[@&＆]/, '').toLowerCase();
  if (!q) return null;
  return sessions.find((p) => p.name.toLowerCase() === q)
    || sessions.find((p) => String(p.remoteId || '').toLowerCase() === q)
    || sessions.find((p) => p.id.startsWith(q) || String(p.remoteId || '').toLowerCase().startsWith(q))
    || null;
}

function choose(sessions, io) {
  io.stdout.write('Background sessions on this computer:\n');
  sessions.forEach((p, i) => io.stdout.write(`  ${i + 1}. &${p.name}  ${p.cwd}${p.remoteId ? `  (${p.remoteId})` : ''}\n`));
  const rl = readline.createInterface({ input: io.stdin, output: io.stdout });
  return new Promise((resolve) => {
    rl.question(`Which one? [1-${sessions.length}, Enter for 1] `, (answer) => {
      rl.close();
      const n = answer.trim() ? Number(answer.trim()) : 1;
      resolve(Number.isInteger(n) && n >= 1 && n <= sessions.length ? sessions[n - 1] : findBackground(answer.trim(), sessions));
    });
  });
}

// One connection: resolves with how it ended, 'detached' or 'closed'.
function connect(peer, io) {
  return new Promise((resolve, reject) => {
    const { columns = 100, rows = 30 } = io.stdout;
    const req = http.request({
      host: '127.0.0.1', port: peer.port, path: `/attach?cols=${columns}&rows=${rows}`,
      headers: { connection: 'Upgrade', upgrade: 'claude-pro-attach', authorization: `Bearer ${peer.token}` },
    });
    req.on('response', (res) => reject(new Error(res.statusCode === 404 ? 'this session cannot be attached to (a terminal session, or an older claude-pro)' : `HTTP ${res.statusCode}`)));
    req.on('error', reject);
    req.on('upgrade', (_res, socket, head) => {
      let ended = null;
      const finish = (how) => {
        if (ended) return;
        ended = how;
        io.stdin.off('data', onKeys);
        io.stdout.off('resize', onResize);
        socket.destroy();
        resolve(how);
      };
      const send = (msg) => { if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`); };
      const onKeys = (data) => {
        const i = data.indexOf(DETACH);
        if (i >= 0) {
          if (i > 0) send({ keys: data.subarray(0, i).toString('base64') });
          finish('detached');
          return;
        }
        send({ keys: data.toString('base64') });
      };
      const onResize = () => send({ resize: [io.stdout.columns, io.stdout.rows] });
      if (head?.length) io.stdout.write(head);
      socket.on('data', (d) => io.stdout.write(d));
      socket.on('close', () => finish('closed'));
      socket.on('error', () => finish('closed'));
      io.stdin.on('data', onKeys);
      io.stdout.on('resize', onResize);
    });
    req.end();
  });
}

// A window the computer service opened for it (--keep-open, see HostService.window): what went wrong, or that the
// session ended, stays readable until a key is pressed (a window that closes at once says nothing).
function keepOpen(args, io) {
  if (!args.includes('--keep-open') || !io.stdin.isTTY) return Promise.resolve();
  io.stdout.write('Press any key to close this window.');
  io.stdin.setRawMode(true);
  io.stdin.resume();
  return new Promise((resolve) => io.stdin.once('data', () => { io.stdin.setRawMode(false); io.stdin.pause(); resolve(); }));
}

// io: the terminal (process.stdin/stdout/stderr; the tests give their own).
export async function attachCommand(args = [], io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    io.stderr.write('claude-pro attach needs a terminal.\n');
    return 2;
  }
  const sessions = backgroundSessions();
  if (!sessions.length) {
    io.stdout.write('No background session runs on this computer. The web page opens them (新建会话, without "open a terminal window").\n');
    await keepOpen(args, io);
    return 1;
  }
  const ref = args.find((a) => !a.startsWith('-'));
  let peer = ref ? findBackground(ref, sessions) : sessions.length === 1 ? sessions[0] : await choose(sessions, io);
  if (!peer) {
    io.stderr.write(`No background session called "${ref}". These run here: ${sessions.map((p) => `&${p.name}`).join(', ')}\n`);
    await keepOpen(args, io);
    return 1;
  }
  const label = `&${peer.name}`;
  io.stdin.setRawMode(true);
  io.stdin.resume();
  let how;
  try {
    for (;;) {
      how = await connect(peer, io);
      if (how === 'detached') break;
      // closed: the session restarting (it comes back under the same registry id), or ended
      const id = peer.id;
      let back = null;
      for (let t = 0; t < BACK_WITHIN_MS && !back; t += 300) {
        await new Promise((r) => setTimeout(r, 300));
        back = backgroundSessions().find((p) => p.id === id && p.pid !== peer.pid) || null;
      }
      if (!back) { how = 'ended'; break; }
      peer = back;
    }
  } catch (e) {
    io.stdout.write(RESET);
    io.stdin.setRawMode(false);
    io.stderr.write(`Could not attach to ${label}: ${e.message}\n`);
    await keepOpen(args, io);
    return 1;
  }
  io.stdout.write(RESET);
  io.stdin.setRawMode(false);
  io.stdin.pause();
  io.stdout.write(how === 'detached' ? `Detached from ${label}: it goes on in the background (claude-pro attach ${peer.name} comes back).\n` : `${label} has ended.\n`);
  if (how !== 'detached') await keepOpen(args, io);
  return 0;
}
