// Peers: the other interactive claude-pro sessions on this machine. Each session registers itself in
// CONFIG_DIR/peers/<id>.json (name, directory, pid, and a port and token of a small HTTP server on 127.0.0.1)
// so that sessions can send each other tasks: the user with `@name task` in the input box, the model with the
// MessagePeer tool. A task is answered automatically with the final text of the turn that handled it.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config.js';

export const PEERS_DIR = path.join(CONFIG_DIR, 'peers');
const MAX_BODY = 2_000_000;

export function peersEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(env.CLAUDE_PRO_PEERS || '');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export const cleanName = (s) => String(s || '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'agent';

// The sessions that are running now (stale entries of sessions that died are removed).
export function listPeers({ excludeId } = {}) {
  let files = [];
  try { files = fs.readdirSync(PEERS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const peers = [];
  for (const f of files) {
    const file = path.join(PEERS_DIR, f);
    let p;
    try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!p?.id || !p.port || !alive(p.pid)) { try { fs.unlinkSync(file); } catch { /* ignore */ } continue; }
    if (p.id !== excludeId) peers.push(p);
  }
  return peers.sort((a, b) => a.startedAt - b.startedAt);
}

export function findPeer(peers, ref) {
  const q = String(ref || '').replace(/^@/, '').toLowerCase();
  if (!q) return null;
  return peers.find((p) => p.name.toLowerCase() === q) || peers.find((p) => p.id.startsWith(q)) || null;
}

export class PeerNode {
  // onMessage(msg): msg = {id, kind: 'task'|'reply', text, inReplyTo, from: {id, name, cwd}}
  // `id`: the id this session had before a restart, so that answers on their way still find it.
  constructor({ cwd, name, id, onMessage }) {
    this.cwd = cwd;
    this.wantedName = name || null;
    this.onMessage = onMessage;
    this.id = /^[0-9a-f]{12}$/.test(id || '') ? id : crypto.randomBytes(6).toString('hex');
    this.token = crypto.randomBytes(16).toString('hex');
    this.name = null;
    this.server = null;
    this.port = null;
  }

  get file() { return path.join(PEERS_DIR, `${this.id}.json`); }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.server.unref();
    this.port = this.server.address().port;
    this.setName(this.wantedName || path.basename(this.cwd) || 'agent');
    return this;
  }

  // Take `name`, or name-2, name-3... when another live session has it. Returns the name taken.
  setName(name) {
    const base = cleanName(name);
    const taken = new Set(listPeers({ excludeId: this.id }).map((p) => p.name.toLowerCase()));
    let n = base;
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base}-${i}`;
    this.name = n;
    this.write();
    return n;
  }

  setCwd(cwd) {
    if (cwd === this.cwd) return;
    this.cwd = cwd;
    this.write();
  }

  write() {
    if (!this.port) return;
    fs.mkdirSync(PEERS_DIR, { recursive: true });
    const data = { id: this.id, name: this.name, cwd: this.cwd, pid: process.pid, port: this.port, token: this.token, startedAt: this.startedAt ??= Date.now() };
    fs.writeFileSync(this.file, JSON.stringify(data));
  }

  peers() { return listPeers({ excludeId: this.id }); }

  close() {
    try { fs.unlinkSync(this.file); } catch { /* ignore */ }
    try { this.server?.close(); } catch { /* ignore */ }
    this.port = null;
  }

  handle(req, res) {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/message') return reply(404, { error: 'not found' });
    if (req.headers.authorization !== `Bearer ${this.token}`) return reply(401, { error: 'bad token' });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { return reply(400, { error: 'bad json' }); }
      if (typeof msg?.text !== 'string' || !msg.from?.name) return reply(400, { error: 'text and from are required' });
      const id = crypto.randomBytes(4).toString('hex');
      reply(200, { ok: true, id, name: this.name });
      try { this.onMessage?.({ id, kind: msg.kind === 'reply' ? 'reply' : 'task', text: msg.text, inReplyTo: msg.inReplyTo || null, from: msg.from }); } catch { /* the receiver's problem */ }
    });
  }

  // Send to a peer (an entry of peers(), or its name). Resolves with {id} (the id the receiver gave the message).
  async send(target, { text, kind = 'task', inReplyTo = null }) {
    const peer = typeof target === 'string' ? findPeer(this.peers(), target) : target;
    if (!peer) throw new Error(`No running session called "${target}". /peers lists them.`);
    const body = JSON.stringify({ kind, text, inReplyTo, from: { id: this.id, name: this.name, cwd: this.cwd } });
    return await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: peer.port, path: '/message', method: 'POST', timeout: 10_000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${peer.token}` },
      }, (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { out += d; });
        res.on('end', () => {
          let data = {};
          try { data = JSON.parse(out); } catch { /* ignore */ }
          if (res.statusCode !== 200) reject(new Error(`${peer.name} refused the message: ${data.error || res.statusCode}`));
          else resolve({ id: data.id, peer });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`${peer.name} did not answer`)));
      req.on('error', (e) => reject(new Error(`Could not reach ${peer.name}: ${e.message}`)));
      req.end(body);
    });
  }
}

// What the model is given for a message from another session.
export function peerMessagePrompt(msg) {
  const from = `${msg.from.name}${msg.from.cwd ? ` (working in ${msg.from.cwd})` : ''}`;
  if (msg.kind === 'reply') {
    return `<peer-message from="${msg.from.name}" kind="reply">\n${msg.text}\n</peer-message>\n<system-reminder>This is the answer of another ${'claude-pro'} session, ${from}, to a message you sent it with MessagePeer. Carry on with your task using it.</system-reminder>`;
  }
  return `<peer-message from="${msg.from.name}" kind="task">\n${msg.text}\n</peer-message>\n<system-reminder>This task was sent to you by another claude-pro session, ${from}, not typed by your user. Do it as you would a request of the user. The final text of your answer is sent back to ${msg.from.name} automatically, so end with a self-contained report of what you did or found.</system-reminder>`;
}
