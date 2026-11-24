// Background shells (Bash run_in_background) that outlive the process that started them.
//
// A background command (a dev server, a watcher) is not this program's work: a restart of the program (an update,
// the Restart tool, the web console taking up new code) must not stop it. So it does not hang on the process by pipes:
// its output goes to a file and its exit code to another, and a record of it is kept on disk, CONFIG_DIR/shells:
//
//   <uid>.json  {uid, id, owner, ownerPid, sessionId, command, description, cwd, startedAt, status, exitCode,
//                endedAt, released, seen, readPos, winpid, msysPid, msysWinpid, pid, startKey, kind}
//   <uid>.log   what it printed (stdout and stderr)
//   <uid>.exit  its exit code, written by the shell when the command ends (bash only)
//   <uid>.pid   on Windows, the MSYS process id of the shell (how its tree is found, see utils/shell.js)
//
// Ownership: the process that runs the session (`ownerPid`, and `owner`, the session's id in a process that runs
// several, the web console). When the session ends (/exit, closed in the console), its shells are killed. When the
// process restarts for the session to go on, they are `released` instead, under the conversation's id, and the next
// process takes them up (adopt) when it loads that conversation: same ids, the output not yet read still to read.
// What nobody takes up (a crash, a conversation never opened again) is killed after a while (sweep).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { CONFIG_DIR } from './config.js';
import { spawnShell, findPs, parsePsRows, msysTree, killTree, killTreeSync, processAlive } from './utils/shell.js';
import { OutputDecoder } from './utils/encoding.js';
import { stripAnsi } from './ui/ansi.js';

const isWin = process.platform === 'win32';
export const shellTiming = {
  orphanMs: 10 * 60_000, // a shell nobody took up after its process went away: killed (sweep)
  keepEndedMs: 24 * 3600_000, // an ended one's files, left by a process that is gone
  heartbeatMs: 60_000,
};
const MAX_ENDED = 50; // ended shells kept listed per session (their unread output with them)
const READ_MAX = 5_000_000; // new output past this is read from its last READ_KEEP bytes
const READ_KEEP = 2_000_000;

export const shellsDir = () => path.join(CONFIG_DIR, 'shells');
const fileOf = (uid, ext) => path.join(shellsDir(), `${uid}.${ext}`);

// uid -> {rec, child}: the shells this process owns (child: when it started them; null when it took them up)
const shells = new Map();
let counter = 0;
let heartbeat = null;

const ownedBy = (rec, owner) => !owner || !rec.owner || rec.owner === owner;

function save(rec) {
  try {
    fs.mkdirSync(shellsDir(), { recursive: true });
    const file = fileOf(rec.uid, 'json');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, file);
  } catch { /* the shell runs all the same; only taking it up after a restart needs this */ }
}

function readRec(file) {
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    return rec && typeof rec.uid === 'string' && typeof rec.id === 'string' ? rec : null;
  } catch { return null; }
}

function removeFiles(uid) {
  for (const ext of ['json', 'log', 'exit', 'pid']) {
    try { fs.rmSync(fileOf(uid, ext), { force: true }); } catch { /* still open (Windows): the sweep tries again */ }
  }
}

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    const now = Date.now();
    for (const { rec } of shells.values()) {
      if (rec.status !== 'running') continue;
      learnMsysSoon(rec, 1, 0);
      rec.seen = now;
      save(rec);
    }
  }, shellTiming.heartbeatMs);
  heartbeat.unref?.();
}

// ---------------------------------------------------------------- who a shell is (so as not to kill another process)

// POSIX: when a process started (/proc on Linux, ps elsewhere): with its pid, what tells it from a later process that
// got the same number.
function startKey(pid) {
  if (isWin || !pid) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null; // (field 22, after the name)
  } catch { /* not Linux */ }
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch { return null; }
}

