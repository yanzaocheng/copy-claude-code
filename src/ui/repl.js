// Interactive REPL: owns the terminal, renders the transcript and live region, and
// implements the agent's IO callbacks (streaming, tool display, permission prompts).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { c, ESC, stringWidth, truncate, padEnd, wordWrap } from './ansi.js';
import { Screen } from './screen.js';
import { Editor } from './editor.js';
import { SelectDialog } from './dialogs.js';
import { MarkdownStream, renderMarkdown } from './markdown.js';
import {
  DOT, toolHeader, renderToolResult, renderTodos, renderUserMessage, resultLines, formatTokens, formatDuration, toolLabel,
} from './render.js';
import { createRuntime } from '../runtime.js';
import { SessionStore, firstUserText } from '../session.js';
import { defaultEffort, effortSupported, effortToSend, quickQuery } from '../api.js';
import { CONFIG_DIR, VERSION, APP_NAME, INSTALL_DIR, rememberChoice } from '../config.js';
import { readGatewayLogin } from '../gateway.js';
import { TOPIC_TITLE_SYSTEM, topicTitlePrompt } from '../prompts.js';
import { buildCommands } from '../commands.js';
import { canRestart, writeRestartState, runSelfCheck, watchSource, restartNote, RESTART_EXIT_CODE, MAX_RESTARTS, RESTART_WINDOW_MS } from '../restart.js';
import { resolvePath, displayPath } from '../utils/paths.js';
import { ripgrepPath } from '../utils/shell.js';
import { describePause, formatClock, humanDuration, resumeText, shouldAnnounce } from '../ratelimit.js';
import { shutdownBackgroundShells, listBackgroundShells } from '../tools/bash.js';
import { estimateTokens } from '../agent.js';
import { readClipboardImage, imageFromFile, watchClipboard } from '../utils/clipboard.js';
import { checkForUpdate } from '../updater.js';
import { PeerNode, peersEnabled, findPeer, peerMessagePrompt } from '../peers.js';

// A model id as people say it: claude-sonnet-5-5 -> sonnet-5-5, claude-haiku-4-5-20251001 -> haiku-4-5.
export const modelTag = (model) => String(model?.id ?? '').replace(/^claude-/, '').replace(/-\d{8}$/, '');

// The model and effort level that requests use now, for the footer and the terminal title. The effort
// is left out when none is sent (auto) and for a model that does not take one.
export function modelInfo(config) {
  const model = config.mainModel;
  // What the requests carry: the nearest level the model takes (none goes out as low on gpt-6.1-sol, ultra as max on Claude).
  const sent = effortToSend(config, model.id, config.effort);
  const effort = sent && effortSupported(model.id) ? sent : null;
  return { model: modelTag(model), effort };
}

// The small model's answer about the topic (see topicTitlePrompt) as a clean title, or null when it is not
// a new topic or the answer cannot be used. `required`: there is no title yet, so any title will do.
export function parseTopicTitle(answer, { required = false } = {}) {
  const json = /\{[\s\S]*\}/.exec(String(answer ?? ''))?.[0];
  if (!json) return null;
  let data;
  try { data = JSON.parse(json); } catch { return null; }
  if ((!required && data?.isNewTopic !== true) || typeof data?.title !== 'string') return null;
  const title = data.title
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["'`“”‘’「」『』《》\s]+|["'`“”‘’「」『』《》\s.。!！?？,，:：;；]+$/g, '')
    .trim();
  return title ? truncate(title, 40).replace(/\x1b\[0m$/, '') : null;
}

const imageBlock = (img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });

const FOCUS_EVENTS_ON = '\x1b[?1004h';
const FOCUS_EVENTS_OFF = '\x1b[?1004l';

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'];
const VERBS = ['Thinking', 'Pondering', 'Crafting', 'Brewing', 'Computing', 'Conjuring', 'Cooking', 'Musing', 'Noodling', 'Percolating', 'Ruminating', 'Synthesizing', 'Working', 'Tinkering', 'Mulling', 'Deliberating', 'Churning', 'Forging', 'Hatching', 'Simmering'];
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.jsonl');

function loadHistory(cwd) {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.project === cwd).map((e) => e.display).slice(-500);
  } catch { return []; }
}

function appendHistory(cwd, text) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({ display: text, project: cwd, timestamp: Date.now() }) + '\n');
  } catch { /* ignore */ }
}

class FileIndex {
  constructor(cwd, getConfig = () => null) { this.cwd = cwd; this.getConfig = getConfig; this.files = []; this.at = 0; this.loading = false; }
  refresh() {
    if (this.loading || Date.now() - this.at < 30_000) return;
    this.loading = true;
    const done = (list) => { this.files = list.slice(0, 50_000); this.at = Date.now(); this.loading = false; };
    const rg = ripgrepPath(this.getConfig());
    if (rg) {
      const child = spawn(rg, ['--files', '--hidden', '--glob', '!.git'], { cwd: this.cwd, windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { if (out.length < 10_000_000) out += d; });
      child.on('close', () => done(out.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, '/'))));
      child.on('error', () => done([]));
    } else {
      (async () => {
        const list = [];
        try {
          for await (const f of fs.promises.glob('**/*', { cwd: this.cwd, exclude: (p) => /(^|[\\/])(node_modules|\.git)$/.test(p) })) {
            list.push(f.replace(/\\/g, '/'));
            if (list.length > 50_000) break;
          }
        } catch { /* ignore */ }
        done(list);
      })();
    }
  }
  search(q) {
    this.refresh();
    const query = q.toLowerCase();
    const dirs = new Set();
    for (const f of this.files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
      if (dirs.size > 5000) break;
    }
    // Without ripgrep the listing comes from a glob that also returns directories (as plain names): they are already in `dirs`, with their slash.
    const all = [...dirs, ...this.files.filter((f) => !dirs.has(f + '/'))];
    const scored = [];
    for (const f of all) {
      const lower = f.toLowerCase();
      const base = lower.replace(/\/$/, '').split('/').pop();
      let score = -1;
      if (!query) score = f.split('/').length;
      else if (base.startsWith(query)) score = 0;
      else if (lower.startsWith(query)) score = 1;
      else if (base.includes(query)) score = 2;
      else if (lower.includes(query)) score = 3;
      if (score >= 0) scored.push({ f, score: score * 1000 + f.length });
      if (scored.length > 2000) break;
    }
    return scored.sort((a, b) => a.score - b.score).slice(0, 12).map((s) => s.f);
  }
}

export class App {
  constructor({ flags, cwd, stdin = process.stdin, stdout = process.stdout, noProcessExit = false }) {
    this.flags = flags;
    this.cwd = cwd;
    this.stdin = stdin;
    this.stdout = stdout;
    this.noProcessExit = noProcessExit;
    this.screen = new Screen(stdout);
    this.busy = false;
    this.controller = null;
    this.queue = [];
    this.dialogs = [];
    this.active = []; // running tool entries, in call order
    this.pendingToolBlocks = new Map(); // streaming tool_use blocks, by index
    this.md = null;
    this.thinking = null;
    this.verbose = !!flags.verbose;
    this.showTodos = true;
    this.turnStart = 0;
    this.turnTokens = 0;
    this.verb = 'Thinking';
    this.status = null; // override spinner text (e.g. compacting)
    this.rateWait = null; // {resumeAt, label, polling} while paused for a rate limit
    this.exitArmed = 0;
    this.notices = [];
    this.topic = null; // what the conversation is about now, named by the small model (see refreshTopic)
    this.firstPrompt = null; // the session's first message: the title until there is a topic
    this.topicSeq = 0; // topic requests sent ...
    this.topicApplied = 0; // ... and the newest one whose answer was used
    this.restarts = []; // when this session was restarted lately (carried over by each restart)
    this.restartRequest = null; // {reason, then, continueTurn}: restart as soon as nothing is running
    this.sourceChanged = null; // the program's own source changed since it was last checked
    this.reloading = false;
    this.skipAutoReload = false;
    this.peers = null; // this session as seen by the other sessions on the machine (see peers.js)
    this.turnPeers = []; // tasks from other sessions that the running turn answers: [{msg}]
    this.userSentToPeers = new Set(); // ids of messages the user sent to other sessions with @name
    this.fileIndex = new FileIndex(cwd, () => this.runtime?.config);
    this.store = new SessionStore(cwd);
    this.editor = new Editor({
      history: loadHistory(cwd),
      onSubmit: (value, raw, images) => { try { this.onSubmit(value, raw, images); } catch (e) { this.logError(e); } },
      imageFromPath: (p) => {
        const r = imageFromFile(resolvePath(p, this.cwd));
        if (r.error && !/not found|Not a file/.test(r.error)) this.flash(r.error, 'warn');
        if (r.image) this.flashMessage = null;
        return r.image || null;
      },
      getSuggestions: (text, cursor) => this.suggest(text, cursor),
      onChange: () => this.screen.schedule(),
    });
  }

  get agent() { return this.runtime.agent; }
  get config() { return this.runtime.config; }
  get width() { return this.screen.width; }

