// Files between the sessions of a gateway account (see remote.js): resumable uploads in chunks, and downloads that
// continue with Range requests, so that a 2 GB video survives a network outage. Nothing holds a whole file in
// memory: uploads read a chunk at a time, downloads stream to a .part file in the target folder.
//
// Upload: POST /v1/remote/uploads {name, size, sha256} -> {id, received, chunkSize} (the same unfinished upload
// again for the same file: sending it again later continues it), then PUT /v1/remote/uploads/:id with
// x-upload-offset = received, one chunk at a time, until {complete: true, file}. A 409 says where the gateway is.
// Download: GET /v1/remote/files/:id, with Range: bytes=N- to continue; checked against its sha256 at the end.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeFileName } from './utils/downloads.js';

const CHUNK = 8 * 1024 * 1024;
const MIN_CHUNK = 256 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
export const RETRY_FOR_MS = 60 * 60 * 1000; // keep trying through a network outage this long
const IDLE_MS = 60_000; // a download that receives nothing this long is cut, and continued

const abortError = () => Object.assign(new Error('stopped'), { name: 'AbortError' });

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// What is worth waiting out: no answer at all (the network), a timeout, the gateway overloaded or restarting. Not
// a gateway out of disk space (507) or one that lacks the feature (501): waiting an hour would not change that.
export const transient = (e) => e?.name !== 'AbortError' && (!e?.status || (e.status >= 500 && e.status !== 501 && e.status !== 507) || e.status === 429 || e.status === 408);

const signalWith = (signal, ms) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

// One request to the gateway; a failure carries {status, data} (data: the JSON of the error, when there is one).
async function api(client, method, route, { json, body, headers = {}, timeout = 30_000, signal } = {}) {
  let res;
  try {
    res = await client.fetch(`${client.base}${route}`, {
      method,
      headers: { authorization: `Bearer ${client.apiKey}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: signalWith(signal, timeout),
    });
  } catch (e) {
    if (signal?.aborted) throw abortError();
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || (typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`);
    const missing = res.status === 404 && /\/uploads$/.test(route) ? `the gateway ${client.base} does not take files (yet)` : null;
    throw Object.assign(new Error(missing || String(message)), { status: res.status, data });
  }
  return data;
}

export async function hashFile(file, { signal, onProgress } = {}) {
  const hash = crypto.createHash('sha256');
  let done = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20, signal })) {
    hash.update(chunk);
    done += chunk.length;
    onProgress?.(done);
  }
  return hash.digest('hex');
}

// Put the file `{path, name, size}` on the gateway: resolves with {id, name, size, sha256}, the id a message's
// files refer to. onProgress({phase: 'hashing'|'sending'|'waiting', done, total, error, retryIn}).
export async function uploadFile(client, file, { signal, onProgress = () => {}, retryForMs = RETRY_FOR_MS } = {}) {
  const { size } = file;
  onProgress({ phase: 'hashing', done: 0, total: size });
  const sha256 = await hashFile(file.path, { signal, onProgress: (done) => onProgress({ phase: 'hashing', done, total: size }) });
  let failingSince = 0;
  let wait = 1000;
  // A failure worth waiting out: wait (1 s, 2 s... 30 s), for an hour at most since the last thing that worked.
  const waitOut = async (e, done) => {
    if (signal?.aborted) throw abortError();
    if (!transient(e)) throw e;
    failingSince ||= Date.now();
    if (Date.now() - failingSince > retryForMs) throw e;
    onProgress({ phase: 'waiting', done, total: size, error: e.message, retryIn: wait });
    await sleep(wait, signal);
    wait = Math.min(wait * 2, 30_000);
  };
  const start = async () => {
    for (;;) {
      try { return await api(client, 'POST', '/v1/remote/uploads', { json: { name: file.name, size, sha256 }, signal }); } catch (e) { await waitOut(e, 0); }
    }
  };
  let up = await start();
  if (up.complete && up.file) return up.file;
  const chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Number(up.chunkSize) || CHUNK));
  let received = Number(up.received) || 0;
  let restarts = 0;
  const fd = fs.openSync(file.path, 'r');
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      try {
        const len = Math.max(0, Math.min(chunkSize, size - received));
        const chunk = Buffer.alloc(len);
        if (len) fs.readSync(fd, chunk, 0, len, received);
        const r = await api(client, 'PUT', `/v1/remote/uploads/${encodeURIComponent(up.id)}`, {
          body: chunk, headers: { 'content-type': 'application/octet-stream', 'x-upload-offset': String(received) },
          timeout: 60_000 + Math.ceil(len / 50), signal, // at least 50 KB/s
        });
        received = Number(r.received) || received + len;
        failingSince = 0;
        wait = 1000;
        onProgress({ phase: 'sending', done: received, total: size });
        if (r.complete && r.file) return r.file;
      } catch (e) {
        if (e.status === 409 && Number.isFinite(Number(e.data?.received))) {
          // the gateway has more (or less) than was thought: a chunk cut off midway counted in part
          received = Number(e.data.received);
          if (e.data.complete && e.data.file) return e.data.file;
          if (received >= size) {
            const st = await api(client, 'GET', `/v1/remote/uploads/${encodeURIComponent(up.id)}`, { signal });
            if (st.complete && st.file) return st.file;
          }
          continue;
        }
        if (e.status === 404 && restarts < 3) { // the gateway dropped it (expired): start over
          restarts++;
          up = await start();
          if (up.complete && up.file) return up.file;
          received = Number(up.received) || 0;
          continue;
        }
        if (e.status === 422) throw new Error(`${file.name} changed while it was being sent (checksum): send it again`);
        await waitOut(e, received);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Move `part` into `dir` as `name`, or "name (1).ext"... when that is taken: never over an existing file.
export function moveUnique(part, dir, name) {
  const safe = safeFileName(name);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const target = path.join(dir, i ? `${stem} (${i})${ext}` : safe);
    try {
      fs.linkSync(part, target); // fails when the name is taken, unlike a rename
      fs.unlinkSync(part);
      return target;
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      if (fs.existsSync(target)) continue;
      fs.renameSync(part, target); // a file system without hard links
      return target;
    }
  }
  throw new Error(`too many files called ${safe} in ${dir}`);
}

