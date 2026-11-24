// Tasks from the sessions on the account's other computers are authorized as a remote desktop program authorizes a
// connection. Each computer has an identity of its own (device.json: an Ed25519 key made on first use; the id is a
// hash of its public key) and signs the tasks it sends; the gateway passes the signature along. The computer that
// receives a task runs it when the sender's computer is one its user said to always trust (trusted-devices.json),
// or the sending session was allowed earlier for as long as it runs; otherwise its user is asked: allow this
// connection, always trust this computer, or decline. A signature that does not check out (or a task from an older
// claude-pro, which signs nothing) can only be allowed once. The user may instead let every session of the account
// in without asking (policy "account", how it was before 2026-11-24).
//
// Sessions of the same computer talk to each other directly (peers.js) and need none of this.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config.js';

const identityFile = () => path.join(CONFIG_DIR, 'device.json');
const trustFile = () => path.join(CONFIG_DIR, 'trusted-devices.json');
const SKEW_MS = 60 * 60_000; // how far a signature's time may be from this computer's clock
export const POLICIES = ['ask', 'account'];

const idOf = (key) => crypto.createHash('sha256').update(Buffer.from(String(key), 'base64url')).digest('base64url').slice(0, 22);
const digest = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
// what is signed: the session it is for (a signature does not work for another one), when, and the text
const payload = (to, at, text) => Buffer.from(`claude-pro peer task\n${to}\n${at}\n${digest(text)}`);

function writeFile(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

let identity = null;
// This computer's identity: {id, key (the public key, base64url), privateKey}. Made once, the first time it is needed:
// created exclusively, so that two processes starting together end up with the same one.
export function deviceIdentity() {
  if (identity) return identity;
  const file = identityFile();
  for (let attempt = 0; attempt < 20 && !identity; attempt++) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.publicKey && data?.privateKey) identity = { id: idOf(data.publicKey), key: data.publicKey, privateKey: crypto.createPrivateKey(data.privateKey) };
      else throw new Error('incomplete');
    } catch (e) {
      if (e.code === 'ENOENT') {
        const pair = crypto.generateKeyPairSync('ed25519');
        const data = { publicKey: pair.publicKey.export({ format: 'jwk' }).x, privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), createdAt: Date.now() };
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
          identity = { id: idOf(data.publicKey), key: data.publicKey, privateKey: pair.privateKey };
        } catch (err) { if (err.code !== 'EEXIST') throw err; }
      } else if (attempt < 19) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // another process is writing it
      } else {
        throw new Error(`${file} is damaged: delete it and this computer gets a new identity (computers that trusted it ask again)`);
      }
    }
  }
  return identity;
}

// The signature of a task for the session `to` at the gateway: {key, sig, at}.
export function signTask(to, text) {
  const me = deviceIdentity();
  const at = Date.now();
  return { key: me.key, sig: crypto.sign(null, payload(to, at, text), me.privateKey).toString('base64url'), at };
}

const seen = new Set(); // signatures already taken (the same task sent again)
// The sender's computer when `auth` is its valid signature of `text` for the session `to` and `device` is its id;
// null otherwise (unsigned, forged, too old, or taken already).
export function verifyTask({ auth, device, to, text }) {
  if (!auth || typeof auth !== 'object' || !device || typeof auth.key !== 'string' || typeof auth.sig !== 'string') return null;
  try {
    if (idOf(auth.key) !== device || !Number.isFinite(auth.at) || Math.abs(Date.now() - auth.at) > SKEW_MS) return null;
    if (seen.has(auth.sig)) return null;
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: auth.key }, format: 'jwk' });
    if (!crypto.verify(null, payload(to, auth.at, text), key, Buffer.from(auth.sig, 'base64url'))) return null;
    seen.add(auth.sig);
    if (seen.size > 2000) seen.delete(seen.values().next().value);
    return device;
  } catch { return null; }
}

// {policy, devices: {id: {name, trustedAt, lastSeen}}}
export function readDeviceTrust() {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(trustFile(), 'utf8')); } catch { /* none yet */ }
  const devices = data?.devices && typeof data.devices === 'object' && !Array.isArray(data.devices) ? data.devices : {};
  return { policy: POLICIES.includes(data?.policy) ? data.policy : 'ask', devices };
}

function updateTrust(change) {
  const data = readDeviceTrust();
  change(data);
  writeFile(trustFile(), data);
  return data;
}

export const deviceTrusted = (id) => Boolean(id && Object.hasOwn(readDeviceTrust().devices, id));

export function trustDevice(id, name) {
  if (!id) throw new Error('That computer cannot be identified (an older claude-pro): it can only be allowed once.');
  return updateTrust((d) => { d.devices[id] = { name: String(name || 'computer').slice(0, 80), trustedAt: Date.now(), lastSeen: Date.now() }; });
}

// Forget a trusted computer, by id (or the start of one) or by name. Returns the removed entries.
export function untrustDevice(ref) {
  const q = String(ref || '').trim().toLowerCase();
  if (!q) return [];
  let removed = [];
  updateTrust((d) => {
    const all = Object.entries(d.devices);
    let hits = all.filter(([id]) => id.toLowerCase() === q);
    if (!hits.length) hits = all.filter(([, v]) => String(v.name).toLowerCase() === q);
    if (!hits.length && q.length >= 4) hits = all.filter(([id]) => id.toLowerCase().startsWith(q));
    if (hits.length > 1 && !hits.every(([, v]) => String(v.name).toLowerCase() === q)) throw new Error(`"${ref}" could be ${hits.map(([id, v]) => `${v.name} (${id.slice(0, 8)})`).join(', ')}: give the id.`);
    for (const [id] of hits) delete d.devices[id];
    removed = hits.map(([id, v]) => ({ id, ...v }));
  });
  return removed;
}

export function noteDeviceSeen(id, name) {
  if (!deviceTrusted(id)) return;
  try { updateTrust((d) => { if (d.devices[id]) Object.assign(d.devices[id], { lastSeen: Date.now(), ...(name ? { name: String(name).slice(0, 80) } : {}) }); }); } catch { /* only a date */ }
}

export function setInboundPolicy(policy) {
  if (!POLICIES.includes(policy)) throw new Error(`The policy is ask (each computer is asked for, default) or account (every session of the account runs tasks here without asking).`);
  return updateTrust((d) => { d.policy = policy; });
}