  // ---------------------------------------------------------------- lifecycle

  async start(initialPrompt) {
    const stdin = this.stdin;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    this.stdout.write(ESC.bracketedPasteOn);
    this.watchCopies();
    const cleanup = () => this.restoreTerminal();
    process.on('exit', cleanup);
    process.on('SIGTERM', () => this.exit(143));
    process.on('SIGHUP', () => this.exit(129));

    await this.startPeer();
    this.runtime = await createRuntime({ cwd: this.cwd, flags: this.flags, io: this });
    // The conversation's id, sent to the gateway with each request (see streamMessage); it follows /clear and /resume.
    Object.defineProperty(this.runtime.config, 'sessionId', { get: () => this.store.id, configurable: true });
    this.commands = buildCommands(this);
    // Keys typed while starting up stay buffered in stdin until we listen.
    stdin.on('keypress', (str, key) => {
      try { this.onKey(str, key || {}); } catch (e) { this.logError(e); }
    });
    stdin.resume();
    this.runtime.modes.listeners.add(() => this.screen.schedule());
    // Started by a restart of this session: the output of the process before it is still on screen, so no
    // welcome box and no transcript, just a line saying so.
    const restart = this.flags.restart || null;
    const resumable = Boolean(restart?.sessionFile && fs.existsSync(restart.sessionFile));
    if (!resumable) this.printWelcome();
    // The tab label, as in the official client: what this session is about, then where and with what.
    this.screen.setTitle(() => this.terminalTitle(), path.basename(this.cwd) || this.cwd, { inherited: Boolean(restart) });

    if (restart) this.resumeAfterRestart(restart, resumable);
    else if (this.flags.resumeFile) this.loadSession(this.flags.resumeFile, this.flags.resumeId);
    else if (this.flags.resume) await this.commands.get('resume').run('');

    this.screen.setLive((w) => this.renderLive(w));
    this.spinnerTimer = setInterval(() => { if (this.busy || this.active.length) this.screen.schedule(); }, 120);
    if (restart) this.continueAfterRestart(restart);
    else if (initialPrompt?.trim()) this.onSubmit(initialPrompt, initialPrompt);
    // Nothing configured yet: the gateway is the default, and its login comes first, as in Claude Code.
    else if (this.config.usesGateway && !readGatewayLogin(this.config.gatewayUrl)) {
      Promise.resolve(this.commands.get('login').run('')).catch((e) => this.logError(e)).finally(() => this.screen.schedule());
    }
    this.fileIndex.refresh();
    this.startSourceWatch();
    if (!this.noProcessExit && !this.flags.restart) this.autoUpdate();
    return new Promise((resolve) => { this.resolveExit = resolve; });
  }

  // What the session is about now: the topic the small model named last, or else the first thing asked
  // (kept when the conversation is compacted afterwards). Cleared by /clear, replaced by /resume.
  sessionLabel() {
    if (this.topic) return this.topic;
    if (!this.firstPrompt) {
      const first = this.agent?.messages.find((m) => m.role === 'user' && firstUserText(m));
      this.firstPrompt = first ? firstUserText(first) : null;
    }
    return this.firstPrompt;
  }

