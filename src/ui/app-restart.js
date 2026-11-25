// How the App restarts, reloads its new code and updates itself, carrying the session over (restart.js), and what
// keeps it from doing so now (a turn, a background program). A part of App, see repl.js, which puts these methods on
// App.prototype.

import { glyphs, c } from './ansi.js';
import { moveSession } from '../session.js';
import { INSTALL_DIR, VERSION, APP_NAME } from '../config.js';
import { RESTART_WINDOW_MS, MAX_RESTARTS, writeRestartState, RESTART_EXIT_CODE, restartNote, canRestart, watchSource, reloadTiming, runSelfCheck } from '../restart.js';
import { listBackgroundShells, adoptBackgroundShells } from '../tools/bash.js';
import { browserSessionFor } from '../browser/session.js';
import { installedVersion, installedByNpm, isNewer, checkForUpdate, installUpdate } from '../updater.js';

export const restartMethods = {
  // What a restart would kill: agents and shells that are still running in the background.
  // Something is going on that an update must not cut into: a turn, a question waiting for an answer, messages
  // waiting to be sent, background agents and shells.
  working() {
    return Boolean(this.isTurnRunning() || this.dialogs.length || this.queue.length || this.restartBlockers().length);
  },

  // What runs in the background for this session, for the web console's live view: its background agents and the
  // commands it started with run_in_background that still run. [{kind: 'agent'|'shell', id, label, command, since}]
  backgroundWork() {
    const out = [];
    for (const t of this.runtime?.tasks?.running() || []) out.push({ kind: 'agent', id: t.id, label: t.description || t.subagentType || 'agent', since: t.started || null });
    const owner = this.owner;
    // (in the console's process the shells of all its sessions are in one list: without an owner, none is this one's)
    if (owner || !this.host) {
      for (const s of listBackgroundShells(owner)) {
        if (s.status !== 'running') continue;
        const command = String(s.command || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        out.push({ kind: 'shell', id: s.id, label: s.description || command, command, since: s.startedAt || null });
      }
    }
    return out;
  },

  // What a restart would kill: the background agents (they run in this process). Background shells do not count: they
  // keep running and the next process takes them over (shells.js).
  restartBlockers() {
    const found = [];
    for (const t of this.runtime?.tasks?.running() || []) found.push(`background agent ${t.id} "${t.description}"`);
    return found;
  },

  // The background shells of this session that still run (a dev server): what keeps it from being put away or ended
  // without a word, though not from a restart.
  runningShells() {
    const owner = this.owner;
    if (!owner && this.host) return 0; // (in the console's process the shells of all its sessions are in one list)
    return listBackgroundShells(owner).filter((s) => s.status === 'running').length;
  },

  // The conversation `id` is this session's: the background shells a process before left for it (a restart) are its
  // own now, with the same ids. One still held by the process handing it over is asked for again a little later.
  adoptShells(id, attempt = 0) {
    clearTimeout(this.adoptTimer);
    if (this.exiting || !this.runtime || !id) return;
    let r;
    try { r = adoptBackgroundShells(this.owner, id); } catch (e) { this.logError?.(e); return; }
    if (r.waiting && attempt < 8 && this.store?.id === id) {
      this.adoptTimer = setTimeout(() => this.adoptShells(id, attempt + 1), Math.min(8000, 500 * 2 ** attempt));
      this.adoptTimer.unref?.();
    }
  },

  // Restart as soon as nothing is running: at once when idle, otherwise when the current turn ends (the
  // turn that asked for it still has to be answered and saved). `continueTurn`: the model gets a note in
  // the new process and goes on by itself. Returns {ok, message}.
  // `cwd`: the session goes on in that directory (/cd).
  // `alone`: this session starts again by itself, no new code needed (in the web console, without waiting for the others)
  requestRestart({ reason = '', then = '', continueTurn = false, force = false, cwd = null, alone = false } = {}) {
    if (!this.canRestart()) return { ok: false, message: 'This session cannot restart itself.' };
    const now = Date.now();
    const recent = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (recent.length >= MAX_RESTARTS && !cwd && !alone) {
      return { ok: false, message: `The program was restarted ${recent.length} times in the last ${Math.round(RESTART_WINDOW_MS / 60_000)} minutes. That looks like a loop: stop restarting and tell the user what is going on.` };
    }
    const blockers = this.restartBlockers();
    if (blockers.length && !force) return { ok: false, message: `${cwd ? 'Changing the directory restarts the session, which would stop' : 'A restart would kill'}: ${blockers.join('; ')}.` };
    this.restartRequest = { reason, then, continueTurn, cwd, alone };
    this.screen.schedule();
    if (!this.isTurnRunning()) this.restartNow();
    return { ok: true };
  },

  // Leave the state of the session for the next process and go; the supervisor starts it again. In the web console
  // (`host`) a restart that loads new code restarts the console's process with all its sessions, once all of them
  // are idle (see web/host.js); a /cd needs no new code, and this session alone starts again, at once.
  restartNow() {
    const request = this.restartRequest || {};
    this.restartRequest = null;
    if (this.host && !request.cwd && !request.alone) { this.host.restartFor(this, request); return; }
    // A write of the conversation failed at some point (a full disk): it is written again whole first, before /cd
    // copies the file, or there is no restart: the next process would go on from a file that lacks part of it, and the
    // only whole copy, this process's, would be gone.
    if (!this.flushUnsavedConversation()) {
      this.notice('Could not restart: the conversation could not be saved (is the disk full?). Free some space, then try again.', 'warn');
      return;
    }
    // /cd: the conversation's file goes along to the new directory's project (see moveSession); the old one is
    // removed once the next process is sure to find the new one
    let moved = null;
    if (request.cwd) {
      try { moved = moveSession(this.store.file, this.store.id, request.cwd); } catch (e) { this.notice(`Could not change the directory: ${e.message}`, 'warn'); return; }
    }
    const state = this.restartState(request, { moved });
    if (this.host) {
      moved?.commit();
      this.host.relaunch(this, state);
      return;
    }
    try {
      writeRestartState(state);
    } catch (e) {
      moved?.undo();
      this.notice(`Could not restart: ${e.message}`, 'warn');
      return;
    }
    moved?.commit();
    this.exit(RESTART_EXIT_CODE, { restart: true });
  },

  // Recover a missing conversation write before releasing the only in-memory copy.
  flushUnsavedConversation() {
    const store = this.store;
    if (!store?.lost) return true;
    const messages = this.runtime?.agent?.messages;
    if (!messages) return false;
    store.lost = false;
    store.reset(messages); // append sets lost again if this write fails too
    return !store.lost;
  },

  // What the next process (in the web console: the next App) needs to take the session up where it is now.
  // `counts`: towards the restarts that look like a loop; not a /cd (the user's), nor a restart of the web console that
  // another of its sessions or a change of the source caused.
  restartState(request = {}, { moved = null, counts = !request.cwd } = {}) {
    const cfg = this.config;
    const now = Date.now();
    // a write of the conversation failed at some point: the file lacks part of it, and the next process goes on from it
    this.flushUnsavedConversation();
    return {
      at: now,
      reason: request.reason || '',
      continueWith: request.continueTurn ? restartNote(request) : '',
      cwd: request.cwd || this.cwd,
      changedDirectory: Boolean(request.cwd),
      // the browser instance in use (it may be any of several): the next process connects to it again, where the
      // tab ids in the conversation are still its tabs'
      browser: browserSessionFor(this.owner).preferred || null,
      sessionId: this.store.id,
      sessionFile: moved?.file || this.store.file,
      modelOverride: cfg.modelOverride,
      effortOverride: cfg.effortOverride,
      effortBoost: cfg.effortBoost,
      todos: this.agent.todos,
      draft: this.editor.text,
      screenHistory: this.screen.history.slice(-3000),
      draftCursor: this.editor.cursor,
      draftParts: this.editor.draftParts(),
      // `peer`: a task of another session, which gets the answer of the turn that handles it
      queue: this.queue.map((q) => ({ text: q.text, images: q.images || [], display: q.display ?? null, peer: q.peer || null })),
      checkpoints: this.runtime.checkpoints.snapshot(),
      restarts: [...this.restarts.filter((t) => now - t < RESTART_WINDOW_MS), ...(counts ? [now] : [])],
      // a name given with /rename or --name stays; the one taken from the directory follows it
      peerName: request.cwd && !this.customTitle ? null : this.peers?.name || this.sessionName,
      peerId: this.peers?.id,
      remote: this.remote?.handoff() || null,
      userSentToPeers: [...this.userSentToPeers].slice(-200),
      sentToRemote: [...this.sentToRemote],
      restartNote: this.restartNote || null, // the last restart line, merged with the next one when nothing came between
      used: this.inUse(),
      // a terminal's (see attach.js): the web console taking up new code waits for its window to attach again
      attached: Boolean(this.attached),
    };
  },

  // A session of an older version that the console started in a hidden window, a process (and a supervisor) of its
  // own: once it is idle the console takes it up in its own process (see web/host.js), with the same id and the state
  // a restart carries over, and this process ends (exit code 0: the supervisor does not start it again).
  async maybeMoveIntoConsole() {
    if (!this.legacyHidden || this.moving || this.exiting || !this.runtime || this.peerMessages || this.working() || this.restartRequest || this.reloading || this.updating) return;
    this.moving = true;
    try {
      const { adoptIntoConsole } = await import('../web/server.js');
      if (this.exiting || this.working() || this.restartRequest || this.reloading || this.updating) return;
      if (!this.flushUnsavedConversation()) return;
      const state = this.restartState({ reason: 'moved into the web console' }, { counts: false });
      const r = await adoptIntoConsole(state);
      if (!r?.ok) { this.moveRefused = r?.error || 'refused'; return; }
      // the console's session has this one's id now, and its peer file: closed here without removing it
      try { this.peers?.server?.close(); } catch { /* gone */ }
      this.peers = null;
      this.exit(0, { restart: true }); // (the gateway's remote page, if any, goes on with the console's session)
    } catch (e) {
      this.moveRefused = e.message; // tried again in a minute
    } finally {
      this.moving = false;
      if (!this.exiting && this.sourceChanged) this.maybeAutoReload().catch((e) => this.logError(e));
    }
  },

  // /cd: the session goes on in `dir` (an existing directory). It restarts there, so that everything that belongs to
  // a project is that directory's: its settings and CLAUDE.md, its memory, the system prompt's directory and git
  // state, the @ file index, the input history and where the conversation is kept. The conversation, the remote
  // page's id and a name given with /rename stay. Returns {ok, message}.
  changeDirectory(dir) {
    if (this.isTurnRunning()) return { ok: false, message: 'Wait for the current task to finish (or press Esc) before changing the directory.' };
    if (!this.canRestart()) return { ok: false, message: 'This session cannot change its directory: that restarts it, and it was not started by the claude-pro launcher. Start claude-pro in that directory instead.' };
    return this.requestRestart({ reason: `working directory ${dir}`, cwd: dir });
  },

  // In the process a restart started: take up the session where the one before it left it.
  resumeAfterRestart(state, resumable) {
    const cfg = this.config;
    // The model and effort the session had, none chosen included: the remembered /model and /effort are shared by
    // every window on this machine, and another one may have changed them since (an update restarts them all).
    // A restart is not a choice either, so it leaves what is remembered as it is.
    if ('modelOverride' in state) cfg.modelOverride = state.modelOverride || null;
    if ('effortOverride' in state) cfg.effortOverride = state.effortOverride || null;
    // The Effort tool's level holds for the request the restart continues, not for the user's next one.
    if (state.effortBoost) { cfg.effortBoost = state.effortBoost; cfg.effortBoostKeepNext = Boolean(state.continueWith); }
    this.restarts = (Array.isArray(state.restarts) ? state.restarts : []).filter((t) => Number.isFinite(t));
    this.used = state.used !== false; // (a state from before it was kept: a session in use)
    if (resumable) {
      this.loadSession(state.sessionFile, state.sessionId, { quiet: true });
      if (Array.isArray(state.todos)) this.agent.todos = state.todos;
      if (state.checkpoints) this.runtime.checkpoints.adopt(state.checkpoints);
    }
    if (state.browser && typeof state.browser === 'object' && typeof state.browser.dir === 'string') browserSessionFor(this.owner).preferred = state.browser;
    if (typeof state.draft === 'string' && state.draft) this.editor.restoreDraft(state.draft, state.draftCursor, state.draftParts);
    if (state.changedDirectory) {
      // /cd: the line it answers with, here and on the remote page (which starts again from the conversation)
      const line = `Working directory: ${this.cwd}`;
      this.screen.log(line, '');
      this.seedOutput = [line];
      return;
    }
    const text = `${glyphs.restart} Restarted${state.reason ? `: ${state.reason}` : ''}${state.continueWith ? ' · continuing' : ''}`;
    // The same restart line as last time with nothing shown since (idle while the source keeps changing): one line
    // with a count instead of a screenful of them.
    let count = 1;
    const prev = state.restartNote;
    const hist = this.screen.history;
    if (prev && prev.text === text && !state.continueWith) {
      let i = hist.length;
      while (i > 0 && hist[i - 1] === '') i--;
      if (i > 0 && hist[i - 1] === prev.line) {
        hist.splice(i - 1);
        count = (prev.count || 1) + 1;
        this.collapsedRestart = true;
      }
    }
    const line = c.dim(count > 1 ? `${text} (×${count})` : text);
    if (this.collapsedRestart) this.screen.queueLog([line, '']); // drawn by the repaint in start()
    else this.screen.log(line, '');
    this.restartNote = { text, count, line };
  },

  // The turn that goes on after a restart: the note for the model, and what the user had queued meanwhile.
  continueAfterRestart(state) {
    const queued = (Array.isArray(state.queue) ? state.queue : []).filter((q) => q && typeof q.text === 'string' && q.text.trim());
    if (!state.continueWith && !queued.length) return;
    const typed = queued.map((q) => q.text).join('\n\n');
    const shown = queued.map((q) => (typeof q.display === 'string' ? q.display : q.text)).join('\n\n');
    this.startTurn([state.continueWith, typed].filter(Boolean).join('\n\n'), {
      echo: queued.length > 0,
      display: shown,
      topic: shown,
      images: queued.flatMap((q) => (Array.isArray(q.images) ? q.images : [])),
      peers: queued.map((q) => q.peer).filter((p) => p && typeof p === 'object' && p.from),
    });
  },

  // Follow the program's own source: a change to it is loaded by a restart, if the new code starts. A change made
  // while a turn of this session runs is its own work, and is loaded when the turn is over. One that arrives while
  // the session is idle was made elsewhere (another session working on the program, an editor), one step of a
  // change that is not finished: it is loaded once the source has been left alone for a few minutes. (Loaded at
  // once, every edit of one session made each of the other open sessions check and restart, into a half-made
  // change: 8 of them, a dozen times in a day's work.)
  startSourceWatch() {
    if (!canRestart() || this.host) return; // (the web console follows the source for all its sessions: web/host.js)
    this.sourceWatch = watchSource(INSTALL_DIR, (file) => {
      this.sourceChanged = file || true;
      if (this.isTurnRunning()) this.sourceChangedInTurn = true;
      else this.sourceQuietAt = Date.now() + reloadTiming.quietMs + Math.random() * reloadTiming.spreadMs; // (not all sessions at the same moment)
      // another window (or npm) installed a new version: say so, and load it once this session is idle. In a
      // source checkout a newer version in package.json is a release being made, not an install.
      const disk = installedVersion();
      if (installedByNpm() && disk !== VERSION && isNewer(disk, VERSION) && this.updateRestart !== disk) {
        this.updateRestart = disk;
        this.pendingUpdate = null;
        this.notice(`${APP_NAME} ${disk} was installed (by another window or npm); this one restarts to load it ${this.working() ? 'once its work is done' : 'now'}.`);
      }
      if (!this.isTurnRunning()) this.maybeAutoReload();
    });
  },

  async maybeAutoReload() {
    if (this.host) { this.host.check(); return; } // all the console's sessions restart together, once all are idle
    if (!this.sourceChanged || this.updating || this.reloading || this.isTurnRunning() || this.exiting || this.moving || this.restartRequest || this.dialogs.length || this.queue.length) return;
    if (this.skipAutoReload) { this.skipAutoReload = false; return; } // the user just interrupted: not now
    if (this.restartBlockers().length) return; // looked at again whenever the program is next idle
    clearTimeout(this.reloadTimer);
    const wait = this.updateRestart || this.sourceChangedInTurn ? 0 : this.sourceQuietAt - Date.now(); // (an installed version is complete)
    if (wait > 0) {
      this.reloadTimer = setTimeout(() => this.maybeAutoReload(), wait + 50);
      this.reloadTimer.unref?.();
      this.screen.schedule();
      return;
    }
    const changed = this.sourceChanged;
    const inTurn = this.sourceChangedInTurn;
    this.sourceChanged = null;
    this.sourceChangedInTurn = false;
    this.reloading = true;
    this.flash(this.updateRestart ? `Updated to ${this.updateRestart}: checking it starts, then restarting…` : 'Source changed: checking the new code…');
    let check;
    try { check = await runSelfCheck(); } finally { this.reloading = false; }
    if (this.exiting) return;
    if (!check.ok) {
      this.notice(`The program's source changed but the new code does not start, so it was not restarted:\n${check.output.split('\n').slice(0, 12).join('\n')}\nFix it; the restart follows by itself (or run /restart).`, 'warn');
      return;
    }
    if (this.isTurnRunning() || this.dialogs.length) { this.sourceChanged = changed; this.sourceChangedInTurn = inTurn; return; } // something started meanwhile: later
    const r = this.requestRestart({ reason: this.updateRestart ? `updated to ${APP_NAME} ${this.updateRestart}` : 'source changed', force: true });
    // refused (too many restarts in a row): say so, or later changes would go unloaded without a word
    if (!r.ok) this.notice(`The program's source changed, but it was not restarted to load it: ${r.message.replace(/ That looks like a loop:.*$/, '')} A change after that window loads it, or /restart once it has passed.`, 'warn');
  },

  // /update: a newer version on npm (see updater.js) is installed once no session of this machine is working, and
  // then loaded by a restart (this session's; the others restart when they see the files change).
  async updateFromNpm() {
    if (this.updating) { this.notice(`${APP_NAME} ${this.updating} is being installed.`); return; }
    let r;
    try {
      r = await checkForUpdate();
    } catch (e) {
      r = { status: 'failed', error: e.message };
    }
    if (this.exiting) return;
    if (r.status === 'available') {
      if (this.pendingUpdate !== r.version) {
        this.pendingUpdate = r.version;
        this.screen.schedule();
      }
      if (this.working()) this.notice(`${APP_NAME} ${r.version} is out: it is installed as soon as this session's work is done.`);
      await this.maybeInstallUpdate({ force: true });
    } else if (r.status === 'installed') {
      this.notice(`${APP_NAME} ${r.version} is installed already; this session restarts to load it ${this.working() ? 'once its work is done' : 'now'}.`);
      this.updateRestart = r.version;
      if (this.canRestart()) { this.sourceChanged ||= true; if (!this.isTurnRunning()) this.maybeAutoReload(); }
    } else if (r.status === 'failed') {
      this.notice(`Could not update ${APP_NAME}${r.version ? ` to ${r.version}` : ''}: ${r.error}`, 'warn');
    } else {
      this.notice(r.status === 'dev' ? `This copy runs from a source checkout (${INSTALL_DIR}): update it with git.` : `${APP_NAME} ${VERSION} is the latest version.`);
    }
  },

  // Install the version found (pendingUpdate) if nothing is going on: in this session, and in the other sessions
  // of this machine, whose files it replaces under them. Called again when this session's turn ends, and every
  // half minute while another session works.
  async maybeInstallUpdate({ force = false } = {}) {
    const version = this.pendingUpdate;
    if (!version || this.updating || this.exiting || this.restartRequest) return;
    if (this.working()) return; // the end of the turn calls this again
    const local = this.peers?.peers() || [];
    const busy = [];
    for (const p of local) if ((await this.peers.status(p)).busy) busy.push(p.name);
    if (this.pendingUpdate !== version || this.updating || this.exiting) return;
    if (busy.length) {
      if (this.updateWaitingFor !== busy.join(',')) {
        this.updateWaitingFor = busy.join(',');
        this.screen.schedule();
        if (force) this.notice(`${APP_NAME} ${version} is installed once @${busy.join(', @')} ${busy.length === 1 ? 'is' : 'are'} done working.`);
      }
      clearTimeout(this.updateRetry);
      this.updateRetry = setTimeout(() => this.maybeInstallUpdate(), 30_000);
      this.updateRetry.unref?.();
      return;
    }
    if (this.working()) return;
    this.updateWaitingFor = null;
    this.updating = version;
    this.screen.schedule();
    let r;
    try {
      r = await installUpdate(version);
    } catch (e) {
      r = { status: 'failed', version, error: e.message };
    } finally {
      this.updating = null;
      this.screen.schedule();
    }
    if (this.exiting) return;
    if (r.status === 'locked') return; // another window is installing it: its files changing tell this one
    if (r.status === 'updated' || r.status === 'installed') {
      this.pendingUpdate = null;
      this.updateRestart = r.version;
      if (this.canRestart()) {
        this.notice(`${APP_NAME} was updated to ${r.version} (from ${VERSION}); restarting to load it. The conversation carries over.`);
        this.sourceChanged = true;
        this.maybeAutoReload();
      } else {
        this.notice(`${APP_NAME} was updated to ${r.version}: restart the program to use it.`);
      }
      return;
    }
    this.notice(`Could not update ${APP_NAME} to ${version}: ${r.error}`, 'warn');
  },
};
