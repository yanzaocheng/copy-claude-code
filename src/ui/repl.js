// Interactive REPL: owns the terminal, renders the transcript and live region, and
// implements the agent's IO callbacks (streaming, tool display, permission prompts).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from '../utils/proc.js';
import { c, ESC, glyphs, stringWidth, stripAnsi, truncate, padEnd, wordWrap } from './ansi.js';
import { Screen, HeadlessScreen, queryCursorRow } from './screen.js';
import { Editor, shownQuotes } from './editor.js';
import { SelectDialog } from './dialogs.js';
import { MarkdownStream, renderMarkdown } from './markdown.js';
import {
  DOT, toolHeader, renderToolResult, modelInfo, renderUserMessage, resultLines, formatTokens, formatDuration, toolLabel, bashModeLines,
} from './render.js';
import { createRuntime } from '../runtime.js';
import { SessionStore, firstUserText } from '../session.js';
import { defaultEffort, quickQuery } from '../api.js';
import { CONFIG_DIR, VERSION, APP_NAME, projectRisk, projectTrusted, trustProject } from '../config.js';
import { gatewayLogin, loadGatewayModels, formatUsd } from '../gateway.js';
import { connectedProviders } from '../providers.js';
import { TOPIC_TITLE_SYSTEM, topicTitlePrompt } from '../prompts.js';
import { buildCommands } from '../commands.js';
import { canRestart } from '../restart.js';
import { resolvePath, displayPath } from '../utils/paths.js';
import { ripgrepPath } from '../utils/shell.js';
import { describePause, formatClock, humanDuration, resumeText, shouldAnnounce } from '../ratelimit.js';
import { shutdownBackgroundShells, releaseBackgroundShells } from '../tools/bash.js';
import { sweepShells } from '../shells.js';
import { shutdownInterpreters } from '../tools/code.js';
import { closeBrowserSession } from '../browser/session.js';
import { estimateTokens } from '../agent.js';
import { readClipboardImage, imageFromFile, writeClipboard, readClipboardText } from '../utils/clipboard.js';
import { fitImagesIn } from '../utils/images.js';
import { resolvePeer } from '../peers.js';
import { LiveFeed } from '../live.js';
import { transcriptItems, REMOTE_WIDTH } from '../remote.js';
// the App's other parts, by what they do (their methods are App's: see the end of the class)
import { peerMethods } from './app-peers.js';
import { remoteMethods } from './app-remote.js';
import { restartMethods } from './app-restart.js';

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

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'];
const VERBS = ['Thinking', 'Pondering', 'Crafting', 'Brewing', 'Computing', 'Conjuring', 'Cooking', 'Musing', 'Noodling', 'Percolating', 'Ruminating', 'Synthesizing', 'Working', 'Tinkering', 'Mulling', 'Deliberating', 'Churning', 'Forging', 'Hatching', 'Simmering'];
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.jsonl');

const HISTORY_KEEP = 500; // entries a project's history loads (and keeps, see loadHistory)
const HISTORY_PRUNE_CHARS = 5_000_000;
const HISTORY_PASTE_CHARS = 100_000; // pasted text kept with an entry in the file, at most (images are not kept)

// The input history of the project, oldest first: the text, or {text, parts} with the pasted text and quotes its
// placeholders stand for (see Editor.submit). A file past HISTORY_PRUNE_CHARS is written again with the last
// HISTORY_KEEP entries of each project: it grew for good (every message of every project), read whole at each start.
function loadHistory(cwd) {
  let text;
  try { text = fs.readFileSync(HISTORY_FILE, 'utf8'); } catch { return []; }
  const entries = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && typeof e.display === 'string');
  if (text.length > HISTORY_PRUNE_CHARS) pruneHistory(entries);
  return entries.filter((e) => e.project === cwd).slice(-HISTORY_KEEP).map((e) => (Array.isArray(e.pastes) && e.pastes.length
    ? { text: e.display, parts: { pastes: e.pastes, quotes: Array.isArray(e.quotes) ? e.quotes : [] } }
    : e.display));
}

function pruneHistory(entries) {
  const count = new Map();
  const keep = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const n = count.get(entries[i].project) || 0;
    if (n >= HISTORY_KEEP) continue;
    count.set(entries[i].project, n + 1);
    keep.push(entries[i]);
  }
  try { // whole or not at all; an entry another window adds meanwhile may be lost, which costs an up-arrow
    const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, keep.reverse().map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.renameSync(tmp, HISTORY_FILE);
  } catch { /* pruned another time */ }
}

function appendHistory(cwd, text, parts = null) {
  const entry = { display: text, project: cwd, timestamp: Date.now() };
  const pastes = (parts?.pastes || []).filter(([label]) => text.includes(label));
  if (pastes.length && pastes.reduce((n, [, content]) => n + String(content).length, 0) <= HISTORY_PASTE_CHARS) {
    entry.pastes = pastes;
    if (parts.quotes?.length) entry.quotes = parts.quotes;
  }
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
  } catch { /* ignore */ }
}

