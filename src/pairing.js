// Pairing two computers, as remote desktop programs pair: one shows a code, the other types it, and from then on they
// know each other (devices.js). Nothing else is needed: no account, no gateway key.
//
// The code has nine digits. The first three are where the two meet at the relay (the slot the computer showing the
// code holds there); the other six never leave the two computers: they run CPace (a PAKE, the one the IETF chose) over
// them. Whoever is in between, the relay included, learns nothing that lets it check a guess offline, and cannot take
// part without the code: a wrong code is one try, and the computer showing it allows three. Then each proves who it is
// (the Ed25519 key of its identity signs the exchange) and hands over its keys, sealed with the key the PAKE gave both.
//
// The computer showing the code (host): opens a slot, waits for a hello. The one typing it (joiner):
//   joiner → host  {t: hello, sid, Y}            sid: random; Y = y·G, G derived from the six digits, the slot and sid
//   host → joiner  {t: reply, Y, box}            box: its identity, sealed with the key from K = y·Y'
//   joiner → host  {t: confirm, box}             its identity (a joiner with a wrong code cannot open the host's box)
//   host → joiner  {t: done, box}                the host has added it; the joiner adds the host

import crypto from 'node:crypto';
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { RelayClient } from './relay.js';
import { deviceIdentity, idOf, signWith, verifyWith, addPaired, cleanDeviceName } from './devices.js';

const Point = ristretto255.Point;
const ORDER = Point.Fn.ORDER;
const DSI = 'CPaceRistretto255';
const TRIES = 3;
const STEP_MS = 30_000; // how long one side waits for the other's next message

// ---------------------------------------------------------------- the code

const lv = (...parts) => Buffer.concat(parts.flatMap((p) => { const b = Buffer.from(p); const len = Buffer.alloc(2); len.writeUInt16BE(b.length); return [len, b]; }));
export const formatCode = (code) => code.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
// The code as typed (spaces, dashes and other separators left out): {slot, secret}, or null.
export function parseCode(text) {
  const digits = String(text ?? '').replace(/[\s\-_.·]/g, '');
  return /^\d{9}$/.test(digits) ? { slot: digits.slice(0, 3), secret: digits.slice(3) } : null;
}

// ---------------------------------------------------------------- CPace

