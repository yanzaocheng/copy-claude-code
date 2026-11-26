// Git for the console's panel (js/dock-git.js), as VS Code's 源代码管理: the repository the workspace is in, its
// branch and how far it is from its upstream, the changes (staged, not staged, conflicts), and staging, discarding,
// committing, pulling, pushing, switching branches. Each is git itself, run without a shell (arguments as data).
//
// The status asked every few seconds does not take the index lock (GIT_OPTIONAL_LOCKS=0): an agent's git commands
// running at the same moment must not find the index locked by the page. git never asks on the terminal it does not
// have (GIT_TERMINAL_PROMPT=0): a push that needs a password fails with git's message instead of hanging.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from '../utils/proc.js';
import { decodeText } from '../utils/encoding.js';
import { httpError } from './data.js';
import { trashEntry } from './files.js';

const MAX_ENTRIES = 5000;
const LOCAL_MS = 30_000;
const NETWORK_MS = 180_000;
const env = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'true' });

// git, in `cwd`: {code, out (Buffer), err (text)}
function git(args, { cwd, input = null, timeout = LOCAL_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd, env: env(), windowsHide: true, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (e) { resolve({ code: -1, out: Buffer.alloc(0), err: e.message }); return; }
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: Buffer.alloc(0), err: e.code === 'ENOENT' ? '没有找到 git：请先安装 Git' : e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out: Buffer.concat(out), err: Buffer.concat(err).toString('utf8').trim() }); });
    if (input != null) child.stdin.end(input);
  });
}
// the same, failing with git's own words
async function must(args, opts) {
  const r = await git(args, opts);
  if (r.code !== 0) throw httpError(409, r.err || r.out.toString('utf8').trim() || `git ${args[0]} 失败（${r.code}）`);
  return r;
}

// One operation at a time in a repository (staging while committing, two clicks): the status is not one of them.
const queues = new Map();
function serial(root, fn) {
  const before = queues.get(root) || Promise.resolve();
  const run = before.catch(() => {}).then(fn);
  queues.set(root, run.finally(() => { if (queues.get(root) === run) queues.delete(root); }));
  return run;
}

// The repository a folder is in: its top directory, or null.
const roots = new Map(); // folder -> {root, at}
async function repoOf(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw httpError(400, '无效的目录');
  const hit = roots.get(cwd);
  if (hit && Date.now() - hit.at < 10_000) return hit.root;
  const r = await git(['rev-parse', '--show-toplevel'], { cwd });
  const root = r.code === 0 ? path.resolve(r.out.toString('utf8').trim()) : null;
  roots.set(cwd, { root, at: Date.now() });
  if (roots.size > 50) roots.delete(roots.keys().next().value);
  return root;
}
async function needRepo(cwd) {
  const root = await repoOf(cwd);
  if (!root) throw httpError(404, '这个文件夹不是 Git 仓库');
  return root;
}

// A path the page names: inside the repository, relative to it with forward slashes.
function relOf(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw httpError(400, '无效的路径');
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw httpError(400, '路径不在仓库里');
  return r.split(path.sep).join('/');
}
const relsOf = (root, list) => {
  if (!Array.isArray(list) || !list.length) throw httpError(400, '没有指定文件');
  return list.slice(0, 2000).map((r) => relOf(root, r));
};

// ---------------------------------------------------------------- what the page asks

export async function gitStatus(cwd) {
  const root = await repoOf(cwd);
  if (!root) return { repo: false };
  const r = await git(['status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all'], { cwd: root });
  if (r.code !== 0) throw httpError(409, r.err || 'git status 失败');
  const fields = r.out.toString('utf8').split('\0');
  const head = fields[0].startsWith('## ') ? fields.shift().slice(3) : '';
  // "main...origin/main [ahead 1, behind 2]", "No commits yet on main", "HEAD (no branch)"
  const m = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head) || [];
  const branch = m[1] && !/^HEAD \(no branch\)$/.test(m[1]) ? m[1] : null;
  const ahead = Number(/ahead (\d+)/.exec(m[3] || '')?.[1] || 0);
  const behind = Number(/behind (\d+)/.exec(m[3] || '')?.[1] || 0);
  const staged = [], changes = [], conflicts = [];
  let truncated = false;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    if (staged.length + changes.length + conflicts.length >= MAX_ENTRIES) { truncated = true; break; }
    const x = f[0], y = f[1], rel = f.slice(3);
    let orig = null;
    if (x === 'R' || x === 'C') orig = fields[++i] || null;
    if (x === '?' && y === '?') { changes.push({ rel, status: 'U' }); continue; }
    if (x === '!') continue;
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { conflicts.push({ rel, status: '!' }); continue; }
    if (x !== ' ') staged.push({ rel, status: x, ...(orig ? { orig } : {}) });
    if (y !== ' ') changes.push({ rel, status: y });
  }
  const headOk = (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root })).code === 0;
  return { repo: true, root, branch, detached: !branch, upstream: m[2] || null, ahead, behind, noCommits: !headOk, staged, changes, conflicts, truncated };
}

