// The background sessions of this computer: claude-pro --headless processes that the computer service (host.js)
// starts for the web page, without a window. Each one is a supervisor (bin/claude-pro.js, see supervisor.js) with
// the session as its child, so that /restart, /cd, the Restart tool and updates restart it as they restart a
// terminal session, under the same id. The service only watches the supervisor:
//
// - it ends with 0, or the session left a mark that it ended (/exit, the service's stop): exited, and off the list
//   of sessions to open again;
// - otherwise it crashed: opened again with --resume (the same conversation, the same id at the gateway), at most
//   MAX_CRASHES times in CRASH_WINDOW_MS, then failed (with the end of its log as the error);
// - CONFIG_DIR/host-sessions.json keeps the sessions to open again when the service starts (after a reboot, or a
//   new version of the service): one still running is taken over, the others are opened again with --resume. A task
//   that was running is not continued: the conversation is.
// - Whether a session runs is told by the processes themselves (liveSessionProcesses: those started with --headless
//   --remote-id <id>), not by a pid kept from before: a session is never opened while a process of it runs, and
//   copies that should not be there (two supervisors of one id) are ended, the one the service knew kept.
//
// Each session's output (its log: what it printed, as plain text, and the errors of its processes) goes to
// CONFIG_DIR/logs/sessions/<id>.log, cut down to LOG_BYTES (copied to .log.1 first) once a minute.
//
// What the service learns from a session (its directory after a /cd, its name, its conversation) comes from the
// registry of this computer's sessions (peers.js), where a session also takes its orders from the service
// (POST /control: exit, restart).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { listPeers, controlPeer } from './peers.js';

export const CRASH_WINDOW_MS = 10 * 60_000;
export const MAX_CRASHES = 3;
const KEEP_ENDED = 20;
const LOG_BYTES = 1_000_000;
const STOP_WAIT_MS = 10_000;
const STARTING_MS = 30_000; // a session that has not shown up in the registry by then counts as running anyway
const ID = /^[A-Za-z0-9_-]{8,64}$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The processes of background sessions running now, by their id at the gateway: Map id -> {supervisors, sessions}
// ([{pid, ppid}] each): the processes started with --headless --remote-id <id> (bin/claude-pro.js runs the
// supervisor, which runs the session with the same arguments). A supervisor is one whose parent is not one of them;
// a session without its supervisor (killed) is in `sessions` alone. Read from the system's list of processes.
export function liveSessionProcesses() {
  let rows = [];
  try {
    if (process.platform === 'win32') {
      const script = [
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
        // a tab between the fields: "`t" in a string of double quotes
        "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%--headless%'\" | ForEach-Object { \"{0}`t{1}`t{2}\" -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }",
      ].join('\n');
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
      rows = String(r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => { const [pid, ppid, ...rest] = l.split('\t'); return { pid: Number(pid), ppid: Number(ppid), args: rest.join('\t') }; });
    } else if (process.platform === 'linux') {
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          const args = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ');
          if (!args.includes('--headless')) continue;
          const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
          rows.push({ pid: Number(d), ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), args });
        } catch { /* gone meanwhile */ }
      }
    } else {
      const r = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 30_000 });
      rows = String(r.stdout || '').split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
    }
  } catch { /* nothing known: nothing taken for running */ }
  const byId = new Map();
  for (const row of rows) {
    const id = /--remote-id\s+"?([A-Za-z0-9_-]{8,64})/.exec(row.args)?.[1];
    if (!id || !/--headless/.test(row.args) || row.pid === process.pid) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ pid: row.pid, ppid: row.ppid });
  }
  const out = new Map();
  for (const [id, list] of byId) {
    const pids = new Set(list.map((p) => p.pid));
    out.set(id, { supervisors: list.filter((p) => !pids.has(p.ppid)), sessions: list.filter((p) => pids.has(p.ppid)) });
  }
  return out;
}

// Where a background session says it ended for good (see App.exit): the service reads and removes it.
export const endedMarker = (dir, id) => path.join(dir, 'background-ended', id);

