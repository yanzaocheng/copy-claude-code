// Interactive REPL: owns the terminal, renders the transcript and live region, and
// implements the agent's IO callbacks (streaming, tool display, permission prompts).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { c, ESC, stringWidth, stripAnsi, truncate, padEnd, wordWrap } from './ansi.js';
import { Screen, queryCursorRow, mouseFilter } from './screen.js';
import { Editor, topBorder, shownQuotes } from './editor.js';
import { SelectDialog } from './dialogs.js';
import { MarkdownStream, renderMarkdown } from './markdown.js';
import {
  DOT, toolHeader, renderToolResult, renderTodos, renderUserMessage, resultLines, formatTokens, formatDuration, toolLabel, bashModeLines,
} from './render.js';
import { createRuntime } from '../runtime.js';
import { SessionStore, firstUserText, moveSession } from '../session.js';
import { defaultEffort, effortSupported, effortToSend, quickQuery } from '../api.js';
import { CONFIG_DIR, VERSION, APP_NAME, INSTALL_DIR } from '../config.js';
import { gatewayLogin, loadGatewayModels, normalizeGatewayUrl, formatUsd } from '../gateway.js';
import { TOPIC_TITLE_SYSTEM, topicTitlePrompt } from '../prompts.js';
import { buildCommands, modelChoices, effortChoices } from '../commands.js';
import { canRestart, writeRestartState, runSelfCheck, watchSource, restartNote, RESTART_EXIT_CODE, MAX_RESTARTS, RESTART_WINDOW_MS } from '../restart.js';
import { resolvePath, displayPath } from '../utils/paths.js';
import { listDirectory, recentDirectories } from '../utils/dirs.js';
import { ripgrepPath } from '../utils/shell.js';
import { describePause, formatClock, humanDuration, resumeText, shouldAnnounce } from '../ratelimit.js';
import { shutdownBackgroundShells, listBackgroundShells } from '../tools/bash.js';
import { shutdownInterpreters } from '../tools/code.js';
import { estimateTokens } from '../agent.js';
import { readClipboardImage, imageFromFile, writeClipboard, readClipboardText } from '../utils/clipboard.js';
import { fitImagesIn, imageSize } from '../utils/images.js';
import { checkForUpdate, installUpdate, installedVersion, installedByNpm, isNewer } from '../updater.js';
import { PeerNode, peersEnabled, findPeer, resolvePeer, machineName, cleanName, peerMessagePrompt } from '../peers.js';
import { RemoteControl, transcriptItems, onlineEnabled, remoteCommandsEnabled, REMOTE_WIDTH } from '../remote.js';

// A model id as people say it: claude-sonnet-5-5 -> sonnet-5-5, claude-haiku-4-5-20251001 -> haiku-4-5.
export const modelTag = (model) => String(model?.id ?? '').replace(/^claude-/, '').replace(/-\d{8}$/, '');

// The model and effort level that requests use now, for the footer and the terminal title. The effort
// is left out when none is sent (auto) and for a model that does not take one.
export function modelInfo(config) {
  const model = config.model;
  // What the requests carry: the nearest level the model takes (none goes out as low on gpt-6.1-sol, ultra as max on Claude).
  const sent = effortToSend(config, model.id, config.effort);
  const effort = sent && effortSupported(model.id) ? sent : null;
  return { model: modelTag(model), effort };
}

// The title model's answer about the topic (see topicTitlePrompt) as a clean title, or null when it is not
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