// Copy a file of this computer into `dir` (a session on the same computer sent it), never over an existing file.
export async function copyUnique(src, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const safe = safeFileName(name);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const target = path.join(dir, i ? `${stem} (${i})${ext}` : safe);
    try {
      await fs.promises.copyFile(src, target, fs.constants.COPYFILE_EXCL);
      return target;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`too many files called ${safe} in ${dir}`);
}

// The file `{id, name, size, sha256}` from the gateway into `dir`: resolves with the path it was saved at. It
// streams into a .part file named after the file's id, which a later attempt (after a restart too) continues.
export async function downloadFile(client, file, dir, { signal, onProgress = () => {}, retryForMs = RETRY_FOR_MS } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, `.${String(file.id).replace(/[^\w-]/g, '_')}.claude-pro-part`);
  const total = Number(file.size) || 0;
  try {
    const { bavail, bsize } = fs.statfsSync(dir);
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (total - have > bavail * bsize) throw new Error(`not enough free space in ${dir} (${Math.round(total / 1048576)} MB needed)`);
  } catch (e) {
    if (/free space/.test(e.message)) throw e; // statfs itself not available: just try
  }
  let failingSince = 0;
  let wait = 1000;
  let fresh = false; // started over once after a checksum failure
  for (;;) {
    if (signal?.aborted) throw abortError();
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have > total && total) { fs.truncateSync(part, 0); have = 0; }
    try {
      if (have < total || !fs.existsSync(part)) {
        const idle = new AbortController();
        let timer = setTimeout(() => idle.abort(), IDLE_MS);
        const res = await client.fetch(`${client.base}/v1/remote/files/${encodeURIComponent(file.id)}`, {
          headers: { authorization: `Bearer ${client.apiKey}`, ...(have ? { range: `bytes=${have}-` } : {}) },
          signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal,
        });
        if (!res.ok && res.status !== 206) {
          const data = await res.json().catch(() => ({}));
          throw Object.assign(new Error(data?.error?.message || `HTTP ${res.status}`), { status: res.status });
        }
        if (have && res.status !== 206) have = 0; // the range was not honoured: from the start
        let done = have;
        const count = new Transform({
          transform(chunk, _enc, cb) {
            clearTimeout(timer);
            timer = setTimeout(() => idle.abort(), IDLE_MS);
            done += chunk.length;
            onProgress({ phase: 'receiving', done, total });
            cb(null, chunk);
          },
        });
        try {
          await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(part, { flags: have ? 'a' : 'w' }));
        } finally {
          clearTimeout(timer);
        }
      }
      const got = fs.statSync(part).size;
      if (total && got < total) throw Object.assign(new Error('the download stopped early'), { status: 0 });
      if (file.sha256) {
        onProgress({ phase: 'checking', done: got, total });
        if ((await hashFile(part, { signal })) !== String(file.sha256).toLowerCase()) {
          fs.rmSync(part, { force: true });
          if (fresh) throw new Error(`${file.name} arrived damaged twice (checksum)`);
          fresh = true;
          continue;
        }
      }
      return moveUnique(part, dir, file.name);
    } catch (caught) {
      if (signal?.aborted) throw abortError();
      // cut for receiving nothing for a while: the network, not the user
      const e = caught?.name === 'AbortError' ? Object.assign(new Error('nothing arrived for a minute'), { status: 0 }) : caught;
      if (!transient(e)) throw e;
      const now = fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (now > have) { failingSince = 0; wait = 1000; } // it got further: the hour starts again
      failingSince ||= Date.now();
      if (Date.now() - failingSince > retryForMs) throw e;
      onProgress({ phase: 'waiting', done: now, total, error: e.message, retryIn: wait });
      await sleep(wait, signal);
      wait = Math.min(wait * 2, 30_000);
    }
  }
}