export function markEnded(dir, id) {
  if (!ID.test(String(id || ''))) return;
  try {
    fs.mkdirSync(path.dirname(endedMarker(dir, id)), { recursive: true });
    fs.writeFileSync(endedMarker(dir, id), new Date().toISOString());
  } catch { /* the service then thinks it crashed, and opens it again */ }
}

// The last `lines` lines of a log (and of the one before it, when that is not enough).
export function tailFile(file, lines = 200) {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  let text = read(file);
  if (text.split('\n').length <= lines) text = read(`${file}.1`) + text;
  const all = text.replace(/\n$/, '').split('\n');
  return all.slice(-lines).join('\n');
}

// End a process and what it started: the supervisor of a session, and the session under it.
export function killTree(pid) {
  if (!pidAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref?.();
}

export class BackgroundSessions {
  // dir: CONFIG_DIR. entry: bin/claude-pro.js. env: what the sessions get. onChange(): something to report.
  constructor({ dir, entry, env = process.env, log = () => {}, onChange = () => {}, execPath = process.execPath }) {
    this.dir = dir;
    this.entry = entry;
    this.env = env;
    this.log = log;
    this.onChange = onChange;
    this.execPath = execPath;
    this.sessions = new Map(); // sessionId -> record (running, starting, restarting, failed, or suspended)
    this.ended = []; // the public records of the sessions that ended, newest first
    this.timer = null;
    this.rotateTimer = null;
    this.suspended = false;
  }

  get file() { return path.join(this.dir, 'host-sessions.json'); }
  logFile(id) { return path.join(this.dir, 'logs', 'sessions', `${id}.log`); }

  // The sessions saved by the service before: taken over when they still run, opened again when not.
  start() {
    let saved = [];
    let live = null; // the processes of the sessions running now, read once
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* none */ }
    for (const s of Array.isArray(saved) ? saved : []) {
      if (!s || !ID.test(String(s.sessionId || '')) || typeof s.cwd !== 'string') continue;
      const rec = this.record(s);
      this.sessions.set(rec.sessionId, rec);
      if (s.state === 'failed') { rec.state = 'failed'; rec.error = s.error || null; continue; }
      if (s.suspended) { rec.suspended = true; rec.state = 'exited'; continue; }
      live ??= liveSessionProcesses();
      if (this.adopt(rec, live.get(rec.sessionId), s.pid)) {
        rec.startedAt = s.startedAt || null;
      } else {
        this.log(`opening the background session ${rec.sessionId} again in ${rec.cwd}`);
        this.launch(rec, { resume: true });
      }
    }
    this.closed = false;
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref?.();
    this.rotateTimer = setInterval(() => this.rotateLogs(), 60_000);
    this.rotateTimer.unref?.();
    this.persist();
  }

  // The service stops watching (its sessions run on, for the next one to take over).
  close() {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.rotateTimer);
  }

  record(s) {
    return {
      sessionId: s.sessionId,
      cwd: s.cwd,
      name: s.name || '',
      conversationId: s.conversationId || null,
      model: s.model || null,
      state: 'starting',
      pid: null,
      childPid: null,
      child: null,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      error: null,
      restarts: 0,
      crashes: [],
      stopping: false,
      restartFrom: null,
      suspended: false,
      attached: 0, // terminals attached to it (claude-pro attach, a window the page opened)
    };
  }

  // A new background session for the web page: {sessionId, cwd, name, conversationId (to resume), model}.
  open({ sessionId, cwd, name = '', resume = null, model = null }) {
    if (this.sessions.get(sessionId) && this.alive(this.sessions.get(sessionId))) throw new Error('这个会话已经在运行');
    const rec = this.record({ sessionId, cwd, name, conversationId: resume, model });
    this.sessions.set(sessionId, rec);
    this.ended = this.ended.filter((e) => e.sessionId !== sessionId);
    this.launch(rec, { resume: Boolean(resume), first: true });
    this.persist();
    this.onChange();
    return { pid: rec.pid };
  }

  // Take over the session `rec` when processes of it run (`found`: an entry of liveSessionProcesses): its supervisor,
  // the one with pid `prefer` when there are several (the others, copies that should not be there, are ended);
  // without one, the session process itself (its supervisor was killed: it ends one day, and is then opened again).
  // Returns whether there was one to take over.
  adopt(rec, found, prefer = null) {
    const heads = found?.supervisors?.length ? found.supervisors : found?.sessions || [];
    if (!heads.length) return false;
    const keep = heads.find((p) => p.pid === prefer) || heads.find((p) => p.pid === rec.pid) || heads[heads.length - 1];
    for (const p of heads) {
      if (p === keep) continue;
      this.log(`the background session ${rec.sessionId} ran twice: ended the copy with pid ${p.pid}, kept ${keep.pid}`);
      killTree(p.pid);
    }
    rec.pid = keep.pid;
    rec.child = null;
    rec.state = 'running';
    rec.suspended = false;
    this.log(`took over the background session ${rec.sessionId} (pid ${rec.pid}) in ${rec.cwd}`);
    return true;
  }

  // Start the session's processes; with `resume` (opened again: after a crash, a restart of the service, a login)
  // only when none of them runs (see adopt): opening it again then would make two copies of one session.
  launch(rec, { resume = false, first = false } = {}) {
    if (resume && this.adopt(rec, liveSessionProcesses().get(rec.sessionId))) {
      this.persist();
      this.onChange();
      return;
    }
    const args = [this.entry, '--headless', '--remote-id', rec.sessionId];
    if (resume && rec.conversationId) args.push('--resume', rec.conversationId);
    if (first && rec.name) args.push('--name', rec.name);
    if (first && rec.model) args.push('--model', rec.model);
    const log = this.logFile(rec.sessionId);
    let fd = null;
    try {
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.appendFileSync(log, `${new Date().toISOString()} [service] starting: claude-pro ${args.slice(1).join(' ')}\n`);
      fd = fs.openSync(log, 'a');
      const child = spawn(this.execPath, args, { cwd: rec.cwd, env: this.env, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
      rec.child = child;
      rec.pid = child.pid ?? null;
      rec.childPid = null;
      rec.state = rec.state === 'restarting' ? 'restarting' : 'starting';
      rec.startedAt = new Date().toISOString();
      rec.launchedAt = Date.now();
      rec.endedAt = null;
      rec.exitCode = null;
      rec.error = null;
      rec.stopping = false;
      rec.suspended = false;
      child.on('error', (e) => {
        if (rec.child !== child) return;
        rec.child = null;
        this.fail(rec, `无法启动：${e.message}`);
      });
      child.on('exit', (code, signal) => {
        if (rec.child !== child) return;
        rec.child = null;
        this.gone(rec, code ?? (signal ? `signal ${signal}` : null));
      });
      child.unref();
    } catch (e) {
      this.fail(rec, `无法启动：${e.message}`);
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
    }
  }

  alive(rec) { return Boolean(rec.child) || pidAlive(rec.pid); }

  // The supervisor of `rec` is gone: ended for good, or crashed.
  gone(rec, code) {
    if (!this.sessions.has(rec.sessionId)) return;
    let marked = false;
    try { fs.rmSync(endedMarker(this.dir, rec.sessionId)); marked = true; } catch { /* none */ }
    if (rec.suspended) { rec.state = 'exited'; rec.endedAt = new Date().toISOString(); this.persist(); this.onChange(); return; }
    if (rec.stopping || marked || code === 0) {
      this.finish(rec, code);
      return;
    }
    const now = Date.now();
    rec.crashes = rec.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    rec.crashes.push(now);
    if (rec.crashes.length > MAX_CRASHES) {
      this.fail(rec, tailFile(this.logFile(rec.sessionId), 12) || `退出码 ${code}`, code);
      return;
    }
    rec.restarts++;
    rec.state = 'restarting';
    rec.exitCode = code;
    this.log(`the background session ${rec.sessionId} stopped (${code ?? 'no exit code'}): opening it again (${rec.crashes.length}/${MAX_CRASHES} in ${CRASH_WINDOW_MS / 60_000} minutes)`);
    this.onChange();
    setTimeout(() => { if (!this.closed && this.sessions.get(rec.sessionId) === rec && rec.state === 'restarting' && !this.alive(rec)) this.launch(rec, { resume: true }); }, 1000).unref?.();
  }

  fail(rec, error, code = null) {
    rec.state = 'failed';
    rec.error = String(error || '').slice(-2000);
    rec.exitCode = code;
    rec.endedAt = new Date().toISOString();
    this.log(`the background session ${rec.sessionId} failed: ${rec.error.split('\n').pop()}`);
    this.persist();
    this.onChange();
  }

  // Ended for good: off the list of sessions to open again.
  finish(rec, code = null) {
    rec.state = 'exited';
    rec.exitCode = code;
    rec.endedAt = new Date().toISOString();
    this.sessions.delete(rec.sessionId);
    this.ended.unshift(this.public(rec));
    this.ended.length = Math.min(this.ended.length, KEEP_ENDED);
    this.log(`the background session ${rec.sessionId} ended`);
    this.persist();
    this.onChange();
  }

  peerOf(rec) { return listPeers().find((p) => p.remoteId === rec.sessionId && p.kind === 'background') || null; }

  // Every two seconds: what the sessions say about themselves in the registry, and whether they still run.
  tick() {
    let changed = false;
    const peers = listPeers();
    for (const rec of this.sessions.values()) {
      if (rec.state === 'failed' || rec.suspended) continue;
      const p = peers.find((x) => x.remoteId === rec.sessionId);
      if (p) {
        for (const [k, v] of [['cwd', p.cwd], ['name', p.name], ['conversationId', p.conversationId], ['childPid', p.pid]]) {
          if (v && rec[k] !== v) { rec[k] = v; changed = true; }
        }
        if (rec.state === 'starting' || (rec.state === 'restarting' && p.pid !== rec.restartFrom)) { rec.state = 'running'; rec.restartFrom = null; changed = true; }
      } else if (rec.state === 'starting' && Date.now() - (rec.launchedAt || 0) > STARTING_MS && this.alive(rec)) {
        rec.state = 'running';
        changed = true;
      }
      // the terminals attached to it (none while it is not in the registry: starting, restarting)
      const attached = Number(p?.attached) || 0;
      if (rec.attached !== attached) { rec.attached = attached; changed = true; }
      // one taken over from an earlier service has no child process here: its pid tells
      if (!rec.child && rec.state !== 'restarting' && !pidAlive(rec.pid)) this.gone(rec, null);
    }
    if (changed) { this.persist(); this.onChange(); }
  }

  // stop: as /exit (the session stops what it does, then ends); not ended after STOP_WAIT_MS, it is killed.
  async stop(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) {
      if (this.ended.some((e) => e.sessionId === sessionId)) return {};
      throw new Error('这台电脑上没有这个后台会话');
    }
    if (!this.alive(rec)) { this.finish(rec, rec.exitCode); return {}; }
    rec.stopping = true;
    const peer = this.peerOf(rec);
    if (peer) await controlPeer(peer, { action: 'exit' }).catch(() => { /* killed below */ });
    for (let t = 0; t < STOP_WAIT_MS && this.alive(rec); t += 200) await sleep(200);
    if (this.alive(rec)) {
      this.log(`the background session ${sessionId} did not end in ${STOP_WAIT_MS / 1000} s: killing it`);
      killTree(rec.pid);
      for (let t = 0; t < 5000 && this.alive(rec); t += 200) await sleep(200);
    }
    if (this.sessions.get(sessionId) === rec) this.finish(rec, rec.exitCode);
    return {};
  }

  // restart: as /restart for one that runs (the same process tree, the conversation kept); one that failed or
  // ended is opened again with --resume, its count of restarts back to 0.
  async restart(sessionId) {
    let rec = this.sessions.get(sessionId);
    if (rec && this.alive(rec) && rec.state !== 'failed') {
      const peer = this.peerOf(rec);
      if (!peer) throw new Error('这个会话还在启动，稍后再试');
      rec.restartFrom = peer.pid;
      rec.state = 'restarting';
      this.onChange();
      try {
        await controlPeer(peer, { action: 'restart' });
      } catch (e) {
        rec.state = 'running';
        rec.restartFrom = null;
        this.onChange();
        throw new Error(`重启失败：${e.message}`);
      }
      return {};
    }
    if (!rec) {
      const old = this.ended.find((e) => e.sessionId === sessionId);
      if (!old) throw new Error('这台电脑上没有这个后台会话');
      rec = this.record(old);
      this.ended = this.ended.filter((e) => e.sessionId !== sessionId);
      this.sessions.set(sessionId, rec);
    }
    rec.crashes = [];
    rec.restarts = 0;
    rec.state = 'starting';
    this.launch(rec, { resume: true });
    this.persist();
    this.onChange();
    return {};
  }

  // The gateway no longer takes this computer (or it logged out): the sessions end, and are kept to be opened
  // again when it is back (resumeAll).
  async suspendAll() {
    if (this.suspended) return;
    this.suspended = true;
    const running = [...this.sessions.values()].filter((r) => this.alive(r));
    for (const rec of running) rec.suspended = true;
    await Promise.all(running.map(async (rec) => {
      const peer = this.peerOf(rec);
      if (peer) await controlPeer(peer, { action: 'exit' }).catch(() => {});
      for (let t = 0; t < STOP_WAIT_MS && this.alive(rec); t += 200) await sleep(200);
      if (this.alive(rec)) killTree(rec.pid);
    }));
    this.persist();
    this.onChange();
  }

  resumeAll() {
    if (!this.suspended && ![...this.sessions.values()].some((r) => r.suspended)) return;
    this.suspended = false;
    for (const rec of this.sessions.values()) {
      if (!rec.suspended) continue;
      rec.suspended = false;
      rec.crashes = [];
      this.launch(rec, { resume: true });
    }
    this.persist();
    this.onChange();
  }

  // The conversation `conversationId` deleted: the sessions that are not running and had it (failed, suspended,
  // ended) are forgotten, so that it is not opened again. Returns their logs (they hold its text), to delete too.
  forgetConversation(conversationId) {
    const logs = [];
    for (const rec of [...this.sessions.values()]) {
      if (rec.conversationId !== conversationId || this.alive(rec)) continue;
      this.sessions.delete(rec.sessionId);
      logs.push(this.logFile(rec.sessionId));
    }
    for (const e of this.ended.filter((x) => x.conversationId === conversationId)) logs.push(this.logFile(e.sessionId));
    this.ended = this.ended.filter((x) => x.conversationId !== conversationId);
    this.persist();
    this.onChange();
    return logs.flatMap((f) => [f, `${f}.1`]);
  }

  // The conversation `conversationId` already open in a session of this computer (a background one, or a terminal):
  // its entry in the registry.
  openConversation(conversationId) {
    if (!conversationId) return null;
    return listPeers().find((p) => p.conversationId === conversationId) || null;
  }

  rotateLogs() {
    for (const rec of this.sessions.values()) {
      const file = this.logFile(rec.sessionId);
      try {
        if (fs.statSync(file).size <= LOG_BYTES) continue;
        // copied, then emptied: the processes write to it all along (in append mode, so they go on at its end)
        fs.copyFileSync(file, `${file}.1`);
        fs.truncateSync(file, 0);
      } catch { /* not there yet */ }
    }
  }

  public(rec) {
    return {
      sessionId: rec.sessionId,
      cwd: rec.cwd,
      name: rec.name,
      conversationId: rec.conversationId,
      state: rec.state,
      pid: rec.pid,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      exitCode: rec.exitCode,
      error: rec.error,
      restarts: rec.restarts,
      attached: rec.attached || 0,
    };
  }

  // For the gateway: the sessions now, then those that ended (at most KEEP_ENDED).
  list() {
    return [...[...this.sessions.values()].map((r) => this.public(r)), ...this.ended];
  }

  persist() {
    const list = [...this.sessions.values()].map((r) => ({
      sessionId: r.sessionId, cwd: r.cwd, name: r.name, conversationId: r.conversationId, model: r.model,
      pid: r.pid, startedAt: r.startedAt, state: r.state === 'failed' ? 'failed' : undefined, error: r.state === 'failed' ? r.error : undefined,
      suspended: r.suspended || undefined,
    }));
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log(`could not save ${this.file}: ${e.message}`);
    }
  }
}
