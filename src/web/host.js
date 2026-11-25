// The 后台会话 of the web console: sessions that run inside the console's own process, each an App with no terminal
// (what it prints goes to the console's live view), instead of a claude-pro process (and a supervisor) of their own
// in a hidden window. One process for all of them, as DeepSeek Harness runs its sessions: about 90 MB less per
// session. What a session owns in the process (background shells, REPL interpreters, browser tabs) is kept apart by
// its config.owner (see tools/bash.js, code.js, browser.js).
//
// New code (a change of the source, an update, the Restart tool, /restart) can only be loaded by a new process, so
// the console restarts with all its sessions at once, when none of them is working: each leaves its state (as a
// supervised session does, see App.restartState) in a hand-over file, and the next process takes them all up again
// with the same ids, so that open pages carry on. /cd needs no new code: that session alone starts again, at once.
// The sessions running are also listed in a file, so that a console that went away without a hand-over (a crash, a
// kill) brings them back when it starts again.

import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { CONFIG_DIR, INSTALL_DIR, VERSION, APP_NAME } from '../config.js';
import { runSelfCheck, watchSource, reloadTiming, RESTART_EXIT_CODE, MAX_RESTARTS, RESTART_WINDOW_MS } from '../restart.js';
import { installedByNpm, installedVersion, isNewer } from '../updater.js';
import { listPeers } from '../peers.js';
import { REMOTE_WIDTH } from '../remote.js';
import { sweepShells } from '../shells.js';
import { inTerminal } from '../ui/ansi.js';
import { nextStreams, terminalReady, terminalEnded } from './terminals.js';

