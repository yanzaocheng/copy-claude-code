// The App's connection to the gateway's session relay (remote.js) and what the web console's live view shows and
// sends (its status, dialogs, messages, images, the directory and suggestion lists). A part of App, see repl.js,
// which puts these methods on App.prototype.

import fs from 'node:fs';
import path from 'node:path';
import { c, stripAnsi } from './ansi.js';
import { renderToolResult, modelInfo } from './render.js';
import { defaultEffort } from '../api.js';
import { VERSION, CONFIG_DIR } from '../config.js';
import { gatewayLogin, normalizeGatewayUrl } from '../gateway.js';
import { webModelChoices, effortChoices } from '../commands.js';
import { listDirectory, recentDirectories } from '../utils/dirs.js';
import { formatClock } from '../ratelimit.js';
import { estimateTokens } from '../agent.js';
import { imageSize } from '../utils/images.js';
import { machineName } from '../peers.js';
import { onlineEnabled, RemoteControl, REMOTE_WIDTH } from '../remote.js';

// What the page may not send (see App.remoteSend): ending or restarting the session, or updating claude-pro (which
// restarts it), with or without arguments. The gateway uses the same pattern.
const TERMINAL_ONLY = /^\s*\/(exit|quit|restart|reload|update)(?:\s|$)/i;

// The images the remote page sends with a message ({media_type, data: base64}), checked as the API would: at most
// REMOTE_MAX_IMAGES, each a PNG, JPEG, GIF or WebP of at most 5 MB. Throws what to tell the page.
const REMOTE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
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

