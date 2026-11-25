// This computer and the computers it is paired with, for the sessions on them to send each other tasks.
//
// Each computer has an identity of its own (device.json, made on first use): an Ed25519 key, which signs its requests
// to the relay and proves who it is when it pairs, and an X25519 key, with which two paired computers agree on the key
// that encrypts what they send each other. Its id is a hash of its Ed25519 public key.
//
// Two computers are paired once (pairing.js: a code shown on one, typed on the other), and remember each other in
// paired-devices.json: id, name, public keys, and how its tasks are taken here (run, or ask the user first). Nothing
// else lets a computer in: no account, no gateway key. What they send each other goes through the gateway's relay
// (relay.js) sealed here: AES-256-GCM with a key only the two of them can compute, so the relay can neither read it nor
// make one up. Sessions of the same computer talk to each other directly (peers.js) and need none of this.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config.js';

const identityFile = () => path.join(CONFIG_DIR, 'device.json');
const extraKeyFile = () => path.join(CONFIG_DIR, 'device-x25519.json'); // (the X25519 key of an identity made before it had one)
const pairedFile = () => path.join(CONFIG_DIR, 'paired-devices.json');
const seenFile = () => path.join(CONFIG_DIR, 'device-messages-seen.json');
const SKEW_MS = 60 * 60_000; // how old a message may be, or how far ahead of this computer's clock
export const MODES = ['run', 'ask'];

export const idOf = (key) => crypto.createHash('sha256').update(Buffer.from(String(key), 'base64url')).digest('base64url').slice(0, 22);

function writeFile(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A file made once, by whichever process gets there first (exclusively: two starting together end up with the same).
function once(file, make, read) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const got = read(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (got) return got;
      throw new Error('incomplete');
    } catch (e) {
      if (e.code === 'ENOENT') {
        const data = make();
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
          return read(data);
        } catch (err) { if (err.code !== 'EEXIST') throw err; }
      } else if (attempt < 19) {
        sleepSync(50); // another process is writing it
      } else {
        throw new Error(`${file} is damaged: delete it and this computer gets a new identity (it must be paired again)`);
      }
    }
  }
  throw new Error(`${file} could not be read`);
}

const x25519Pair = () => {
  const pair = crypto.generateKeyPairSync('x25519');
  return { xPublicKey: pair.publicKey.export({ format: 'jwk' }).x, xPrivateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) };
};

let identity = null;
// This computer: {id, key, privateKey (Ed25519), xkey, xPrivateKey (X25519)}; the keys as base64url, the private ones as
// KeyObjects.
export function deviceIdentity() {
  if (identity) return identity;
  const base = once(identityFile(), () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    return { publicKey: pair.publicKey.export({ format: 'jwk' }).x, privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), ...x25519Pair(), createdAt: Date.now() };
  }, (d) => (d?.publicKey && d?.privateKey ? d : null));
  const x = base.xPublicKey && base.xPrivateKey ? base : once(extraKeyFile(), x25519Pair, (d) => (d?.xPublicKey && d?.xPrivateKey ? d : null));
  identity = {
    id: idOf(base.publicKey), key: base.publicKey, privateKey: crypto.createPrivateKey(base.privateKey),
    xkey: x.xPublicKey, xPrivateKey: crypto.createPrivateKey(x.xPrivateKey),
  };
  return identity;
}

export const signWith = (privateKey, bytes) => crypto.sign(null, Buffer.from(bytes), privateKey).toString('base64url');
export function verifyWith(key, bytes, sig) {
  try {
    const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(bytes), publicKey, Buffer.from(String(sig), 'base64url'));
  } catch { return false; }
}

// The x-cp-device header of a request to the relay: this computer's key, the time, and its signature of the request.
export function relayAuth(method, url, body = '') {
  const me = deviceIdentity();
  const at = Date.now();
  const text = `claude-pro relay\n${method}\n${url}\n${at}\n${crypto.createHash('sha256').update(body || '').digest('hex')}`;
  return `${me.key}.${at}.${signWith(me.privateKey, text)}`;
}

// ---------------------------------------------------------------- paired computers

// {devices: {id: {name, key, xkey, pairedAt, lastSeen, mode}}, unpairs: {id: {xkey, at}}}: `unpairs`, the computers
// this one stopped pairing with whose own list may still have it (told when they can be reached).
export function readPaired() {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(pairedFile(), 'utf8')); } catch { /* none yet */ }
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const devices = {};
  for (const [id, d] of Object.entries(obj(data?.devices))) {
    if (typeof d?.key === 'string' && typeof d?.xkey === 'string' && idOf(d.key) === id) devices[id] = { ...d, mode: MODES.includes(d.mode) ? d.mode : 'run' };
  }
  return { devices, unpairs: obj(data?.unpairs) };
}

function updatePaired(change) {
  const data = readPaired();
  const result = change(data);
  writeFile(pairedFile(), data);
  keys.clear();
  return result;
}

export const pairedDevice = (id) => (id ? readPaired().devices[id] || null : null);
export const pairedIds = () => Object.keys(readPaired().devices).sort();

// After a pairing (pairing.js): the other computer, as it proved itself.
export function addPaired({ id, key, xkey, name }) {
  if (idOf(key) !== id) throw new Error('That computer\'s id does not match its key');
  return updatePaired((d) => {
    const before = d.devices[id];
    d.devices[id] = { name: cleanDeviceName(name), key, xkey, pairedAt: Date.now(), lastSeen: Date.now(), mode: before?.mode || 'run' };
    delete d.unpairs[id];
    return d.devices[id];
  });
}