export const rosterFile = () => path.join(CONFIG_DIR, 'web-running.json');
export const handoffFile = () => path.join(CONFIG_DIR, 'web-handoff.json');
const errorLog = () => path.join(CONFIG_DIR, 'web-errors.log');
export const hostTiming = { idleMs: 30 * 60_000, emptyQuietMs: 2000, recheckMs: 5000, handoffMaxAgeMs: 10 * 60_000, startMs: 20_000, reattachMs: 30_000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// The streams an App takes for its terminal: keys nobody types, and output nobody reads (HeadlessScreen draws
// nothing anyway), as wide as the live view lays things out.
function noTerminal() {
  const stdin = new PassThrough();
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  const stdout = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  Object.assign(stdout, { isTTY: false, columns: REMOTE_WIDTH, rows: 40 });
  return { stdin, stdout };
}

export class SessionHost {
  // `restartProcess()`: a new console process takes over (the hand-over file is written), and this one ends.
  constructor({ restartProcess = () => {} } = {}) {
    this.apps = new Set();
    this.restartProcess = restartProcess;
    this.requests = new Map(); // app -> the restart it asked for ({reason, then, continueTurn}), until all are idle
    this.told = new Map(); // app -> whom it was last told its restart waits for
    this.source = null; // a change of the program's source not loaded yet: {key, inTurn, quietAt, update}
    this.failed = null; // the key of the change whose new code did not start (said once)
    this.restarting = false;
    this.checking = false;
    this.updating = false;
    this.recovering = false;
    this.launching = 0; // sessions starting (a /cd starts one again under the same id)
    this.startedAt = Date.now();
    this.restartTimes = []; // when the console restarted lately (carried over by the hand-over): a loop is refused
    this.timer = null;
    this.watcher = null;
    this.rosterTimer = setInterval(() => this.saveRoster(), 60_000); // (the model of each, which changes in between)
    this.rosterTimer.unref();
    this.idleSince = new Map(); // app -> since when nothing has gone on in it and no page has watched it
    this.reapTimer = setInterval(() => { this.reap(); sweepShells().catch((e) => this.log(e, 'sweep')); }, 60_000);
    this.reapTimer.unref();
    // sessions of attached terminals the console before this one handed over, by peer id: {state, timer}, until their
    // window attaches again (or, after a while, taken up without one: they go on as 后台会话)
    this.pendingAttach = new Map();
  }

  get size() { return this.apps.size; }

  beginUpdate() {
    if (this.updating || this.restarting || this.checking || this.recovering || this.launching || [...this.apps].some((app) => !this.ready(app))) return false;
    this.updating = true;
    return true;
  }

  endUpdate(restart) {
    this.updating = false;
    if (restart) this.requestHandover();
    else this.check();
  }

  log(e, what = '') {
    try {
      const file = errorLog();
      // (kept small: the newer half stays when it has grown to 2 MB)
      try { if (fs.statSync(file).size > 2 * 1024 * 1024) { const old = fs.readFileSync(file); fs.writeFileSync(file, old.subarray(old.indexOf(10, old.length >> 1) + 1)); } } catch { /* none yet */ }
      fs.appendFileSync(file, `${new Date().toISOString()} ${what}${what ? ': ' : ''}${e?.stack || e}\n`);
    } catch { /* nowhere to say it */ }
  }

  // A session: new in `cwd`, a saved one (`resumeFile`, `resumeId`), or one taken up again (`restart`: the state it
  // left). Resolves with its App once the console's page can reach it.
  // `terminal`: the link of an attached window (see terminals.js), whose terminal the session gets.
  async launch({ cwd, restart = null, resumeFile = null, resumeId = null, initialChoices = null, terminal = null }) {
    this.launching++;
    try {
      return await this.startApp({ cwd, restart, resumeFile, resumeId, initialChoices, terminal });
    } finally {
      this.launching--;
      this.check();
    }
  }

  async startApp({ cwd, restart, resumeFile, resumeId, initialChoices, terminal }) {
    const { App } = await import('../ui/repl.js');
    const flags = { ...(terminal?.flags || {}), ...(initialChoices ? { initialChoices } : {}) };
    if (restart) flags.restart = restart;
    else if (resumeFile) Object.assign(flags, { resumeFile, resumeId });
    const { stdin, stdout } = terminal ? nextStreams(terminal) : noTerminal();
    const app = new App({ flags, cwd, stdin, stdout, host: this, attached: terminal ? { row: terminal.row, profile: terminal.profile, link: terminal } : null });
    if (terminal) terminal.app = app;
    this.apps.add(app);
    // (an attached session runs, and so does all it starts, drawing for its window's terminal: see ansi.js)
    const ended = inTerminal(terminal?.profile, () => app.start(restart ? '' : terminal?.prompt || '')).catch((e) => {
      this.log(e, `session in ${cwd}`);
      try { app.exit(1); } catch { /* half started */ }
      return 1;
    });
    if (terminal) ended.then((code) => terminalEnded(terminal, app, code, { goesOn: this.restarting || code === RESTART_EXIT_CODE }));
    ended.finally(() => {
      this.apps.delete(app);
      this.requests.delete(app);
      this.told.delete(app);
      this.idleSince.delete(app);
      if (!this.restarting) { this.saveRoster(); this.check(); }
    });
    // up: its runtime exists (its peer server, which the page talks to, comes before it)
    const until = Date.now() + hostTiming.startMs;
    while (!app.runtime && !app.exiting && Date.now() < until) await sleep(50);
    if (terminal && !app.exiting) terminalReady(terminal, app);
    this.saveRoster();
    return app;
  }

  // A session of an attached terminal asks its user something before it is up (the project's trust): the window's
  // keys, which wait for the session to be ready, are let through now.
  terminalAsks(app) {
    if (app.attached?.link) terminalReady(app.attached.link, app);
  }

  // A window attaches (see terminals.js): a new session for it, the one a supervised session of its own leaves when it
  // restarts into this (`hello.restart`), or the one the console before this one handed over (`hello.reattach`).
  async attachTerminal(link, hello) {
    if (hello.reattach) {
      const pending = this.pendingAttach.get(hello.reattach);
      if (!pending) return null;
      this.pendingAttach.delete(hello.reattach);
      clearTimeout(pending.timer);
      link.flags = {};
      return this.launch({ cwd: pending.state.cwd, restart: pending.state, terminal: link });
    }
    const flags = hello.flags && typeof hello.flags === 'object' ? { ...hello.flags } : {};
    delete flags.restart;
    link.flags = flags;
    link.prompt = typeof hello.prompt === 'string' ? hello.prompt : '';
    const restart = hello.restart && typeof hello.restart === 'object' ? hello.restart : null;
    const cwd = restart?.cwd && fs.existsSync(restart.cwd) ? restart.cwd : hello.cwd;
    if (!fs.existsSync(cwd)) return null;
    return this.launch({ cwd, restart, terminal: link });
  }

  // A session nobody works in or looks at for a while is put away: opening the conversation (or sending to it) takes
  // it up again in a tenth of a second, so the page does not tell running and saved conversations apart, and what
  // the console holds is what is in use. Not one that works, asks, has something queued or running in the background,
  // or waits for a restart.
  reap(now = Date.now()) {
    if (this.restarting) return;
    for (const app of this.apps) {
      if (app.exiting || !app.runtime || app.attached) continue; // (a terminal's session ends with its window)
      // (a background shell keeps it: putting it away would end the shell; a restart does not, see shells.js)
      const busy = app.working() || app.runningShells?.() > 0 || this.requests.has(app) || app.liveFeed?.active;
      if (busy || !this.idleSince.has(app)) { this.idleSince.set(app, now); continue; }
      if (now - this.idleSince.get(app) >= hostTiming.idleMs) {
        try {
          if (!app.flushUnsavedConversation()) continue;
          this.idleSince.delete(app);
          app.exit(0);
        } catch (e) { this.log(e, 'put away'); }
      }
    }
  }

  // /cd in one session: it alone starts again, in the new directory, with the state it left.
  relaunch(app, state) {
    const terminal = app.attached?.link || null; // (in the same window)
    app.exit(RESTART_EXIT_CODE, { restart: true });
    this.launch({ cwd: state.cwd, restart: state, terminal }).catch((e) => this.log(e, 'relaunch'));
  }

  // The sessions the page reaches through peer servers (see peers.js), by id: waited for while the console takes
  // them up again (a hand-over, a start after a crash), so that an open page does not take one for gone.
  async waitForPeer(peerId, ms = 8000) {
    const until = Date.now() + ms;
    for (;;) {
      const peer = listPeers().find((p) => p.id === peerId);
      if (peer) return peer;
      if (!(this.recovering || this.launching || Date.now() - this.startedAt < 30_000) || Date.now() > until) return null;
      await sleep(200);
    }
  }

  // ---------------------------------------------------------------- the list of sessions, and bringing them back

  saveRoster() {
    if (this.restarting) return;
    const sessions = [...this.apps].filter((a) => !a.exiting && a.store).map((a) => ({
      sessionId: a.store.id,
      sessionFile: a.store.file,
      cwd: a.cwd,
      peerId: a.peers?.id || null,
      peerName: a.peers?.name || a.sessionName || null,
      modelOverride: a.runtime?.config.modelOverride ?? null,
      effortOverride: a.runtime?.config.effortOverride ?? null,
      used: a.inUse(),
      attached: Boolean(a.attached), // (after a crash its window attaches again to the console started next)
    }));
    try { writeJson(rosterFile(), { pid: process.pid, at: Date.now(), sessions }); } catch (e) { this.log(e, 'roster'); }
  }

  // At the start of the console: the sessions the console before it handed over, or else those it was running when
  // it went away without a word.
  async recover() {
    this.recovering = true;
    try {
      let states = null;
      const handoff = readJson(handoffFile());
      try { fs.rmSync(handoffFile(), { force: true }); } catch { /* read once anyway */ }
      if (handoff && Array.isArray(handoff.states) && Date.now() - handoff.at < hostTiming.handoffMaxAgeMs) {
        states = handoff.states;
        this.restartTimes = (handoff.restarts || []).filter(Number.isFinite);
      } else {
        const roster = readJson(rosterFile());
        if (roster && roster.pid !== process.pid && !alive(roster.pid) && Array.isArray(roster.sessions)) {
          states = roster.sessions.map((s) => ({ ...s, reason: 'the web console started again', restarts: [] }));
        }
      }
      // (those of attached terminals first, before any wait: their windows may attach again at once)
      const usable = (states || []).filter((s) => s && typeof s.cwd === 'string' && fs.existsSync(s.cwd));
      for (const state of usable.filter((s) => s.attached && s.peerId)) {
        const timer = setTimeout(() => {
          if (this.pendingAttach.get(state.peerId)?.state !== state) return;
          this.pendingAttach.delete(state.peerId);
          this.launch({ cwd: state.cwd, restart: { ...state, attached: false } }).catch((e) => this.log(e, 'recover'));
        }, hostTiming.reattachMs);
        timer.unref?.();
        this.pendingAttach.set(state.peerId, { state, timer });
      }
      for (const state of usable.filter((s) => !(s.attached && s.peerId))) {
        await this.launch({ cwd: state.cwd, restart: state }).catch((e) => this.log(e, 'recover'));
      }
    } finally {
      this.recovering = false;
      this.saveRoster();
      this.check();
    }
  }

  // ---------------------------------------------------------------- new code: the console restarts

  // Follow the program's source, as a supervised session does (App.startSourceWatch): a change made while a session
  // works is its work, loaded when the sessions are idle; one made while all are idle is loaded once the source has
  // been left alone for a few minutes (a few seconds when there is no session to restart).
  watch() {
    // (the page too: the server serves the page it started with, so that page and API always match)
    this.watcher = watchSource(INSTALL_DIR, () => this.noteChange());
  }

  noteChange({ now = false } = {}) {
    const disk = installedVersion();
    const update = installedByNpm() && disk !== VERSION && isNewer(disk, VERSION) ? disk : null;
    const inTurn = [...this.apps].some((a) => a.isTurnRunning());
    const quiet = this.apps.size ? reloadTiming.quietMs + Math.random() * reloadTiming.spreadMs : hostTiming.emptyQuietMs;
    this.source = { key: `${Date.now()}`, inTurn: inTurn || Boolean(this.source?.inTurn) || now, update, quietAt: Date.now() + quiet };
    this.check();
  }

  // A newer console (another version) was started: this one gives way once its sessions are idle.
  requestHandover() { this.noteChange({ now: true }); }

  // New code waiting for the sessions to be idle (the page's notice): the version on disk and what each session that
  // is not idle is busy with. A background agent may run long: the page offers to end it (clearBlockers). Background
  // shells are not in the way: they go on running and the next console takes them over. Null when nothing waits.
  pendingUpdate() {
    const due = this.requests.size || (this.source && this.source.key !== this.failed);
    if (!due) return null;
    const blockers = [...this.apps].filter((a) => !this.ready(a)).map((a) => ({
      name: a.peerLabel(),
      title: a.sessionLabel?.() || a.peerLabel(),
      turn: Boolean(a.isTurnRunning?.()),
      dialog: Boolean(a.dialogs?.length),
      queued: a.queue?.length || 0,
      background: (a.backgroundWork?.() || []).filter((w) => w.kind === 'agent').map(({ kind, id, label }) => ({ kind, id, label })),
    }));
    return { version: installedVersion() || VERSION, blockers };
  }

  // 结束后台程序并更新: the background agents of the sessions the new code waits for (a turn running goes on: it ends by
  // itself; background shells are not in the way). Returns how many were ended.
  async clearBlockers() {
    let ended = 0;
    for (const app of [...this.apps].filter((a) => !this.ready(a))) {
      for (const t of app.runtime?.tasks?.running() || []) { app.runtime.tasks.kill(t.id); ended++; }
    }
    this.check();
    return { ended };
  }

  // A session asks for a restart (the Restart tool, /restart, an update): done when all sessions are idle.
  restartFor(app, request) {
    this.requests.set(app, request || {});
    this.check();
  }

  restartWaits(app) { return this.requests.has(app); }

  // Ready for the restart: not working (a turn, a question open, something queued, a background shell or agent). The
  // session that asked is ready once its turn is over: what it queued goes along, and it said what may be stopped.
  ready(app) {
    if (app.exiting) return true;
    if (!app.runtime) return false; // still starting
    if (this.requests.has(app)) return !app.isTurnRunning() && !app.dialogs.length;
    return !app.working() && !app.reloading && !app.restartRequest;
  }

  check() {
    if (this.restarting || this.checking || this.updating || this.launching || this.recovering) return;
    clearTimeout(this.timer);
    const sourceDue = this.source && this.source.key !== this.failed;
    if (!this.requests.size && !sourceDue) return;
    if (!this.requests.size && !this.source.inTurn && !this.source.update && Date.now() < this.source.quietAt) {
      this.timer = setTimeout(() => this.check(), this.source.quietAt - Date.now() + 50);
      this.timer.unref?.();
      return;
    }
    const busy = [...this.apps].filter((a) => !this.ready(a));
    if (busy.length) {
      const names = busy.map((a) => `@${a.peerLabel()}`).join(', ');
      for (const app of this.requests.keys()) {
        if (this.told.get(app) === names) continue;
        this.told.set(app, names);
        app.notice(`The restart waits until ${names} ${busy.length === 1 ? 'is' : 'are'} idle: the web console restarts all its sessions together.`);
      }
      // a turn's end checks again (App.maybeAutoReload); a background shell or agent that ends does not
      this.timer = setTimeout(() => this.check(), hostTiming.recheckMs);
      this.timer.unref?.();
      return;
    }
    this.restart().catch((e) => { this.restarting = false; this.log(e, 'restart'); });
  }

  async restart() {
    this.checking = true;
    let check;
    try { check = await runSelfCheck(); } finally { this.checking = false; }
    if (!check.ok) {
      this.failed = this.source?.key ?? null;
      const asked = [...this.requests.keys()];
      this.requests.clear();
      for (const app of this.apps) {
        app.notice(`The new code of ${APP_NAME} does not start, so the web console was not restarted${asked.includes(app) ? ' (as this session asked)' : ''}:\n${check.output.split('\n').slice(0, 12).join('\n')}\nFix it; the restart follows by itself (or run /restart).`, 'warn');
      }
      return;
    }
    if (this.launching || this.recovering || [...this.apps].some((a) => !this.ready(a))) { this.check(); return; } // something started meanwhile
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restartTimes.length >= MAX_RESTARTS) {
      this.failed = this.source?.key ?? null;
      this.requests.clear();
      for (const app of this.apps) app.notice(`The web console restarted ${this.restartTimes.length} times in the last ${Math.round(RESTART_WINDOW_MS / 60_000)} minutes, so it does not restart again by itself now: that looks like a loop. A change after that window loads it, or /restart once it has passed.`, 'warn');
      return;
    }
    this.restarting = true;
    clearTimeout(this.timer);
    const why = this.source?.update ? `updated to ${APP_NAME} ${this.source.update}` : this.source ? 'source changed' : '';
    const asked = [...this.requests.values()][0];
    const states = [];
    for (const app of this.apps) {
      if (app.exiting) continue;
      const own = this.requests.get(app);
      // the others: why the console restarted (a change of the source, or what another session asked for)
      const request = own || { reason: why || `web console restarted${asked?.reason ? ` (${asked.reason})` : ''}` };
      try { states.push(app.restartState(request, { counts: Boolean(own) })); } catch (e) { this.log(e, 'restart state'); }
    }
    try {
      writeJson(handoffFile(), { at: now, states, restarts: [...this.restartTimes, now] });
    } catch (e) {
      this.restarting = false;
      this.requests.clear();
      for (const app of this.apps) app.notice(`Could not restart the web console: ${e.message}`, 'warn');
      return;
    }
    for (const app of [...this.apps]) {
      try { app.exit(RESTART_EXIT_CODE, { restart: true }); } catch (e) { this.log(e, 'exit'); }
    }
    this.restartProcess();
  }

  close() {
    clearTimeout(this.timer);
    clearInterval(this.rosterTimer);
    clearInterval(this.reapTimer);
    this.watcher?.close();
  }
}