// The two sides of a change, for the page's diff: staged, HEAD against the index; else the index against the file.
export async function gitDiff(cwd, rel, staged) {
  const root = await needRepo(cwd);
  const r = relOf(root, rel);
  const show = async (spec) => {
    const s = await git(['show', spec], { cwd: root });
    return s.code === 0 ? s.out : null;
  };
  let before, after;
  if (staged) {
    before = await show(`HEAD:${r}`);
    after = await show(`:${r}`);
  } else {
    before = await show(`:${r}`);
    try { after = await fs.promises.readFile(path.join(root, r)); } catch { after = null; }
  }
  const decode = (buf) => (buf == null ? { text: '' } : decodeText(buf));
  const a = decode(before), b = decode(after);
  if (a === null || b === null) return { path: path.join(root, r), binary: true };
  return { path: path.join(root, r), rel: r, original: a.text, modified: b.text, existed: before != null, exists: after != null };
}

export async function gitStage(body) {
  const root = await needRepo(body?.cwd);
  return serial(root, async () => {
    if (body.all) await must(['add', '-A'], { cwd: root });
    else await must(['add', '-A', '--', ...relsOf(root, body.paths)], { cwd: root });
    return { ok: true };
  });
}

export async function gitUnstage(body) {
  const root = await needRepo(body?.cwd);
  return serial(root, async () => {
    const hasHead = (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root })).code === 0;
    const rels = body.all ? null : relsOf(root, body.paths);
    if (hasHead) await must(['reset', '-q', 'HEAD', '--', ...(rels || ['.'])], { cwd: root });
    else await must(['rm', '--cached', '-r', '-q', '--', ...(rels || ['.'])], { cwd: root });
    return { ok: true };
  });
}

// 放弃更改: a tracked file back to what the index has; a new file to the recycle bin (files.js), never removed.
export async function gitDiscard(body) {
  const root = await needRepo(body?.cwd);
  const items = Array.isArray(body?.items) ? body.items.slice(0, 2000) : [];
  if (!items.length) throw httpError(400, '没有指定文件');
  return serial(root, async () => {
    const tracked = items.filter((i) => !i.untracked).map((i) => relOf(root, i.rel));
    const untracked = items.filter((i) => i.untracked).map((i) => relOf(root, i.rel));
    if (tracked.length) await must(['checkout', '--', ...tracked], { cwd: root });
    for (const r of untracked) await trashEntry({ path: path.join(root, r) });
    return { ok: true };
  });
}

export async function gitCommit(body) {
  const root = await needRepo(body?.cwd);
  const message = String(body?.message || '').trim();
  if (!message) throw httpError(400, '请写提交信息');
  return serial(root, async () => {
    if (body.all) await must(['add', '-A'], { cwd: root });
    await must(['commit', '-F', '-'], { cwd: root, input: `${message}\n`, timeout: NETWORK_MS });
    const h = await git(['log', '-1', '--format=%h'], { cwd: root });
    return { ok: true, hash: h.out.toString('utf8').trim() };
  });
}

export async function gitSync(body, what) {
  const root = await needRepo(body?.cwd);
  return serial(root, async () => {
    if (what === 'fetch') await must(['fetch', '--prune'], { cwd: root, timeout: NETWORK_MS });
    else if (what === 'pull') await must(['pull'], { cwd: root, timeout: NETWORK_MS });
    else {
      // a branch with no upstream yet: published to the first remote, as VS Code's 发布分支
      const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: root });
      if (up.code === 0) await must(['push'], { cwd: root, timeout: NETWORK_MS });
      else {
        const remotes = (await git(['remote'], { cwd: root })).out.toString('utf8').split(/\r?\n/).filter(Boolean);
        if (!remotes.length) throw httpError(409, '这个仓库没有远程仓库（git remote），不能推送');
        const remote = remotes.includes('origin') ? 'origin' : remotes[0];
        await must(['push', '-u', remote, 'HEAD'], { cwd: root, timeout: NETWORK_MS });
      }
    }
    return { ok: true };
  });
}

export async function gitBranches(cwd) {
  const root = await needRepo(cwd);
  const r = await must(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: root });
  return { branches: r.out.toString('utf8').split(/\r?\n/).filter(Boolean) };
}

export async function gitCheckout(body) {
  const root = await needRepo(body?.cwd);
  const name = String(body?.branch || '').trim();
  if (!name || name.startsWith('-')) throw httpError(400, '无效的分支名');
  return serial(root, async () => {
    if (body.create) {
      if ((await git(['check-ref-format', '--branch', name], { cwd: root })).code !== 0) throw httpError(400, `「${name}」不能用作分支名`);
      await must(['checkout', '-b', name], { cwd: root });
    } else await must(['checkout', name], { cwd: root });
    return { ok: true };
  });
}

export async function gitInit(body) {
  const cwd = body?.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw httpError(400, '无效的目录');
  await must(['init'], { cwd });
  roots.delete(cwd);
  return { ok: true };
}
