// The App's talk with the other sessions (a part of App, see repl.js, which puts these methods on App.prototype):
// those of this computer directly (peers.js), those of the account's other computers through the gateway, whose
// tasks run once their computer is allowed here (devices.js), as a remote desktop program asks before a connection.

import path from 'node:path';
import { c, wordWrap } from './ansi.js';
import { SelectDialog } from './dialogs.js';
import { renderMarkdown } from './markdown.js';
import { displayPath } from '../utils/paths.js';
import { peersEnabled, PeerNode, cleanName, resolvePeer, machineName, peerMessagePrompt, findPeer } from '../peers.js';
import { verifyTask, readDeviceTrust, noteDeviceSeen, trustDevice } from '../devices.js';

const PEER_AUTH_TIMEOUT_MS = 10 * 60_000; // a task from another computer that nobody allowed in this time is declined

export const peerMethods = {
  // Register this session so that the other sessions on the machine can send it tasks. Not in the tests
  // (which drive the App themselves) and not with CLAUDE_PRO_PEERS=0.
  async startPeer() {
    if (this.driven || !peersEnabled()) return;
    try {
      const peer = new PeerNode({
        cwd: this.cwd,
        name: this.flags.restart?.peerName,
        id: this.flags.restart?.peerId,
        onMessage: (msg) => this.onPeerMessage(msg),
        getStatus: () => this.liveStatus(),
        live: { feed: this.liveFeed, command: (type, body) => this.pageCommand(type, body), image: (n) => this.liveImage(n) },
      });
      if (this.legacyHidden) {
        const handle = peer.handle.bind(peer);
        peer.handle = (req, res) => {
          if (req.method === 'POST' && req.url === '/message' && req.headers.authorization === `Bearer ${peer.token}`) {
            // PeerNode acknowledges before calling onMessage. Refuse at the endpoint, and do not move while an
            // already accepted request is still uploading its message.
            if (this.moving || this.exiting) {
              res.writeHead(503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session is moving or ending; try again.' }));
              return;
            }
            this.peerMessages = (this.peerMessages || 0) + 1;
            res.once('close', () => { this.peerMessages--; });
          }
          handle(req, res);
        };
      }
      await peer.start();
      if (this.exiting) peer.close();
      else this.peers = peer;
    } catch (e) {
      this.peers = null;
      this.notice(`Other sessions cannot reach this one: ${e.message}`, 'warn');
    }
  },

  // This session's name for the others.
  peerLabel() { return this.peers?.name || this.sessionName || cleanName(path.basename(this.cwd)) || 'claude-pro'; },

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
  },

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
        const offline = this.remote ? '' : ' Sessions on your other computers can be reached once this one is online at the gateway (/connect 7bit.fun).';
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
  },

  // The account's sessions on other computers that are online now, from the gateway (what was known stays when
  // it cannot be asked). Sessions of this computer are left out: they are reached directly.
  refreshRemotePeers() {
    if (!this.remote?.registered) return Promise.resolve(this.remotePeers);
    this.remotePeersLoading ??= (async () => {
      try {
        const near = new Set([this.peers?.id, ...(this.peers?.peers() || []).map((p) => p.id)].filter(Boolean));
        const own = await this.remote.sessions();
        this.remotePeers = own
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
  },

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
  },

  // A task from a session on another computer runs when that computer is trusted here (its signature checks out, see
  // devices.js), the session was allowed earlier for as long as it runs, or the user lets every session of the
  // account in (/devices policy account); otherwise the user is asked first, as a remote desktop program asks before
  // a connection. One question at a time for each sending session. Resolves with whether the task runs.
  authorizePeerTask(msg) {
    const f = msg.from;
    const device = verifyTask({ auth: msg.auth, device: f.device, to: msg.to, text: msg.text });
    const trust = readDeviceTrust();
    if (trust.policy === 'account') return Promise.resolve(true);
    if (device && Object.hasOwn(trust.devices, device)) { noteDeviceSeen(device, f.machine); return Promise.resolve(true); }
    const key = `${f.id}|${device || 'unidentified'}`;
    if (this.peerAllowed.has(key)) return Promise.resolve(true);
    if (!this.peerAuthPending.has(key)) {
      this.peerAuthPending.set(key, this.askPeerTask(msg, device, key).finally(() => this.peerAuthPending.delete(key)));
    }
    return this.peerAuthPending.get(key);
  },

  async askPeerTask(msg, device, key) {
    const f = msg.from;
    const me = `${machineName(this.config.env)}/${this.peerLabel()}`;
    // the sender is told that it waits (an older claude-pro, which signs nothing, would take a notice for a task)
    if (f.device) this.remote?.sendPeer(f.id, { kind: 'notice', text: `Delivered to ${me}: waiting for its user to allow the task.`, inReplyTo: msg.id }).catch(() => {});
    const preview = msg.text.length > 1200 ? `${msg.text.slice(0, 1200)}…` : msg.text;
    const who = device ? `device ${device.slice(0, 8)}`
      : f.device ? c.yellow('its signature does not check out: it may not be the computer it says')
        : 'an older claude-pro, which cannot be identified';
    const dialog = new SelectDialog({
      title: `Task from another computer: ${f.machine}`,
      body: [c.dim(`From the session @${f.name} (${who}):`), ...preview.split('\n').flatMap((line) => wordWrap(line, Math.max(20, this.width - 8))).slice(0, 20)],
      question: 'Let this session work on it? Its final answer is sent back.',
      color: c.yellow,
      options: [
        { label: 'Allow this connection', value: 'once', description: `This task, and later ones from @${f.name} while that session runs` },
        ...(device ? [{ label: `Always trust ${f.machine}`, value: 'always', description: 'The tasks of its sessions run without asking (/devices to revoke)' }] : []),
        { label: 'Decline', value: 'decline', description: 'They are told that you declined it' },
      ],
    });
    // (for the web console, which shows it at the top whatever page is open)
    dialog.peerAuth = { from: f.name, machine: f.machine, device: device || null, verified: Boolean(device), signed: Boolean(f.device), text: preview };
    const timer = setTimeout(() => dialog.resolve('timeout'), PEER_AUTH_TIMEOUT_MS);
    timer.unref?.();
    let choice;
    try { choice = await this.showDialog(dialog); } finally { clearTimeout(timer); }
    if (choice === 'always') {
      try { trustDevice(device, f.machine); } catch (e) { this.notice(`Could not save the trusted computer: ${e.message}`, 'warn'); }
    }
    if (choice === 'once' || choice === 'always') { this.peerAllowed.add(key); return true; }
    const timedOut = choice === 'timeout';
    this.screen.log(c.dim(`  ✉ ${timedOut ? 'Nobody answered: declined' : 'Declined'} the task from @${f.name}`), '');
    this.replyToPeer(msg, timedOut ? `Nobody at ${me} allowed this task within ${PEER_AUTH_TIMEOUT_MS / 60_000} minutes: it was not run.` : `The user of ${me} declined this task.`);
    return false;
  },

  onPeerMessage(msg) {
    if (this.exiting) return;
    if (msg.kind === 'notice') {
      // about a task this session sent: it waits for the user over there (the text is ours, not the other side's)
      this.screen.log(`${c.blue('✉')} ${c.bold(`@${msg.from.name}`)} ${c.dim('got the task: it waits for its user to allow it')}`, '');
      if (!this.userSentToPeers.has(`${msg.from.id}:${msg.inReplyTo}`)) this.agent.addReminder(`The claude-pro session ${msg.from.name} on another computer got your message; its user has to allow the task there before it runs, and its answer comes once it is done (or a refusal).`);
      return;
    }
    if (msg.kind === 'task' && msg.from.remote && !msg.authorized) {
      this.authorizePeerTask(msg).then((ok) => { if (ok) this.onPeerMessage({ ...msg, authorized: true }); }, (e) => this.logError(e));
      return;
    }
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
  },

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
  },

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
  },

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
  },

  // What `@name` in a message the user wrote stands for, told to the model: which session, and how to reach it.
  async peerMentions(prompt) {
    // (a colon at the end is punctuation)
    const refs = [...new Set([...String(prompt).matchAll(/(?:^|\s)@([^\s@"&，。;；：!！?？、)）]+)/gu)].map((m) => m[1].replace(/:+$/, '')).filter(Boolean))];
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
  },

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
      if (!q && atStart && !quiet) this.flash(this.remote ? 'No other session is running here or online at the gateway' : 'No other session is running on this computer');
      return null;
    }
    return { items, from: cursor - q.length - 1, to: cursor };
  },

  peerSuggestionItems(q) {
    const lq = q.toLowerCase();
    return [
      ...(this.peers?.peers() || []).filter((p) => p.name.toLowerCase().startsWith(lq))
        .map((p) => ({ value: '@' + p.name, label: `@${p.name}`, description: `session · this computer · ${displayPath(p.cwd, this.cwd)}` })),
      ...this.remotePeers.filter((p) => [p.label, p.name, p.machine].some((v) => v.toLowerCase().startsWith(lq)))
        .map((p) => ({ value: '@' + p.label, label: `@${p.label}`, description: `session · ${p.machine} · ${p.cwd}${p.busy ? ' · busy' : ''}` })),
    ];
  },
};