export const remoteMethods = {
  // The images of the user's messages, in order (what transcriptItems numbers {k: 'image', n}).
  conversationImages() {
    const out = [];
    for (const m of this.agent?.messages || []) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content) if (b.type === 'image') out.push(b);
    }
    return out;
  },

  // The n-th image of the conversation, for the web console: {mediaType, data (Buffer)} or null.
  liveImage(n) {
    const b = this.conversationImages()[n];
    return b?.source?.type === 'base64' ? { mediaType: b.source.media_type, data: Buffer.from(b.source.data, 'base64') } : null;
  },

  // Whether this session should be online at the gateway (see remote.js): whenever this computer is logged in to
  // it. CLAUDE_PRO_ONLINE=0 keeps it off (the self-check sets it); the tests, which drive the App themselves, go
  // online only with CLAUDE_PRO_ONLINE=1.
  onlineWanted() {
    const env = this.config.env;
    if (!onlineEnabled(env)) return false;
    if (this.driven && !/^(1|true|yes|on)$/i.test(env.CLAUDE_PRO_ONLINE || '')) return false;
    return Boolean(gatewayLogin(this.config.gatewayUrl));
  },

  // Online at the gateway from the start when this computer is logged in, and after a restart with the same
  // session id so that an already-open page keeps following it.
  autoStartRemote(restart) {
    const id = restart?.remote?.id || null;
    if (!id && !this.onlineWanted()) return;
    this.startRemote({ id }).catch((e) => {
      if (e.code === 'NO_GATEWAY_LOGIN') return;
      this.notice(`This session could not go online at the gateway: ${e.message}`, 'warn');
    });
  },

  // Connect this session to the gateway (see remote.js): the web page and the sessions on the account's other
  // computers reach it from then on. Needs the gateway login from /connect; throws
  // {code: 'NO_GATEWAY_LOGIN'} without it. A gateway that cannot be reached now is tried again in the background;
  // one that refuses the key throws, and that key is not tried again (see syncRemote).
  startRemote({ id } = {}) {
    if (this.remote) return Promise.resolve(this.remote);
    this.remoteStarting ??= this.connectRemote({ id }).finally(() => { this.remoteStarting = null; });
    return this.remoteStarting;
  },

  // Online or offline as this computer's gateway login is now: after /connect and /disconnect, and every few seconds (a
  // login or a logout in another window, another account). Resolves with the connection, or null.
  syncRemote() {
    if (this.exiting) return Promise.resolve(null);
    if (this.remoteStarting) return this.remoteStarting.catch(() => null);
    const login = gatewayLogin(this.config.gatewayUrl);
    const r = this.remote;
    // logged out, or another account: not this account's session any more
    if (r && (!login || login.apiKey !== r.apiKey || normalizeGatewayUrl(login.url || this.config.gatewayUrl) !== normalizeGatewayUrl(r.base))) this.stopRemote();
    if (this.remote) return Promise.resolve(this.remote);
    if (!login || login.apiKey === this.remoteRefused || !this.onlineWanted()) return Promise.resolve(null);
    return this.startRemote().catch((e) => {
      this.notice(`This session could not go online at the gateway: ${e.message}`, 'warn');
      return null;
    });
  },

  async connectRemote({ id }) {
    const login = gatewayLogin(this.config.gatewayUrl);
    if (!login) throw Object.assign(new Error(`this computer is not logged in to the gateway ${this.config.gatewayUrl} (/connect 7bit.fun connects it)`), { code: 'NO_GATEWAY_LOGIN' });
    const remote = new RemoteControl({
      gateway: { url: login.url || this.config.gatewayUrl, apiKey: login.apiKey },
      id,
      handlers: {
        info: () => ({
          name: this.peerLabel(), machine: machineName(this.config.env), peerId: this.peers?.id || null, title: this.sessionLabel() || '',
          cwd: (this.agent.cwd || this.cwd).replace(/\\/g, '/'), model: modelInfo(this.config).model, version: VERSION,
        }),
        // (what the other computers' sessions are shown, compared twice a second: only these, not remoteStatus)
        status: () => ({
          busy: this.isTurnRunning(), name: this.peerLabel(), title: this.sessionLabel() || path.basename(this.cwd),
          cwd: (this.agent?.cwd || this.cwd).replace(/\\/g, '/'), model: modelInfo(this.config).model,
        }),
        peerMessage: (msg) => this.moving || this.exiting ? false : this.onPeerMessage(msg),
        changed: () => {
          this.screen.schedule();
          if (remote.online && Date.now() - this.remotePeersAt > 10_000) this.refreshRemotePeers();
        },
        // The key was refused after the start (revoked on the web page, say): offline until the login changes.
        refused: () => {
          this.remoteRefused = login.apiKey;
          if (this.remote === remote) { this.remote = null; this.remotePeers = []; }
          this.notice('The gateway refused this computer\'s key: this session is offline there now (/connect 7bit.fun to enter another key).', 'warn');
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
  },

  stopRemote() {
    this.remote?.close();
    this.remote = null;
    this.remotePeers = [];
    this.screen.schedule();
  },

  // This session at the gateway (its session relay: tasks across computers), for /status: {text}.
  remoteState() {
    const r = this.remote;
    if (r) {
      const who = r.account ? ` as ${r.account}` : '';
      const text = r.online ? `${c.green('online')}${who}${c.dim(' · your other computers can send it tasks (/devices)')}` : r.registered ? c.yellow(`not connected now, retrying${who}`) : `connecting to ${r.base}${who}…`;
      return { text };
    }
    if (this.remoteStarting) return { text: 'connecting…' };
    const login = gatewayLogin(this.config.gatewayUrl);
    if (!login) return { text: c.dim(`offline: this computer is not logged in to the gateway ${this.config.gatewayUrl} (/connect 7bit.fun)`) };
    if (login.apiKey === this.remoteRefused) return { text: c.red('offline: the gateway refused this computer\'s key (/connect 7bit.fun to enter another)') };
    if (!onlineEnabled(this.config.env)) return { text: c.dim('offline (CLAUDE_PRO_ONLINE=0)') };
    return { text: c.dim('offline') };
  },

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
      background: this.backgroundWork(),
      restarting: Boolean(this.restartRequest || this.host?.restartWaits(this)),
      asking: this.dialogs.length > 0, // a question waits for an answer (the page reminds the user of it)
      conversationId: this.store.id,
      cost: Number(this.cost.toFixed(6)),
      context: { used: this.contextUsed(), window: cfg.model.contextWindow },
      kind: 'terminal',
    };
  },

  // The tokens the conversation takes now, as /context counts them: what the last request used and what came
  // since, or before any request an estimate (kept until the conversation changes: the status is asked for often).
  contextUsed() {
    const a = this.agent;
    if (a.lastContextTokens) return a.contextEstimate;
    // not built yet: the prompt is counted once git has answered in the background (building it here blocked on git)
    const ready = this.runtime.systemPromptReady?.() ?? true;
    const key = `${a.messages.length}|${this.runtime.tools.length}|${ready}`;
    if (this.contextGuess?.key !== key) {
      if (!ready) this.runtime.prepareSnapshot().then(() => this.screen.schedule());
      let used = 0;
      try { used = (ready ? estimateTokens(this.runtime.systemPrompt()) : 0) + estimateTokens(a.toolSchemas()) + estimateTokens(a.messages); } catch { /* 0 */ }
      this.contextGuess = { key, used };
    }
    return this.contextGuess.used;
  },

  // The dialog open in the terminal, for the page to answer (options by index: values need not be strings).
  remoteDialog() {
    const d = this.dialogs[0];
    if (!d) return null;
    d.remoteId ??= ++this.remoteDialogs;
    const base = { id: d.remoteId, title: d.title || '', question: d.question || '', body: d.body || [], markdown: d.markdown || null };
    if (!Array.isArray(d.options)) return base;
    return { ...base, multi: Boolean(d.multi), options: d.options.map((o) => ({ label: String(o.label ?? ''), description: o.description || '', other: o.value === '__other__' })) };
  },

  // The answer to the dialog the status showed the page (remoteDialog): {id, index}, {id, indices}, {id, text,
  // indices?} (its "other" option) or {id, cancel: true}.
  answerDialog({ id, index, indices, text, cancel } = {}) {
    // (the open one, or a computer asking to run a task, which the console shows whatever else is open)
    const d = this.dialogs.find((x, i) => x.remoteId === id && (i === 0 || x.peerAuth));
    if (!d) throw new Error('That question is no longer open.');
    if (cancel) { d.resolve(d.cancelValue); return {}; }
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
  },

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
    if (this.isTurnRunning() && value.trim().startsWith('/') && !this.modelSwitchAtPause(value.trim())) throw new Error('Commands wait until the current task is done (or stopped).');
    if (this.dialogs.length && !this.isTurnRunning()) throw new Error('A question is open: answer it first.');
    const queued = this.isTurnRunning();
    this.onSubmit(value, value, pictures);
    this.screen.schedule();
    return { queued };
  },

  // Esc: the turn stops, and the questions waiting for an answer are cancelled.
  remoteInterrupt() {
    for (const d of this.dialogs.splice(0)) d.resolve(d.cancelValue);
    this.interrupt();
    this.screen.schedule();
    return {};
  },

  // The page's model and effort menus, from the kept lists. The page sends /model or /effort with the choice.
  async remoteOptions() {
    const cfg = this.config;
    const [models, efforts] = await Promise.all([webModelChoices(cfg), effortChoices(cfg, { cached: true })]);
    const effortChosen = cfg.effortOverride || 'default';
    const { effort } = modelInfo(cfg);
    return {
      model: cfg.model.id,
      models,
      effort: effort || defaultEffort(cfg.model.id, cfg),
      efforts: efforts.options.map((o) => ({ ...o, ...(o.value === effortChosen ? { current: true } : {}) })),
    };
  },

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
  },

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
  },

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
  },

  // An event of the transcript, for the gateway's page and the local web console's live view (each takes its own copy).
  emitEvent(ev) {
    this.liveFeed.emit({ ...ev });
  },

  // What the local web console shows of this session: its list and the status under the live view.
  liveStatus() {
    let status = {};
    try { status = this.remoteStatus(); } catch { /* the basics below */ }
    // computers asking to run a task here (see askPeerTask): the console shows them at the top of every page
    const authRequests = this.dialogs.filter((d) => d.peerAuth).map((d) => ({
      id: (d.remoteId ??= ++this.remoteDialogs), ...d.peerAuth, options: d.options.map((o, index) => ({ index, value: o.value })),
    }));
    return { ...status, busy: this.working() || this.runningShells() > 0, turn: this.isTurnRunning(), sessionId: this.store?.id, pid: process.pid, hidden: this.hidden, authRequests };
  },

  // A command of the local web console's live view: the same ones the gateway's page sends (see remote.js).
  pageCommand(type, body = {}) {
    const handlers = {
      send: (b) => this.remoteSend(b.text, b.images),
      interrupt: () => this.remoteInterrupt(),
      dialog: (b) => this.answerDialog(b),
      options: () => this.remoteOptions(),
      suggest: (b) => this.remoteSuggest(b),
      list: (b) => this.remoteList(b),
      output: (b) => this.remoteOutput(b),
      end: (b) => this.pageEnd(b),
    };
    if (!Object.hasOwn(handlers, type)) throw new Error(`Unknown command: ${type}`);
    if (['send', 'interrupt', 'dialog', 'end'].includes(type)) {
      if (this.exiting) throw new Error('The session is ending.');
      if (this.moving) throw new Error('The session is moving into the web console; try again.');
    }
    return handlers[type](body);
  },

  // The web console only ends sessions it owns. The host process survives and the current HTTP request can reply.
  pageEnd({ force = false } = {}) {
    if (!this.host) throw new Error('请在对应的终端结束这个会话');
    if (!force && (this.working() || this.runningShells())) throw new Error('会话正在工作或有后台程序：先停止它们，或选择强制结束');
    this.exit(0);
    return { ending: true };
  },

  // A tool call finished (or was refused, or interrupted): its result on the remote page, once.
  remoteToolDone(entry) {
    if (!this.liveFeed.active || !entry.tu?.id || entry.remoteDone) return;
    entry.remoteDone = true;
    let lines = [];
    try { lines = renderToolResult(entry, { width: REMOTE_WIDTH, cwd: this.cwd }); } catch { /* shown without */ }
    this.emitEvent({ t: 'done', id: entry.tu.id, status: entry.result?.isError || entry.rejected ? 'error' : 'done', lines });
  },
};