  // The newest message the user typed in this conversation (not a tool result, a reminder or a summary).
  latestPrompt() {
    const messages = this.agent?.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') continue;
      const text = firstUserText(messages[i]);
      if (text && !text.startsWith('This session is being continued')) return text;
    }
    return null;
  }

  // Keep the title on the topic of the conversation: ask the small model, in the background, whether
  // `message` starts a new topic and what to call it (as the official client does). Nothing waits for the
  // answer, and when there is none (a rate limit, no network) the title just stays as it is.
  refreshTopic(message) {
    const text = String(message ?? '').trim();
    if (!text || /^(1|true|yes)$/i.test(this.config.env.CLAUDE_PRO_DISABLE_TOPIC_TITLE || '')) return;
    const store = this.store;
    const seq = ++this.topicSeq;
    const current = this.topic;
    quickQuery(this.config, {
      model: this.config.smallModel, system: TOPIC_TITLE_SYSTEM, prompt: topicTitlePrompt(current, text.slice(0, 2000)), maxTokens: 2048,
    }).then((answer) => {
      // another session meanwhile, or an answer about a newer message already in use
      if (store !== this.store || this.exiting || seq < this.topicApplied) return;
      const title = parseTopicTitle(answer, { required: !current });
      if (!title) return;
      this.topicApplied = seq;
      if (title === this.topic) return;
      this.topic = title;
      store.setTopic(title);
      this.screen.schedule();
    }, () => { /* only the title: not worth a word */ });
  }

  // "<state> <session> | <directory> · <model> · <effort>". The session is cut short so that the model and
  // effort, which are what tells tabs apart, are not what a narrow tab loses. While it works the state mark
  // blinks, so that a tab that is busy can be told from one that waits for the user.
  terminalTitle() {
    const dir = path.basename(this.cwd) || this.cwd;
    const { model, effort } = modelInfo(this.config);
    const state = this.rateWait ? '⏸' : this.busy ? (Math.floor(Date.now() / 1000) % 2 ? '⠐' : '⠂') : '✳';
    const session = this.sessionLabel();
    const where = [dir, model, effort].filter(Boolean).join(' · ');
    return `${state} ${session ? `${truncate(session, 40).replace(/\x1b\[0m$/, '')} | ` : ''}${where}`;
  }

  // `handOver`: another process takes the terminal over at once (a restart). It is left the way the program
  // had it (raw mode, bracketed paste, the tab's title), so that keys typed in between are not echoed or lost.
  restoreTerminal({ handOver = false } = {}) {
    if (this.restored) return;
    this.restored = true;
    try {
      this.screen.close({ keepTitle: handOver });
      this.clipboardWatch?.close();
      if (this.clipboardWatch) this.stdout.write(FOCUS_EVENTS_OFF);
      this.stdout.write(handOver ? ESC.showCursor : ESC.bracketedPasteOff + ESC.showCursor);
      if (!handOver && this.stdin.isTTY) this.stdin.setRawMode(false);
    } catch { /* ignore */ }
  }

  exit(code = 0, { restart = false } = {}) {
    if (this.exiting) return;
    this.exiting = true;
    this.controller?.abort();
    clearInterval(this.spinnerTimer);
    this.sourceWatch?.close();
    shutdownBackgroundShells();
    this.runtime?.tasks.killAll();
    this.runtime?.mcp.close();
    this.peers?.close();
    const u = this.agent?.totalUsage();
    if (!restart && u && u.requests) {
      this.screen.log(c.dim(`Total usage: ${formatTokens(u.input + u.cacheRead + u.cacheWrite)} input (${formatTokens(u.cacheRead)} cached), ${formatTokens(u.output)} output, ${u.requests + u.compactions} requests`));
    }
    if (!restart && this.agent?.messages.length) this.screen.log(c.dim(`Resume this session with: ${APP_NAME} --resume ${this.store.id}`));
    this.restoreTerminal({ handOver: restart });
    this.stdin.pause();
    this.resolveExit?.(code);
    if (!this.noProcessExit) setTimeout(() => process.exit(code), 50).unref();
  }

  // ---------------------------------------------------------------- other sessions (see peers.js)

  // Register this session so that the other sessions on the machine can send it tasks. Not in the tests
  // (which drive the App themselves) and not with CLAUDE_PRO_PEERS=0.
  async startPeer() {
    if (this.noProcessExit || !peersEnabled()) return;
    try {
      this.peers = await new PeerNode({ cwd: this.cwd, name: this.flags.restart?.peerName, id: this.flags.restart?.peerId, onMessage: (msg) => this.onPeerMessage(msg) }).start();
    } catch (e) {
      this.peers = null;
      this.notice(`Other sessions cannot reach this one: ${e.message}`, 'warn');
    }
  }

  // `byModel`: the MessagePeer tool sent it, so the answer goes to the model; otherwise the user typed
  // `@name ...` and the answer is only shown (and noted for the model).
  async sendToPeer(name, text, { byModel = false } = {}) {
    if (!this.peers) throw new Error('Talking to other sessions is off in this session.');
    const r = await this.peers.send(name, { text });
    if (!byModel) this.userSentToPeers.add(`${r.peer.id}:${r.id}`);
    return r;
  }

  onPeerMessage(msg) {
    if (this.exiting) return;
    const from = c.bold(`@${msg.from.name}`);
    const width = this.width - 1;
    if (msg.kind === 'reply' && this.userSentToPeers.delete(`${msg.from.id}:${msg.inReplyTo}`)) {
      // the answer to something the user sent: shown, and noted for the model, without a turn of its own
      this.screen.log(`${c.blue('✉')} ${from} ${c.dim('answered:')}`, ...renderMarkdown(msg.text, { width: width - 2 }).map((l) => '  ' + l), '');
      this.agent.addReminder(`The user sent a message to another claude-pro session, ${msg.from.name} (${msg.from.cwd}), which answered:\n${msg.text}`);
      return;
    }
    const display = `✉ ${msg.kind === 'reply' ? 'answer from' : 'task from'} @${msg.from.name}: ${msg.text}`;
    const item = { text: peerMessagePrompt(msg), images: [], display, peer: msg.kind === 'task' ? msg : null };
    if (this.busy) { this.queue.push(item); this.screen.schedule(); return; }
    this.startTurn(item.text, { display, peers: item.peer ? [item.peer] : [] });
  }

  // The turn that handled tasks of other sessions ended: send each its answer.
  answerPeers(result, error) {
    const tasks = this.turnPeers.splice(0);
    if (!tasks.length || !this.peers) return;
    const text = error ? `The session failed before finishing: ${error.message || error}`
      : result?.interrupted ? `The user of ${this.peers.name} interrupted the work before it was finished.${result.text ? `\n\nWhat it had written:\n${result.text}` : ''}`
        : (result?.text || '(no answer text)');
    // One answer per session, to its last message: several messages from it that waited for this turn were all
    // handled in it, and sending the whole answer once for each would hand that session the same text again and again.
    const lastOfEach = new Map();
    for (const msg of tasks) lastOfEach.set(`${msg.from.id}|${msg.from.name}|${msg.from.cwd}`, msg);
    for (const msg of lastOfEach.values()) {
      // by id, or by name: a session that was restarted by older code comes back with a new id
      const running = this.peers.peers();
      const peer = findPeer(running, msg.from.id) || running.find((p) => p.name === msg.from.name && p.cwd === msg.from.cwd);
      if (!peer) { this.notice(`@${msg.from.name} is no longer running: its answer was not sent.`, 'warn'); continue; }
      this.peers.send(peer, { text, kind: 'reply', inReplyTo: msg.id })
        .then(() => this.screen.log(c.dim(`  ⎿  Answer sent to @${msg.from.name}`)), (e) => this.notice(`Could not send the answer to @${msg.from.name}: ${e.message}`, 'warn'));
    }
  }

  // ---------------------------------------------------------------- restarting (see restart.js)

  // What a restart would kill: agents and shells that are still running in the background.
  restartBlockers() {
    const found = [];
    for (const t of this.runtime.tasks.running()) found.push(`background agent ${t.id} "${t.description}"`);
    for (const s of listBackgroundShells()) if (s.status === 'running') found.push(`background shell ${s.id} (${String(s.command).slice(0, 40)})`);
    return found;
  }

  // Restart as soon as nothing is running: at once when idle, otherwise when the current turn ends (the
  // turn that asked for it still has to be answered and saved). `continueTurn`: the model gets a note in
  // the new process and goes on by itself. Returns {ok, message}.
  requestRestart({ reason = '', then = '', continueTurn = false, force = false } = {}) {
    if (!canRestart()) return { ok: false, message: 'This session cannot restart itself.' };
    const now = Date.now();
    const recent = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (recent.length >= MAX_RESTARTS) {
      return { ok: false, message: `The program was restarted ${recent.length} times in the last ${Math.round(RESTART_WINDOW_MS / 60_000)} minutes. That looks like a loop: stop restarting and tell the user what is going on.` };
    }
    const blockers = this.restartBlockers();
    if (blockers.length && !force) return { ok: false, message: `A restart would kill: ${blockers.join('; ')}.` };
    this.restartRequest = { reason, then, continueTurn };
    this.screen.schedule();
    if (!this.busy) this.restartNow();
    return { ok: true };
  }

  // Leave the state of the session for the next process and go; the supervisor starts it again.
  restartNow() {
    const request = this.restartRequest || {};
    this.restartRequest = null;
    const cfg = this.config;
    const now = Date.now();
    const state = {
      at: now,
      reason: request.reason || '',
      continueWith: request.continueTurn ? restartNote(request) : '',
      sessionId: this.store.id,
      sessionFile: this.store.file,
      modelOverride: cfg.modelOverride,
      effortOverride: cfg.effortOverride,
      effortBoost: cfg.effortBoost,
      mode: this.runtime.modes.mode,
      todos: this.agent.todos,
      draft: this.editor.text,
      draftCursor: this.editor.cursor,
      queue: this.queue.map((q) => ({ text: q.text, images: q.images || [] })),
      checkpoints: this.runtime.checkpoints.snapshot(),
      restarts: [...this.restarts.filter((t) => now - t < RESTART_WINDOW_MS), now],
      peerName: this.peers?.name,
      peerId: this.peers?.id,
    };
    try {
      writeRestartState(state);
    } catch (e) {
      this.notice(`Could not restart: ${e.message}`, 'warn');
      return;
    }
    this.exit(RESTART_EXIT_CODE, { restart: true });
  }

  // In the process a restart started: take up the session where the one before it left it.
  resumeAfterRestart(state, resumable) {
    const cfg = this.config;
    const kept = {};
    if (state.modelOverride) cfg.modelOverride = kept.model = state.modelOverride;
    if (state.effortOverride) cfg.effortOverride = kept.effort = state.effortOverride;
    // The Effort tool's level holds for the request the restart continues, not for the user's next one.
    if (state.effortBoost) { cfg.effortBoost = state.effortBoost; cfg.effortBoostKeepNext = Boolean(state.continueWith); }
    // These were chosen with /model and /effort, which are kept for later sessions. One made by a version of
    // the program that did not keep them yet is saved now.
    try { rememberChoice(cfg.provider, kept); } catch { /* it still holds for this session */ }
    if (state.mode === 'plan') this.runtime.modes.setMode('plan');
    this.restarts = (Array.isArray(state.restarts) ? state.restarts : []).filter((t) => Number.isFinite(t));
    if (resumable) {
      this.loadSession(state.sessionFile, state.sessionId, { quiet: true });
      if (Array.isArray(state.todos)) this.agent.todos = state.todos;
      if (state.checkpoints) this.runtime.checkpoints.adopt(state.checkpoints);
    }
    if (typeof state.draft === 'string' && state.draft) this.editor.set(state.draft, state.draftCursor);
    this.screen.log(c.dim(`↻ Restarted${state.reason ? `: ${state.reason}` : ''}${state.continueWith ? ' · continuing' : ''}`), '');
  }

  // The turn that goes on after a restart: the note for the model, and what the user had queued meanwhile.
  continueAfterRestart(state) {
    const queued = (Array.isArray(state.queue) ? state.queue : []).filter((q) => q && typeof q.text === 'string' && q.text.trim());
    if (!state.continueWith && !queued.length) return;
    const typed = queued.map((q) => q.text).join('\n\n');
    this.startTurn([state.continueWith, typed].filter(Boolean).join('\n\n'), { echo: queued.length > 0, display: typed, topic: typed, images: queued.flatMap((q) => q.images || []) });
  }

  // Follow the program's own source: once a turn is over (or at once when idle) a change to it is loaded by
  // a restart, if the new code starts.
  startSourceWatch() {
    if (!canRestart() || /^(0|false|no|off)$/i.test(this.config.env.CLAUDE_PRO_AUTO_RESTART || '')) return;
    this.sourceWatch = watchSource(INSTALL_DIR, (file) => {
      this.sourceChanged = file || true;
      if (!this.busy) this.maybeAutoReload();
    });
  }

  async maybeAutoReload() {
    if (!this.sourceChanged || this.updating || this.reloading || this.busy || this.exiting || this.restartRequest || this.dialogs.length || this.queue.length) return;
    if (this.skipAutoReload) { this.skipAutoReload = false; return; } // the user just interrupted: not now
    if (this.restartBlockers().length) return; // looked at again whenever the program is next idle
    const changed = this.sourceChanged;
    this.sourceChanged = null;
    this.reloading = true;
    this.flash('Source changed: checking the new code…');
    let check;
    try { check = await runSelfCheck(); } finally { this.reloading = false; }
    if (this.exiting) return;
    if (!check.ok) {
      this.notice(`The program's source changed but the new code does not start, so it was not restarted:\n${check.output.split('\n').slice(0, 12).join('\n')}\nFix it; the restart follows by itself (or run /restart).`, 'warn');
      return;
    }
    if (this.busy || this.dialogs.length) { this.sourceChanged = changed; return; } // something started meanwhile: later
    this.requestRestart({ reason: 'source changed', force: true });
  }

  // A newer version on npm is installed in the background (see updater.js) and loaded by a restart once the
  // session is idle. `force`: the /update command, which also says when there is nothing to do.
  async autoUpdate({ force = false } = {}) {
    if (this.updating) { if (force) this.notice('An update is already being installed.'); return; }
    let r;
    try {
      r = await checkForUpdate({ force, env: { ...process.env, ...this.config.env }, onInstalling: (v) => { this.updating = true; this.flash(`Installing ${APP_NAME} ${v}…`); } });
    } catch (e) {
      r = { status: 'failed', error: e.message };
    } finally {
      this.updating = false;
    }
    if (this.exiting) return;
    if (r.status === 'updated') {
      this.notice(`${APP_NAME} was updated to ${r.version} (from ${VERSION}); it is loaded by a restart as soon as the session is idle.`);
      if (canRestart()) { this.sourceChanged = true; if (!this.busy) this.maybeAutoReload(); }
      else this.notice('Restart the program to use it.');
    } else if (r.status === 'failed') {
      if (force || r.version) this.notice(`Could not update ${APP_NAME}${r.version ? ` to ${r.version}` : ''}: ${r.error}`, 'warn');
    } else if (force) {
      this.notice(r.status === 'dev' ? `This copy runs from a source checkout (${INSTALL_DIR}): update it with git.` : `${APP_NAME} ${VERSION} is the latest version.`);
    }
  }

  printWelcome() {
    const cfg = this.config;
    const w = Math.min(this.width - 1, 76);
    const inner = w - 4;
    const row = (s) => c.claude('│') + ' ' + padEnd(truncate(s, inner), inner) + ' ' + c.claude('│');
    const model = cfg.mainModel;
    const lines = [
      c.claude('╭' + '─'.repeat(w - 2) + '╮'),
      row(`${c.claude('✻')} Welcome to ${c.bold(APP_NAME)}! ${c.dim(`v${VERSION} · a Claude Code style agent`)}`),
      row(''),
      row(c.dim('  /help for help, /status for your current setup')),
      row(''),
      row(c.dim(`  cwd:    ${this.cwd}`)),
      row(c.dim(`  model:  ${model.label}${cfg.effort ? ` · effort ${cfg.effort}` : ''} · ${formatTokens(model.contextWindow)} context`)),
      row(c.dim(`  backend: ${cfg.endpointLabel}`)),
      c.claude('╰' + '─'.repeat(w - 2) + '╯'),
    ];
    lines.push('', c.dim(' Full access: every tool runs immediately, nothing is ever asked. File edits are checkpointed;'), c.dim(' /rewind puts files and/or the conversation back (shell-command changes are not tracked).'));
    if (cfg.usesGateway && !readGatewayLogin(cfg.gatewayUrl)) {
      lines.push('', c.yellow(` ⚠ Not logged in to the gateway ${cfg.gatewayUrl}. Run /login.`));
    } else if (cfg.provider === 'api' && !cfg.authToken && !cfg.apiKey) {
      lines.push('', c.yellow(' ⚠ No API credentials found. Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in .env, ~/.claude-pro/settings.json or the environment.'));
    }
    const mcp = this.runtime.mcp.status();
    if (mcp.length) {
      const ok = mcp.filter((m) => m.status === 'connected').length;
      lines.push(c.dim(` MCP: ${ok}/${mcp.length} servers connected${ok < mcp.length ? ' · /mcp for details' : ''}`));
    }
    lines.push('', c.dim(' Tips for getting started:'), c.dim(' 1. Ask questions, edit files, or run commands'), c.dim(' 2. Be as specific as you would with another engineer for the best results'), c.dim(` 3. Run /init to create a CLAUDE.md file with instructions for ${APP_NAME}`), '');
    this.screen.log(lines);
  }

  // ---------------------------------------------------------------- input

  // Say "copied" when the user copies text selected in this terminal, as Claude Code does. The terminal does the
  // selecting and copying and tells nobody, so the clipboard is watched; focus events (which the terminal sends
  // once asked to) keep copies made in other windows from being announced. Off with CLAUDE_PRO_COPY_NOTICE=0,
  // and when not writing to the real terminal (the tests).
  watchCopies() {
    if (this.stdout !== process.stdout || !this.stdout.isTTY || /^(0|false|no)$/i.test(process.env.CLAUDE_PRO_COPY_NOTICE || '')) return;
    this.focused = true;
    this.clipboardWatch = watchClipboard((chars) => {
      if (!this.focused || this.exiting) return;
      this.flash(chars ? `Copied ${chars.toLocaleString()} characters to the clipboard` : 'Copied to the clipboard');
    });
    this.stdout.write(FOCUS_EVENTS_ON);
  }

  onKey(str, key) {
    if (this.exiting) return;
    if (key.sequence === '\x1b[I') { this.focused = true; return; }
    if (key.sequence === '\x1b[O') { this.focused = false; return; }
    if (key.ctrl && key.name === 'c') { this.onCtrlC(); return; }
    const dialog = this.dialogs[0];
    if (dialog) {
      dialog.handleKey(str, key);
      this.screen.schedule();
      return;
    }
    if (key.name === 'tab' && key.shift) { this.runtime.modes.toggle(); this.screen.schedule(); return; }
    // alt+v like Claude Code on Windows (ctrl+v is the terminal's own text paste there).
    if ((key.meta || key.ctrl) && key.name === 'v') { this.pasteImage(); return; }
    if (key.ctrl && key.name === 'o') {
      this.verbose = !this.verbose;
      this.notice(this.verbose ? 'Verbose mode on: showing thinking and full tool output' : 'Verbose mode off', 'info');
      return;
    }
    if (key.ctrl && key.name === 't') { this.showTodos = !this.showTodos; this.screen.schedule(); return; }
    if (key.ctrl && key.name === 'l') { this.screen.clearScreen(); return; }
    if (key.ctrl && key.name === 'd' && !this.editor.text) { this.exit(0); return; }
    if (key.name === 'escape' && this.busy) { this.interrupt(); return; }
    this.exitArmed = 0;
    this.editor.handleKey(str, key);
    this.screen.schedule();
  }

  onCtrlC() {
    if (this.dialogs.length) {
      // Cancel the dialog and interrupt the run.
      for (const d of this.dialogs.splice(0)) d.resolve(d.cancelValue);
      this.interrupt();
      return;
    }
    if (this.busy) { this.interrupt(); return; }
    if (this.editor.text) { this.editor.discard(); this.screen.schedule(); return; }
    if (Date.now() - this.exitArmed < 1500) { this.exit(0); return; }
    this.exitArmed = Date.now();
    this.screen.schedule();
    setTimeout(() => this.screen.schedule(), 1600);
  }

  interrupt() {
    if (!this.controller || this.controller.signal.aborted) return;
    this.controller.abort();
    this.screen.schedule();
  }

  suggest(text, cursor) {
    if (text.startsWith('/') && !/\s/.test(text) && cursor === text.length) {
      const q = text.slice(1).toLowerCase();
      const all = [...this.commands.values()].filter((cmd) => !cmd.hidden);
      const pref = all.filter((cmd) => cmd.name.startsWith(q) || cmd.aliases?.some((a) => a.startsWith(q)));
      const incl = q ? all.filter((cmd) => !pref.includes(cmd) && cmd.name.includes(q)) : [];
      const items = [...pref, ...incl].map((cmd) => ({
        value: '/' + cmd.name,
        label: '/' + cmd.name + (cmd.argHint ? ' ' + cmd.argHint : ''),
        description: cmd.description,
        submitOnEnter: !cmd.argRequired,
      }));
      if (items.length === 1 && items[0].value === text && !items[0].submitOnEnter) return null;
      return { items, from: 0, to: text.length };
    }
    // The mention being typed: `@name`, or `@"name with spaces` once a quote has been opened.
    const before = text.slice(0, cursor);
    const m = /(^|\s)@(?:"([^"@]*)|([^\s@"]*))$/.exec(before);
    if (m) {
      const quoted = m[2] !== undefined;
      const q = quoted ? m[2] : m[3];
      const files = this.fileIndex.search(q);
      // At the start of the message `@name` sends it to another session.
      const peers = !quoted && m.index === 0 && this.peers
        ? this.peers.peers().filter((p) => p.name.toLowerCase().startsWith(q.toLowerCase()))
          .map((p) => ({ value: '@' + p.name, label: `@${p.name}`, description: `session · ${displayPath(p.cwd, this.cwd)}` }))
        : [];
      if (!files.length && !peers.length) return null;
      // A name with spaces has to be quoted for the mention to be read back as one file. A directory
      // leaves the quote open, so that completion goes on inside it; a file closes it.
      const value = (f) => (quoted || /\s/.test(f) ? (f.endsWith('/') ? `@"${f}` : `@"${f}"`) : '@' + f);
      return { items: [...peers, ...files.map((f) => ({ value: value(f), label: f, noSpace: f.endsWith('/') }))], from: cursor - q.length - (quoted ? 2 : 1), to: cursor };
    }
    return null;
  }

  onSubmit(value, raw, images = []) {
    const text = value.trim();
    if (!text) { this.screen.schedule(); return; }
    appendHistory(this.cwd, raw);
    if (this.sendTypedToPeer(text)) return;
    if (this.busy) {
      if (text.startsWith('/')) { this.notice('Wait for the current task to finish (or press Esc) before running commands.', 'warn'); return; }
      this.queue.push({ text: value, images });
      this.screen.schedule();
      return;
    }
    if (images.length) { this.startTurn(value, { images }); return; }
    if (text === '?') { this.screen.log(this.shortcutsHelp()); return; }
    if (raw.startsWith('!')) { this.runBashMode(value.slice(1).trim()); return; }
    if (raw.startsWith('#')) { this.addMemory(value.slice(1).trim()); return; }
    if (text.startsWith('/')) {
      const [name, ...rest] = text.slice(1).split(/\s+/);
      const args = text.slice(1 + name.length).trim();
      const cmd = this.commands.get(name.toLowerCase()) || [...this.commands.values()].find((x) => x.aliases?.includes(name.toLowerCase()));
      if (cmd) {
        this.screen.log(renderUserMessage(text, this.width));
        Promise.resolve(cmd.run(args, rest)).catch((e) => this.logError(e)).finally(() => this.screen.schedule());
        return;
      }
      if (!/^\/[\w:-]+$/.test(text.split(/\s/)[0])) { this.startTurn(value); return; } // e.g. a path like /usr/bin
      this.notice(`Unknown command: /${name}. Type /help for the list of commands.`, 'warn');
      return;
    }
    this.startTurn(value);
  }

  // `@name message`, name being another session: the message goes to that session, as a task for it.
  sendTypedToPeer(text) {
    const m = /^@([\w.-]+)\s+([\s\S]+)$/.exec(text);
    if (!m || !this.peers) return false;
    const peer = findPeer(this.peers.peers(), m[1]);
    if (!peer || peer.name.toLowerCase() !== m[1].toLowerCase()) return false;
    this.screen.log(renderUserMessage(text, this.width));
    this.sendToPeer(peer, m[2].trim()).then(
      () => this.screen.log(c.dim(`  ⎿  Sent to @${peer.name} (${displayPath(peer.cwd, this.cwd)}); its answer will be shown here`), ''),
      (e) => this.notice(e.message, 'warn'),
    );
    return true;
  }

  shortcutsHelp() {
    const rows = [
      ['! for bash mode', 'double tap esc to clear input'],
      ['/ for commands', 'shift + tab to cycle permission modes'],
      ['@ for file paths or sessions', 'ctrl + o to toggle verbose output'],
      ['# to memorize', 'ctrl + t to toggle todos'],
      ['\\⏎ or alt+⏎ for newline', 'ctrl + l to redraw, ctrl + d to exit'],
      ['alt + v to paste an image', ''],
    ];
    return rows.map(([a, b]) => c.dim('  ' + padEnd(a, 30) + b));
  }

  // ---------------------------------------------------------------- turns

  // Where a mentioned path is (null when there is no such file): relative to the project root, which is
  // where the autocomplete lists files from, or else relative to where the shell is now (a `cd` in a
  // Bash tool call moves that). Nothing at all is not a path: it would mean the directory itself.
  resolveMention(ref) {
    if (!ref.trim()) return null;
    for (const base of [this.cwd, this.agent.cwd]) {
      const file = resolvePath(ref, base);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  // The file a mention `@...` stands for. A quoted name is exactly what is inside the quotes. A plain name
  // that exists as written is that file; otherwise the punctuation prose puts behind a mention ("see
  // @a.js, then", "(@a.js)") is not part of it.
  mentionedFile(token) {
    if (token.startsWith('"')) return this.resolveMention(token.slice(1, -1));
    return this.resolveMention(token) || this.resolveMention(token.replace(/[,.;:!?)]+$/, ''));
  }

  // Expand @file mentions into attached file contents, like Claude Code: what the model would have
  // seen had it called Read itself. Going through the Read tool is what keeps this honest: binary files
  // are refused, images become images, and the file is recorded as read, as only partly read when it
  // was cut (so Write will not overwrite lines the model was never shown).
  async attachments(text) {
    const blocks = [];
    const seen = new Set();
    const read = this.runtime.tools.find((t) => t.name === 'Read');
    const skipped = (file, why) => this.screen.log(c.dim(`  ⎿  Skipped ${displayPath(file, this.cwd)}: ${why}`));
    for (const m of text.matchAll(/(?:^|\s)@("[^"]+"|[^\s"]+)/g)) {
      const file = this.mentionedFile(m[1]);
      if (!file || seen.has(file)) continue; // @someone, @..., a file that is not there: not a mention
      seen.add(file);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.isDirectory()) {
        let entries;
        try {
          const all = fs.readdirSync(file, { withFileTypes: true });
          entries = all.slice(0, 200).map((e) => (e.isDirectory() ? e.name + '/' : e.name));
          if (all.length > 200) entries.push(`(${all.length - 200} more entries not shown)`);
        } catch (e) { skipped(file, e.message); continue; }
        blocks.push({ type: 'text', text: `<system-reminder>Called the Bash tool with the following input: {"command":"ls ${file}"}\nResult:\n${entries.join('\n')}</system-reminder>` });
        this.screen.log(c.dim(`  ⎿  Listed directory ${displayPath(file, this.cwd)}/`));
        continue;
      }
      if (!read || !st.isFile()) continue;
      const isImage = /\.(png|jpe?g|gif|webp)$/i.test(file);
      if (!isImage && st.size >= 512 * 1024) { skipped(file, `${Math.round(st.size / 1024)}KB is too large to attach; ask for the part you need`); continue; }
      const input = { file_path: file, limit: 2000 };
      let result;
      try { result = await read.call(input, this.agent.makeCtx()); } catch (e) { skipped(file, e.message); continue; }
      if (result.isError) { skipped(file, String(result.content).split('\n')[0]); continue; }
      blocks.push(typeof result.content === 'string'
        ? { type: 'text', text: `<system-reminder>Called the Read tool with the following input: ${JSON.stringify(input)}\nResult of calling the Read tool:\n${result.content}</system-reminder>` }
        : { type: 'text', text: `<system-reminder>The user attached ${file}:</system-reminder>` });
      if (typeof result.content !== 'string') blocks.push(...result.content);
      this.screen.log(c.dim(`  ⎿  ${result.display?.summary || 'Read'}: ${displayPath(file, this.cwd)}`));
    }
    return blocks;
  }

  // `topic`: what to name the conversation's topic after (default: the message as shown).
  // `peers`: tasks of other sessions that this turn answers.
  async startTurn(prompt, { echo = true, display, images = [], topic, peers = [] } = {}) {
    if (echo) this.screen.log(renderUserMessage(display ?? prompt, this.width));
    this.refreshTopic(topic ?? display ?? prompt);
    let content;
    try {
      content = [{ type: 'text', text: prompt }, ...images.map(imageBlock), ...(await this.attachments(prompt))];
    } catch (e) {
      this.logError(e); // nobody awaits this method: an error left to escape would end the program
      return;
    }
    await this.runAgent(content, { peers });
  }

  // alt+v (ctrl+v where the terminal passes it through): attach an image from the clipboard.
  async pasteImage() {
    if (this.readingClipboard) return;
    this.readingClipboard = true;
    this.flash('Reading image from clipboard…');
    try {
      const r = await readClipboardImage();
      if (r.image) {
        const label = this.editor.insertImage(r.image);
        const size = r.image.width ? `${r.image.width}×${r.image.height}, ` : '';
        this.flash(`${label} attached (${size}${formatTokens(r.image.bytes).replace(/k$/, 'KB')})`);
      } else {
        this.flash(r.error || 'No image found in clipboard. Copy an image (e.g. Win+Shift+S) and press alt+v again.', 'warn');
      }
    } catch (e) {
      this.flash(`Could not read the clipboard: ${e.message}`, 'warn');
    } finally {
      this.readingClipboard = false;
      this.screen.schedule();
    }
  }

  // A short-lived message in the footer (not written to the transcript).
  flash(text, kind = 'info') {
    this.flashMessage = { text, kind, until: Date.now() + 4000 };
    this.screen.schedule();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.screen.schedule(), 4100);
  }

  async runAgent(content, { peers = [] } = {}) {
    this.busy = true;
    this.turnPeers.push(...peers);
    let result = null;
    let error = null;
    this.controller = new AbortController();
    this.turnStart = Date.now();
    this.turnTokens = 0;
    this.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    this.screen.schedule();
    try {
      result = await this.agent.run(content, { signal: this.controller.signal });
      if (result.interrupted) {
        this.flushStreaming();
        this.flushActive(true);
        this.screen.log(resultLines([c.red('Interrupted by user')]), '');
        if (this.restartRequest) {
          this.restartRequest = null;
          this.notice('The restart was cancelled with the turn. Run /restart to load the new code.');
        }
        if (this.sourceChanged) this.skipAutoReload = true;
      }
    } catch (e) {
      error = e;
      this.flushStreaming();
      this.logError(e);
    } finally {
      this.flushStreaming();
      this.flushActive(true);
      this.answerPeers(result, error);
      this.busy = false;
      this.controller = null;
      this.status = null;
      this.rateWait = null;
      this.screen.schedule();
    }
    this.sendWhatWaited();
  }

  // The app has stopped being busy (a turn, a compaction, a command): send what was typed in the
  // meantime as the next turn, or else tell the model about background agents that finished after the
  // last check. Everything that makes the app busy has to end with this, or what waited stays queued.
  sendWhatWaited() {
    if (this.busy || this.exiting) return;
    // A restart that was asked for goes first; what waited is carried over and sent by the new process.
    if (this.restartRequest) { this.restartNow(); return; }
    if (this.queue.length) {
      const next = this.queue.splice(0);
      this.startTurn(next.map((q) => q.text).join('\n\n'), {
        images: next.flatMap((q) => q.images),
        display: next.map((q) => q.display ?? q.text).join('\n\n'),
        peers: next.map((q) => q.peer).filter(Boolean),
      });
    } else if (this.agent.notifications.length) {
      this.runAgent(this.agent.drainNotifications());
    } else {
      this.maybeAutoReload();
    }
  }

  // A background agent ended. If nothing is running, start a turn so the model sees its
  // report right away; otherwise the running turn picks it up at its next step.
  backgroundTaskDone(task) {
    const secs = Math.round((task.ended - task.started) / 1000);
    const color = task.status === 'completed' ? c.green : c.red;
    this.screen.log(`${color(DOT)} ${c.bold('Background agent')} ${task.id} ${c.dim(`"${task.description}"`)} ${task.status} ${c.dim(`(${formatDuration(secs * 1000)})`)}`, '');
    if (!this.busy && !this.exiting && this.agent.notifications.length) this.runAgent(this.agent.drainNotifications());
    else this.screen.schedule();
  }

  async runBashMode(command) {
    if (!command) return;
    this.screen.log(c.magenta('! ') + command);
    const tool = this.runtime.tools.find((t) => t.name === 'Bash');
    this.busy = true;
    this.controller = new AbortController();
    this.status = 'Running';
    this.turnStart = Date.now();
    this.turnTokens = 0;
    const ctx = this.agent.makeCtx(this.controller.signal);
    const entry = { tool, input: { command }, status: 'running', progress: '', sub: [], subCount: 0, ctx, started: Date.now() };
    this.active.push(entry);
    let result;
    try {
      ctx.onProgress = (p) => { entry.progress = p; };
      result = await tool.call({ command }, ctx);
    } catch {
      const partial = (entry.progress || '').replace(/\r\n/g, '\n').trimEnd();
      result = { isError: true, content: `${partial ? partial + '\n' : ''}Interrupted by user`, interrupted: true };
    }
    this.active = this.active.filter((e) => e !== entry);
    const out = typeof result.content === 'string' ? result.content : '';
    let lines = out.split('\n');
    if (lines.length > 40) lines = [...lines.slice(0, 20), c.dim(`… +${lines.length - 40} lines`), ...lines.slice(-20)];
    this.screen.log(resultLines(lines.map((l) => (result.isError && l === lines[lines.length - 1] ? c.red(l) : c.dim(l)))), '');
    this.agent.pushMessage({
      role: 'user',
      content: [{ type: 'text', text: `<bash-input>${command}</bash-input>\n<bash-stdout>${out}</bash-stdout>\n<system-reminder>The user ran this command directly in bash mode. Take its output into account in later answers.</system-reminder>` }],
    });
    this.busy = false;
    this.controller = null;
    this.status = null;
    this.screen.schedule();
    this.sendWhatWaited();
  }

  addMemory(text) {
    if (!text) return;
    const files = {
      project: path.join(this.cwd, 'CLAUDE.md'),
      local: path.join(this.cwd, 'CLAUDE.local.md'),
      user: path.join(CONFIG_DIR, 'CLAUDE.md'),
    };
    this.showDialog(new SelectDialog({
      title: 'Save memory',
      body: [c.dim(truncate(text, this.width - 10))],
      question: 'Where should this memory be saved?',
      color: c.blue,
      options: [
        { label: `Project memory  ${c.dim(displayPath(files.project, this.cwd))}`, value: 'project', description: 'Checked in and shared with your team' },
        { label: `Project memory (local)  ${c.dim(displayPath(files.local, this.cwd))}`, value: 'local', description: 'Just for you in this project' },
        { label: `User memory  ${c.dim(displayPath(files.user, this.cwd))}`, value: 'user', description: 'Your instructions for all projects' },
      ],
    })).then((choice) => {
      if (!choice) return;
      const file = files[choice];
      // This runs outside any handler: an error here (a read-only directory) would end the program.
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let existing = '';
        try { existing = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
        fs.appendFileSync(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}- ${text}\n`);
        // The system prompt stays as it is until the conversation starts over (/clear or a compaction): a prompt
        // that changes in the middle of it cannot be read from the prompt cache.
        this.runtime.deferSystemPromptRefresh();
        this.screen.log(resultLines([c.dim(`Saved to ${displayPath(file, this.cwd)} · the model sees it from the next /clear or /compact`)]));
      } catch (e) {
        this.notice(`Could not save the memory to ${displayPath(file, this.cwd)}: ${e.message}`, 'error');
      }
    });
  }

  // `quiet`: do not print the transcript (a restart: it is still on screen).
  loadSession(file, id, { quiet = false } = {}) {
    const loaded = SessionStore.load(file);
    this.store = new SessionStore(this.cwd, id);
    this.topic = loaded.topic;
    this.firstPrompt = loaded.title;
    this.agent.messages = loaded.messages;
    this.agent.restoreFileState(loaded.messages, loaded.times);
    this.agent.lastActivityAt = loaded.lastAt; // a long pause before this turn clears old tool results, as it would have
    this.agent.lastContextTokens = estimateTokens(loaded.messages);
    // Continue behind the system prompt the conversation had (and its cache), not a freshly built one.
    this.store.systemPrompt = loaded.systemPrompt;
    this.runtime.resumeSystemPrompt(loaded.systemPrompt);
    if (!this.topic) this.refreshTopic(this.latestPrompt()); // a session from before topics were kept
    if (quiet) return;
    this.screen.log(c.dim(`Resumed session ${id} (${loaded.messages.length} messages)`), '');
    this.printTranscript(loaded.messages.slice(-30));
  }

  printTranscript(messages) {
    const toolMap = new Map(this.runtime.tools.map((t) => [t.name, t]));
    const ctx = this.agent.makeCtx();
    for (const m of messages) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      for (const b of blocks) {
        if (m.role === 'user' && b.type === 'text' && !b.text.startsWith('<system-reminder>')) this.screen.log(renderUserMessage(b.text.slice(0, 2000), this.width));
        if (m.role === 'assistant' && b.type === 'text') this.screen.log(renderMarkdown(b.text, { width: this.width - 1, firstPrefix: `${DOT} `, indent: '  ' }), '');
        if (m.role === 'assistant' && b.type === 'tool_use') {
          const tool = toolMap.get(b.name) || { name: b.name };
          this.screen.log(toolHeader(tool, b.input, ctx, { width: this.width }));
        }
      }
    }
    this.screen.log('');
  }

  newSession() {
    this.store = new SessionStore(this.cwd);
    this.topic = null;
    this.firstPrompt = null;
  }

  // ---------------------------------------------------------------- dialogs

  showDialog(dialog) {
    return new Promise((resolve) => {
      const prev = dialog.onResolve;
      dialog.onResolve = (v) => {
        this.dialogs = this.dialogs.filter((d) => d !== dialog);
        prev?.(v);
        resolve(v);
        this.screen.schedule();
      };
      this.dialogs.push(dialog);
      this.screen.schedule();
    });
  }

  async approvePlan(plan) {
    this.flushStreaming();
    const md = renderMarkdown(plan, { width: this.width - 8 });
    const max = Math.max(8, this.screen.height - 14);
    const body = md.length > max ? [...md.slice(0, max), c.dim(`… +${md.length - max} lines (the full plan is printed above)`)] : md;
    if (md.length > max) this.screen.log(c.plan(`${DOT} Plan:`), ...md.map((l) => '  ' + l), '');
    const choice = await this.showDialog(new SelectDialog({
      title: 'Ready to code?',
      body: ["Here is the plan:", '', ...body],
      question: 'Would you like to proceed?',
      color: c.plan,
      cancelValue: 'reject',
      options: [
        { label: 'Yes, start coding', value: 'full' },
        { label: 'No, keep planning', value: 'reject' },
      ],
    }));
    return choice;
  }

  async askQuestion(q) {
    const answer = await this.showDialog(new SelectDialog({
      title: q.header || 'Question',
      question: c.bold(q.question),
      color: c.blue,
      multi: !!q.multiSelect,
      otherOption: true,
      options: (q.options || []).map((o) => ({ label: o.label, value: o.label, description: o.description })),
    }));
    if (answer === null || answer === undefined) return null;
    return Array.isArray(answer) ? answer.join(', ') : answer;
  }

  // ---------------------------------------------------------------- agent IO

  isMain(agent) { return !agent || agent === this.runtime?.agent; }

  streamEvent(ev, agent) {
    if (!this.isMain(agent)) return;
    const w = this.width - 1;
    switch (ev.type) {
      case 'block_start':
        if (ev.block.type === 'text') {
          this.flushThinking();
          this.md = new MarkdownStream({ width: w, firstPrefix: `${DOT} `, indent: '  ' });
        } else if (ev.block.type === 'thinking') {
          this.thinking = { start: Date.now(), text: '', md: this.verbose ? new MarkdownStream({ width: w, firstPrefix: c.dim('✻ '), indent: '  ', style: (s) => c.dim(c.italic(s)) }) : null };
        } else if (ev.block.type === 'tool_use') {
          this.flushThinking();
          this.pendingToolBlocks.set(ev.index, { name: ev.block.name, partial: '' });
        }
        break;
      case 'text':
        this.turnTokens += estimateTokens(ev.text);
        if (this.md) {
          const lines = this.md.write(ev.text);
          if (lines.length) this.screen.log(lines);
        }
        break;
      case 'thinking':
        this.turnTokens += estimateTokens(ev.text);
        if (this.thinking) {
          this.thinking.text += ev.text;
          if (this.thinking.md) {
            const lines = this.thinking.md.write(ev.text);
            if (lines.length) this.screen.log(lines);
          }
        }
        break;
      case 'tool_input': {
        this.turnTokens += 1;
        const p = this.pendingToolBlocks.get(ev.index);
        if (p) p.partial = ev.partial;
        break;
      }
      case 'block_stop':
        if (ev.block.type === 'text' && this.md) {
          const lines = this.md.end();
          if (lines.length) this.screen.log(lines);
          this.screen.log('');
          this.md = null;
        } else if (ev.block.type === 'thinking') {
          this.flushThinking();
        } else if (ev.block.type === 'tool_use') {
          this.pendingToolBlocks.delete(ev.index);
        }
        break;
      case 'retry':
        this.notice(`API error: ${truncate(ev.error.message, 200)} · retrying in ${Math.round(ev.delayMs / 1000)}s (attempt ${ev.attempt}${ev.maxRetries ? `/${ev.maxRetries}` : ''})`, 'warn');
        break;
      case 'rate_limit_wait':
      case 'rate_limit_resume':
        this.rateLimitEvent(ev);
        break;
      case 'reset':
        this.md = null;
        this.thinking = null;
        this.pendingToolBlocks.clear();
        break;
      default:
        break;
    }
    this.screen.schedule();
  }

  // A rate limit pause or its end, from a model request of the main agent (a turn or a compaction).
  rateLimitEvent(ev) {
    if (ev.type === 'rate_limit_resume') {
      this.rateWait = null;
      this.notice(resumeText(ev));
      return;
    }
    // Say it once; later waits of the same pause only move the countdown (unless the reset moved a lot).
    const prev = this.rateWait;
    this.rateWait = { resumeAt: ev.resumeAt, label: ev.label, polling: ev.polling, waitingForLogin: Boolean(ev.waitingForLogin), overloaded: Boolean(ev.overloaded) };
    if (shouldAnnounce(prev, ev)) this.notice(`${describePause(ev)} Esc cancels.`, 'warn');
    this.screen.schedule();
  }

  flushThinking() {
    const t = this.thinking;
    if (!t) return;
    this.thinking = null;
    if (t.md) {
      const lines = t.md.end();
      if (lines.length) this.screen.log(lines);
      this.screen.log('');
    } else if (t.text.trim()) {
      const secs = Math.max(1, Math.round((Date.now() - t.start) / 1000));
      this.screen.log(c.dim(c.italic(`✻ Thought for ${secs}s (ctrl+o to show thinking)`)), '');
    }
  }

  flushStreaming() {
    this.flushThinking();
    if (this.md) {
      const lines = this.md.end();
      if (lines.length) this.screen.log(lines, '');
      this.md = null;
    }
    this.pendingToolBlocks.clear();
  }

  toolBatchStart() {
    this.flushStreaming();
  }

  toolStart(tu, tool, input, agent) {
    if (!this.isMain(agent)) return {};
    const entry = { tu, tool, input, status: 'running', progress: '', sub: [], subCount: 0, ctx: agent.makeCtx(), started: Date.now() };
    this.active.push(entry);
    this.screen.schedule();
    return {
      progress: (p) => {
        if (typeof p === 'string') entry.progress = p;
        else if (p?.type === 'subtool') { entry.sub.push(p.header); entry.subCount++; }
        this.screen.schedule();
      },
      done: (result) => {
        entry.result = result;
        entry.status = result.isError ? 'error' : 'done';
        this.flushActive();
      },
    };
  }

  toolRejected(tu, tool, message, agent) {
    if (!this.isMain(agent)) return;
    const ctx = agent.makeCtx();
    const entry = { tu, tool, input: tu.input, status: 'rejected', rejected: true, rejectMessage: message, ctx };
    this.screen.log(toolHeader(tool, tu.input, ctx, { status: 'rejected', width: this.width }), renderToolResult(entry, { width: this.width, cwd: this.cwd }), '');
  }

  // Move finished tool entries (in call order) from the live region to the transcript.
  flushActive(all = false) {
    while (this.active.length && (all || this.active[0].status !== 'running')) {
      const e = this.active.shift();
      if (e.status === 'running') { e.status = 'error'; e.result = { isError: true, content: 'Interrupted', interrupted: true }; }
      const status = e.result?.isError ? 'error' : 'done';
      this.screen.log(toolHeader(e.tool, e.input, e.ctx, { status, width: this.width }), renderToolResult(e, { verbose: this.verbose, width: this.width, cwd: this.cwd }), '');
    }
    this.screen.schedule();
  }

  // IO object for a sub-agent: reports its tool calls into the parent's Task entry.
  subagentIo({ def, parentCtx }) {
    const app = this;
    let paused = null; // the rate limit wait last announced for this agent
    // The spinner belongs to the main agent (a background agent can be paused while it keeps working),
    // so a sub-agent's pause is only announced, once, and its end too. This covers the agent's turns
    // and the compaction of its own conversation alike.
    const rateLimit = (ev) => {
      if (ev.type === 'rate_limit_wait') {
        if (shouldAnnounce(paused, ev)) app.notice(`[${def.name}] ${describePause(ev)}`, 'warn');
        paused = { resumeAt: ev.resumeAt, waitingForLogin: Boolean(ev.waitingForLogin) };
      }
      if (ev.type === 'rate_limit_resume') {
        paused = null;
        app.notice(`[${def.name}] ${resumeText(ev)}`);
      }
    };
    return {
      approvePlan: async () => 'reject',
      askQuestion: async () => null,
      notice: (text, kind) => app.notice(`[${def.name}] ${text}`, kind),
      toolStart(tu, tool, input, agent) {
        parentCtx.onProgress?.({ type: 'subtool', header: toolHeader(tool, input, agent.makeCtx(), { status: 'done', width: app.width - 8, dot: false }) });
        return {};
      },
      streamEvent(ev) {
        if (ev.type === 'text' || ev.type === 'thinking') app.turnTokens += estimateTokens(ev.text);
        if (ev.type === 'retry') app.notice(`[${def.name}] API error, retrying: ${truncate(ev.error.message, 120)}`, 'warn');
        rateLimit(ev);
      },
      compactProgress: rateLimit,
      takeQueued: () => [],
    };
  }

  takeQueued() {
    if (!this.queue.length) return [];
    const items = this.queue.splice(0);
    for (const q of items) this.screen.log(renderUserMessage(q.display ?? q.text, this.width));
    this.turnPeers.push(...items.map((q) => q.peer).filter(Boolean));
    this.refreshTopic(items.map((q) => q.display ?? q.text).join('\n\n'));
    // Content blocks for the agent: each queued message's text followed by its images.
    return items.flatMap((q) => [{ type: 'text', text: q.text }, ...q.images.map(imageBlock)]);
  }

  messageAdded(msg, agent) { if (this.isMain(agent)) this.store.message(msg); }
  systemPrompt(text, agent) { if (this.isMain(agent)) this.store.setSystemPrompt(text); }
  messagesReplaced(msgs, agent) { if (this.isMain(agent)) this.store.reset(msgs); }
  usage() { this.screen.schedule(); }

  compactStart(auto, agent) {
    if (!this.isMain(agent)) return;
    this.flushStreaming();
    this.status = auto ? 'Auto-compacting conversation' : 'Compacting conversation';
    this.compactTokens = 0;
    this.screen.schedule();
  }

  compactProgress(ev) {
    if (ev.type === 'text' || ev.type === 'thinking') { this.turnTokens += estimateTokens(ev.text); this.screen.schedule(); }
    // A compaction can hit the limit too: say so instead of sitting on "Compacting conversation" for hours.
    else if (ev.type === 'rate_limit_wait' || ev.type === 'rate_limit_resume') this.rateLimitEvent(ev);
  }

  compactEnd(summary, agent, err) {
    if (!this.isMain(agent)) return;
    this.status = null;
    if (err) return;
    this.lastSummary = summary;
    this.screen.log(c.dim('✻ Conversation compacted (the summary is in context; /context to see usage)'), '');
  }

  notice(text, kind = 'info') {
    const color = kind === 'warn' ? c.yellow : kind === 'error' ? c.red : c.dim;
    // Long notices (the rate limit ones are) break between words, not wherever the terminal width falls.
    // A notice of several lines (a hook's warning, say) keeps its lines, each one indented and wrapped.
    const width = Math.max(20, this.width - 4);
    this.screen.log(String(text).split('\n').flatMap((line) => wordWrap(line, width)).map((line) => color(`  ${line.trimEnd()}`)));
  }

  logError(e) {
    const msg = e?.message || String(e);
    this.screen.log(c.red(`${DOT} API Error: ${msg}`), '');
    if (process.env.CLAUDE_PRO_DEBUG && e?.stack) this.screen.log(c.dim(e.stack));
  }

  // ---------------------------------------------------------------- live region

  spinnerLine() {
    const frame = SPINNER[Math.floor(Date.now() / 120) % SPINNER.length];
    if (this.rateWait) {
      const w = this.rateWait;
      const left = humanDuration(w.resumeAt - Date.now()); // the same wording as the notice above it
      const esc = c.dim(`(${this.controller?.signal.aborted ? 'cancelling…' : 'esc to cancel'})`);
      if (w.waitingForLogin) return c.yellow(`${frame} Waiting for the Claude Code login to be renewed · checking again in ${left}`) + ' ' + esc;
      const label = w.label.charAt(0).toUpperCase() + w.label.slice(1);
      const when = w.polling ? `checking again in ${left}` : `resumes at ${formatClock(w.resumeAt)} (in ${left})`;
      return c.yellow(`${frame} ${w.overloaded ? label : `${label} reached`} · ${when}`) + ' ' + esc;
    }
    const secs = formatDuration(Date.now() - this.turnStart);
    const verb = this.status || (this.thinking ? 'Thinking' : this.verb);
    const aborted = this.controller?.signal.aborted;
    const parts = [secs];
    if (this.turnTokens) parts.push(`↓ ${formatTokens(this.turnTokens)} tokens`);
    parts.push(aborted ? 'interrupting…' : 'esc to interrupt');
    return c.claude(`${frame} ${verb}…`) + ' ' + c.dim(`(${parts.join(' · ')})`);
  }

  renderActiveEntry(e, w) {
    const lines = [toolHeader(e.tool, e.input, e.ctx, { status: 'running', width: w })];
    if (e.tool.name === 'Task' || e.sub.length) {
      const shown = e.sub.slice(-3);
      const more = e.subCount - shown.length;
      const sub = shown.map((h) => c.dim(truncate(h, w - 8)));
      if (more > 0) sub.push(c.dim(`+${more} more tool use${more === 1 ? '' : 's'}`));
      if (!sub.length) sub.push(c.dim('Initializing…'));
      lines.push(...resultLines(sub));
    } else if (e.progress) {
      const out = e.progress.replace(/\r\n/g, '\n').trimEnd().split('\n');
      const tail = out.slice(-5).map((l) => c.dim(truncate(l.replace(/\r/g, ''), w - 8)));
      if (out.length > 5) tail.unshift(c.dim(`… +${out.length - 5} lines`));
      lines.push(...resultLines(tail));
    } else {
      const secs = Math.floor((Date.now() - e.started) / 1000);
      if (secs >= 2) lines.push(...resultLines([c.dim(`Running… (${secs}s)`)]));
    }
    return lines;
  }

  renderLive(width) {
    const w = width - 1;
    const lines = [];
    let cursor = null;
    if (this.busy) {
      // In-progress assistant text.
      if (this.md) {
        const partial = this.md.partial();
        lines.push(...partial.slice(-Math.floor(this.screen.height / 2)));
      }
      if (this.thinking?.md) lines.push(...this.thinking.md.partial().slice(-3));
      else if (this.thinking && this.thinking.text) {
        const last = this.thinking.text.trimEnd().split('\n').pop() || '';
        lines.push(c.dim(c.italic(truncate(`✻ ${last}`, w))));
      }
      for (const [, p] of this.pendingToolBlocks) {
        const m = /"(?:file_path|command|pattern|url|description|query)"\s*:\s*"((?:\\.|[^"\\])*)/.exec(p.partial);
        const tool = this.runtime.tools.find((t) => t.name === p.name) || { name: p.name };
        const arg = m ? m[1].replace(/\\n/g, ' ').replace(/\\(.)/g, '$1') : '';
        lines.push(`${c.gray(DOT)} ${c.bold(toolLabel(tool, {}))}${arg ? `(${truncate(arg, w - 20)})` : ''} ${c.dim(p.partial.length > 200 ? `(${formatTokens(Math.round(p.partial.length / 4))} tokens…)` : '…')}`);
      }
      for (const e of this.active) lines.push(...this.renderActiveEntry(e, w));
      if (!this.dialogs.length) {
        if (lines.length) lines.push('');
        lines.push(this.spinnerLine());
        const todos = this.agent.todos;
        if (this.showTodos && todos.length) lines.push(...renderTodos(todos).map((l) => truncate(l, w)));
      }
    } else if (this.active.length) {
      for (const e of this.active) lines.push(...this.renderActiveEntry(e, w));
    }
    if (this.dialogs.length) {
      if (lines.length) lines.push('');
      const r = this.dialogs[0].render(width, this.screen.height - lines.length - 1);
      const top = lines.length;
      lines.push(...r.lines);
      if (r.cursor) cursor = { row: top + r.cursor.row, col: r.cursor.col };
      return { lines, cursor };
    }
    if (this.queue.length) {
      for (const q of this.queue) lines.push(c.dim('  ⎿ queued: ') + c.gray(truncate((q.display ?? q.text).replace(/\s+/g, ' '), w - 14)));
    }
    if (lines.length) lines.push('');
    const placeholder = this.busy ? 'Type a message to queue it for the agent…' : (this.agent.messages.length ? '' : 'Try "explain this codebase" or "fix the failing test"');
    const r = this.editor.render(width, { placeholder, title: this.boxTitle() });
    const top = lines.length;
    lines.push(...r.lines);
    if (r.cursor) cursor = { row: top + r.cursor.row, col: r.cursor.col };
    if (this.editor.suggestions) lines.push(...this.editor.renderSuggestions(w));
    else if (this.editor.text === '?') lines.push(...this.shortcutsHelp());
    else lines.push(this.footer(w));
    return { lines, cursor };
  }

  // In the input box's top border: the directory the agent is in now (a `cd` moves it), and this
  // session's name for the other sessions.
  boxTitle() {
    const dir = this.agent?.cwd || this.cwd;
    const home = os.homedir();
    const shown = dir.toLowerCase().startsWith(home.toLowerCase()) ? '~' + dir.slice(home.length) : dir;
    return { left: shown.replace(/\\/g, '/'), right: this.peers ? `@${this.peers.name}` : '' };
  }

  footer(w) {
    const mode = this.runtime.modes.mode;
    let left;
    const flash = this.flashMessage && Date.now() < this.flashMessage.until ? this.flashMessage : null;
    if (this.exitArmed && Date.now() - this.exitArmed < 1500) left = c.dim('  Press Ctrl-C again to exit');
    else if (flash) left = (flash.kind === 'warn' ? c.yellow : c.dim)('  ' + truncate(flash.text, w - 4));
    else if (this.restartRequest) left = c.dim('  ↻ restarting when this turn ends');
    else if (mode === 'plan') left = '  ' + c.plan('⏸ plan mode on (read-only)') + c.dim(' (shift+tab to leave)');
    else if (this.editor.mode === 'bash') left = c.magenta('  ! for bash mode');
    else if (this.editor.mode === 'memory') left = c.blue('  # to memorize');
    else left = c.dim('  ? for shortcuts');
    const cfg = this.config;
    const threshold = cfg.autoCompactThreshold(cfg.mainModel);
    const used = this.agent.contextEstimate;
    let notice = '';
    const pctLeft = Math.max(0, Math.round((1 - used / threshold) * 100));
    if (pctLeft <= 30 && cfg.autoCompactEnabled) notice = c.yellow(`Context left until auto-compact: ${pctLeft}%`);
    else if (this.runtime.tasks.running().length) notice = c.dim(`${this.runtime.tasks.running().length} background agent${this.runtime.tasks.running().length === 1 ? '' : 's'} running · /tasks`);
    else if (this.verbose) notice = c.dim('verbose');
    // The model and effort in use always have a place at the right: with the notice after it when both fit,
    // and the notice alone when they do not (a context warning matters more than the model's name).
    const { model, effort } = modelInfo(cfg);
    // An effort that is not set is not sent: the API then uses the model's default, which is shown instead.
    const level = effort || defaultEffort(cfg.mainModel.id, cfg);
    const info = c.dim(level ? `${model} · effort ${level}` : model);
    const room = w - stringWidth(left) - 1;
    const right = [notice && info ? `${notice}${c.dim(' · ')}${info}` : '', notice, info].find((r) => r && stringWidth(r) < room) || '';
    const gap = room - stringWidth(right);
    return right ? left + ' '.repeat(gap) + right : left;
  }
}

export async function runRepl({ flags, cwd, initialPrompt }) {
  const app = new App({ flags, cwd });
  process.on('uncaughtException', (e) => {
    app.restoreTerminal();
    process.stderr.write(`\nUnexpected error: ${e?.stack || e}\n`);
    process.exit(1);
  });
  return await app.start(initialPrompt);
}