// The files of the working directory, for the completion after an `@`. Listed when an `@` is first typed, not at
// the start, and never more than MAX_FILES of them: the listing is stopped there. (It ran at every start and
// restart and went through the whole directory before keeping the first 50,000: in a home directory of 1.3
// million files that was 10 seconds of ripgrep on every core and 45 MB, for every session open there, each time
// the program's source changed.) `onLoaded` is called when a listing is in, so that the completion is drawn again.
const MAX_FILES = 50_000;
class FileIndex {
  constructor(cwd, getConfig = () => null, onLoaded = () => {}) {
    Object.assign(this, { cwd, getConfig, onLoaded, files: [], at: 0, took: 0, loading: false });
  }
  refresh() {
    // listed again after 30 seconds, or later where the listing itself takes long
    if (this.loading || Date.now() - this.at < Math.max(30_000, this.took * 30)) return;
    this.loading = true;
    const started = Date.now();
    const done = (list) => {
      Object.assign(this, { files: list.slice(0, MAX_FILES), at: Date.now(), took: Date.now() - started, loading: false });
      this.onLoaded();
    };
    const rg = ripgrepPath(this.getConfig());
    if (rg) {
      const child = spawn(rg, ['--files', '--hidden', '--glob', '!.git'], { cwd: this.cwd, windowsHide: true });
      let out = '';
      let lines = 0;
      child.stdout.setEncoding('utf8'); // a Chinese file name can be split between two chunks
      child.stdout.on('data', (d) => {
        if (lines >= MAX_FILES) return;
        out += d;
        for (let i = d.indexOf('\n'); i !== -1; i = d.indexOf('\n', i + 1)) lines++;
        if (lines >= MAX_FILES) child.kill();
      });
      // (stopped in the middle of a name: the list is cut to MAX_FILES whole ones in done)
      child.on('close', () => done(out.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, '/'))));
      child.on('error', () => done([]));
    } else {
      (async () => {
        const list = [];
        try {
          for await (const f of fs.promises.glob('**/*', { cwd: this.cwd, exclude: (p) => /(^|[\\/])(node_modules|\.git)$/.test(p) })) {
            list.push(f.replace(/\\/g, '/'));
            if (list.length > MAX_FILES) break;
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
  // `host`: a 后台会话, one of the sessions the web console runs in its own process (see web/host.js): no terminal
  // (what it prints goes to the console's live view only), the process is the host's, and so are restarts.
  // `attached` {row, profile}: run by the web console too, but with the terminal of a window attached to it (see
  // attach.js): stdin and stdout come from there, `row` is where its cursor was, `profile` its measured widths.
  constructor({ flags, cwd, stdin = process.stdin, stdout = process.stdout, noProcessExit = false, selfCheck = false, host = null, attached = null }) {
    this.flags = flags;
    this.cwd = cwd;
    this.stdin = stdin;
    this.stdout = stdout;
    this.host = host;
    this.attached = host ? attached : null;
    this.noProcessExit = noProcessExit || selfCheck || Boolean(host);
    this.driven = noProcessExit;
    this.screen = host && !this.attached ? new HeadlessScreen(stdout) : new Screen(stdout);
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
    this.sourceChangedInTurn = false; // ...while a turn of this session ran: its own work, most likely
    this.sourceQuietAt = 0; // a change made elsewhere is loaded once the source has been left alone until then
    this.reloading = false;
    this.skipAutoReload = false;
    this.peers = null; // this session as seen by the other sessions on the machine (see peers.js)
    this.turnPeers = []; // tasks from other sessions that the running turn answers: [{msg}]
    this.userSentToPeers = new Set(flags?.restart?.userSentToPeers || []); // ids of messages the user sent to other sessions with @name
    // messages sent to sessions on other computers that may still be answered ('sessionId:messageId' -> when)
    this.sentToRemote = new Map(flags?.restart?.sentToRemote || []);
    this.remote = null; // the connection to the relay, through which the paired computers reach this session (see relay.js)
    // the local web console's live view of this session (claude-pro web, see live.js and web/server.js)
    this.liveFeed = new LiveFeed({
      seed: () => [
        ...transcriptItems(this.agent?.messages || [], { tools: this.runtime?.tools || [], ctx: this.agent?.makeCtx(), cwd: this.cwd, images: true, turns: this.turnMarks }),
        ...(this.seedOutput.length ? [{ k: 'output', lines: this.seedOutput.slice() }] : []),
      ],
      status: () => this.liveStatus(),
    });
    // run by the web console (a 后台会话): only the console shows it, and ends it. `legacyHidden`: one an older version
    // of the console started in a hidden window, a process of its own: it moves into the console's (maybeMoveIntoConsole)
    this.legacyHidden = !host && /^(1|true|yes)$/i.test(process.env.CLAUDE_PRO_BACKGROUND || '');
    this.hidden = (Boolean(host) && !this.attached) || this.legacyHidden;
    this.remoteMuted = 0; // > 0 while printing something the page is told about in its own terms
    this.remoteDialogs = 0;
    this.remoteStarting = null;
    this.seedOutput = []; // lines the page is shown after the conversation when it starts from it (see resumeAfterRestart)
    // Where the turns of the conversation ended, with their "✻ Done at …" lines: [{after, text, msg}] (`msg`: the
    // message the line follows, to find it again when the messages are replaced), and the array they were made on.
    this.turnMarks = [];
    this.marksBase = null;
    this.selfCheck = selfCheck;
    this.sessionName = flags?.restart?.peerName || null; // this session's name when the sessions of this computer do not know it (CLAUDE_PRO_PEERS=0)
    this.customTitle = null; // the conversation's name given with /rename: the title, instead of the topic
    this.remotePeers = []; // the sessions on the paired computers, as last listed by the relay (see app-peers.js)
    this.remotePeersAt = 0;
    this.remotePeersLoading = null;
    this.remotePeersTimer = null;
    this.cost = 0; // what this conversation's requests have cost so far (USD at list prices): the footer and /cost
    this.fileIndex = new FileIndex(cwd, () => this.runtime?.config, () => {
      const e = this.editor;
      if (!e) return;
      // a Tab pressed while the list was being made had nothing to complete: it does now
      const miss = e.lastMiss;
      if (miss && miss.text === e.text && miss.cursor === e.cursor && Date.now() - miss.at < 5000) e.complete();
      else e.refreshSuggestions();
      this.screen?.schedule();
    });
    this.storeError = (e, store) => this.notice(`Could not save the conversation to ${store.file} (${e.code || e.message}): it is written again whole before a restart, but /resume may miss what was not saved.`, 'warn');
    this.store = new SessionStore(cwd);
    this.store.onError = this.storeError;
    // What the terminal prints goes to the remote page too, except what it is told about as events.
    this.screen.onLog = (items) => {
      const lines = () => items.flatMap((i) => (Array.isArray(i) ? i : [i])).flatMap((l) => String(l).split(/\r?\n/));
      if (this.remoteMuted || !this.liveFeed?.active) return;
      this.liveFeed.output(lines());
    };
    this.editor = new Editor({
      history: loadHistory(cwd),
      onSubmit: (value, raw, images, display, parts) => { try { this.onSubmit(value, raw, images, display, parts); } catch (e) { this.logError(e); } },
      onDoubleEscape: () => this.openRewind(),
      imageFromPath: (p) => {
        const r = imageFromFile(resolvePath(p, this.cwd));
        if (r.error && !/not found|Not a file/.test(r.error)) this.flash(r.error, 'warn');
        return r.image || null;
      },
      getSuggestions: (text, cursor, opts) => this.suggest(text, cursor, opts),
      onChange: () => this.screen.schedule(),
    });
  }

  get agent() { return this.runtime.agent; }
  // Whether this session can restart (to load new code, or for /cd): under the supervisor, or in the web console.
  canRestart() { return Boolean(this.host) || canRestart(); }
  get owner() { return this.runtime?.config?.owner; }
  // Whether the conversation is being worked on, not only looked at: a session the web console took up because its
  // conversation was opened is not, until it runs a turn (`used`, carried over by a restart).
  inUse() { return !this.host || Boolean(this.attached) || Boolean(this.used); }
  get config() { return this.runtime.config; }
  get width() { return this.screen.width; }
  isTurnRunning() { return this.busy || this.turnStarting; }

  // ---------------------------------------------------------------- lifecycle

  async start(initialPrompt) {
    if (this.exiting) return this.exitCode;
    const stdin = this.stdin;
    stdin.setRawMode(true);
    // Where the cursor is, before anything is drawn: the input box is kept on the last rows of the window from
    // there (see screen.js).
    // (an attached terminal was asked by its window's process, which measured its widths too)
    if (this.attached) this.screen.pinFrom(Number.isInteger(this.attached.row) ? this.attached.row : null);
    else if (stdin.isTTY && this.stdout.isTTY) this.screen.pinFrom(await queryCursorRow(stdin, this.stdout));
    if (this.exiting) return this.exitCode;
    stdin.setEncoding('utf8');
    this.stdout.write(ESC.bracketedPasteOn);
    if (!this.host) { // (the host's process is not this session's)
      process.on('exit', () => this.restoreTerminal());
      process.on('SIGTERM', () => this.exit(143));
      process.on('SIGHUP', () => this.exit(129));
    }

    // A project whose hooks, MCP servers or env are not trusted yet (see projectRisk): asked before any of it runs, in
    // plain lines, the interface not drawn yet. (The web console asks on its page before it starts a session.)
    if ((!this.host || this.attached) && !this.selfCheck && !this.flags.restart && stdin.isTTY) await this.askProjectTrust();
    if (this.exiting) return this.exitCode;
    await this.startPeer();
    if (this.exiting) return this.exitCode;
    const runtime = await createRuntime({ cwd: this.cwd, flags: this.flags, io: this, sessionId: this.store.id });
    if (this.exiting) {
      this.closeRuntime(runtime); // exit could not clean up the runtime while it was still being built
      return this.exitCode;
    }
    this.runtime = runtime;
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
    // not in the self-check a restart runs first: that would ask the gateway once more for every restart
    if (!this.driven && !this.selfCheck) loadGatewayModels(this.runtime.config).then(() => this.screen.schedule());
    // background shells nobody took up (a session that crashed, or was never opened again): ended after a while
    if (!this.selfCheck) setTimeout(() => sweepShells().catch(() => {}), 30_000).unref?.();
    // What the session showed before a restart: repainted after a resize.
    if (Array.isArray(this.flags.restart?.screenHistory)) this.screen.history = this.flags.restart.screenHistory.filter((l) => typeof l === 'string');
    // Keys typed while starting up stay buffered in stdin until we listen.
    readline.emitKeypressEvents(stdin);
    stdin.on('keypress', (str, key) => {
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

    const skipped = this.config.settings.projectTrust;
    if (skipped?.needed && (!restart || restart.changedDirectory)) {
      const kinds = { mcp: 'MCP servers', hooks: 'hooks', env: 'env' };
      const what = Object.entries(kinds).map(([k, label]) => [label, skipped.items.filter((i) => i.kind === k).map((i) => i.name)]).filter(([, n]) => n.length).map(([label, n]) => `${label} ${n.join(', ')}`).join('; ');
      this.notice(`This project's ${what} are off: the project is not trusted (yet). If it is yours or you trust it, /trust turns them on.`, 'warn');
    }
    if (restart) this.resumeAfterRestart(restart, resumable);
    else if (this.flags.resumeFile) this.loadSession(this.flags.resumeFile, this.flags.resumeId);
    else if (this.flags.resume) await this.commands.get('resume').run('');
    if (this.exiting) return this.exitCode;
    if (!restart && this.flags.name?.trim()) this.renameSession(this.flags.name); // --name, as /rename does
    this.autoStartRemote(restart);
    // 远程访问 on: the console's server (and its tunnel) is brought up again by any session that starts
    if (!this.driven && !this.selfCheck && !this.host) { // (in the console's process it is up already)
      import('../web/remote-access.js')
        .then((ra) => (ra.readRemote().enabled ? import('../web/server.js').then((w) => w.ensureWebServer()) : null))
        .catch(() => { /* /web remote says what is wrong */ });
    }

    this.screen.setLive((w) => this.renderLive(w));
    // the restart line took the place of the same one of the process before (see resumeAfterRestart): the screen is
    // written again from the history, which no longer has the old one
    if (this.collapsedRestart) { this.collapsedRestart = false; this.screen.repaint(); }
    this.spinnerTimer = setInterval(() => {
      if (this.isTurnRunning() || this.active.length) this.screen.schedule();
    }, 120);
    if (restart) this.continueAfterRestart(restart);
    else if (initialPrompt?.trim()) this.onSubmit(initialPrompt, initialPrompt);
    // Nothing configured yet (no gateway login, no provider): /connect, where the gateway comes first.
    else if (!gatewayLogin(this.config.gatewayUrl) && !connectedProviders().length) {
      Promise.resolve(this.commands.get('connect').run('')).catch((e) => this.logError(e)).finally(() => this.screen.schedule());
    }
    this.startSourceWatch();
    if (this.legacyHidden && !this.selfCheck) {
      this.moveTimer = setInterval(() => this.maybeMoveIntoConsole(), 60_000);
      this.moveTimer.unref?.();
      setTimeout(() => this.maybeMoveIntoConsole(), 5000).unref?.();
    }
    if (!this.driven) {
      // Updates are deliberately manual: /update checks npm and installs the selected release.
      // Do not query the registry or install/restart a running session in the background.
      // connected or not as this computer's pairings change (/pair or /devices in another window, the web console)
      this.loginTimer = setInterval(() => this.syncRemote(), 10_000);
      this.loginTimer.unref?.();
    }
    return this.exiting ? this.exitCode : new Promise((resolve) => { this.resolveExit = resolve; });
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

  // `restart`: the session goes on in a next process (a restart, the web console taking up new code, a /cd, the move
  // into the console): its background shells keep running for it to take up (shells.js); else they end with it.
  closeRuntime(runtime, { restart = false } = {}) {
    // In the console process, no owner means there is nothing to clean up, not every session.
    const owner = this.host ? runtime?.config?.owner : undefined;
    if (!this.host || owner) {
      if (restart && this.store?.id) releaseBackgroundShells(owner, this.store.id);
      else shutdownBackgroundShells(owner);
      shutdownInterpreters(owner);
    }
    clearTimeout(this.adoptTimer);
    if (this.host && owner) closeBrowserSession(owner);
    runtime?.agent?.keepAlive?.stop();
    runtime?.tasks?.killAll();
    runtime?.mcp?.close();
    runtime?.releaseSession?.();
  }

  exit(code = 0, { restart = false } = {}) {
    if (this.exiting) return;
    this.exiting = true;
    this.exitCode = code;
    let remoteClosed;
    const farewell = []; // left on the terminal once the program's screen is gone (see Screen.close)
    try {
      this.controller?.abort();
      clearInterval(this.spinnerTimer);
      clearTimeout(this.reloadTimer);
      this.sourceWatch?.close();
      clearTimeout(this.updateRetry);
      clearInterval(this.moveTimer);
      this.closeRuntime(this.runtime, { restart });
      this.peers?.close();
      this.liveFeed?.close();
      clearInterval(this.remotePeersTimer);
      clearInterval(this.loginTimer);
      this.pairing?.abort();
      remoteClosed = this.remote?.close();
      const agent = this.runtime?.agent;
      const u = agent?.totalUsage();
      if (!restart && u?.requests) {
        farewell.push(c.dim(`Total usage: ${formatTokens(u.input + u.cacheRead + u.cacheWrite)} input (${formatTokens(u.cacheRead)} cached), ${formatTokens(u.output)} output, ${u.requests + u.compactions} requests`));
      }
      if (!restart && agent?.messages.length) farewell.push(c.dim(`Resume this session with: ${APP_NAME} --resume ${this.store.id}`));
    } finally {
      this.resolveExit?.(code);
      this.restoreTerminal({ handOver: restart, farewell });
      this.stdin.pause();
      if (!this.noProcessExit) {
        if (remoteClosed) remoteClosed.finally(() => process.exit(code));
        else setTimeout(() => process.exit(code), 50).unref();
      }
    }
  }

  // ---------------------------------------------------------------- other sessions (see peers.js)

  // ---------------------------------------------------------------- remote control (see remote.js)

  // Print to the terminal only: the remote page is told about this as an event of its own.
  // `{soon: true}` first: drawn with the next frame (streamed text, see Screen.logSoon).
  logLocal(...items) {
    const soon = items[0]?.soon === true && items.shift();
    this.remoteMuted++;
    try { if (soon) this.screen.logSoon(...items); else this.screen.log(...items); } finally { this.remoteMuted--; }
  }

  // A message of the user in the transcript (typed here, on the remote page, or sent by another session).
  echoUser(text) {
    this.logLocal(renderUserMessage(text, this.width));
    this.liveFeed.emit({ t: 'user', text: String(text) });
  }

  // ---------------------------------------------------------------- the page's commands (see remote.js)

  // ---------------------------------------------------------------- restarting (see restart.js)

  printWelcome() {
    const cfg = this.config;
    const model = cfg.model;
    const lines = [
      `${c.claude('✻')} Welcome to ${c.bold(APP_NAME)}! ${c.dim(`v${VERSION} · /help · ? for shortcuts · ${APP_NAME} web: the web console`)}`,
      c.dim(`  cwd:     ${this.cwd}`),
      c.dim(`  model:   ${model.label}${cfg.effort ? ` · effort ${cfg.effort}` : ''} · ${formatTokens(model.contextWindow)} context`),
      c.dim(`  backend: ${cfg.endpointLabel}`),
    ];
    lines.push('', c.dim(' Full access: every tool runs immediately, nothing is ever asked. File edits are checkpointed;'), c.dim(' /rewind puts files and/or the conversation back (shell-command changes are not tracked).'));
    // (the model in use cannot be reached: said, with what connects it)
    const provider = cfg.model.provider;
    if (!cfg.anyProviderConnected) lines.push('', c.yellow(' ⚠ No model provider is connected. Run /connect.'));
    else if (!cfg.providerConnected(provider)) lines.push('', c.yellow(` ⚠ ${cfg.model.label} is a model of ${cfg.providerName(provider)}, which is not connected. Run /connect ${provider === '7bit' ? '7bit.fun' : provider}, or /model for another.`));
    const mcp = this.runtime.mcp.status();
    if (mcp.length) {
      const ok = mcp.filter((m) => m.status === 'connected').length;
      lines.push(c.dim(` MCP: ${ok}/${mcp.length} servers connected${ok < mcp.length ? ' · /mcp for details' : ''}`));
    }
    lines.push('');
    this.logLocal(lines);
  }

  // ---------------------------------------------------------------- input

  copyText(text) {
    writeClipboard(text).then((ok) => {
      if (ok) this.flash(`Copied ${text.length.toLocaleString()} characters to the clipboard`);
      else this.flash('Could not copy: no clipboard tool found', 'warn');
    });
  }

  clipboardEditor() {
    const dialog = this.dialogs[0];
    if (dialog) return dialog.editor || dialog.other || null;
    return this.editor;
  }

  // Pasted text into the input box or the open dialog's text field.
  insertPastedText(text, target = this.clipboardEditor()) {
    const clean = String(text || '').replace(/\x1b\[20[01]~/g, '');
    if (!clean) return;
    if (target) target.insertPaste(clean);
    this.screen.schedule();
  }

  // Read the system clipboard: an image first, else its text. Each read starts PowerShell (about a second), so it
  // is only done when the terminal had nothing to paste (alt+v, ctrl+v as a key, an empty bracketed paste).
  pasteClipboard(target = this.clipboardEditor()) {
    if (this.readingClipboard || this.exiting) return;
    if (!target) return; // selection dialogs have no text field to paste into
    this.readingClipboard = true;
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
    if (this.exiting || this.moving) return;
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
    if (key.name === 'paste-start' || key.sequence === '\x1b[200~') {
      this.bracketedPaste = { raw: '' };
      return;
    }
    if (key.ctrl && key.name === 'c') { this.onCtrlC(); return; }
    if ((key.ctrl || key.meta) && key.name === 'v') { this.pasteClipboard(); return; } // alt+v: the clipboard's image
    const dialog = this.dialogs[0];
    if (dialog) {
      dialog.handleKey(str, key);
      this.screen.schedule();
      return;
    }
    if (key.ctrl && key.name === 'l') { this.screen.clearScreen(); return; }
    if (key.ctrl && key.name === 'd' && !this.editor.text) { this.keyboardExit(); return; }
    // esc closes an open completion list first (the editor does that), and only then stops the turn
    if (key.name === 'escape' && this.isTurnRunning() && !this.editor.completing) { this.interrupt(); return; }
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
      if (!q && m.index === 0 && !m[1] && !quiet && !this.fileIndex.loading) this.flash(this.remote ? 'No file or session is available here or on your paired computers' : 'No file or other session is available on this computer');
      return null;
    }
    return { items, from: cursor - q.length - (quoted ? 2 : 1), to: cursor };
  }

  // `display`: how the message shows in the transcript when that is not `value` (a quote shows its first lines).
  onSubmit(value, raw, images = [], display = undefined, parts = null) {
    const text = value.trim();
    if (!text) { this.screen.schedule(); return; }
    appendHistory(this.cwd, raw, parts);
    if (this.sendTypedToPeer(text)) return;
    if (this.isTurnRunning() && !this.modelSwitchAtPause(text)) {
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
      this.notice(`Unknown command: /${name}. Type / and press Tab for the list of commands, or /help.`, 'warn');
      return;
    }
    this.startTurn(value, { display });
  }

  // /model while the turn's request is paused for a rate limit: the one command that runs in a turn. The request
  // then goes on with the model chosen instead of waiting hours for the limit of the other (the user had to stop
  // the turn, change the model and say "go on" for that).
  modelSwitchAtPause(text) {
    return /^\/model(?:\s|$)/i.test(text) && this.agent.pausedForLimit;
  }

  shortcutsHelp() {
    const rows = [
      ['! for bash mode', 'double tap esc to clear input'],
      ['/ for commands', 'tab to complete / and @'],
      ['@ for files and sessions', '/verbose for detailed tool output'],
      ['# to memorize', 'esc to interrupt'],
      ['\\⏎ or alt+⏎ for newline', 'ctrl + l to clear, ctrl + d to exit'],
      ['ctrl + v to paste text or an image', 'claude-pro web: the web console'],
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
    if (echo) this.echoUser(display ?? prompt);
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

  // The status line under each answer: "✻ Done at 14:05 · worked 1m 3s · $0.12 (total $3.40) · ctx 45k/1M · opus-5-5 max".
  doneText() {
    const at = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    const parts = [`✻ Done at ${at}`, `worked ${formatDuration(Date.now() - this.turnStart)}`];
    const spent = this.cost - (this.turnCostStart || 0);
    if (spent > 0) parts.push(this.cost > spent + 0.005 ? `${formatUsd(spent)} (total ${formatUsd(this.cost)})` : formatUsd(spent));
    try {
      const cfg = this.config;
      const k = (n) => formatTokens(n).replace(/\.0([kM])$/, '$1');
      parts.push(`ctx ${k(this.agent.contextEstimate)}/${k(cfg.model.contextWindow)}`);
      const { model, effort } = modelInfo(cfg);
      const level = effort || defaultEffort(cfg.model.id, cfg);
      parts.push(level ? `${model} ${level}` : model);
    } catch { /* no model information: the time and the cost are enough */ }
    return parts.join(' · ');
  }

  // A turn ended with `text` under its answer: kept with the conversation, so that the web console shows it again
  // when it rebuilds the view from the messages (a reload, a restart of the session or of the console).
  markTurn(text) {
    const msgs = this.agent?.messages || [];
    if (!msgs.length) return;
    if (this.marksBase !== msgs) { this.marksBase = msgs; this.turnMarks = this.turnMarks.filter((m) => msgs[m.after - 1] === m.msg); }
    this.turnMarks.push({ after: msgs.length, text, msg: msgs[msgs.length - 1] });
    this.store.turnEnd(msgs.length, text);
  }

  // A short message about something the user just did (a paste, a copy, a completion with nothing to offer): a
  // line of its own, as there is no footer to show it in.
  flash(text, kind = 'info') {
    this.notice(text, kind);
  }

  async runAgent(content, { peers = [] } = {}) {
    this.used = true; // (see inUse)
    this.turnStarting = false;
    this.busy = true;
    this.turnPeers.push(...peers);
    let result = null;
    let error = null;
    this.controller = new AbortController();
    this.turnStart = Date.now();
    this.turnTokens = 0;
    this.turnCostStart = this.cost;
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
      // When the answer came and how long the turn took, under the answer (the user asked for the time, 2026-11-21),
      // with what there is no footer for: the cost, the context in use, the model.
      if (result && !result.interrupted && !error) {
        const text = this.doneText();
        this.screen.log(c.dim(text), '');
        this.markTurn(text);
      }
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
    const loaded = this.runtime.useSession(id, () => SessionStore.load(file));
    this.adoptShells(id);
    this.previousSession = null; // the conversation before a /clear: resuming another one ends the offer
    this.seedOutput = [];
    this.store = new SessionStore(this.cwd, id);
    this.store.onError = this.storeError;
    this.runtime.trace?.setSessionId(id);
    this.topic = loaded.topic;
    this.customTitle = loaded.name;
    // a conversation that was given a name brings it back: the other sessions reach this one by it again
    if (loaded.name && loaded.name !== this.peerLabel()) {
      if (this.peers) this.peers.setName(loaded.name);
      else this.sessionName = loaded.name;
      this.remote?.flush();
    }
    this.firstPrompt = loaded.title;
    this.cost = loaded.cost;
    this.agent.cache.clockUntil = this.store.cacheUntil = loaded.cacheUntil;
    this.agent.messages = loaded.messages;
    this.marksBase = loaded.messages;
    this.turnMarks = (loaded.turns || []).map((t) => ({ ...t, msg: loaded.messages[t.after - 1] }));
    this.agent.restoreFileState(loaded.messages, loaded.times);
    this.agent.lastActivityAt = loaded.lastAt; // a long pause before this turn clears old tool results, as it would have
    this.agent.lastContextTokens = estimateTokens(loaded.messages);
    // Continue behind the system prompt the conversation had (and its cache), not a freshly built one.
    this.store.systemPrompt = loaded.systemPrompt;
    this.runtime.resumeSystemPrompt(loaded.systemPrompt, loaded.promptCode);
    // Its cache still warm (a restart, a quick resume): it goes on being refreshed while idle (keepalive.js).
    // (in the web console a conversation is taken up as soon as it is opened: one only looked at costs nothing, no
    // cache refreshes and no title request, until it is used)
    this.agent.restoreCacheState(loaded.cacheState, { keepWarm: this.inUse() });
    if (!this.topic && this.inUse()) this.refreshTopic(this.latestPrompt()); // a session from before topics were kept
    this.liveFeed.resync();
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
        if (m.role === 'assistant' && b.type === 'thinking' && b.thinking) this.screen.log(renderMarkdown(b.thinking, { width: this.width - 1, firstPrefix: c.dim('✻ '), indent: '  ', style: (s) => c.dim(c.italic(s)) }), '');
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
    const store = new SessionStore(this.cwd);
    this.runtime.useSession(store.id);
    this.store = store;
    this.store.onError = this.storeError;
    this.runtime.trace?.setSessionId(this.store.id);
    this.seedOutput = [];
    this.turnMarks = [];
    this.marksBase = this.agent?.messages || null;
    this.topic = null;
    this.customTitle = null;
    this.firstPrompt = null;
    this.cost = 0;
    this.liveFeed.resync();
  }

  // ---------------------------------------------------------------- dialogs

  // The question of start(): one key, y trusts, anything else (Enter included) does not; Ctrl+C quits.
  async askProjectTrust() {
    const risk = projectRisk(this.cwd);
    if (!risk || projectTrusted(this.cwd, risk)) return;
    if (this.attached) this.host?.terminalAsks?.(this); // (its window sends keys from now on, see attach.js)
    const labels = { mcp: 'MCP servers (programs it starts)', hooks: 'hooks (commands it runs)', env: 'env (it can point the gateway or the shell elsewhere)' };
    const lines = ['', c.yellow(c.bold('This project comes with settings that run programs on this computer or change the configuration:'))];
    for (const [kind, label] of Object.entries(labels)) {
      const names = risk.items.filter((i) => i.kind === kind).map((i) => i.name);
      if (names.length) lines.push(`  ${label}: ${names.join(', ')}`);
    }
    lines.push(c.dim(`  from ${[...new Set(risk.items.map((i) => path.relative(this.cwd, i.file) || i.file))].join(', ')}`));
    lines.push('', `Turn them on only for a project you trust (your own, say). ${c.bold('[y]')} trust it   ${c.bold('[n]')} not this time `);
    this.stdout.write(lines.join('\n'));
    const key = await new Promise((resolve) => {
      const onData = (d) => {
        const ch = String(d)[0];
        if (!ch) return;
        this.stdin.off('data', onData);
        this.stdin.pause();
        resolve(ch);
      };
      this.stdin.on('data', onData);
      this.stdin.resume();
    });
    this.stdout.write(`${key === 'y' || key === 'Y' ? 'trusted' : 'off'}\n\n`);
    if (key === '\x03') { this.exit(130); return; }
    if (key === 'y' || key === 'Y') trustProject(this.cwd, risk.hash);
  }

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
          this.emitEvent({ t: 'start', kind: 'text' });
        } else if (ev.block.type === 'thinking') {
          this.emitEvent({ t: 'start', kind: 'thinking' });
          this.thinking = new MarkdownStream({ width: w, firstPrefix: c.dim('✻ '), indent: '  ', style: (s) => c.dim(c.italic(s)) });
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
          this.emitEvent({ t: 'delta', kind: 'text', text: ev.text });
        }
        break;
      case 'thinking':
        this.turnTokens += estimateTokens(ev.text);
        if (this.thinking) {
          this.emitEvent({ t: 'delta', kind: 'thinking', text: ev.text });
          const lines = this.thinking.write(ev.text);
          if (lines.length) this.logLocal({ soon: true }, lines);
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
          this.emitEvent({ t: 'stop' });
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
        if (this.md || this.thinking) this.emitEvent({ t: 'stop' });
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
    if (shouldAnnounce(prev, ev)) this.notice(`${describePause(ev)} Esc cancels${!ev.overloaded && this.agent.pauseControl ? '; /model goes on with another model at once' : ''}.`, 'warn');
    this.screen.schedule();
  }

  flushThinking() {
    const t = this.thinking;
    if (!t) return;
    this.thinking = null;
    this.emitEvent({ t: 'stop' });
    const lines = t.end();
    if (lines.length) this.logLocal(lines);
    if (t.emittedAny) this.logLocal('');
  }

  flushStreaming() {
    this.flushThinking();
    if (this.md) {
      const lines = this.md.end();
      if (lines.length) this.logLocal(lines, '');
      this.md = null;
      this.emitEvent({ t: 'stop' });
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
    this.emitEvent({ t: 'tool', id: tu.id, head: toolHeader(tool, input, entry.ctx, { width: REMOTE_WIDTH, dot: false }) });
    this.screen.schedule();
    return {
      progress: (p, meta) => {
        // `all`: the whole output so far (the progress is its end), for the page's "the whole output"
        if (typeof p === 'string') { entry.progress = p; entry.progressLines = meta?.lines; entry.progressAll = meta?.all; this.liveFeed.toolProgress(tu.id, entry); }
        else if (p?.type === 'subtool') { entry.sub.push(p.header); entry.subCount++; this.emitEvent({ t: 'sub', id: tu.id, head: p.header }); }
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
    if (this.liveFeed.active) {
      this.emitEvent({ t: 'tool', id: tu.id, head: toolHeader(tool, tu.input, ctx, { width: REMOTE_WIDTH, dot: false }) });
      this.remoteToolDone(entry);
    }
    this.logLocal(toolHeader(tool, tu.input, ctx, { status: 'rejected', width: this.width }), renderToolResult(entry, { width: this.width, cwd: this.cwd }), '');
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
    for (const q of items) this.echoUser(q.display ?? q.text);
    this.turnPeers.push(...items.map((q) => q.peer).filter(Boolean));
    this.refreshTopic(items.map((q) => q.display ?? q.text).join('\n\n'));
    // Content blocks for the agent: each queued message's text followed by its images.
    return items.flatMap((q) => [{ type: 'text', text: q.text }, ...q.images.map(imageBlock)]);
  }

  messageAdded(msg, agent) {
    if (!this.isMain(agent)) return;
    this.store.message(msg);
    if (!this.liveFeed.active || msg.role !== 'user' || !Array.isArray(msg.content)) return;
    const count = msg.content.filter((b) => b.type === 'image').length;
    if (!count) return;
    // Publish after pushMessage adds the fitted images: the page can immediately fetch them via liveImage.
    const end = this.conversationImages().length;
    for (let n = end - count; n < end; n++) this.liveFeed.emit({ t: 'image', n });
  }
  systemPrompt(text, agent) { if (this.isMain(agent)) this.store.setSystemPrompt(text); }
  messagesReplaced(msgs, agent) {
    if (!this.isMain(agent)) return;
    this.store.reset(msgs);
    // The turn lines go with their messages: where the same message is (a rewind keeps a prefix, a partial compaction
    // the other part), or where they were when only messages' contents changed (cleared tool results, lighter images);
    // those of what was summarized go. Written again: the reset drops them from the file.
    const before = this.marksBase;
    this.marksBase = msgs;
    if (!this.turnMarks.length) return;
    const sameLength = before === msgs || before?.length === msgs.length;
    const kept = [];
    for (const m of this.turnMarks) {
      let at = msgs[m.after - 1] === m.msg ? m.after : msgs.indexOf(m.msg) + 1;
      if (!at && sameLength && m.after <= msgs.length) at = m.after;
      if (at > 0) kept.push({ after: at, text: m.text, msg: msgs[at - 1] });
    }
    this.turnMarks = kept.sort((a, b) => a.after - b.after);
    if (kept.length) this.store.setTurns(kept);
  }
  usage(_u, agent) {
    if (this.isMain(agent)) this.store.setCacheUntil(agent.cache.clockUntil, agent.cacheState()); // for a resumed or restarted conversation
    this.screen.schedule();
  }

  compactStart(auto, agent) {
    if (!this.isMain(agent)) return;
    this.flushStreaming();
    this.status = auto ? 'Auto-compacting conversation' : 'Compacting conversation';
    this.screen.schedule();
  }

  compactProgress(ev) {
    if (ev.type === 'text' || ev.type === 'thinking') { this.turnTokens += estimateTokens(ev.text); this.screen.schedule(); }
    // A compaction can hit the limit too: say so instead of sitting on "Compacting conversation" for hours.
    else if (ev.type === 'rate_limit_wait' || ev.type === 'rate_limit_resume') this.rateLimitEvent(ev);
  }

  compactEnd(_summary, agent, err, { part } = {}) {
    if (!this.isMain(agent)) return;
    this.status = null;
    if (err) return;
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
    // (as wide as the widest frame: where the terminal draws some of them in two cells, the text behind moved back and forth)
    const frame = padEnd(SPINNER[Math.floor(Date.now() / 120) % SPINNER.length], Math.max(...SPINNER.map(stringWidth)));
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
      if (this.thinking) lines.push(...this.thinking.partial().slice(-Math.floor(this.screen.height / 2)));
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
    const hint = this.hint();
    const after = this.editor.suggestions ? this.editor.renderSuggestions(w) : hint ? [hint] : [];
    // the input's text gets the screen less what is above and below it, and two rows of the conversation
    const maxRows = Math.max(3, this.screen.height - 1 - lines.length - after.length - 1 - 2);
    const r = this.editor.render(width, { placeholder, maxRows });
    const top = lines.length;
    lines.push(...r.lines);
    if (r.cursor) cursor = { row: top + r.cursor.row, col: r.cursor.col };
    lines.push(...after);
    return { lines, cursor };
  }

  // A line under the input, only while there is something to say that cannot wait for the end of the turn.
  hint() {
    if (this.exitArmed && Date.now() - this.exitArmed < 1500) return c.dim('  Press Ctrl-C again to exit');
    if (this.restartRequest) return c.dim(`  ${glyphs.restart} restarting when this turn ends`);
    if (this.updating) return c.blue(`  ${glyphs.update} updating ${APP_NAME} to ${this.updating}…`);
    if (this.updateRestart && this.sourceChanged) return c.blue(`  ${glyphs.restart} ${this.updateRestart} installed: restarts ${this.working() ? 'when the work is done' : 'now'}`);
    if (this.sourceChanged && !this.sourceChangedInTurn && !this.reloading && !this.working() && this.sourceQuietAt > Date.now()) return c.dim(`  ${glyphs.restart} source changed: restarts once it is left alone (/restart: now)`);
    return '';
  }
}

// App is written in parts, one file each (see the imports): their methods are its own, as if written in the class.
for (const part of [peerMethods, remoteMethods, restartMethods]) Object.defineProperties(App.prototype, Object.getOwnPropertyDescriptors(part));

export async function runRepl({ flags, cwd, initialPrompt }) {
  const app = new App({ flags, cwd });
  process.on('uncaughtException', (e) => {
    app.restoreTerminal();
    process.stderr.write(`\nUnexpected error: ${e?.stack || e}\n`);
    process.exit(1);
  });
  // A promise without a handler that rejects is a bug to show, not a reason to end the session: Node ends the process
  // on one by default (through the handler above, with exit code 1, which the supervisor does not restart).
  process.on('unhandledRejection', (e) => { try { app.logError(e); } catch { /* the screen is gone */ } });
  return await app.start(initialPrompt);
}