let psRows = null;
function msysRows() {
  if (psRows && Date.now() - psRows.at < 2000) return psRows.rows;
  const ps = findPs();
  let rows = null;
  if (ps) {
    try {
      const r = spawnSync(ps, ['-W'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      if (r.status === 0) rows = parsePsRows(r.stdout);
    } catch { /* no ps */ }
  }
  psRows = { at: Date.now(), rows };
  return rows;
}

// Windows: the shell's MSYS id (it writes it at its start) and the Windows id of that process, once known.
function learnMsys(rec) {
  if (!isWin || rec.kind !== 'bash' || (rec.msysPid && rec.msysWinpid)) return;
  if (!rec.msysPid) {
    const n = parseInt(String(readFile(fileOf(rec.uid, 'pid')) || ''), 10);
    if (Number.isFinite(n)) rec.msysPid = n;
  }
  if (rec.msysPid && !rec.msysWinpid) {
    const row = msysRows()?.find((r) => r.pid === rec.msysPid);
    if (row) rec.msysWinpid = row.winpid;
  }
}

function readFile(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

// The same without blocking: right after the start (Node puts the shell it starts, Git Bash's launcher, in a job
// object killed when Node exits, the real bash under it and what it starts not; once this process is gone, only the
// real bash's id tells whether the command still runs), and for a status asked of a shell taken up without it.
// Tried a few times: the shell writes its id as it starts. Not in ps any more (the listing worked): `msysGone`.
const looking = new WeakSet(); // the records a lookup runs for
function learnMsysSoon(rec, tries = 5, delay = 700) {
  if (!isWin || rec.kind !== 'bash' || tries <= 0 || looking.has(rec)) return;
  looking.add(rec);
  const again = () => { looking.delete(rec); learnMsysSoon(rec, tries - 1); };
  const timer = setTimeout(() => {
    if (rec.msysWinpid || rec.msysGone || rec.status !== 'running') { looking.delete(rec); return; }
    const n = rec.msysPid || parseInt(String(readFile(fileOf(rec.uid, 'pid')) || ''), 10);
    const ps = findPs();
    if (!Number.isFinite(n) || !ps) { again(); return; }
    rec.msysPid = n;
    let out = '';
    let child;
    try { child = spawn(ps, ['-W'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { looking.delete(rec); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => looking.delete(rec));
    child.on('close', (code) => {
      looking.delete(rec);
      const rows = code === 0 ? parsePsRows(out) : [];
      const row = rows.find((r) => r.pid === n);
      if (row) { rec.msysWinpid = row.winpid; save(rec); } else if (rows.length) rec.msysGone = true; else learnMsysSoon(rec, tries - 1);
    });
    child.unref();
  }, delay);
  timer.unref?.();
}

// Whether the command still runs, for a shell this process did not start (it has no child object to ask). Asked
// twice a second while a page shows the session: nothing here blocks on another program.
const keyChecked = new WeakMap(); // record -> when its process's start time was last compared
function stillRunning(rec) {
  if (isWin) {
    if (rec.msysWinpid) return processAlive(rec.msysWinpid);
    if (rec.msysGone) return false;
    if (!rec.msysPid) {
      const n = parseInt(String(readFile(fileOf(rec.uid, 'pid')) || ''), 10);
      if (Number.isFinite(n)) rec.msysPid = n;
    }
    // (an adopted shell whose process did not get to know it: looked up in the background, running until then)
    if (rec.msysPid && rec.kind === 'bash') { learnMsysSoon(rec, 1, 0); return true; }
    return processAlive(rec.winpid);
  }
  if (!rec.pid) return false;
  if (processAlive(rec.pid)) {
    // another process may have its number by now: its start time tells (ps on macOS: once a minute is enough)
    if (rec.startKey && !rec.pidReused && Date.now() - (keyChecked.get(rec) || 0) > 60_000) {
      keyChecked.set(rec, Date.now());
      const key = startKey(rec.pid);
      if (key && key !== rec.startKey) rec.pidReused = true;
    }
    return !rec.pidReused;
  }
  // the shell has ended; what it left running in its process group is its
  try { process.kill(-rec.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// What the files say of a shell that was running: ended with a code, ended otherwise (killed), or still running.
function refresh(rec) {
  if (rec.status !== 'running') return rec;
  const code = readFile(fileOf(rec.uid, 'exit'));
  if (code !== null && code.trim() !== '') {
    rec.status = 'completed';
    rec.exitCode = parseInt(code, 10);
    if (!Number.isFinite(rec.exitCode)) rec.exitCode = null;
  } else if (!stillRunning(rec)) {
    rec.status = 'killed';
    rec.exitCode = null;
  } else return rec;
  rec.endedAt = Date.now();
  save(rec);
  return rec;
}

// The processes of a recorded shell, killed: on Windows everything MSYS says is under it or in its group, with its
// launcher (only while the shell is known to be the same process); elsewhere its process group.
function treeOf(rec) {
  if (!isWin) return null;
  learnMsys(rec);
  const rows = msysRows();
  const pids = new Set();
  const own = rows && rec.msysPid ? rows.find((r) => r.pid === rec.msysPid) : null;
  const same = own && (!rec.msysWinpid || own.winpid === rec.msysWinpid);
  if (rows && rec.msysPid) for (const p of msysTree(rows, same || !own ? rec.msysPid : -1)) pids.add(p);
  if (same || (!rows && processAlive(rec.winpid))) pids.add(rec.winpid);
  return [...pids].filter(Boolean);
}

function killRecordedSync(rec) {
  if (isWin) {
    const pids = treeOf(rec);
    if (!pids.length) return;
    const args = ['/F', '/T'];
    for (const pid of pids) args.push('/PID', String(pid));
    try { spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 10_000 }); } catch { /* gone */ }
    return;
  }
  if (stillRunning(rec)) { try { process.kill(-rec.pid, 'SIGKILL'); } catch { /* gone */ } }
}

function killRecorded(rec) {
  if (!isWin) { killRecordedSync(rec); return Promise.resolve(); }
  const pids = treeOf(rec);
  if (!pids.length) return Promise.resolve();
  const args = ['/F', '/T'];
  for (const pid of pids) args.push('/PID', String(pid));
  return new Promise((resolve) => {
    let child;
    try { child = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }); } catch { resolve(); return; }
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

// ---------------------------------------------------------------- the shells of this process

// A background command: started with its output into a file. Returns its id (bash_N).
export function startShell({ shell, command, cwd, env, stdin, owner = null, sessionId = null, description = '' }) {
  fs.mkdirSync(shellsDir(), { recursive: true });
  const uid = crypto.randomUUID();
  // (not 'a': on Windows that is append-only access, to which MSYS programs, bash's own echo included, cannot write;
  // the processes of the command share this one handle, and its position)
  const out = fs.openSync(fileOf(uid, 'log'), 'w');
  let child;
  try {
    child = spawnShell(shell, command, {
      cwd, env, stdin, out,
      exitFile: shell.kind === 'bash' ? fileOf(uid, 'exit') : null,
      pidFile: isWin && shell.kind === 'bash' ? fileOf(uid, 'pid') : null,
    });
  } finally {
    try { fs.closeSync(out); } catch { /* the child has its own */ }
  }
  const rec = {
    uid, id: `bash_${++counter}`, owner, ownerPid: process.pid, sessionId, command, description: String(description || ''),
    cwd, startedAt: Date.now(), status: 'running', exitCode: null, endedAt: null, released: null, seen: Date.now(), readPos: 0,
    kind: shell.kind, winpid: isWin ? child.pid : null, pid: isWin ? null : child.pid, startKey: isWin ? null : startKey(child.pid),
    msysPid: null, msysWinpid: null,
  };
  shells.set(uid, { rec, child });
  // not this process's to wait for: it would keep a process that is done (a restart) from exiting
  child.unref();
  child.stdin?.unref?.();
  child.on('exit', (code) => {
    rec.status = rec.status === 'killed' ? 'killed' : 'completed';
    rec.exitCode = code;
    rec.endedAt = Date.now();
    save(rec);
  });
  child.on('error', (e) => {
    rec.status = 'failed';
    rec.endedAt = Date.now();
    try { fs.appendFileSync(fileOf(uid, 'log'), `\n${e.message}\n`); } catch { /* none */ }
    save(rec);
  });
  save(rec);
  learnMsysSoon(rec);
  // the shells that ended stay listed, with what was not read of their output: the oldest go past MAX_ENDED
  const ended = [...shells.values()].filter((s) => s.rec.status !== 'running' && s.rec.owner === owner).sort((a, b) => a.rec.startedAt - b.rec.startedAt);
  for (const s of ended.slice(0, Math.max(0, ended.length - MAX_ENDED))) { shells.delete(s.rec.uid); removeFiles(s.rec.uid); }
  startHeartbeat();
  return rec.id;
}

function entryOf(id, owner) {
  for (const s of shells.values()) if (s.rec.id === id && ownedBy(s.rec, owner)) return s;
  return null;
}

function current(s) { return s.child ? s.rec : refresh(s.rec); }

export function listShells(owner) {
  return [...shells.values()].filter((s) => ownedBy(s.rec, owner)).map(current).sort((a, b) => a.startedAt - b.startedAt)
    .map((r) => ({ id: r.id, command: r.command, description: r.description || '', status: r.status, exitCode: r.exitCode, startedAt: r.startedAt }));
}

export const hasShell = (id, owner) => Boolean(entryOf(id, owner));

// The output a shell printed since it was last read: {status, exitCode, text, skipped (bytes not read: too much)}.
export function readShell(id, owner) {
  const s = entryOf(id, owner);
  if (!s) return null;
  const rec = current(s);
  const final = rec.status !== 'running';
  let text = '';
  let skipped = 0;
  try {
    const size = fs.statSync(fileOf(rec.uid, 'log')).size;
    if (size < rec.readPos) rec.readPos = 0; // (cut down meanwhile)
    let start = rec.readPos;
    if (size - start > READ_MAX) { skipped = size - READ_KEEP - start; start = size - READ_KEEP; }
    const len = size - start;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(fileOf(rec.uid, 'log'), 'r');
      try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
      // whole lines (a line still being written may end inside a character): its end is read next time
      const decoder = new OutputDecoder();
      text = decoder.write(buf);
      let consumed = len - (decoder.pending?.length || 0);
      if (final) { text += decoder.end(); consumed = len; }
      rec.readPos = start + consumed;
      save(rec);
    }
  } catch { /* no output file (yet) */ }
  return { status: rec.status, exitCode: rec.exitCode, text: stripAnsi(text), skipped };
}

export async function killShell(id, owner) {
  const s = entryOf(id, owner);
  if (!s) return { found: false };
  const rec = current(s);
  if (rec.status !== 'running') return { found: true, status: rec.status, command: rec.command };
  rec.status = 'killed';
  if (s.child) await killTree(s.child, { orphans: true }); // still running: the shell, or what it left running
  else await killRecorded(rec);
  rec.endedAt = Date.now();
  save(rec);
  return { found: true, killed: true, command: rec.command };
}

// The session ends (every session of the process when `owner` is not given): its shells are killed, their files go.
export function endShells(owner) {
  for (const [uid, s] of shells) {
    if (!ownedBy(s.rec, owner)) continue;
    if (s.rec.status === 'running') {
      if (s.child) killTreeSync(s.child, { orphans: true });
      else killRecordedSync(s.rec);
    }
    shells.delete(uid);
    removeFiles(uid);
  }
}

// The process restarts and the session goes on in the next one (conversation `sessionId`): the shells keep running,
// left for it to take up. Ended ones go along (their output may not have been read).
export function releaseShells(owner, sessionId) {
  const now = Date.now();
  for (const [uid, s] of shells) {
    if (!ownedBy(s.rec, owner)) continue;
    const rec = current(s);
    learnMsys(rec); // (the next process knows the shell by it)
    Object.assign(rec, { released: now, seen: now, sessionId: sessionId || rec.sessionId, owner: null });
    save(rec);
    shells.delete(uid);
  }
}

// The conversation `sessionId` is loaded in this process (`owner`): the shells a process before it left for it are
// this one's now. Returns {adopted, waiting}: `waiting`, those still held by a process that runs (it is handing the
// session over and has not let go yet: ask again).
export function adoptShells({ owner = null, sessionId }) {
  let adopted = 0;
  let waiting = 0;
  if (!sessionId) return { adopted, waiting };
  let names = [];
  try { names = fs.readdirSync(shellsDir()).filter((n) => n.endsWith('.json')); } catch { return { adopted, waiting }; }
  for (const name of names) {
    const rec = readRec(path.join(shellsDir(), name));
    if (!rec || rec.sessionId !== sessionId || shells.has(rec.uid)) continue;
    const held = !rec.released && rec.ownerPid && rec.ownerPid !== process.pid && processAlive(rec.ownerPid);
    if (held) { waiting++; continue; }
    Object.assign(rec, { owner, ownerPid: process.pid, released: null, seen: Date.now() });
    refresh(rec);
    save(rec);
    shells.set(rec.uid, { rec, child: null });
    const n = parseInt(rec.id.replace(/^bash_/, ''), 10);
    if (Number.isFinite(n) && n > counter) counter = n;
    adopted++;
  }
  if (adopted) startHeartbeat();
  return { adopted, waiting };
}

// Shells nobody took up: a process that went away without a word (a crash) or released them for a next process that
// never loaded the conversation. Killed after shellTiming.orphanMs; the files of ended ones go after keepEndedMs.
let lastSweep = 0;
export async function sweepShells(now = Date.now(), { force = false } = {}) {
  if (!force && now - lastSweep < 5 * 60_000) return; // (every process of the program asks: once in a while is enough)
  lastSweep = now;
  let names = [];
  try { names = fs.readdirSync(shellsDir()); } catch { return; }
  for (const name of names) {
    if (/\.tmp$/.test(name)) {
      try { if (now - fs.statSync(path.join(shellsDir(), name)).mtimeMs > 60_000) fs.rmSync(path.join(shellsDir(), name), { force: true }); } catch { /* gone */ }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const rec = readRec(path.join(shellsDir(), name));
    if (!rec || shells.has(rec.uid)) continue;
    const ownerAlive = rec.ownerPid && rec.ownerPid !== process.pid && processAlive(rec.ownerPid);
    if (ownerAlive && !rec.released) continue; // its process has it
    const since = rec.released || rec.seen || rec.startedAt || 0;
    refresh(rec);
    if (rec.status === 'running') {
      if (now - since < shellTiming.orphanMs) continue;
      rec.status = 'killed';
      await killRecorded(rec);
      rec.endedAt = now;
      save(rec);
      continue;
    }
    if (now - (rec.endedAt || since) > shellTiming.keepEndedMs) removeFiles(rec.uid);
  }
}
