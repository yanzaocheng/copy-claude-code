// The console's side of its page's terminals (the 终端 tabs, js/dock-terminal.js). They run in pty-host.js, a process
// of their own that outlives the console's restarts; this module finds it (started with the first terminal), says what
// each terminal runs, where and with which environment, and passes the page's requests and each screen's stream
// through. A host started by older code is used as long as something runs in it, and replaced once nothing does.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, onPath } from '../utils/proc.js';
import { CONFIG_DIR } from '../config.js';
import { findShell } from '../utils/shell.js';
import { httpError } from './data.js';

const isWin = process.platform === 'win32';
const HOST_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pty-host.js');
const PROTOCOL = 1;
const stateFile = () => path.join(CONFIG_DIR, 'web-pty.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostCode = () => { try { return crypto.createHash('sha1').update(fs.readFileSync(HOST_FILE)).digest('hex').slice(0, 12); } catch { return ''; } };
// what the page's xterm is told about a Windows pseudo console (how it reflows lines)
const windowsPty = isWin ? { backend: 'conpty', buildNumber: Number(os.release().split('.')[2]) || 0 } : null;

// ---------------------------------------------------------------- the shells offered

let shellList = null;
export function shells() {
  if (shellList) return shellList;
  const list = [];
  const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  if (isWin) {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const pwsh = onPath('pwsh.exe');
    list.push({ id: 'powershell', label: 'PowerShell', file: exists(pwsh) ? pwsh : path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] });
    list.push({ id: 'cmd', label: 'cmd', file: process.env.ComSpec || path.join(sys, 'System32', 'cmd.exe'), args: [] });
    const bash = findShell();
    if (bash.kind === 'bash' && exists(bash.path)) list.push({ id: 'gitbash', label: 'Git Bash', file: bash.path, args: ['--login', '-i'] });
  } else {
    const seen = new Set();
    for (const f of [process.env.SHELL, '/bin/zsh', '/bin/bash', '/usr/bin/fish', '/bin/sh']) {
      if (!f || !exists(f) || seen.has(path.basename(f))) continue;
      seen.add(path.basename(f));
      list.push({ id: path.basename(f), label: path.basename(f), file: f, args: path.basename(f) === 'sh' ? [] : ['-l'] });
    }
  }
  return (shellList = list);
}

// What a terminal starts with: the console's environment, without what makes a process part of claude-pro (the
// console's own colour setting for the page, the marks of a session's child when a session started the console).
function terminalEnv() {
  const env = { ...process.env };
  for (const k of ['FORCE_COLOR', 'CLAUDE_PRO_BACKGROUND', 'CLAUDE_PRO_SUPERVISED', 'CLAUDE_PRO_RESTART_FILE', 'CLAUDE_PRO_RESTARTED']) delete env[k];
  if (env.CLAUDE_PRO === '1') for (const k of ['CLAUDE_PRO', 'NO_COLOR', 'GIT_EDITOR', 'GIT_PAGER', 'PAGER']) delete env[k];
  return Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'claude-pro' });
}

// ---------------------------------------------------------------- the host process

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return s && Number.isInteger(s.port) && typeof s.token === 'string' ? s : null;
  } catch { return null; }
}