// The images the remote page sends with a message ({media_type, data: base64}), checked as the API would: at most
// REMOTE_MAX_IMAGES, each a PNG, JPEG, GIF or WebP of at most 5 MB. Throws what to tell the page.
const REMOTE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// What the page may not send (see App.remoteSend): ending or restarting the session, or updating claude-pro (which
// restarts it), with or without arguments. The gateway uses the same pattern.
const TERMINAL_ONLY = /^\s*\/(exit|quit|restart|reload|update)(?:\s|$)/i;
const REMOTE_MAX_IMAGES = 6;
const REMOTE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function remoteImages(images) {
  if (images == null) return [];
  if (!Array.isArray(images)) throw new Error('images must be a list.');
  if (images.length > REMOTE_MAX_IMAGES) throw new Error(`At most ${REMOTE_MAX_IMAGES} images can be sent at a time (this message has ${images.length}).`);
  return images.map((img, i) => {
    const n = images.length > 1 ? `Image ${i + 1}` : 'The image';
    const type = String(img?.media_type || '').toLowerCase();
    if (!REMOTE_IMAGE_TYPES.includes(type)) throw new Error(`${n} is ${type || 'of no type'}: only PNG, JPEG, GIF and WebP images can be sent.`);
    const data = typeof img.data === 'string' ? img.data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '') : '';
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error(`${n} is not base64 data.`);
    const buf = Buffer.from(data, 'base64');
    if (buf.length > REMOTE_MAX_IMAGE_BYTES) throw new Error(`${n} is ${(buf.length / 1024 / 1024).toFixed(1)} MB: at most 5 MB.`);
    if (!imageSize(buf)) throw new Error(`${n} is not a readable ${type.slice(6).toUpperCase()} image.`);
    return { media_type: type, data };
  });
}

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
      child.stdout.setEncoding('utf8'); // a Chinese file name can be split between two chunks
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
  // The files and their directories with what search() compares, made once per listing (it runs on every keypress
  // after an @, and building it from up to 50,000 paths each time made typing lag in a big project).
  entries() {
    if (this.cache && this.cacheAt === this.at) return this.cache;
    const dirs = new Set();
    for (const f of this.files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
      if (dirs.size > 5000) break;
    }
    // Without ripgrep the listing comes from a glob that also returns directories (as plain names): they are already in `dirs`, with their slash.
    const all = [...dirs, ...this.files.filter((f) => !dirs.has(f + '/'))];
    this.cache = all.map((f) => {
      const lower = f.toLowerCase();
      return { f, lower, base: lower.replace(/\/$/, '').split('/').pop(), depth: f.split('/').length };
    });
    this.cacheAt = this.at;
    return this.cache;
  }
  search(q) {
    this.refresh();
    const query = q.toLowerCase();
    const scored = [];
    for (const { f, lower, base, depth } of this.entries()) {
      let score = -1;
      if (!query) score = depth;
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
  // `noProcessExit`: the tests, which drive the App themselves; it never ends the process, and it has no peers, no
  // gateway connection, no update checks and the default renderer. `selfCheck` (see selfcheck.js): it never ends the
  // process either, but otherwise starts as a session does, so that code only a real start runs is checked too.
  constructor({ flags, cwd, stdin = process.stdin, stdout = process.stdout, noProcessExit = false, selfCheck = false }) {
    this.flags = flags;
    this.cwd = cwd;
    this.stdin = stdin;
    this.stdout = stdout;
    this.noProcessExit = noProcessExit || selfCheck;
    this.driven = noProcessExit;
    this.screen = new Screen(stdout);
    this.busy = false;
    // Attachment expansion is asynchronous. Claim the turn before the first await so two
    // rapid submits cannot start two Agent.run() calls against the same message array.
    this.turnStarting = false;
    this.controller = null;
    this.queue = [];
    this.dialogs = [];
    // Some terminals turn Ctrl+V into a bracketed-paste sequence. Keep its raw text as a fallback
    // when the platform clipboard helper is unavailable, while still preferring clipboard images.
    this.bracketedPaste = null;
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
    this.topic = null; // what the conversation is about now, named by the title model (see refreshTopic)
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
    this.remote = null; // the browser page that watches and steers this session (see remote.js), when it is on
    this.remoteMuted = 0; // > 0 while printing something the page is told about in its own terms
    this.remoteDialogs = 0;
    this.remoteStarting = null;
    this.remoteRefused = null; // a gateway key the gateway refused: not tried again by itself (a new /login is)
    this.seedOutput = []; // lines the page is shown after the conversation when it starts from it (see resumeAfterRestart)
    this.selfCheck = selfCheck;
    this.sessionName = flags?.restart?.peerName || null; // this session's name when the sessions of this computer do not know it (CLAUDE_PRO_PEERS=0)
    this.customTitle = null; // the conversation's name given with /rename: the title, instead of the topic
    this.remotePeers = []; // the account's sessions on other computers, as last listed by the gateway (see peers.js)
    this.remotePeersAt = 0;
    this.remotePeersLoading = null;
    this.remotePeersTimer = null;
    this.cost = 0; // what this conversation's requests have cost so far (USD at list prices): the footer and /cost
    this.fileIndex = new FileIndex(cwd, () => this.runtime?.config);
    this.store = new SessionStore(cwd);
    // What the terminal prints goes to the remote page too, except what it is told about as events.
    this.screen.onLog = (items) => {
      const lines = () => items.flatMap((i) => (Array.isArray(i) ? i : [i])).flatMap((l) => String(l).split(/\r?\n/));
      if (!this.remote || this.remoteMuted) return;
      this.remote.output(lines());
    };
    this.editor = new Editor({
      history: loadHistory(cwd),
      onSubmit: (value, raw, images, display) => { try { this.onSubmit(value, raw, images, display); } catch (e) { this.logError(e); } },
      onDoubleEscape: () => this.openRewind(),
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
  isTurnRunning() { return this.busy || this.turnStarting; }

  // ---------------------------------------------------------------- lifecycle

  async start(initialPrompt) {
    const stdin = this.stdin;
    stdin.setRawMode(true);
    // Where the cursor is, before anything is drawn: the input box is kept on the last rows of the window from
    // there (see screen.js).
    if (stdin.isTTY && this.stdout.isTTY) this.screen.pinFrom(await queryCursorRow(stdin, this.stdout));
    stdin.setEncoding('utf8');
    this.stdout.write(ESC.bracketedPasteOn);
    const cleanup = () => this.restoreTerminal();
    process.on('exit', cleanup);
    process.on('SIGTERM', () => this.exit(143));
    process.on('SIGHUP', () => this.exit(129));

    await this.startPeer();
    this.runtime = await createRuntime({ cwd: this.cwd, flags: this.flags, io: this, sessionId: this.store.id });
    // The conversation's id, sent to the gateway with each request (see streamMessage); it follows /clear and /resume.
    Object.defineProperty(this.runtime.config, 'sessionId', { get: () => this.store.id, configurable: true });
    // Every request's cost (the conversation's, its sub-agents', side queries'), kept with the session.
    this.runtime.config.onCost = (usd) => {
      this.cost += usd;
      this.store.setCost(this.cost);
      this.screen.schedule();
    };
    this.commands = buildCommands(this);
    // The window of the model in use may come from the gateway's model list (see Config.resolveModel): asked for now,
    // so that the footer shows it before the first request.
    if (!this.driven) loadGatewayModels(this.runtime.config).then(() => this.screen.schedule());
    // What the session showed before a restart: scrolled back to in fullscreen, repainted after a resize otherwise.
    if (Array.isArray(this.flags.restart?.screenHistory)) this.screen.history = this.flags.restart.screenHistory.filter((l) => typeof l === 'string');
    if (this.fullscreenWanted()) this.screen.setFull(true);
    // Keys typed while starting up stay buffered in stdin until we listen. Mouse reports (fullscreen: the wheel)
    // are taken out before the keys are read.
    const keys = mouseFilter(stdin, (m) => this.onMouse(m));
    this.keys = keys;
    readline.emitKeypressEvents(keys);
    keys.on('keypress', (str, key) => {
      if (/^\x1b\[\d+;\d+R$/.test(key?.sequence || '')) return; // a late answer to the cursor position query, not a key
      try { this.onKey(str, key || {}); } catch (e) { this.logError(e); }
    });
    stdin.resume();
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
    if (!restart && this.flags.name?.trim()) this.renameSession(this.flags.name); // --name, as /rename does
    this.autoStartRemote(restart);

    this.screen.setLive((w) => this.renderLive(w));
    this.spinnerTimer = setInterval(() => {
      const clock = this.cacheClock(); // the footer's clock counts down while nothing else is drawn
      if (this.isTurnRunning() || this.active.length || clock !== this.shownClock) this.screen.schedule();
      this.shownClock = clock;
    }, 120);
    if (restart) this.continueAfterRestart(restart);
    else if (initialPrompt?.trim()) this.onSubmit(initialPrompt, initialPrompt);
    // Nothing configured yet: the gateway is the default, and its browser login starts first.
    else if (this.config.usesGateway && !gatewayLogin(this.config.gatewayUrl, this.config.env.CLAUDE_PRO_GATEWAY_API_KEY)) {
      Promise.resolve(this.commands.get('login').run('')).catch((e) => this.logError(e)).finally(() => this.screen.schedule());
    }
    this.fileIndex.refresh();
    this.startSourceWatch();
    if (!this.driven) {
      // Updates are deliberately manual: /update checks npm and installs the selected release.
      // Do not query the registry or install/restart a running session in the background.
      // online or offline as this computer's gateway login changes (/login or /logout in another window)
      this.loginTimer = setInterval(() => this.syncRemote(), 10_000);
      this.loginTimer.unref?.();
    }
    return new Promise((resolve) => { this.resolveExit = resolve; });
  }

  // What the session is about now: the current model named the topic last, or else the first thing asked
  // (kept when the conversation is compacted afterwards). Cleared by /clear, replaced by /resume.
  sessionLabel() {
    if (this.customTitle) return this.customTitle;
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

  // Keep the title on the topic of the conversation: ask the current model, in the background, whether
  // `message` starts a new topic and what to call it (as the official client does). Nothing waits for the
  // answer, and when there is none (a rate limit, no network) the title just stays as it is.
  refreshTopic(message) {
    const text = String(message ?? '').trim();
    if (!text || this.customTitle || /^(1|true|yes)$/i.test(this.config.env.CLAUDE_PRO_DISABLE_TOPIC_TITLE || '')) return;
    const store = this.store;
    const seq = ++this.topicSeq;
    const current = this.topic;
    quickQuery(this.config, {
      model: this.config.model, system: TOPIC_TITLE_SYSTEM, prompt: topicTitlePrompt(current, text.slice(0, 2000)), maxTokens: 2048,
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
    const state = this.rateWait ? '⏸' : this.isTurnRunning() ? (Math.floor(Date.now() / 1000) % 2 ? '⠐' : '⠂') : '✳';
    const session = this.sessionLabel();
    const where = [dir, model, effort].filter(Boolean).join(' · ');
    return `${state} ${session ? `${truncate(session, 40).replace(/\x1b\[0m$/, '')} | ` : ''}${where}`;
  }

  // `handOver`: another process takes the terminal over at once (a restart). It is left the way the program
  // had it (raw mode, bracketed paste, the tab's title), so that keys typed in between are not echoed or lost.
  restoreTerminal({ handOver = false, farewell = [] } = {}) {
    if (this.restored) return;
    this.restored = true;
    try {
      this.screen.close({ keepTitle: handOver, after: farewell });
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
    shutdownInterpreters();
    this.runtime?.tasks.killAll();
    this.runtime?.mcp.close();
    this.peers?.close();
    clearInterval(this.remotePeersTimer);
    clearInterval(this.loginTimer);
    const remoteClosed = this.remote?.close({ restarting: restart });
    const u = this.agent?.totalUsage();
    const farewell = []; // left on the terminal once the program's screen is gone (see Screen.close)
    if (!restart && u && u.requests) {
      farewell.push(c.dim(`Total usage: ${formatTokens(u.input + u.cacheRead + u.cacheWrite)} input (${formatTokens(u.cacheRead)} cached), ${formatTokens(u.output)} output, ${u.requests + u.compactions} requests`));
    }
    if (!restart && this.agent?.messages.length) farewell.push(c.dim(`Resume this session with: ${APP_NAME} --resume ${this.store.id}`));
    this.restoreTerminal({ handOver: restart, farewell });
    this.stdin.pause();
    this.resolveExit?.(code);
    if (!this.noProcessExit) {
      // with remote control on, the gateway is told first (at most a second and a half; see RemoteControl.close)
      if (remoteClosed) remoteClosed.finally(() => process.exit(code));
      else setTimeout(() => process.exit(code), 50).unref();
    }
  }

  // ---------------------------------------------------------------- other sessions (see peers.js)

  // Register this session so that the other sessions on the machine can send it tasks. Not in the tests
  // (which drive the App themselves) and not with CLAUDE_PRO_PEERS=0.
  async startPeer() {
    if (this.driven || !peersEnabled()) return;
    try {
      this.peers = await new PeerNode({
        cwd: this.cwd,
        name: this.flags.restart?.peerName,
        id: this.flags.restart?.peerId,
        onMessage: (msg) => this.onPeerMessage(msg),
        getStatus: () => ({ busy: this.working() }),
      }).start();
    } catch (e) {
      this.peers = null;
      this.notice(`Other sessions cannot reach this one: ${e.message}`, 'warn');
    }
  }

  // This session's name for the others.
  peerLabel() { return this.peers?.name || this.sessionName || cleanName(path.basename(this.cwd)) || 'claude-pro'; }

  // /rename: the session's name, for the other sessions (@name, here and at the gateway) and as the conversation's
  // title (the tab, /resume, the web page), instead of the topic. Returns the name it got: name-2... when another
  // session on this computer has it.
  renameSession(name) {
    const clean = cleanName(name);
    const got = this.peers ? this.peers.setName(clean) : (this.sessionName = clean);
    this.customTitle = got;
    this.store.setName(got);
    this.remote?.register().catch(() => { /* the gateway takes it at the next registration */ });
    this.remote?.flush();
    this.screen.schedule();
    return got;
  }

  // `target`: a peer entry, or what names one (see resolvePeer): a session on this computer, or one on another
  // computer, reached through the gateway. `byModel`: the MessagePeer tool sent it, so the answer goes to the
  // model; otherwise the user typed `@name ...` and the answer is only shown (and noted for the model).
  async sendToPeer(target, text, { byModel = false } = {}) {
    let peer = target && typeof target === 'object' ? target : null;
    if (!peer) {
      const local = this.peers?.peers() || [];
      let found = resolvePeer(local, this.remotePeers, target);
      if (!found.peer && !found.error && this.remote) found = resolvePeer(local, await this.refreshRemotePeers(), target);
      if (!found.peer) {
        const offline = this.remote ? '' : ' Sessions on your other computers can be reached once this one is online at the gateway (/login).';
        throw new Error(found.error || `No running session called "${String(target).replace(/^[@&＆]/, '')}". /peers lists them.${offline}`);
      }
      peer = found.peer;
    }
    if (peer.remote && !this.remote) throw new Error(`@${peer.label} is on another computer, and this session is not online at the gateway (/status says why).`);
    if (!peer.remote && !this.peers) throw new Error('Talking to other sessions on this computer is off (CLAUDE_PRO_PEERS=0).');
    const r = peer.remote
      ? { ...(await this.remote.sendPeer(peer.id, { text })), peer }
      : await this.peers.send(peer, { text });
    if (!byModel) this.userSentToPeers.add(`${r.peer.id}:${r.id}`);
    return r;
  }

  // The account's sessions on other computers that are online now, from the gateway (what was known stays when
  // it cannot be asked). Sessions of this computer are left out: they are reached directly.
  refreshRemotePeers() {
    if (!this.remote?.registered) return Promise.resolve(this.remotePeers);
    this.remotePeersLoading ??= (async () => {
      try {
        const near = new Set([this.peers?.id, ...(this.peers?.peers() || []).map((p) => p.id)].filter(Boolean));
        const list = await this.remote.sessions();
        this.remotePeers = list
          .filter((p) => p.online && !p.ended && p.id !== this.remote?.id && !near.has(p.peerId))
          .map((p) => {
            const machine = p.machine || p.host || 'computer';
            const name = p.name || 'session';
            return { id: p.id, name, machine, cwd: p.cwd || '', remote: true, label: `${machine}/${name}`, busy: Boolean(p.busy), title: p.title || '' };
          });
        this.remotePeersAt = Date.now();
      } catch { /* the gateway cannot be asked now */ } finally {
        this.remotePeersLoading = null;
      }
      return this.remotePeers;
    })();
    return this.remotePeersLoading;
  }

  // This session and the others, here and on the other computers (for /peers and ListPeers).
  async listAllPeers() {
    if (this.remote) await this.refreshRemotePeers();
    const name = this.peerLabel();
    return {
      me: { name, cwd: this.agent?.cwd || this.cwd, label: `${machineName(this.config.env)}/${name}` },
      local: this.peers?.peers() || [],
      remote: this.remotePeers,
      online: Boolean(this.remote?.online),
    };
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
    if (this.isTurnRunning()) { this.queue.push(item); this.screen.schedule(); return; }
    this.startTurn(item.text, { display, peers: item.peer ? [item.peer] : [] });
  }

  // Send `text` as the answer to `msg`, a message of another session: here, or through the gateway.
  replyToPeer(msg, text) {
    const done = () => this.screen.log(c.dim(`  ⎿  Answer sent to @${msg.from.name}`));
    const failed = (e) => this.notice(`Could not send the answer to @${msg.from.name}: ${e.message}`, 'warn');
    if (msg.from.remote) { // from another computer: back through the gateway
      if (!this.remote) { this.notice(`This session is no longer online at the gateway: the answer to @${msg.from.name} was not sent.`, 'warn'); return; }
      this.remote.sendPeer(msg.from.id, { kind: 'reply', text, inReplyTo: msg.id }).then(done, failed);
      return;
    }
    if (!this.peers) return;
    // by id, or by name: a session that was restarted by older code comes back with a new id
    const running = this.peers.peers();
    const peer = findPeer(running, msg.from.id) || running.find((p) => p.name === msg.from.name && p.cwd === msg.from.cwd);
    if (!peer) { this.notice(`@${msg.from.name} is no longer running: its answer was not sent.`, 'warn'); return; }
    this.peers.send(peer, { text, kind: 'reply', inReplyTo: msg.id }).then(done, failed);
  }

  // The turn that handled tasks of other sessions ended: send each its answer.
  answerPeers(result, error) {
    const tasks = this.turnPeers.splice(0);
    if (!tasks.length) return;
    const text = error ? `The session failed before finishing: ${error.message || error}`
      : result?.interrupted ? `The user of ${this.peerLabel()} interrupted the work before it was finished.${result.text ? `\n\nWhat it had written:\n${result.text}` : ''}`
        : (result?.text || '(no answer text)');
    // One answer per session, to its last message: several messages from it that waited for this turn were all
    // handled in it, and sending the whole answer once for each would hand that session the same text again and again.
    const lastOfEach = new Map();
    for (const msg of tasks) lastOfEach.set(`${msg.from.id}|${msg.from.name}|${msg.from.cwd}`, msg);
    for (const msg of lastOfEach.values()) this.replyToPeer(msg, text);
  }

  // ---------------------------------------------------------------- remote control (see remote.js)

  // Print to the terminal only: the remote page is told about this as an event of its own.
  // `{soon: true}` first: drawn with the next frame (streamed text, see Screen.logSoon).
  logLocal(...items) {
    const soon = items[0]?.soon === true && items.shift();
    this.remoteMuted++;
    try { if (soon) this.screen.logSoon(...items); else this.screen.log(...items); } finally { this.remoteMuted--; }
  }

  // A message of the user in the transcript (typed here, on the remote page, or sent by another session).
  echoUser(text, images = 0) {
    this.logLocal(renderUserMessage(text, this.width));
    this.remote?.emit({ t: 'user', text: images ? `${text}\n[${images} image${images === 1 ? '' : 's'}]` : String(text) });
  }

  // Whether this session should be online at the gateway (see remote.js): whenever this computer is logged in to
  // it. CLAUDE_PRO_ONLINE=0 keeps it off (the self-check sets it); the tests, which drive the App themselves, go
  // online only with CLAUDE_PRO_ONLINE=1.
  onlineWanted() {
    const env = this.config.env;
    if (!onlineEnabled(env)) return false;
    if (this.driven && !/^(1|true|yes|on)$/i.test(env.CLAUDE_PRO_ONLINE || '')) return false;
    return Boolean(gatewayLogin(this.config.gatewayUrl, this.config.env.CLAUDE_PRO_GATEWAY_API_KEY));
  }

  // Online at the gateway from the start when this computer is logged in, and after a restart with the same
  // session id so that an already-open page keeps following it.
  autoStartRemote(restart) {
    const id = restart?.remote?.id || null;
    if (!id && !this.onlineWanted()) return;
    this.startRemote({ id }).catch((e) => {
      if (e.code === 'NO_GATEWAY_LOGIN') return;
      this.notice(`This session could not go online at the gateway: ${e.message}`, 'warn');
    });
  }

  // Connect this session to the gateway (see remote.js): the web page and the sessions on the account's other
  // computers reach it from then on. Needs the gateway login from /login or CLAUDE_PRO_GATEWAY_API_KEY; throws
  // {code: 'NO_GATEWAY_LOGIN'} without it. A gateway that cannot be reached now is tried again in the background;
  // one that refuses the key throws, and that key is not tried again (see syncRemote).
  startRemote({ id } = {}) {
    if (this.remote) return Promise.resolve(this.remote);
    this.remoteStarting ??= this.connectRemote({ id }).finally(() => { this.remoteStarting = null; });
    return this.remoteStarting;
  }

  // Online or offline as this computer's gateway login is now: after /login and /logout, and every few seconds (a
  // login or a logout in another window, another account). Resolves with the connection, or null.
  syncRemote() {
    if (this.exiting) return Promise.resolve(null);
    if (this.remoteStarting) return this.remoteStarting.catch(() => null);
    const login = gatewayLogin(this.config.gatewayUrl, this.config.env.CLAUDE_PRO_GATEWAY_API_KEY);
    const r = this.remote;
    // logged out, or another account: not this account's session any more
    if (r && (!login || login.apiKey !== r.apiKey || normalizeGatewayUrl(login.url || this.config.gatewayUrl) !== normalizeGatewayUrl(r.base))) this.stopRemote();
    if (this.remote) return Promise.resolve(this.remote);
    if (!login || login.apiKey === this.remoteRefused || !this.onlineWanted()) return Promise.resolve(null);
    return this.startRemote().catch((e) => {
      this.notice(`This session could not go online at the gateway: ${e.message}`, 'warn');
      return null;
    });
  }

  async connectRemote({ id }) {
    const login = gatewayLogin(this.config.gatewayUrl, this.config.env.CLAUDE_PRO_GATEWAY_API_KEY);
    if (!login) throw Object.assign(new Error(`this computer is not logged in to the gateway ${this.config.gatewayUrl} (/login logs in)`), { code: 'NO_GATEWAY_LOGIN' });
    // What the page may do here, besides watching (see remote.js): nothing with CLAUDE_PRO_REMOTE_COMMANDS=0.
    const commands = remoteCommandsEnabled(this.config.env) ? {
      send: (body) => this.remoteSend(body.text, body.images),
      interrupt: () => this.remoteInterrupt(),
      answer: (body) => this.answerDialog(body),
      options: () => this.remoteOptions(),
      suggest: (body) => this.remoteSuggest(body),
      list: (body) => this.remoteList(body),
      output: (body) => this.remoteOutput(body),
    } : {};
    const remote = new RemoteControl({
      gateway: { url: login.url || this.config.gatewayUrl, apiKey: login.apiKey },
      id,
      handlers: {
        info: () => ({
          name: this.peerLabel(), machine: machineName(this.config.env), peerId: this.peers?.id || null, title: this.sessionLabel() || '',
          cwd: (this.agent.cwd || this.cwd).replace(/\\/g, '/'), model: modelInfo(this.config).model, version: VERSION,
          kind: 'terminal',
        }),
        seed: () => [
          ...transcriptItems(this.agent.messages, { tools: this.runtime.tools, ctx: this.agent.makeCtx(), cwd: this.cwd }),
          ...(this.seedOutput.length ? [{ k: 'output', lines: this.seedOutput.slice() }] : []),
        ],
        status: () => this.remoteStatus(),
        ...commands,
        peerMessage: (msg) => this.onPeerMessage(msg),
        changed: () => {
          this.screen.schedule();
          if (remote.online && Date.now() - this.remotePeersAt > 10_000) this.refreshRemotePeers();
        },
        // The key was refused after the start (revoked on the web page, say): offline until the login changes.
        refused: () => {
          this.remoteRefused = login.apiKey;
          if (this.remote === remote) { this.remote = null; this.remotePeers = []; }
          this.notice('The gateway refused this computer\'s key: this session is offline there now (/logout, then /login).', 'warn');
        },
      },
    });
    remote.account = login.account?.email || login.account?.name || null;
    try {
      await remote.start({ persistent: true });
    } catch (e) {
      if (e.status === 401 || e.status === 403) this.remoteRefused = login.apiKey;
      throw e;
    }
    if (this.exiting) { remote.close(); return remote; }
    this.remote = remote;
    this.remoteRefused = null;
    this.remotePeersTimer ??= setInterval(() => { if (this.remote?.online) this.refreshRemotePeers(); }, 60_000);
    this.remotePeersTimer.unref?.();
    this.screen.schedule();
    return remote;
  }

  stopRemote() {
    this.remote?.close();
    this.remote = null;
    this.remotePeers = [];
    this.screen.schedule();
  }

  // This session at the gateway, for /status: {text}. (Its page is in the web page's list, 远程控制: no link here.)
  remoteState() {
    const r = this.remote;
    if (r) {
      const who = r.account ? ` as ${r.account}` : '';
      const pages = r.viewers ? c.dim(` · ${r.viewers} page${r.viewers === 1 ? '' : 's'} open now`) : '';
      const readOnly = r.commands.length ? '' : c.dim(' · read-only on the page (CLAUDE_PRO_REMOTE_COMMANDS=0)');
      const text = r.online ? `${c.green('online')}${who}${pages}${readOnly}` : r.registered ? c.yellow(`not connected now, retrying${who}`) : `connecting to ${r.base}${who}…`;
      return { text };
    }
    if (this.remoteStarting) return { text: 'connecting…' };
    const login = gatewayLogin(this.config.gatewayUrl, this.config.env.CLAUDE_PRO_GATEWAY_API_KEY);
    if (!login) return { text: c.dim(`offline: this computer is not logged in to the gateway ${this.config.gatewayUrl} (/login)`) };
    if (login.apiKey === this.remoteRefused) return { text: c.red('offline: the gateway refused this computer\'s key (/logout, then /login)') };
    if (!onlineEnabled(this.config.env)) return { text: c.dim('offline (CLAUDE_PRO_ONLINE=0)') };
    return { text: c.dim('offline') };
  }

  // The state the page shows below the transcript; sent whenever it changes.
  remoteStatus() {
    const cfg = this.config;
    const { model, effort } = modelInfo(cfg);
    const w = this.rateWait;
    let rateWait = null;
    if (w) {
      const label = w.label.charAt(0).toUpperCase() + w.label.slice(1);
      rateWait = {
        text: `${w.overloaded ? label : `${label} reached`}${w.polling ? ' · checking again' : ` · resumes at ${formatClock(w.resumeAt)}`}`,
        resumeIn: w.resumeAt - Date.now(),
      };
    }
    return {
      busy: this.isTurnRunning(),
      verb: this.status || (this.thinking ? 'Thinking' : this.verb),
      elapsed: this.isTurnRunning() ? Date.now() - this.turnStart : 0,
      tokens: this.turnTokens,
      aborting: Boolean(this.controller?.signal.aborted),
      rateWait,
      todos: (this.agent.todos || []).map((t) => ({ content: t.content, status: t.status })),
      queue: this.queue.map((q) => q.display ?? q.text),
      dialog: this.remoteDialog(),
      model,
      effort: effort || defaultEffort(cfg.model.id, cfg),
      title: this.sessionLabel() || path.basename(this.cwd),
      cwd: (this.agent.cwd || this.cwd).replace(/\\/g, '/'),
      name: this.peerLabel(),
      tasks: this.runtime.tasks.running().length,
      restarting: Boolean(this.restartRequest),
      asking: this.dialogs.length > 0, // a question waits for an answer (the page reminds the user of it)
      conversationId: this.store.id,
      cost: Number(this.cost.toFixed(6)),
      context: { used: this.contextUsed(), window: cfg.model.contextWindow },
      background: this.backgroundWork(),
      kind: 'terminal',
    };
  }

  // The tokens the conversation takes now, as /context counts them: what the last request used and what came
  // since, or before any request an estimate (kept until the conversation changes: the status is asked for often).
  contextUsed() {
    const a = this.agent;
    if (a.lastContextTokens) return a.contextEstimate;
    const key = `${a.messages.length}|${this.runtime.tools.length}`;
    if (this.contextGuess?.key !== key) {
      let used = 0;
      try { used = estimateTokens(this.runtime.systemPrompt()) + estimateTokens(a.toolSchemas()) + estimateTokens(a.messages); } catch { /* 0 */ }
      this.contextGuess = { key, used };
    }
    return this.contextGuess.used;
  }

  // What runs in the background: the agent's background agents and shells.
  backgroundWork() {
    const agents = this.runtime.tasks.list().map((t) => ({ id: t.id, kind: 'agent', description: t.description, status: t.status, startedAt: t.started }));
    const shells = listBackgroundShells().map((s) => ({ id: s.id, kind: 'shell', description: s.description || s.command, status: s.status, startedAt: s.startedAt || null }));
    return [...agents, ...shells];
  }

  // The dialog open in the terminal, for the page to answer (options by index: values need not be strings).
  remoteDialog() {
    const d = this.dialogs[0];
    if (!d) return null;
    d.remoteId ??= ++this.remoteDialogs;
    const base = { id: d.remoteId, title: d.title || '', question: d.question || '', body: d.body || [], markdown: d.markdown || null };
    // a question answered with typed text (TextDialog): a text box on the page, answered with {id, text}
    if (d.input) return { ...base, input: { placeholder: d.input.placeholder || '', value: d.value || '', multiline: Boolean(d.input.multiline) } };
    if (!Array.isArray(d.options)) return base;
    return { ...base, multi: Boolean(d.multi), options: d.options.map((o) => ({ label: String(o.label ?? ''), description: o.description || '', other: o.value === '__other__' })) };
  }

  // ---------------------------------------------------------------- the page's commands (see remote.js)

  // The answer to the dialog the status showed the page (remoteDialog): {id, index}, {id, indices}, {id, text,
  // indices?} (its "other" option), {id, text} (a text box) or {id, cancel: true}.
  answerDialog({ id, index, indices, text, cancel } = {}) {
    const d = this.dialogs[0];
    if (!d || d.remoteId !== id) throw new Error('That question is no longer open.');
    if (cancel) { d.resolve(d.cancelValue); return {}; }
    if (d.input) {
      if (typeof text !== 'string') throw new Error('Type an answer first.');
      d.resolve(text);
      this.screen.schedule();
      return {};
    }
    if (!Array.isArray(d.options)) throw new Error('This dialog cannot be answered from the page.');
    const valueAt = (i) => {
      const o = d.options[i];
      if (!Number.isInteger(i) || !o || o.value === '__other__') throw new Error('No such option.');
      return o.value;
    };
    if (typeof text === 'string') {
      if (!text.trim()) throw new Error('Type an answer first.');
      d.resolve(d.multi ? [...(indices || []).map(valueAt), text.trim()] : text.trim());
    } else if (d.multi) {
      if (!indices?.length) throw new Error('Choose at least one option.');
      d.resolve(indices.map(valueAt));
    } else {
      d.resolve(valueAt(index));
    }
    this.screen.schedule();
    return {};
  }

  // A message from the page: as if typed in the input box and sent (a turn, queued while one runs; /commands, !,
  // #, @session), its images as if pasted there. Images alone go as their placeholders, which is what the input box
  // sends for them.
  remoteSend(text, images) {
    const pictures = remoteImages(images);
    let value = String(text ?? '').replace(/\r\n/g, '\n');
    if (!value.trim() && pictures.length) value = pictures.map((_, i) => `[Image #${i + 1}]`).join(' ');
    if (!value.trim()) throw new Error('The message is empty.');
    // The user's rule: the page does not end or restart the session, nor update claude-pro; only the terminal does
    // (the automatic update goes on as before: it is not a command of the page). The gateway refuses these too, with
    // the same pattern and message; this holds when it does not (another gateway, or one that misses them).
    if (TERMINAL_ONLY.test(value)) throw new Error('结束、重启会话和更新 claude-pro 只能在终端里操作');
    if (this.exiting) throw new Error('The session is ending.');
    if (this.isTurnRunning() && value.trim().startsWith('/')) throw new Error('Commands wait until the current task is done (or stopped).');
    if (this.dialogs.length && !this.isTurnRunning()) throw new Error('A question is open: answer it first.');
    const queued = this.isTurnRunning();
    this.onSubmit(value, value, pictures);
    this.screen.schedule();
    return { queued };
  }

  // Esc: the turn stops, and the questions waiting for an answer are cancelled.
  remoteInterrupt() {
    for (const d of this.dialogs.splice(0)) d.resolve(d.cancelValue);
    this.interrupt();
    this.screen.schedule();
    return {};
  }

  // For the page's model and effort menus: what /model and /effort offer (in plain text; the page sends /model
  // <value> or /effort <value>), what is chosen (`current`), and the model and effort in use, as the status says.
  async remoteOptions() {
    const cfg = this.config;
    const [models, efforts] = await Promise.all([modelChoices(cfg), effortChoices(cfg)]);
    const chosen = cfg.modelOverride || 'default';
    const current = models.find((o) => o.value === chosen) || models.find((o) => o.value !== 'default' && cfg.resolveModel(o.value).id === cfg.model.id);
    const effortChosen = cfg.effortOverride || 'default';
    const { effort } = modelInfo(cfg);
    return {
      model: cfg.model.id,
      models: models.map((o) => ({ ...o, ...(o === current ? { current: true } : {}) })),
      effort: effort || defaultEffort(cfg.model.id, cfg),
      efforts: efforts.options.map((o) => ({ ...o, ...(o.value === effortChosen ? { current: true } : {}) })),
    };
  }

  // For the page's input box: what the input box here would suggest (/commands, @files and @sessions), in plain
  // text, without anything happening here. Sessions on the other computers are asked for first when the list is old.
  async remoteSuggest(body = {}) {
    const text = String(body.text ?? '');
    const cursor = Number.isInteger(body.cursor) ? Math.max(0, Math.min(text.length, body.cursor)) : text.length;
    if (/(^|\s)@[^\s@"]*$/u.test(text.slice(0, cursor)) && this.remote?.online && Date.now() - this.remotePeersAt > 10_000) {
      await Promise.race([this.refreshRemotePeers(), new Promise((r) => setTimeout(r, 3000))]);
    }
    const found = this.suggest(text, cursor, { quiet: true });
    if (!found?.items?.length) return { items: [] };
    const plain = (s) => (s == null ? '' : stripAnsi(String(s)));
    return {
      items: found.items.slice(0, 50).map((it) => ({ value: it.value, label: plain(it.label ?? it.value), description: plain(it.description), submitOnEnter: Boolean(it.submitOnEnter), noSpace: Boolean(it.noSpace) })),
      from: found.from,
      to: found.to,
    };
  }

  // For the page's directory browser (/cd): the directories in `path` ("": this session's working directory), with
  // the drives, the home directory and where sessions ran lately.
  remoteList(body = {}) {
    const wanted = typeof body.path === 'string' && body.path.trim() ? body.path : (this.agent.cwd || this.cwd);
    return listDirectory(wanted, {
      recent: () => {
        if (!this.recentDirs || Date.now() - this.recentDirs.at > 30_000) this.recentDirs = { at: Date.now(), list: recentDirectories({ projects: path.join(CONFIG_DIR, 'projects') }) };
        return this.recentDirs.list;
      },
    });
  }

  // For the page's "the whole output": the full result of the tool call `id` ({text, truncated, running?}, at most
  // 1 MB of UTF-8): the file it was saved to when it was too long for the conversation or cleared from it later,
  // and what it printed so far while it runs.
  remoteOutput({ id } = {}) {
    if (typeof id !== 'string' || !id) throw new Error('Which tool call?');
    const MAX = 1024 * 1024;
    const cut = (text, running = false) => {
      const buf = Buffer.from(text, 'utf8');
      const truncated = buf.length > MAX;
      // (a character cut at the end decodes as U+FFFD, which is then dropped)
      const shown = truncated ? buf.subarray(0, MAX).toString('utf8').replace(/\ufffd$/, '') : text;
      return { text: shown, truncated, ...(running ? { running } : {}) };
    };
    let result = null;
    for (const m of this.agent.messages) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content) if (b.type === 'tool_result' && b.tool_use_id === id) result = b;
    }
    if (!result) {
      const live = this.active.find((e) => e.tu?.id === id);
      if (live) return cut(live.progressAll?.() ?? String(live.progress || ''), true);
      throw new Error('There is no such tool call in this conversation.');
    }
    let text = typeof result.content === 'string' ? result.content
      : (Array.isArray(result.content) ? result.content : []).map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
    // saved whole in the project's tool-results (a large result, a Bash output, a result cleared after a pause)
    const saved = /(?:saved to:?|saved at)\s+(\S+?\.txt)\b/.exec(text)?.[1];
    const results = path.join(CONFIG_DIR, 'projects');
    if (saved && path.resolve(saved).startsWith(results + path.sep) && path.resolve(saved).includes(`${path.sep}tool-results${path.sep}`)) {
      try { text = fs.readFileSync(saved, 'utf8'); } catch { /* the reference is what there is */ }
    }
    return cut(text);
  }

  // ---------------------------------------------------------------- restarting (see restart.js)

  // What a restart would kill: agents and shells that are still running in the background.
  // Something is going on that an update must not cut into: a turn, a question waiting for an answer, messages
  // waiting to be sent, background agents and shells.
  working() {
    return Boolean(this.isTurnRunning() || this.dialogs.length || this.queue.length || this.restartBlockers().length);
  }

  restartBlockers() {
    const found = [];
    for (const t of this.runtime.tasks.running()) found.push(`background agent ${t.id} "${t.description}"`);
    for (const s of listBackgroundShells()) if (s.status === 'running') found.push(`background shell ${s.id} (${String(s.command).slice(0, 40)})`);
    return found;
  }

  // Restart as soon as nothing is running: at once when idle, otherwise when the current turn ends (the
  // turn that asked for it still has to be answered and saved). `continueTurn`: the model gets a note in
  // the new process and goes on by itself. Returns {ok, message}.
  // `cwd`: the session goes on in that directory (/cd).
  requestRestart({ reason = '', then = '', continueTurn = false, force = false, cwd = null } = {}) {
    if (!canRestart()) return { ok: false, message: 'This session cannot restart itself.' };
    const now = Date.now();
    const recent = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (recent.length >= MAX_RESTARTS && !cwd) {
      return { ok: false, message: `The program was restarted ${recent.length} times in the last ${Math.round(RESTART_WINDOW_MS / 60_000)} minutes. That looks like a loop: stop restarting and tell the user what is going on.` };
    }
    const blockers = this.restartBlockers();
    if (blockers.length && !force) return { ok: false, message: `${cwd ? 'Changing the directory restarts the session, which would stop' : 'A restart would kill'}: ${blockers.join('; ')}.` };
    this.restartRequest = { reason, then, continueTurn, cwd };
    this.screen.schedule();
    if (!this.isTurnRunning()) this.restartNow();
    return { ok: true };
  }

  // Leave the state of the session for the next process and go; the supervisor starts it again.
  restartNow() {
    const request = this.restartRequest || {};
    this.restartRequest = null;
    const cfg = this.config;
    const now = Date.now();
    // /cd: the conversation's file goes along to the new directory's project (see moveSession); the old one is
    // removed once the next process is sure to find the new one
    let moved = null;
    if (request.cwd) {
      try { moved = moveSession(this.store.file, this.store.id, request.cwd); } catch (e) { this.notice(`Could not change the directory: ${e.message}`, 'warn'); return; }
    }
    const state = {
      at: now,
      reason: request.reason || '',
      continueWith: request.continueTurn ? restartNote(request) : '',
      cwd: request.cwd || this.cwd,
      changedDirectory: Boolean(request.cwd),
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
      // a /cd is the user's: it does not count towards the restarts that look like a loop
      restarts: [...this.restarts.filter((t) => now - t < RESTART_WINDOW_MS), ...(request.cwd ? [] : [now])],
      // a name given with /rename or --name stays; the one taken from the directory follows it
      peerName: request.cwd && !this.customTitle ? null : this.peers?.name || this.sessionName,
      peerId: this.peers?.id,
      remote: this.remote?.handoff() || null,
    };
    try {
      writeRestartState(state);
    } catch (e) {
      moved?.undo();
      this.notice(`Could not restart: ${e.message}`, 'warn');
      return;
    }
    moved?.commit();
    this.exit(RESTART_EXIT_CODE, { restart: true });
  }

  // /cd: the session goes on in `dir` (an existing directory). It restarts there, so that everything that belongs to
  // a project is that directory's: its settings and CLAUDE.md, its memory, the system prompt's directory and git
  // state, the @ file index, the input history and where the conversation is kept. The conversation, the remote
  // page's id and a name given with /rename stay. Returns {ok, message}.
  changeDirectory(dir) {
    if (this.isTurnRunning()) return { ok: false, message: 'Wait for the current task to finish (or press Esc) before changing the directory.' };
    if (!canRestart()) return { ok: false, message: 'This session cannot change its directory: that restarts it, and it was not started by the claude-pro launcher. Start claude-pro in that directory instead.' };
    return this.requestRestart({ reason: `working directory ${dir}`, cwd: dir });
  }

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
    if (resumable) {
      this.loadSession(state.sessionFile, state.sessionId, { quiet: true });
      if (Array.isArray(state.todos)) this.agent.todos = state.todos;
      if (state.checkpoints) this.runtime.checkpoints.adopt(state.checkpoints);
    }
    if (typeof state.draft === 'string' && state.draft) this.editor.restoreDraft(state.draft, state.draftCursor, state.draftParts);
    // Fullscreen starts on an empty screen: without what the process before showed (an older version, or one
    // that ran classic), the conversation is drawn again from the session.
    if (this.screen.full && resumable && !Array.isArray(state.screenHistory)) this.printTranscript(this.agent.messages.slice(-80));
    if (state.changedDirectory) {
      // /cd: the line it answers with, here and on the remote page (which starts again from the conversation)
      const line = `Working directory: ${this.cwd}`;
      this.screen.log(line, '');
      this.seedOutput = [line];
      return;
    }
    this.screen.log(c.dim(`↻ Restarted${state.reason ? `: ${state.reason}` : ''}${state.continueWith ? ' · continuing' : ''}`), '');
  }

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
  }

  // Follow the program's own source: once a turn is over (or at once when idle) a change to it is loaded by
  // a restart, if the new code starts.
  startSourceWatch() {
    if (!canRestart() || /^(0|false|no|off)$/i.test(this.config.env.CLAUDE_PRO_AUTO_RESTART || '')) return;
    this.sourceWatch = watchSource(INSTALL_DIR, (file) => {
      this.sourceChanged = file || true;
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
  }

  async maybeAutoReload() {
    if (!this.sourceChanged || this.updating || this.reloading || this.isTurnRunning() || this.exiting || this.restartRequest || this.dialogs.length || this.queue.length) return;
    if (this.skipAutoReload) { this.skipAutoReload = false; return; } // the user just interrupted: not now
    if (this.restartBlockers().length) return; // looked at again whenever the program is next idle
    const changed = this.sourceChanged;
    this.sourceChanged = null;
    this.reloading = true;
    this.flash(this.updateRestart ? `Updated to ${this.updateRestart}: checking it starts, then restarting…` : 'Source changed: checking the new code…');
    let check;
    try { check = await runSelfCheck(); } finally { this.reloading = false; }
    if (this.exiting) return;
    if (!check.ok) {
      this.notice(`The program's source changed but the new code does not start, so it was not restarted:\n${check.output.split('\n').slice(0, 12).join('\n')}\nFix it; the restart follows by itself (or run /restart).`, 'warn');
      return;
    }
    if (this.isTurnRunning() || this.dialogs.length) { this.sourceChanged = changed; return; } // something started meanwhile: later
    this.requestRestart({ reason: this.updateRestart ? `updated to ${APP_NAME} ${this.updateRestart}` : 'source changed', force: true });
  }

  // A newer version on npm (see updater.js): it is installed once no session of this machine is working, and then
  // loaded by a restart (this session's; the others restart when they see the files change). `force`: the /update
  // command, which also says when there is nothing to do. `quiet`: the periodic check, which says nothing when an
  // install fails (it is tried again in a minute).
  async autoUpdate({ force = false, quiet = false } = {}) {
    if (this.updating) { if (force) this.notice(`${APP_NAME} ${this.updating} is being installed.`); return; }
    let r;
    try {
      r = await checkForUpdate({ force, env: { ...process.env, ...this.config.env } });
    } catch (e) {
      r = { status: 'failed', error: e.message };
    }
    if (this.exiting) return;
    if (r.status === 'available') {
      if (this.pendingUpdate !== r.version) {
        this.pendingUpdate = r.version;
        this.updateQuiet = quiet;
        this.screen.schedule();
      }
      if (force && this.working()) this.notice(`${APP_NAME} ${r.version} is out: it is installed as soon as this session's work is done.`);
      await this.maybeInstallUpdate({ force });
    } else if (r.status === 'installed') {
      if (force || this.updateRestart !== r.version) this.notice(`${APP_NAME} ${r.version} is installed already; this session restarts to load it ${this.working() ? 'once its work is done' : 'now'}.`);
      this.updateRestart = r.version;
      if (canRestart()) { this.sourceChanged ||= true; if (!this.isTurnRunning()) this.maybeAutoReload(); }
    } else if (r.status === 'failed') {
      if (force || (r.version && !quiet)) this.notice(`Could not update ${APP_NAME}${r.version ? ` to ${r.version}` : ''}: ${r.error}`, 'warn');
    } else if (force) {
      this.notice(r.status === 'dev' ? `This copy runs from a source checkout (${INSTALL_DIR}): update it with git.` : `${APP_NAME} ${VERSION} is the latest version.`);
    }
  }

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
      if (canRestart()) {
        this.notice(`${APP_NAME} was updated to ${r.version} (from ${VERSION}); restarting to load it. The conversation carries over.`);
        this.sourceChanged = true;
        this.maybeAutoReload();
      } else {
        this.notice(`${APP_NAME} was updated to ${r.version}: restart the program to use it.`);
      }
      return;
    }
    if (force || !this.updateQuiet) this.notice(`Could not update ${APP_NAME} to ${version}: ${r.error}`, 'warn');
  }

  printWelcome() {
    const cfg = this.config;
    const w = Math.min(this.width - 1, 76);
    const inner = w - 4;
    const row = (s) => c.claude('│') + ' ' + padEnd(truncate(s, inner), inner) + ' ' + c.claude('│');
    const model = cfg.model;
    const lines = [
      c.claude('╭' + '─'.repeat(w - 2) + '╮'),
      row(`${c.claude('✻')} Welcome to ${c.bold(APP_NAME)}! ${c.dim(`v${VERSION} · a command line coding agent`)}`),
      row(''),
      row(c.dim('  /help for help, /status for your current setup')),
      row(''),
      row(c.dim(`  cwd:    ${this.cwd}`)),
      row(c.dim(`  model:  ${model.label}${cfg.effort ? ` · effort ${cfg.effort}` : ''} · ${formatTokens(model.contextWindow)} context`)),
      row(c.dim(`  backend: ${cfg.endpointLabel}`)),
      c.claude('╰' + '─'.repeat(w - 2) + '╯'),
    ];
    lines.push('', c.dim(' Full access: every tool runs immediately, nothing is ever asked. File edits are checkpointed;'), c.dim(' /rewind puts files and/or the conversation back (shell-command changes are not tracked).'));
    if (!gatewayLogin(cfg.gatewayUrl, cfg.env.CLAUDE_PRO_GATEWAY_API_KEY)) lines.push('', c.yellow(` ⚠ Not logged in to the gateway ${cfg.gatewayUrl}. Run /login.`));
    const mcp = this.runtime.mcp.status();
    if (mcp.length) {
      const ok = mcp.filter((m) => m.status === 'connected').length;
      lines.push(c.dim(` MCP: ${ok}/${mcp.length} servers connected${ok < mcp.length ? ' · /mcp for details' : ''}`));
    }
    lines.push('', c.dim(' Tips for getting started:'), c.dim(' 1. Ask questions, edit files, or run commands'), c.dim(' 2. Be as specific as you would with another engineer for the best results'), c.dim(` 3. Run /init to create a CLAUDE.md file with instructions for ${APP_NAME}`), '');
    this.logLocal(lines);
  }

  // ---------------------------------------------------------------- input

  // Fullscreen (see screen.js) unless CLAUDE_PRO_TUI=default, as Claude Code's /tui: the input box fixed at the
  // bottom of the window, the conversation scrolled inside the program. Not in the tests that drive the App.
  fullscreenWanted() {
    const mode = String(this.config.env.CLAUDE_PRO_TUI || (this.driven ? 'default' : 'fullscreen')).toLowerCase();
    return mode === 'fullscreen' && this.stdout.isTTY !== false;
  }

  // Fullscreen: the wheel scrolls the conversation (3 rows a notch); a drag,
  // a double or a triple click selects text. Selection is copied only with Ctrl+C.
  // In the input box a click moves the cursor and a drag selects its text (see Editor.mouse).
  onMouse(m) {
    if (!this.screen.full || this.exiting) return;
    if (m.button & 64) {
      if (m.button & 128) return;
      const speed = 3;
      this.screen.scrollBy(m.button & 1 ? -speed : speed);
      return;
    }
    // Right-click is intentionally inert. Clipboard operations use Ctrl+C and Ctrl+V only.
    const had = this.screen.selection;
    const hadInput = this.editor.selection;
    const r = this.screen.mouse(m);
    if (r?.input) this.editor.mouse(r.input);
    else if ((m.button & 3) === 0 && !(m.button & 32) && !m.release) this.editor.clearSelection(); // a press elsewhere
    if ((this.screen.selection && this.screen.selection !== had) || (this.editor.selection && this.editor.selection !== hadInput)) {
      this.flashMessage = null; // the footer says what a selection takes
      this.screen.schedule();
    }
  }

  // Quote what is selected in the conversation in the message being written, as ChatGPT's "Ask ChatGPT" does:
  // ctrl+q (alt+q where the terminal keeps ctrl+q), as the footer says while there is a selection. The box shows
  // "[Quote #1 +12 lines]"; the model gets the text and the line of the conversation it is under (see
  // Editor.insertQuote), so that it knows which part, and which file or command, the question is about.
  quoteSelection() {
    if (!this.screen.full) { this.flash('Quoting works in fullscreen (/tui fullscreen): select text with the mouse, then ctrl+q', 'warn'); return; }
    const quote = this.screen.selectionQuote();
    if (!quote?.text.trim()) { this.flash('Select part of the conversation first (drag over it, or double/triple-click), then ctrl+q', 'warn'); return; }
    if (this.dialogs.length) { this.flash('Answer the open question first, then quote', 'warn'); return; }
    if (this.finder) this.closeFind();
    this.screen.clearSelection();
    const label = this.editor.insertQuote(quote.text, quote.source);
    this.flash(`${label}${quote.source ? ` from ${quote.source}` : ''}: type your question below it`);
  }

  copyText(text) {
    writeClipboard(text).then((ok) => {
      if (ok) this.flash(`Copied ${text.length.toLocaleString()} characters to the clipboard`);
      else this.flash('Could not copy: no clipboard tool found', 'warn');
    });
  }

  clipboardEditor() {
    const dialog = this.dialogs[0];
    if (dialog) return dialog.editor || dialog.other || null;
    return this.finder ? null : this.editor;
  }

  insertFindText(text) {
    const f = this.finder;
    const clean = String(text ?? '').replace(/[\r\n\t]+/g, ' ');
    if (!f || !clean) return;
    if (f.selected) {
      f.text = clean;
      f.cursor = clean.length;
      f.selected = false;
    } else {
      f.text = f.text.slice(0, f.cursor) + clean + f.text.slice(f.cursor);
      f.cursor += clean.length;
    }
    this.screen.setFind(f.text);
  }

  // Pasted text into the input box, the open dialog's text field or the find box.
  insertPastedText(text, target = this.clipboardEditor()) {
    const clean = String(text || '').replace(/\x1b\[20[01]~/g, '');
    if (!clean) return;
    if (target) target.insertPaste(clean);
    else if (this.finder) this.insertFindText(clean);
    this.screen.schedule();
  }

  // Read the system clipboard: an image first, else its text. Each read starts PowerShell (about a second), so it
  // is only done when the terminal had nothing to paste (alt+v, ctrl+v as a key, an empty bracketed paste).
  pasteClipboard(target = this.clipboardEditor()) {
    if (this.readingClipboard || this.exiting) return;
    if (!target && !this.finder) return; // selection dialogs have no text field to paste into
    this.readingClipboard = true;
    this.flash('Reading clipboard…');
    const allowImage = Boolean(target?.insertImage);
    const image = allowImage
      ? readClipboardImage().catch((e) => ({ image: null, error: e.message }))
      : Promise.resolve({ image: null });
    image.then((r) => {
      if (r.image && target) {
        const label = target.insertImage(r.image);
        const size = r.image.width ? `${r.image.width}×${r.image.height}, ` : '';
        this.flash(`${label} attached (${size}${formatTokens(r.image.bytes).replace(/k$/, 'KB')})`);
        return;
      }
      return readClipboardText().then((text) => {
        if (this.exiting) return;
        if (text) this.insertPastedText(text, target);
        else if (r.error) this.flash(`Could not read the clipboard: ${r.error}`, 'warn');
      });
    }).catch((e) => {
      if (!this.exiting) this.flash(`Could not read the clipboard: ${e.message}`, 'warn');
    }).finally(() => {
      this.readingClipboard = false;
      this.screen.schedule();
    });
  }

  onKey(str, key) {
    if (this.exiting) return;
    // Terminals paste (ctrl+v in Windows Terminal and VS Code) as bracketed paste: readline reports paste-start/end
    // and emits the text as ordinary keys between them. That text goes in at once. A paste with no text is what a
    // terminal sends for an image on the clipboard, which only the system clipboard has (alt+v reads it on demand).
    if (this.bracketedPaste) {
      if (key.name === 'paste-end' || key.sequence === '\x1b[201~') {
        const raw = this.bracketedPaste.raw;
        this.bracketedPaste = null;
        if (raw) this.insertPastedText(raw);
        else this.pasteClipboard();
      } else if (key.name === 'return' || key.name === 'enter') {
        // Keep CRLF intact; Editor.insertPaste normalizes line endings once.
        this.bracketedPaste.raw += str || '\n';
      } else if (str) {
        this.bracketedPaste.raw += str;
      }
      return;
    }
    if (this.screen.full) {
      const half = Math.max(1, Math.floor((this.screen.lastArea || this.screen.height) / 2));
      if (key.name === 'pageup') { this.screen.scrollBy(half); return; }
      if (key.name === 'pagedown') { this.screen.scrollBy(-half); return; }
      if (key.ctrl && key.name === 'home') { this.screen.scrollBy('top'); return; }
      if (key.ctrl && key.name === 'end') { this.screen.scrollBy('bottom'); return; }
      // ctrl+f looks for what is selected, if anything
      if (key.ctrl && key.name === 'f' && !this.dialogs.length) {
        const seed = this.screen.selection ? this.screen.selectedText() : '';
        this.screen.clearSelection();
        this.openFind(seed);
        return;
      }
      // A selection: ctrl+c copies it (and does not interrupt), esc only clears it, any other key clears it and
      // then does what it does.
      if (this.screen.selection) {
        if (key.ctrl && key.name === 'c') { this.copyText(this.screen.selectedText()); this.screen.clearSelection(); return; }
        if ((key.ctrl || key.meta) && key.name === 'q') { this.quoteSelection(); return; }
        this.screen.clearSelection();
        if (key.name === 'escape') return;
      }
    }
    // A selection in the input box (see Editor.mouse), the same way: ctrl+c copies it (and neither interrupts nor
    // clears the message), esc only clears it, any other key clears it and then does what it does.
    if (this.editor.selection) {
      const shown = !this.dialogs.length && !this.finder; // else the box is not on screen, and the key is not for it
      if (shown && key.ctrl && key.name === 'c') { this.copyText(this.editor.selectedText()); this.editor.clearSelection(); return; }
      this.editor.clearSelection();
      if (shown && key.name === 'escape') return;
    }
    if (key.name === 'paste-start' || key.sequence === '\x1b[200~') {
      this.bracketedPaste = { raw: '' };
      return;
    }
    if (key.ctrl && key.name === 'c' && this.finder && !this.dialogs.length) { this.closeFind(); return; } // not the hidden input's text
    if (key.ctrl && key.name === 'c') { this.onCtrlC(); return; }
    if ((key.ctrl || key.meta) && key.name === 'v') { this.pasteClipboard(); return; } // alt+v: the clipboard's image
    if ((key.ctrl || key.meta) && key.name === 'q') { this.quoteSelection(); return; } // nothing selected: says how
    const dialog = this.dialogs[0];
    if (dialog) {
      dialog.handleKey(str, key);
      this.screen.schedule();
      return;
    }
    if (key.ctrl && key.name === 'f') { this.openFind(); return; }
    if (this.finder) { this.findKey(str, key); this.screen.schedule(); return; }
    if (key.ctrl && key.name === 'o') {
      this.verbose = !this.verbose;
      this.notice(this.verbose ? 'Verbose mode on: showing thinking and full tool output' : 'Verbose mode off', 'info');
      return;
    }
    if (key.ctrl && key.name === 't') { this.showTodos = !this.showTodos; this.screen.schedule(); return; }
    if (key.ctrl && key.name === 'l') { if (this.screen.full) this.screen.repaint(); else this.screen.clearScreen(); return; }
    if (key.ctrl && key.name === 'd' && !this.editor.text) { this.keyboardExit(); return; }
    // esc closes an open completion list first (the editor does that), and only then stops the turn
    if (key.name === 'escape' && this.isTurnRunning() && !this.editor.suggestions) { this.interrupt(); return; }
    this.exitArmed = 0;
    this.editor.handleKey(str, key);
    this.screen.schedule();
  }

  // ctrl+c twice, ctrl+d: the end of the session.
  keyboardExit() {
    this.exit(0);
  }

  onCtrlC() {
    if (this.dialogs.length) {
      // Cancel the dialog and interrupt the run.
      for (const d of this.dialogs.splice(0)) d.resolve(d.cancelValue);
      this.interrupt();
      return;
    }
    if (this.isTurnRunning()) { this.interrupt(); return; }
    if (this.editor.text) { this.editor.discard(); this.screen.schedule(); return; }
    if (Date.now() - this.exitArmed < 1500) { this.keyboardExit(); return; }
    this.exitArmed = Date.now();
    this.screen.schedule();
    setTimeout(() => this.screen.schedule(), 1600);
  }

  interrupt() {
    if (!this.controller || this.controller.signal.aborted) return;
    this.controller.abort();
    this.screen.schedule();
  }

  // `quiet`: do not print the transcript (a restart: it is still on screen).
  suggest(text, cursor, { quiet = false } = {}) {
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
    // One `@` namespace serves both files and sessions. A quoted token is a file path; session names are
    // never quoted because cleanName() removes spaces from them.
    const before = text.slice(0, cursor);
    const m = /(^|\s)@(?:"([^"@]*)|([^\s@"]*))$/.exec(before);
    if (!m) return null;
    const quoted = m[2] !== undefined;
    const q = quoted ? m[2] : m[3];
    const fileQuery = q.replace(/^\.\/+/, '');
    const filePrefix = q.startsWith('./') ? './' : '';
    const files = this.fileIndex.search(fileQuery);
    const peerResult = quoted ? null : this.peerSuggestions(q, cursor, m.index === 0 && !m[1], { quiet: true });
    const peers = peerResult?.items || [];
    const peerRefs = new Set(peers.map((item) => item.value.slice(1)));
    // A name with spaces has to be quoted for the mention to be read back as one file. A directory
    // leaves the quote open, so that completion goes on inside it. When a file and session have the
    // same name, the file completion uses ./ so the session-priority submit rule cannot misroute it.
    const fileItems = files.map((f) => {
      const conflict = !quoted && !filePrefix && peerRefs.has(f);
      const ref = conflict ? `./${f}` : `${filePrefix}${f}`;
      const value = quoted || /\s/.test(f) ? (f.endsWith('/') ? `@"${ref}` : `@"${ref}"`) : '@' + ref;
      return {
        value,
        label: conflict ? `@./${f}` : f,
        description: f.endsWith('/') ? 'directory' : 'file',
        noSpace: f.endsWith('/'),
      };
    });
    const items = [...peers, ...fileItems];
    if (!items.length) {
      if (!q && m.index === 0 && !m[1] && !quiet) this.flash(this.remote ? 'No file or session is available here or online at the gateway' : 'No file or other session is available on this computer (/login to the gateway reaches your other computers)');
      return null;
    }
    return { items, from: cursor - q.length - (quoted ? 2 : 1), to: cursor };
  }

  peerSuggestions(q, cursor, atStart = true, { quiet = false } = {}) {
    if (this.remote?.online && Date.now() - this.remotePeersAt > 10_000) {
      this.refreshRemotePeers().then(() => {
        if (!/(^|\s)@(?:"[^"@]*|[^\s@"]*)$/u.test(this.editor.text.slice(0, this.editor.cursor))) return;
        this.editor.refreshSuggestions();
        this.screen.schedule();
      });
    }
    const items = this.peerSuggestionItems(q);
    if (!items.length) {
      if (!q && atStart && !quiet) this.flash(this.remote ? 'No other session is running here or online at the gateway' : 'No other session is running on this computer (/login to the gateway reaches your other computers)');
      return null;
    }
    return { items, from: cursor - q.length - 1, to: cursor };
  }

  peerSuggestionItems(q) {
    const lq = q.toLowerCase();
    return [
      ...(this.peers?.peers() || []).filter((p) => p.name.toLowerCase().startsWith(lq))
        .map((p) => ({ value: '@' + p.name, label: `@${p.name}`, description: `session · this computer · ${displayPath(p.cwd, this.cwd)}` })),
      ...this.remotePeers.filter((p) => [p.label, p.name, p.machine].some((v) => v.toLowerCase().startsWith(lq)))
        .map((p) => ({ value: '@' + p.label, label: `@${p.label}`, description: `session · ${p.machine} · ${p.cwd}${p.busy ? ' · busy' : ''}` })),
    ];
  }

  // `display`: how the message shows in the transcript when that is not `value` (a quote shows its first lines).
  onSubmit(value, raw, images = [], display = undefined) {
    const text = value.trim();
    if (!text) { this.screen.schedule(); return; }
    if (this.screen.scrolledUp) this.screen.scrollBy('bottom'); // what was sent, and what comes of it, is in view
    appendHistory(this.cwd, raw);
    if (this.sendTypedToPeer(text)) return;
    if (this.isTurnRunning()) {
      if (text.startsWith('/')) { this.notice('Wait for the current task to finish (or press Esc) before running commands.', 'warn'); return; }
      this.queue.push({ text: value, images, ...(display ? { display } : {}) });
      this.screen.schedule();
      return;
    }
    if (images.length) { this.startTurn(value, { images, display }); return; }
    if (text === '?') { this.screen.log(this.shortcutsHelp()); return; }
    if (raw.startsWith('!')) { this.runBashMode(value.slice(1).trim()); return; }
    if (raw.startsWith('#')) { this.addMemory(value.slice(1).trim()); return; }
    if (text.startsWith('/')) {
      const [name, ...rest] = text.slice(1).split(/\s+/);
      const args = text.slice(1 + name.length).trim();
      const cmd = this.commands.get(name.toLowerCase()) || [...this.commands.values()].find((x) => x.aliases?.includes(name.toLowerCase()));
      if (cmd) {
        this.echoUser(text);
        Promise.resolve(cmd.run(args, rest)).catch((e) => this.logError(e)).finally(() => this.screen.schedule());
        return;
      }
      if (!/^\/[\w:-]+$/.test(text.split(/\s/)[0])) { this.startTurn(value, { display }); return; } // e.g. a path like /usr/bin
      this.notice(`Unknown command: /${name}. Type /help for the list of commands.`, 'warn');
      return;
    }
    this.startTurn(value, { display });
  }

  // `@name message`: the message goes to that session, as a task for it. A session on another computer of the
  // gateway account: `@machine/name message`, or `@machine message` when that computer runs one session. A known
  // file wins only when no session matches; use `@./name` to force a file when the names collide.
  sendTypedToPeer(text) {
    // Quoted @ tokens are file syntax; session names are clean and never contain spaces.
    if (/^@"[^"]*"(?:\s+[\s\S]*)?$/u.test(text)) return false;
    const m = /^@(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
    if (!m) return false;
    const task = m[2]?.trim();
    const found = resolvePeer(this.peers?.peers() || [], this.remotePeers, m[1], { ids: false });
    const file = this.mentionedFile(m[1]);
    const pathLike = /^(?:\.\.?[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(m[1]);
    // A plain @file (including a file followed by ordinary prose) remains a normal prompt. A matching
    // session has priority at the beginning of a line, and an unknown name with a task is allowed to
    // fall through to sendToPeer(), which refreshes the remote list before reporting an error.
    if (!found.peer && !found.ambiguous && (file || pathLike)) return false;
    if (!found.peer && !found.ambiguous && !task) return false;
    if (!task) { this.notice('Type the task after the name: @name task (/peers lists the sessions).', 'warn'); return true; }
    this.echoUser(text);
    if (found.ambiguous) { this.notice(found.error, 'warn'); return true; }
    this.sendToPeer(found.peer || m[1], task).then(
      ({ peer }) => {
        const where = peer.remote ? `on ${peer.machine}: ${peer.cwd}` : displayPath(peer.cwd, this.cwd);
        this.screen.log(c.dim(`  ⎿  Sent to @${peer.label || peer.name} (${where}); its answer will be shown here`), '');
      },
      (e) => this.notice(e.message, 'warn'),
    );
    return true;
  }

  shortcutsHelp() {
    const rows = [
      ['! for bash mode', 'double tap esc to clear input'],
      ['/ for commands', 'ctrl + o to toggle verbose output'],
      ['@ for files and sessions', 'ctrl + f to find in the conversation'],
      ['PgUp/PgDn, wheel to scroll', 'ctrl + home/end to the top/bottom'],
      ['# to memorize', 'ctrl + t to toggle todos'],
      ['\\⏎ or alt+⏎ for newline', 'ctrl + l to redraw, ctrl + d to exit'],
      ['ctrl + c to copy selection', 'ctrl + q to quote it in your message'],
      ['ctrl + v to paste text or an image', ''],
    ];
    return rows.map(([a, b]) => c.dim('  ' + padEnd(a, 30) + b));
  }

  // ---------------------------------------------------------------- finding in the conversation (ctrl+f)
  //
  // As in VS Code: a box takes the input box's place, the conversation shows the matches as they are typed, the
  // current one apart, and goes to it. In a conversation the newest matter most: the first one shown is the
  // nearest above the bottom of the view, enter (or ↑) goes on to older ones, shift+enter (or ↓) back to newer
  // ones, round from either end. Esc closes the box and leaves the view where it is. The text typed last comes
  // back selected (typing replaces it), or what is selected with the mouse. Fullscreen only: in the classic
  // renderer the conversation is in the terminal's own scrollback.

  openFind(seed = '') {
    if (!this.screen.full) { this.flash('ctrl+f finds in the conversation in fullscreen (/tui); here use the terminal\'s own find', 'warn'); return; }
    if (this.finder && !seed.trim()) { this.finder.selected = Boolean(this.finder.text); this.screen.schedule(); return; } // open: select what is typed
    const text = (seed.split('\n').find((l) => l.trim()) || '').trim() || this.lastFind || '';
    if (!this.finder) this.screen.openFind();
    this.finder = { text, cursor: text.length, selected: Boolean(text), pasting: null };
    this.screen.setFind(text);
    this.screen.schedule();
  }

  closeFind() {
    if (!this.finder) return;
    this.lastFind = this.finder.text;
    this.finder = null;
    this.screen.closeFind();
    this.screen.schedule();
  }

  findKey(str, key) {
    const f = this.finder;
    const name = key.name;
    const edit = (text, cursor) => {
      Object.assign(f, { text, cursor, selected: false });
      this.screen.setFind(text);
    };
    const insert = (s) => {
      const t = s.replace(/[\r\n\t]+/g, ' ');
      if (!t) return;
      if (f.selected) edit(t, t.length);
      else edit(f.text.slice(0, f.cursor) + t + f.text.slice(f.cursor), f.cursor + t.length);
    };
    if (name === 'paste-start') { f.pasting = ''; return; }
    if (f.pasting !== null) {
      if (name === 'paste-end') { const t = f.pasting.split(/\r?\n/).find((l) => l.trim()) || ''; f.pasting = null; insert(t.trim()); }
      else if (name === 'return' || name === 'enter') f.pasting += '\n';
      else if (str) f.pasting += str;
      return;
    }
    if (name === 'escape') { this.closeFind(); return; }
    const back = (name === 'return' && (key.meta || key.shift)) || name === 'enter' || key.sequence === '\x1b[13;2u' || (name === 'f3' && key.shift);
    if (back || name === 'down' || (key.ctrl && name === 'n')) { f.selected = false; this.screen.findStep(-1); return; }
    if (name === 'return' || name === 'f3' || name === 'up' || (key.ctrl && name === 'p')) { f.selected = false; this.screen.findStep(1); return; }
    const chars = [...f.text.slice(0, f.cursor)];
    if (name === 'backspace') {
      if (f.selected) edit('', 0);
      else if (chars.length) { const keep = chars.slice(0, -1).join(''); edit(keep + f.text.slice(f.cursor), keep.length); }
      return;
    }
    if (name === 'delete') {
      if (f.selected) edit('', 0);
      else if (f.cursor < f.text.length) { const next = [...f.text.slice(f.cursor)].slice(1).join(''); edit(f.text.slice(0, f.cursor) + next, f.cursor); }
      return;
    }
    if (key.ctrl && name === 'u') { edit('', 0); return; }
    if (name === 'left') { f.selected = false; f.cursor = chars.slice(0, -1).join('').length; return; }
    if (name === 'right') { f.selected = false; f.cursor = Math.min(f.text.length, f.cursor + ([...f.text.slice(f.cursor)][0]?.length || 0)); return; }
    if (name === 'home' || (key.ctrl && name === 'a')) { f.selected = false; f.cursor = 0; return; }
    if (name === 'end' || (key.ctrl && name === 'e')) { f.selected = false; f.cursor = f.text.length; return; }
    if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) insert(str);
  }

  // The find box, in the input box's place: what is typed (selected: in reverse video), and how many matches.
  renderFind(width) {
    const f = this.finder;
    const boxW = Math.max(20, width - 1);
    const textW = boxW - 6;
    const s = this.screen.findStatus();
    const count = !f.text ? '' : s?.total ? `${s.index + 1}/${s.total}` : c.red('No results');
    const title = { left: 'Find in the conversation', right: count };
    // the part of the text that fits, the cursor in it
    let before = f.text.slice(0, f.cursor);
    while (before && stringWidth(before) > textW - 1) before = [...before].slice(1).join('');
    const shown = truncate(before + f.text.slice(f.cursor), textW, '');
    const content = f.selected && shown ? c.inverse(shown) : shown;
    const lines = [
      topBorder(boxW, c.yellow, title),
      c.yellow('│') + ' ' + c.yellow('⌕') + ' ' + padEnd(content, textW) + ' ' + c.yellow('│'),
      c.yellow('╰' + '─'.repeat(boxW - 2) + '╯'),
    ];
    return { lines, cursor: { row: 1, col: 4 + stringWidth(before) } };
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
    const localPeers = this.peers?.peers() || [];
    for (const m of text.matchAll(/(?:^|\s)@("[^"]+"|[^\s"]+)/g)) {
      const token = m[1];
      const peerRef = token.startsWith('"') ? null : token.replace(/[,.;:!?)]+$/, '');
      const peer = peerRef ? resolvePeer(localPeers, this.remotePeers, peerRef, { ids: false }) : null;
      if (peer?.peer || peer?.ambiguous) continue; // a peer wins over a same-named file; use @./name for the file
      const file = this.mentionedFile(token);
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
    // Claim the turn synchronously. attachments() below awaits filesystem work, and a second
    // submit can otherwise enter here before runAgent() has a chance to set busy=true.
    if (this.isTurnRunning()) {
      this.queue.push({ text: prompt, images, display: display ?? prompt, peer: peers.length === 1 ? peers[0] : null });
      this.screen.schedule();
      return;
    }
    this.turnStarting = true;
    this.turnStart = Date.now();
    this.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    if (echo) this.echoUser(display ?? prompt, images.length);
    this.refreshTopic(topic ?? display ?? prompt);
    let content;
    try {
      const sources = images.map((i) => i.source).filter(Boolean);
      content = [
        { type: 'text', text: prompt },
        ...images.map(imageBlock),
        ...(sources.length ? [{ type: 'text', text: `(The attached image${sources.length === 1 ? ' is the file' : 's are the files'} ${sources.join(', ')})` }] : []),
        ...(await this.attachments(prompt)),
        ...(await this.peerMentions(prompt)),
      ];
      await fitImagesIn(content); // a dropped or attached image file at full size would be refused later
    } catch (e) {
      this.turnStarting = false;
      this.logError(e); // nobody awaits this method: an error left to escape would end the program
      this.screen.schedule();
      this.sendWhatWaited();
      return;
    }
    await this.runAgent(content, { peers });
  }

  // What `@name` in a message the user wrote stands for, told to the model: which session, and how to reach it.
  async peerMentions(prompt) {
    const refs = [...new Set([...String(prompt).matchAll(/(?:^|\s)@([^\s@"&，。;；:：!！?？、)）]+)/gu)].map((m) => m[1]))];
    if (!refs.length) return [];
    const local = this.peers?.peers() || [];
    const notes = [];
    for (const ref of refs) {
      let found = resolvePeer(local, this.remotePeers, ref, { ids: false });
      if (!found.peer && !found.ambiguous && this.remote) found = resolvePeer(local, await this.refreshRemotePeers(), ref, { ids: false });
      const p = found.peer;
      if (p) notes.push(`@${ref} is the claude-pro session "${p.label || p.name}" ${p.remote ? `on the user's computer "${p.machine}"` : 'on this computer'}, working in ${p.cwd}`);
      else if (found.ambiguous) notes.push(found.error);
    }
    if (!notes.length) return [];
    return [{ type: 'text', text: `<system-reminder>The user refers to other sessions: ${notes.join('; ')}. MessagePeer (to: the name in quotes) sends a session a task.</system-reminder>` }];
  }

  // A short-lived message in the footer (not written to the transcript).
  flash(text, kind = 'info') {
    this.flashMessage = { text, kind, until: Date.now() + 4000 };
    this.screen.schedule();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.screen.schedule(), 4100);
  }

  async runAgent(content, { peers = [] } = {}) {
    this.turnStarting = false;
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
    if (this.isTurnRunning() || this.exiting) return;
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
      this.maybeInstallUpdate();
    }
  }

  // A background agent ended. If nothing is running, start a turn so the model sees its
  // report right away; otherwise the running turn picks it up at its next step.
  backgroundTaskDone(task) {
    const secs = Math.round((task.ended - task.started) / 1000);
    const color = task.status === 'completed' ? c.green : c.red;
    this.screen.log(`${color(DOT)} ${c.bold('Background agent')} ${task.id} ${c.dim(`"${task.description}"`)} ${task.status} ${c.dim(`(${formatDuration(secs * 1000)})`)}`, '');
    if (!this.isTurnRunning() && !this.exiting && this.agent.notifications.length) this.runAgent(this.agent.drainNotifications());
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
      ctx.onProgress = (p, meta) => { entry.progress = p; entry.progressLines = meta?.lines; };
      result = await tool.call({ command }, ctx);
    } catch (err) {
      const partial = stripAnsi(err?.partialOutput ?? entry.progress ?? '').replace(/\r\n/g, '\n').trimEnd(); // all of it, not just the end the progress shows
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
    this.previousSession = null; // the conversation before a /clear: resuming another one ends the offer
    this.seedOutput = [];
    this.store = new SessionStore(this.cwd, id);
    this.runtime.trace?.setSessionId(id);
    this.topic = loaded.topic;
    this.customTitle = loaded.name;
    // a conversation that was given a name brings it back: the other sessions reach this one by it again
    if (loaded.name && loaded.name !== this.peerLabel()) {
      if (this.peers) this.peers.setName(loaded.name);
      else this.sessionName = loaded.name;
      this.remote?.register().catch(() => {});
    }
    this.firstPrompt = loaded.title;
    this.cost = loaded.cost;
    this.agent.cache.clockUntil = this.store.cacheUntil = loaded.cacheUntil;
    this.agent.messages = loaded.messages;
    this.agent.restoreFileState(loaded.messages, loaded.times);
    this.agent.lastActivityAt = loaded.lastAt; // a long pause before this turn clears old tool results, as it would have
    this.agent.lastContextTokens = estimateTokens(loaded.messages);
    // Continue behind the system prompt the conversation had (and its cache), not a freshly built one.
    this.store.systemPrompt = loaded.systemPrompt;
    this.runtime.resumeSystemPrompt(loaded.systemPrompt, loaded.promptCode);
    // Its cache still warm (a restart, a quick resume): it goes on being refreshed while idle (keepalive.js).
    this.agent.restoreCacheState(loaded.cacheState);
    if (!this.topic) this.refreshTopic(this.latestPrompt()); // a session from before topics were kept
    this.remote?.resync();
    if (quiet) return;
    const restoredCount = loaded.messages.length;
    const shown = loaded.messages.slice(-30);
    const hasSummary = loaded.messages.some((message) => {
      const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content || []);
      return message.role === 'user' && blocks.some((block) => block?.type === 'text' && String(block.text || '').startsWith('This session is being continued'));
    });
    const contextNote = hasSummary ? 'including the saved compaction summary' : 'including the saved conversation history';
    const omitted = restoredCount - shown.length;
    this.logLocal(c.dim(`Resumed session ${id}: restored ${restoredCount} messages to model context, ${contextNote}; showing the ${shown.length} most recent${omitted ? ` (${omitted} older messages not printed)` : ''}.`), '');
    this.remoteMuted++;
    try { this.printTranscript(shown); } finally { this.remoteMuted--; }
  }

  printTranscript(messages) {
    const toolMap = new Map(this.runtime.tools.map((t) => [t.name, t]));
    const ctx = this.agent.makeCtx();
    for (const m of messages) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      for (const b of blocks) {
        const bash = m.role === 'user' && b.type === 'text' ? bashModeLines(b.text) : null;
        if (bash) this.screen.log(bash, '');
        else if (m.role === 'user' && b.type === 'text' && !b.text.startsWith('<system-reminder>')) this.screen.log(renderUserMessage(shownQuotes(b.text).slice(0, 2000), this.width));
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
    this.runtime.trace?.setSessionId(this.store.id);
    this.seedOutput = [];
    this.topic = null;
    this.customTitle = null;
    this.firstPrompt = null;
    this.cost = 0;
    this.remote?.resync();
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
          this.remote?.emit({ t: 'start', kind: 'text' });
        } else if (ev.block.type === 'thinking') {
          this.remote?.emit({ t: 'start', kind: 'thinking' });
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
          if (lines.length) this.logLocal({ soon: true }, lines);
          this.remote?.emit({ t: 'delta', kind: 'text', text: ev.text });
        }
        break;
      case 'thinking':
        this.turnTokens += estimateTokens(ev.text);
        if (this.thinking) {
          this.thinking.text += ev.text;
          this.remote?.emit({ t: 'delta', kind: 'thinking', text: ev.text });
          if (this.thinking.md) {
            const lines = this.thinking.md.write(ev.text);
            if (lines.length) this.logLocal({ soon: true }, lines);
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
          if (lines.length) this.logLocal(lines);
          this.logLocal('');
          this.md = null;
          this.remote?.emit({ t: 'stop' });
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
        if (this.md || this.thinking) this.remote?.emit({ t: 'stop' });
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
    this.rateWait = { resumeAt: ev.resumeAt, label: ev.label, polling: ev.polling, overloaded: Boolean(ev.overloaded) };
    if (shouldAnnounce(prev, ev)) this.notice(`${describePause(ev)} Esc cancels.`, 'warn');
    this.screen.schedule();
  }

  flushThinking() {
    const t = this.thinking;
    if (!t) return;
    this.thinking = null;
    this.remote?.emit({ t: 'stop' });
    if (t.md) {
      const lines = t.md.end();
      if (lines.length) this.logLocal(lines);
      this.logLocal('');
    } else if (t.text.trim()) {
      const secs = Math.max(1, Math.round((Date.now() - t.start) / 1000));
      this.logLocal(c.dim(c.italic(`✻ Thought for ${secs}s (ctrl+o to show thinking)`)), '');
    }
  }

  flushStreaming() {
    this.flushThinking();
    if (this.md) {
      const lines = this.md.end();
      if (lines.length) this.logLocal(lines, '');
      this.md = null;
      this.remote?.emit({ t: 'stop' });
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
    this.remote?.emit({ t: 'tool', id: tu.id, head: toolHeader(tool, input, entry.ctx, { width: REMOTE_WIDTH, dot: false }) });
    this.screen.schedule();
    return {
      progress: (p, meta) => {
        // `all`: the whole output so far (the progress is its end), for the page's "the whole output"
        if (typeof p === 'string') { entry.progress = p; entry.progressLines = meta?.lines; entry.progressAll = meta?.all; this.remote?.toolProgress(tu.id, entry); }
        else if (p?.type === 'subtool') { entry.sub.push(p.header); entry.subCount++; this.remote?.emit({ t: 'sub', id: tu.id, head: p.header }); }
        this.screen.schedule();
      },
      done: (result) => {
        entry.result = result;
        entry.status = result.isError ? 'error' : 'done';
        this.remoteToolDone(entry);
        this.flushActive();
      },
    };
  }

  toolRejected(tu, tool, message, agent) {
    if (!this.isMain(agent)) return;
    const ctx = agent.makeCtx();
    const entry = { tu, tool, input: tu.input, status: 'rejected', rejected: true, rejectMessage: message, ctx };
    if (this.remote) {
      this.remote.emit({ t: 'tool', id: tu.id, head: toolHeader(tool, tu.input, ctx, { width: REMOTE_WIDTH, dot: false }) });
      this.remoteToolDone(entry);
    }
    this.logLocal(toolHeader(tool, tu.input, ctx, { status: 'rejected', width: this.width }), renderToolResult(entry, { width: this.width, cwd: this.cwd }), '');
  }

  // A tool call finished (or was refused, or interrupted): its result on the remote page, once.
  remoteToolDone(entry) {
    if (!this.remote || !entry.tu?.id || entry.remoteDone) return;
    entry.remoteDone = true;
    let lines = [];
    try { lines = renderToolResult(entry, { width: REMOTE_WIDTH, cwd: this.cwd }); } catch { /* shown without */ }
    this.remote.emit({ t: 'done', id: entry.tu.id, status: entry.result?.isError || entry.rejected ? 'error' : 'done', lines });
  }

  // Move finished tool entries (in call order) from the live region to the transcript.
  flushActive(all = false) {
    while (this.active.length && (all || this.active[0].status !== 'running')) {
      const e = this.active.shift();
      if (e.status === 'running') { e.status = 'error'; e.result = { isError: true, content: 'Interrupted', interrupted: true }; }
      const status = e.result?.isError ? 'error' : 'done';
      this.remoteToolDone(e);
      this.logLocal(toolHeader(e.tool, e.input, e.ctx, { status, width: this.width }), renderToolResult(e, { verbose: this.verbose, width: this.width, cwd: this.cwd }), '');
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
        paused = { resumeAt: ev.resumeAt };
      }
      if (ev.type === 'rate_limit_resume') {
        paused = null;
        app.notice(`[${def.name}] ${resumeText(ev)}`);
      }
    };
    return {
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
    for (const q of items) this.echoUser(q.display ?? q.text, q.images?.length);
    this.turnPeers.push(...items.map((q) => q.peer).filter(Boolean));
    this.refreshTopic(items.map((q) => q.display ?? q.text).join('\n\n'));
    // Content blocks for the agent: each queued message's text followed by its images.
    return items.flatMap((q) => [{ type: 'text', text: q.text }, ...q.images.map(imageBlock)]);
  }

  messageAdded(msg, agent) { if (this.isMain(agent)) this.store.message(msg); }
  systemPrompt(text, agent) { if (this.isMain(agent)) this.store.setSystemPrompt(text); }
  messagesReplaced(msgs, agent) { if (this.isMain(agent)) this.store.reset(msgs); }
  usage(_u, agent) {
    if (this.isMain(agent)) this.store.setCacheUntil(agent.cache.clockUntil, agent.cacheState()); // for a resumed or restarted conversation
    this.screen.schedule();
  }

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

  compactEnd(summary, agent, err, { part } = {}) {
    if (!this.isMain(agent)) return;
    this.status = null;
    if (err) return;
    this.lastSummary = summary;
    this.store.setCacheUntil(agent.cache.clockUntil, agent.cacheState());
    const what = part === 'before' ? 'The earlier part of the conversation was summarized' : part === 'after' ? 'The conversation from that message on was summarized' : 'Conversation compacted';
    this.screen.log(c.dim(`✻ ${what} (the summary is in context; /context to see usage)`), '');
  }

  // esc esc on an empty prompt: the rewind menu, as in Claude Code (/rewind). Not while a turn runs (esc stops it).
  openRewind() {
    if (this.isTurnRunning() || this.dialogs.length || this.exiting) return;
    if (!this.runtime.checkpoints.list().length && !this.previousSession) { this.flash('Nothing to rewind yet: every prompt you send makes a point to go back to'); return; }
    Promise.resolve(this.commands.get('rewind').run('')).catch((e) => this.logError(e)).finally(() => this.screen.schedule());
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
      // `progress` is the end of the output (see Bash); `progressLines` how many lines all of it has.
      const out = e.progress.replace(/\r\n/g, '\n').trimEnd().split('\n');
      const total = Math.max(out.length, e.progressLines || 0);
      const tail = out.slice(-5).map((l) => c.dim(truncate(l.replace(/\r/g, ''), w - 8)));
      if (total > 5) tail.unshift(c.dim(`… +${total - 5} lines`));
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
    if (this.isTurnRunning()) {
      // In-progress assistant text.
      if (this.md) {
        const partial = this.md.partial();
        lines.push(...partial.slice(-Math.floor(this.screen.height / 2)));
      }
      if (this.thinking?.md) lines.push(...this.thinking.md.partial().slice(-3));
      else if (this.thinking && this.thinking.text) {
        const text = this.thinking.text.trimEnd();
        const last = text.slice(text.lastIndexOf('\n') + 1); // not split(): this runs every frame on all of it
        lines.push(c.dim(c.italic(truncate(`✻ ${last}`, w))));
      }
      for (const [, p] of this.pendingToolBlocks) {
        // The start of the input is enough for a one-line preview (a streaming Bash heredoc can be very long).
        const m = /"(?:file_path|command|pattern|url|description|query)"\s*:\s*"((?:\\.|[^"\\])*)/.exec(p.partial.slice(0, 4000));
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
      for (const q of this.queue) lines.push(c.dim('  ⎿ queued: ') + c.gray(truncate(String(q.display ?? q.text).slice(0, w * 4).replace(/\s+/g, ' '), w - 14)));
    }
    if (lines.length) lines.push('');
    const placeholder = this.isTurnRunning() ? 'Type a message to queue it for the agent…' : (this.agent.messages.length ? '' : 'Try "explain this codebase" or "fix the failing test"');
    const r = this.finder ? this.renderFind(width) : this.editor.render(width, { placeholder, title: this.boxTitle() });
    const top = lines.length;
    lines.push(...r.lines);
    if (r.cursor) cursor = { row: top + r.cursor.row, col: r.cursor.col };
    const input = r.text ? { ...r.text, row: top + r.text.row } : null; // where the mouse reaches the input box's text
    if (this.finder) lines.push(c.dim(truncate('  ⏎ or ↑ older · shift+⏎ or ↓ newer · PgUp/PgDn scroll · esc to close', w)));
    else if (this.editor.suggestions) lines.push(...this.editor.renderSuggestions(w));
    else if (this.editor.text === '?') lines.push(...this.shortcutsHelp());
    else lines.push(this.footer(w));
    return { lines, cursor, input };
  }

  // In the input box's top border: the directory the agent is in now (a `cd` moves it), and this
  // session's name for the other sessions.
  boxTitle() {
    const dir = this.agent?.cwd || this.cwd;
    const home = os.homedir();
    const shown = dir.toLowerCase().startsWith(home.toLowerCase()) ? '~' + dir.slice(home.length) : dir;
    const name = this.peers || this.remote ? `@${this.peerLabel()}` : '';
    return { left: shown.replace(/\\/g, '/'), right: name && this.remote?.online ? `⇄ ${name}` : name };
  }

  // The prompt cache clock, as in Claude Code's VS Code extension: the minutes the conversation's cache has left
  // ("◷ 12m"), or the icon alone in red once it has run out or right after a compaction, until the next response:
  // the next message then writes the whole conversation to the cache again. Nothing before a response reported
  // cache use.
  cacheClock() {
    const clock = this.agent?.cache.clock();
    return !clock ? '' : clock.cold ? c.red('◷') : c.dim(`◷ ${clock.minutes}m`);
  }

  footer(w) {
    let left;
    const flash = this.flashMessage && Date.now() < this.flashMessage.until ? this.flashMessage : null;
    if (this.exitArmed && Date.now() - this.exitArmed < 1500) left = c.dim('  Press Ctrl-C again to exit');
    else if (flash) left = (flash.kind === 'warn' ? c.yellow : c.dim)('  ' + truncate(flash.text, w - 4));
    else if (this.screen.full && this.screen.selection) left = c.dim('  ctrl+c to copy · ctrl+q to quote it in your message');
    else if (this.editor.selection) left = c.dim('  ctrl+c to copy · esc to clear');
    else if (this.restartRequest) left = c.dim('  ↻ restarting when this turn ends');
    else if (this.editor.mode === 'bash') left = c.magenta('  ! for bash mode');
    else if (this.editor.mode === 'memory') left = c.blue('  # to memorize');
    else left = c.dim('  ? for shortcuts');
    if (this.remote?.online && this.remote.viewers && !flash && !(this.exitArmed && Date.now() - this.exitArmed < 1500)) {
      left += c.dim(' · ') + c.green(`⇄ ${this.remote.viewers} watching`);
    }
    if (!flash) {
      if (this.updating) left += c.dim(' · ') + c.blue(`⇣ updating ${APP_NAME} to ${this.updating}…`);
      else if (this.updateRestart && this.sourceChanged && !this.restartRequest) left += c.dim(' · ') + c.blue(`↻ ${this.updateRestart} installed: restarts ${this.working() ? 'when the work is done' : 'now'}`);
      else if (this.pendingUpdate) left += c.dim(' · ') + c.dim(`update ${this.pendingUpdate} ready · ${this.updateWaitingFor ? `installs when @${this.updateWaitingFor.split(',')[0]} is idle` : 'installs when idle'}`);
    }
    const cfg = this.config;
    const threshold = cfg.autoCompactThreshold(cfg.model);
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
    const level = effort || defaultEffort(cfg.model.id, cfg);
    const info = c.dim(level ? `${model} · ${level}` : model);
    const version = c.dim(`v${VERSION}`);
    const compactTokens = (n) => formatTokens(n).replace(/\.0([kM])$/, '$1');
    const context = c.dim(`ctx ${compactTokens(used)}/${compactTokens(cfg.model.contextWindow)}`);
    // Before the context, version and model: the prompt cache clock, then what the conversation has cost so far;
    // when room is short the cost goes first, then the clock.
    const spent = this.cost > 0 ? c.dim(formatUsd(this.cost)) : '';
    const clock = this.cacheClock();
    const join = (...parts) => parts.filter(Boolean).join(c.dim(' · '));
    const room = w - stringWidth(left) - 1;
    const right = [
      join(notice, clock, spent, context, version, info),
      join(notice, clock, context, version, info),
      join(notice, context, version, info),
      join(notice, context, version),
      join(notice, version),
      version,
    ].find((r) => r && stringWidth(r) < room) || '';
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