const randomScalar = () => {
  for (;;) {
    const s = BigInt(`0x${crypto.randomBytes(64).toString('hex')}`) % ORDER;
    if (s !== 0n) return s;
  }
};
const generator = (secret, slot, sid) => ristretto255_hasher.deriveToCurve(crypto.createHash('sha512').update(lv(DSI, secret, `claude-pro pair v1 ${slot}`, sid)).digest());
const decodePoint = (b64) => {
  const p = Point.fromBytes(Buffer.from(String(b64), 'base64url'));
  if (p.equals(Point.ZERO)) throw new Error('identity');
  return p;
};
// The key both get: from K and the exchange (joiner's Y first); and the two keys of the boxes, one each way.
function sessionKeys(K, sid, yJoiner, yHost) {
  if (K.equals(Point.ZERO)) throw new Error('identity');
  const isk = crypto.createHash('sha512').update(lv(`${DSI}_ISK`, sid, K.toBytes(), yJoiner, yHost)).digest();
  const sub = (label) => crypto.createHash('sha256').update(Buffer.concat([isk, Buffer.from(label)])).digest();
  return { isk, toJoiner: sub('host to joiner'), toHost: sub('joiner to host'), transcript: crypto.createHash('sha256').update(isk).digest('base64url') };
}
function box(key, obj) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64url');
}
function unbox(key, data) {
  try {
    const buf = Buffer.from(String(data), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8'));
  } catch { return null; }
}

// This computer as the other one gets it, its signature binding its key to this exchange.
function myCard(name, transcript, role) {
  const me = deviceIdentity();
  return { key: me.key, xkey: me.xkey, name: cleanDeviceName(name), sig: signWith(me.privateKey, `claude-pro pair ${role}\n${transcript}\n${me.key}\n${me.xkey}`) };
}
// The other computer from its card, checked: its key is the one the relay saw it send with, and it signed this exchange.
function checkCard(card, fromId, transcript, role) {
  if (!card || typeof card.key !== 'string' || typeof card.xkey !== 'string' || idOf(card.key) !== fromId) return null;
  if (!verifyWith(card.key, `claude-pro pair ${role}\n${transcript}\n${card.key}\n${card.xkey}`, card.sig)) return null;
  return { id: fromId, key: card.key, xkey: card.xkey, name: cleanDeviceName(card.name) };
}

const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const decode = (data) => { try { return JSON.parse(Buffer.from(String(data), 'base64url').toString('utf8')); } catch { return null; } };

// ---------------------------------------------------------------- the two sides

// A computer's own connection to the relay for the time of a pairing, its 'pair' frames handed to `onPair`.
async function connect(onPair, url) {
  const relay = new RelayClient({ ...(url ? { url } : {}), session: null, handlers: { pair: onPair } }).start();
  try { await relay.ready(); } catch (e) { relay.close(); throw e; }
  return relay;
}

// Show a code and wait for the other computer. `onCode(code, expiresAt)` gets it to show (nine digits). Resolves with
// the computer paired ({id, name, ...}); rejects when the code expires, is tried too often, or `signal` aborts.
export async function hostPairing({ name, onCode, signal, url } = {}) {
  let settle;
  const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const tries = new Map(); // joiner id -> {keys, timer}
  let failed = 0;
  let over = false;
  let slot = null;
  let secret = null;
  let relay = null;
  const finish = (error, value) => {
    if (over) return;
    over = true;
    for (const t of tries.values()) clearTimeout(t.timer);
    if (slot && relay) relay.request('POST', '/pair/close', { slot }).catch(() => {}).finally(() => relay.close());
    else relay?.close();
    if (error) settle.reject(error); else settle.resolve(value);
  };
  const wrong = (from) => {
    clearTimeout(tries.get(from)?.timer);
    tries.set(from, { done: true });
    if (++failed >= TRIES) finish(Object.assign(new Error('The code was tried with wrong digits too many times: get a new one.'), { code: 'TOO_MANY' }));
  };
  const reply = (to, obj) => relay.request('POST', '/pair/send', { slot, to, data: encode(obj) }, { retry: false });
  const onPair = (frame) => {
    if (over || frame.slot !== slot || typeof frame.from !== 'string') return;
    const msg = decode(frame.data);
    // (the same computer again, after a code typed wrong: the try before is a failed one, this is the next)
    if (msg?.t === 'hello' && tries.get(frame.from)?.keys) wrong(frame.from);
    if (over) return;
    const t = msg?.t === 'hello' ? null : tries.get(frame.from);
    try {
      if (msg?.t === 'hello') {
        const sid = Buffer.from(String(msg.sid), 'base64url');
        if (sid.length !== 16) return;
        const G = generator(secret, slot, sid);
        const y = randomScalar();
        const Y = G.multiply(y);
        const yJoiner = decodePoint(msg.Y);
        const keys = sessionKeys(yJoiner.multiply(y), sid, yJoiner.toBytes(), Y.toBytes());
        const timer = setTimeout(() => wrong(frame.from), STEP_MS);
        timer.unref?.();
        tries.set(frame.from, { keys, timer });
        reply(frame.from, { t: 'reply', Y: Buffer.from(Y.toBytes()).toString('base64url'), box: box(keys.toJoiner, myCard(name, keys.transcript, 'host')) }).catch(() => {});
      } else if (msg?.t === 'confirm' && t?.keys) {
        clearTimeout(t.timer);
        const card = checkCard(unbox(t.keys.toHost, msg.box), frame.from, t.keys.transcript, 'joiner');
        if (!card) { wrong(frame.from); return; }
        const added = addPaired(card);
        reply(frame.from, { t: 'done', box: box(t.keys.toJoiner, { ok: true }) }).catch(() => {});
        finish(null, { id: card.id, ...added });
      }
    } catch { if (t?.keys || msg?.t === 'hello') wrong(frame.from); }
  };
  relay = await connect(onPair, url);
  try {
    const opened = await relay.request('POST', '/pair/open', {});
    slot = opened.slot;
    secret = String(crypto.randomInt(1_000_000)).padStart(6, '0');
    const expire = setTimeout(() => finish(Object.assign(new Error('The code expired: get a new one.'), { code: 'EXPIRED' })), Math.max(0, opened.expiresAt - Date.now()));
    expire.unref?.();
    result.finally(() => clearTimeout(expire)).catch(() => {});
    onCode?.(`${slot}${secret}`, opened.expiresAt);
  } catch (e) { finish(e); }
  if (signal) {
    if (signal.aborted) finish(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    signal.addEventListener('abort', () => finish(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true });
  }
  return result;
}

// Type the code another computer shows. Resolves with the computer paired; rejects with what to tell the user.
export async function joinPairing({ code, name, signal, url } = {}) {
  const parsed = parseCode(code);
  if (!parsed) throw new Error('A pairing code is nine digits (the other computer shows it).');
  const { slot, secret } = parsed;
  const waiting = [];
  const next = (t) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t === 'reply' ? 'The other computer did not answer: check the code, and that it still shows it.' : 'The other computer did not finish the pairing.')), STEP_MS);
    timer.unref?.();
    waiting.push({ t, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  });
  const onPair = (frame) => {
    const msg = decode(frame.data);
    if (frame.slot !== slot || !msg) return;
    const i = waiting.findIndex((w) => w.t === msg.t);
    if (i >= 0) waiting.splice(i, 1)[0].resolve({ msg, from: frame.from });
  };
  const relay = await connect(onPair, url);
  const abort = () => { for (const w of waiting.splice(0)) w.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const sid = crypto.randomBytes(16);
    const G = generator(secret, slot, sid);
    const y = randomScalar();
    const Y = G.multiply(y);
    const replied = next('reply');
    try {
      await relay.request('POST', '/pair/send', { slot, data: encode({ t: 'hello', sid: sid.toString('base64url'), Y: Buffer.from(Y.toBytes()).toString('base64url') }) }, { retry: false });
    } catch (e) {
      throw e.status === 404 ? new Error('No computer is waiting with that code: check it, or get a new one (a code lasts 10 minutes).') : e.status === 429 ? new Error(e.message) : e;
    }
    const { msg, from } = await replied;
    const yHost = decodePoint(msg.Y);
    const keys = sessionKeys(yHost.multiply(y), sid, Y.toBytes(), yHost.toBytes());
    const host = checkCard(unbox(keys.toJoiner, msg.box), from, keys.transcript, 'host');
    if (!host) throw new Error('The code is not right (or the computer that answered is not the one showing it): check it and try again.');
    const done = next('done');
    await relay.request('POST', '/pair/send', { slot, data: encode({ t: 'confirm', box: box(keys.toHost, myCard(name, keys.transcript, 'joiner')) }) }, { retry: false });
    const fin = await done;
    if (fin.from !== from || !unbox(keys.toJoiner, fin.msg.box)?.ok) throw new Error('The other computer did not finish the pairing.');
    return { id: host.id, ...addPaired(host) };
  } finally {
    signal?.removeEventListener('abort', abort);
    relay.close();
  }
}