function request(state, method, p, body, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: state.port, method, path: p, timeout,
      headers: { authorization: `Bearer ${state.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { /* not JSON */ }
        if (res.statusCode >= 400) reject(httpError(res.statusCode === 401 ? 502 : res.statusCode, json?.error || `terminal host: ${res.statusCode}`));
        else resolve(json);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('terminal host did not answer'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(Object.assign(e, { unreachable: true })));
    req.end(data || undefined);
  });
}

let current = null; // the host in use: its state
let starting = null;

async function answering(state) {
  if (!state) return null;
  try {
    const hello = await request(state, 'GET', '/hello', undefined, { timeout: 1500 });
    return hello?.v === PROTOCOL ? { ...state, hello } : null;
  } catch { return null; }
}

// The host, started when `start` and none answers. One of older code is replaced when nothing runs in it.
async function hostFor(start) {
  if (current) return current;
  if (starting) return starting;
  let s = await answering(readState());
  if (s && start && s.hello.code !== hostCode() && !s.hello.terminals) {
    await request(s, 'POST', '/quit', {}).catch(() => {});
    for (let i = 0; i < 30 && (await answering(s)); i++) await sleep(100);
    s = null;
  }
  if (s) return (current = s);
  if (!start) return null;
  starting = (async () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const child = spawn(process.execPath, [HOST_FILE, stateFile()], { cwd: os.homedir(), detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    let ended = false;
    child.on('error', () => { ended = true; });
    child.on('exit', () => { ended = true; });
    child.unref();
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      await sleep(100);
      // (another console's host may have won the race: any that answers will do)
      const alive = await answering(readState());
      if (alive) return (current = alive);
      if (ended) break;
    }
    // what it said before it ended: the last error of its log
    const logFile = path.join(CONFIG_DIR, 'web-pty.log');
    let why = '';
    try { why = fs.readFileSync(logFile, 'utf8').trim().split('\n').reverse().find((l) => /^\d{4}-/.test(l))?.replace(/^\S+ \[\d+\] /, '') || ''; } catch { /* no log */ }
    throw httpError(500, `终端服务没有启动${why ? `：${why.slice(0, 300)}` : ''}（详见 ${logFile}）`);
  })().finally(() => { starting = null; });
  return starting;
}

// A request to the host; one that finds it gone looks for it again once (it ended: idle, or a newer one took over).
async function call(method, p, body, { start = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const s = await hostFor(start);
    if (!s) throw httpError(404, '这个终端已经关闭');
    try { return await request(s, method, p, body); } catch (e) {
      if (!e.unreachable || attempt) throw e.unreachable ? httpError(502, '终端服务没有回应') : e;
      if (current === s) current = null;
    }
  }
}

// ---------------------------------------------------------------- what the API does

export async function listTerminals() {
  const s = await hostFor(false);
  let terminals = [];
  if (s) {
    try { terminals = (await request(s, 'GET', '/terminals')).terminals || []; } catch (e) {
      if (!e.unreachable) throw e;
      if (current === s) current = null;
    }
  }
  return { terminals, shells: shells().map(({ id, label }) => ({ id, label })), windowsPty };
}

export async function createTerminal(body) {
  const raw = typeof body?.cwd === 'string' ? body.cwd : '';
  if (!raw || !path.isAbsolute(raw)) throw httpError(400, '无效的目录');
  const cwd = path.resolve(raw);
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); } catch { throw httpError(404, `目录不存在：${cwd}`); }
  const list = shells();
  const sh = list.find((x) => x.id === body.shell) || list[0];
  if (!sh) throw httpError(409, '这台电脑上没有找到可用的 shell');
  const env = terminalEnv();
  // (a console started without a login session's environment, on Linux or macOS: the shell in the C locale draws a
  // Chinese file name as escapes. Git Bash sets it itself, in its login profile.)
  if (!env.LANG && !isWin) {
    const m = /^([a-z]{2,3})(?:-[A-Za-z]{4})?-([A-Z]{2})\b/.exec(Intl.DateTimeFormat().resolvedOptions().locale || '');
    env.LANG = m ? `${m[1]}_${m[2]}.UTF-8` : 'C.UTF-8';
  }
  const info = await call('POST', '/terminals', {
    file: sh.file, args: sh.args, cwd, env, label: sh.label, shell: sh.id,
    workspace: typeof body.workspace === 'string' && body.workspace ? body.workspace : cwd,
    cols: Number.isInteger(body.cols) ? body.cols : 80, rows: Number.isInteger(body.rows) ? body.rows : 24, windowsPty,
  }, { start: true });
  return { ...info, windowsPty };
}

const validId = (id) => { if (!/^[0-9a-f]{12}$/.test(id)) throw httpError(404, '这个终端已经关闭'); return id; };
export const terminalInput = (id, body) => call('POST', `/terminals/${validId(id)}/input`, { data: typeof body?.data === 'string' ? body.data : '' });
export const terminalResize = (id, body) => call('POST', `/terminals/${validId(id)}/resize`, { cols: body?.cols, rows: body?.rows });
export const closeTerminal = (id) => call('DELETE', `/terminals/${validId(id)}`);

// GET /api/terminals/<id>/events: the host's stream of the terminal's screen, passed through. `opened`/`closed`: the
// console counts the streams it holds open (it does not stop while a page watches).
export async function pipeTerminalEvents(id, res, { opened = () => {}, closed = () => {} } = {}) {
  const fail = (status, error) => {
    if (res.headersSent || res.destroyed) { res.end(); return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error }));
  };
  if (!/^[0-9a-f]{12}$/.test(id)) return fail(404, '这个终端已经关闭');
  const s = await hostFor(false);
  if (!s) return fail(404, '这个终端已经关闭');
  if (res.destroyed) return;
  let counted = false;
  const upstream = http.get({ host: '127.0.0.1', port: s.port, path: `/terminals/${id}/events`, headers: { authorization: `Bearer ${s.token}` } }, (up) => {
    if (res.destroyed) { up.destroy(); return; }
    if (up.statusCode !== 200) { up.resume(); return fail(up.statusCode === 404 ? 404 : 502, up.statusCode === 404 ? '这个终端已经关闭' : '终端服务没有回应'); }
    counted = true;
    opened();
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    up.pipe(res);
    up.on('error', () => res.end());
    up.on('end', () => res.end());
  });
  upstream.on('error', () => {
    if (current === s) current = null;
    fail(502, '终端服务没有回应');
  });
  res.once('close', () => {
    upstream.destroy();
    if (counted) closed();
  });
}