export const cleanDeviceName = (name) => String(name ?? '').replace(/[\x00-\x1f\x7f-\x9f<>"]/g, ' ').trim().slice(0, 60) || 'computer';

// The paired computers that `ref` names: an id (or its first characters, 4 at least) or a name. Throws when it could be
// more than one.
export function findPaired(ref) {
  const q = String(ref ?? '').trim().toLowerCase();
  if (!q) return [];
  const all = Object.entries(readPaired().devices);
  let hits = all.filter(([id]) => id.toLowerCase() === q);
  if (!hits.length) hits = all.filter(([, v]) => v.name.toLowerCase() === q);
  if (!hits.length && q.length >= 4) hits = all.filter(([id]) => id.toLowerCase().startsWith(q));
  if (hits.length > 1) throw new Error(`"${ref}" could be ${hits.map(([id, v]) => `${v.name} (${id.slice(0, 8)})`).join(', ')}: give the id.`);
  return hits.map(([id, v]) => ({ id, ...v }));
}

// Stop pairing with a computer (`notify`: it is told, so that it drops this one too: see takeUnpairs). Returns the
// removed entries.
export function removePaired(ref, { notify = true } = {}) {
  const hits = findPaired(ref);
  if (!hits.length) return [];
  updatePaired((d) => {
    for (const h of hits) {
      delete d.devices[h.id];
      if (notify) d.unpairs[h.id] = { xkey: h.xkey, at: Date.now() };
    }
  });
  return hits;
}

export function setPairedMode(ref, mode) {
  if (!MODES.includes(mode)) throw new Error('The mode is run (its tasks run at once) or ask (you are asked about each).');
  const hits = findPaired(ref);
  if (!hits.length) return [];
  updatePaired((d) => { for (const h of hits) d.devices[h.id].mode = mode; });
  return hits.map((h) => ({ ...h, mode }));
}

export function notePairedSeen(id, name) {
  const d = pairedDevice(id);
  if (!d) return;
  const clean = name ? cleanDeviceName(name) : d.name;
  if (Date.now() - (d.lastSeen || 0) < 60_000 && clean === d.name) return; // (not a write for every message)
  try { updatePaired((all) => { if (all.devices[id]) Object.assign(all.devices[id], { lastSeen: Date.now(), name: clean }); }); } catch { /* only a date */ }
}

// The computers still to be told that this one is not paired with them any more (older than a week: given up).
export function pendingUnpairs() {
  const week = Date.now() - 7 * 24 * 3600_000;
  return Object.entries(readPaired().unpairs).filter(([, u]) => u && typeof u.xkey === 'string' && u.at > week).map(([id, u]) => ({ id, xkey: u.xkey }));
}
export function unpairSent(id) {
  try { updatePaired((d) => { delete d.unpairs[id]; }); } catch { /* told again next time */ }
}

// ---------------------------------------------------------------- sealing what is sent

const keys = new Map(); // `${id}|${xkey}` -> the AES key shared with that computer
function sharedKey(id, xkey) {
  const cacheKey = `${id}|${xkey}`;
  let k = keys.get(cacheKey);
  if (!k) {
    const me = deviceIdentity();
    const theirs = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: xkey }, format: 'jwk' });
    const secret = crypto.diffieHellman({ privateKey: me.xPrivateKey, publicKey: theirs });
    // (both compute the same: the two ids in one order)
    const salt = Buffer.from([me.id, id].sort().join('|'));
    k = Buffer.from(crypto.hkdfSync('sha256', secret, salt, Buffer.from('claude-pro relay v1'), 32));
    keys.set(cacheKey, k);
  }
  return k;
}

// `obj` sealed for the computer `id` (paired, or `xkey` given: a computer told it is not paired any more): base64url
// of nonce, ciphertext and tag. The direction is part of it: what this computer sent cannot be handed back to it as the
// other's.
export function seal(id, obj, xkey = pairedDevice(id)?.xkey) {
  if (!xkey) throw new Error('That computer is not paired with this one');
  const me = deviceIdentity();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sharedKey(id, xkey), nonce);
  cipher.setAAD(Buffer.from(`${me.id}>${id}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
}

// What the computer `id` sealed for this one, or null (not paired, damaged, or not for this computer).
export function unseal(id, data) {
  const d = pairedDevice(id);
  if (!d || typeof data !== 'string') return null;
  try {
    const me = deviceIdentity();
    const buf = Buffer.from(data, 'base64url');
    if (buf.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKey(id, d.xkey), buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${id}>${me.id}`));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]).toString('utf8'));
  } catch { return null; }
}

// A message is taken once: the relay could hand the same sealed message over again. What was taken is kept, by its id,
// for as long as its time would still be accepted: in this process and in a file, so that a restart (they are
// frequent: new code, an update) does not forget it. False for a message taken already or too old.
const seen = new Map();
export function takeMessage(id, at) {
  const now = Date.now();
  if (typeof id !== 'string' || !id || !Number.isFinite(at) || Math.abs(now - at) > SKEW_MS) return false;
  const fresh = (t) => Math.abs(now - t) <= SKEW_MS + 60_000;
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(seenFile(), 'utf8')) || {}; } catch { /* none yet */ }
  if (seen.has(id) || Object.hasOwn(stored, id)) return false;
  for (const [k, t] of seen) if (!fresh(t)) seen.delete(k);
  seen.set(id, at);
  const kept = Object.fromEntries(Object.entries(stored).filter(([, t]) => Number.isFinite(t) && fresh(t)));
  kept[id] = at;
  try { writeFile(seenFile(), kept); } catch { /* remembered in this process at least */ }
  return true;
}
