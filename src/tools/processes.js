// Processes: the processes on this machine (pid, parent, start time, memory, the ports they use, command line),
// found by name, command line, pid, tree or port, and killed by pid with their children. On Windows it is one
// PowerShell query (CIM, for the command lines) and netstat; the model did the same through Bash about a thousand
// times in two weeks, where PowerShell's $_ inside bash quoting made one call in ten fail.

import { spawn } from 'node:child_process';
import { OutputDecoder } from '../utils/encoding.js';
import { findPs, parsePsRows, msysTree } from '../utils/shell.js';

const isWin = process.platform === 'win32';
export const processLimits = { rows: 40, maxRows: 200, commandChars: 220, queryMs: 30_000 };

function capture(cmd, args, { timeoutMs = processLimits.queryMs, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, out: '', err: e.message });
      return;
    }
    const outDec = new OutputDecoder();
    const errDec = new OutputDecoder();
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    const onAbort = () => { try { child.kill(); } catch { /* gone */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c) => { out += outDec.write(c); });
    child.stderr.on('data', (c) => { err += errDec.write(c); });
    const done = (code, e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ code, out: out + outDec.end(), err: err + errDec.end() + (e ? e.message : '') }); };
    child.on('error', (e) => done(null, e));
    child.on('close', (code) => done(code));
  });
}

// ---- Reading the process table

// Select-Object, not a ForEach-Object that builds objects: half a second faster on 650 processes (PowerShell's own
// start takes 1.3 s of the 2.7). The dates come as "/Date(ms)/".
const PS_SCRIPT = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,WorkingSetSize | ConvertTo-Json -Compress';

async function windowsProcesses(signal) {
  const r = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], { signal });
  if (r.code !== 0) throw new Error(`PowerShell could not list the processes: ${(r.err || r.out).trim().slice(0, 300)}`);
  let rows;
  try { rows = JSON.parse(r.out.replace(/^\uFEFF/, '').trim()); } catch { throw new Error(`PowerShell gave no process list: ${r.out.slice(0, 200)}`); }
  const date = (d) => Number(/\/Date\((-?\d+)/.exec(String(d ?? ''))?.[1]) || (d ? Date.parse(d) || null : null);
  return (Array.isArray(rows) ? rows : [rows]).map((x) => ({ pid: x.ProcessId, ppid: x.ParentProcessId, name: x.Name || '', command: x.CommandLine || '', started: date(x.CreationDate), memory: x.WorkingSetSize || 0 }));
}

// ps on Linux and macOS: pid ppid rss lstart (five words) args. (Not run on this project's own machine, which has
// no POSIX system to try it on.)
async function posixProcesses(signal) {
  const r = await capture('ps', ['-axo', 'pid=,ppid=,rss=,lstart=,args='], { signal });
  if (r.code !== 0) throw new Error(`ps failed: ${r.err.trim().slice(0, 300)}`);
  const out = [];
  for (const line of r.out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[5].trim();
    const exe = command.split(/\s+/)[0] || '';
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: exe.split('/').pop(), command, started: Date.parse(m[4]) || null, memory: Number(m[3]) * 1024 });
  }
  return out;
}

// Sockets: [{proto, local, remote, state, pid}] from netstat -ano (Windows) or lsof (elsewhere).
async function sockets(signal) {
  if (isWin) {
    const r = await capture('netstat', ['-ano'], { signal });
    const out = [];
    for (const line of r.out.split('\n')) {
      const t = line.trim().split(/\s+/);
      if (t[0] === 'TCP' && t.length >= 5) out.push({ proto: 'TCP', local: t[1], remote: t[2], state: t[3], pid: Number(t[4]) });
      else if (t[0] === 'UDP' && t.length >= 4) out.push({ proto: 'UDP', local: t[1], remote: t[2], state: '', pid: Number(t[3]) });
    }
    return out;
  }
  const r = await capture('lsof', ['-nP', '-i', '-FpPnT'], { signal });
  const out = [];
  let pid = 0;
  let proto = '';
  for (const line of r.out.split('\n')) {
    const k = line[0];
    const v = line.slice(1);
    if (k === 'p') pid = Number(v);
    else if (k === 'P') proto = v;
    else if (k === 'n') {
      const [local, remote = ''] = v.split('->');
      out.push({ proto, local, remote, state: '', pid });
    } else if (k === 'T' && v.startsWith('ST=') && out.length) out[out.length - 1].state = v.slice(3);
  }
  return out;
}

const portOf = (address) => Number(/:(\d+)$/.exec(address || '')?.[1] || NaN);

// ---- What may not be killed

const CRITICAL = new Set(['system', 'system idle process', 'registry', 'memory compression', 'secure system', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'lsaiso.exe', 'svchost.exe', 'dwm.exe', 'fontdrvhost.exe', 'init', 'systemd', 'launchd', 'kernel_task', 'loginwindow', 'windowserver']);
const NEEDS_FORCE = new Set(['explorer.exe', 'finder']);

// claude-pro and everything it runs under (its supervisor, the shell, the terminal): never killed from here.
function ownLine(byPid) {
  const out = new Set();
  for (let pid = process.pid, guard = 0; pid && byPid.has(pid) && guard < 64; pid = byPid.get(pid).ppid, guard++) out.add(pid);
  out.add(process.pid);
  return out;
}

function descendants(list, root) {
  const children = new Map();
  for (const p of list) {
    if (p.pid === p.ppid) continue;
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const out = [];
  // A process that started before the one its parent id names is not its child: Windows gives no new parent to an
  // orphan, and its parent's id may be another process's by now (a tree listed or killed unrelated processes).
  const walk = (pid, depth, started) => {
    for (const c of children.get(pid) || []) {
      if (out.length > 2000) return;
      if (started && c.started && c.started < started) continue;
      out.push({ ...c, depth });
      walk(c.pid, depth + 1, c.started);
    }
  };
  walk(root, 1, list.find((p) => p.pid === root)?.started);
  return out;
}

// What a Git Bash in the tree started: Windows does not link a program started from bash to it (its parent id is a
// launcher that is gone by then), MSYS does (`ps -W`). Those, with their own Windows children, not already in the
// tree. (`npm start` from bash: npm, the cmd.exe it runs, and the app; a tree kill without them left the app
// running.)
const SHELL_EXE = /^(bash|sh|dash|zsh)\.exe$/i;
async function msysExtras(list, victims, signal) {
  if (!isWin || !victims.some((v) => SHELL_EXE.test(v.name))) return [];
  const ps = findPs();
  const r = ps ? await capture(ps, ['-W'], { timeoutMs: 8000, signal }) : { code: 1 };
  const rows = r.code === 0 ? parsePsRows(r.out) : [];
  const byWin = new Map(rows.map((row) => [row.winpid, row]));
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const have = new Set(victims.map((v) => v.pid));
  const extra = [];
  const queue = [...victims];
  const take = (p, depth) => {
    if (have.has(p.pid)) return;
    have.add(p.pid);
    const row = { ...p, depth };
    extra.push(row);
    queue.push(row);
  };
  while (queue.length) {
    const v = queue.shift();
    const depth = (v.depth || 0) + 1;
    // what MSYS says is under it
    const row = byWin.get(v.pid);
    if (!row) continue;
    for (const winpid of msysTree(rows, row.pid)) {
      const p = byPid.get(winpid);
      if (!p || have.has(p.pid)) continue;
      take(p, depth);
      for (const d of descendants(list, p.pid)) take(d, depth + d.depth);
    }
  }
  return extra;
}

// What may be left of a Git Bash killed, and nothing links to it: when bash runs a script (`npm start`: npm is one) it
// starts a new bash for it whose Windows parent is gone and whose MSYS parent is 1, the old one a stub waiting for it.
// Not killed on a guess (another session's command may have started that second): said, with what runs under them.
function maybeLeft(list, victims) {
  if (!isWin) return [];
  const bashes = victims.filter((v) => SHELL_EXE.test(v.name) && v.started);
  if (!bashes.length) return [];
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const have = new Set(victims.map((v) => v.pid));
  const out = [];
  for (const p of list) {
    if (have.has(p.pid) || !SHELL_EXE.test(p.name) || byPid.has(p.ppid) || !p.started) continue;
    if (!bashes.some((b) => p.started >= b.started && p.started - b.started < 3000)) continue;
    out.push(p, ...descendants(list, p.pid).filter((d) => !have.has(d.pid)));
  }
  return out;
}

// ---- Showing them

const pad = (s, n) => (String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length));
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const mb = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}G` : `${Math.round(bytes / 1024 ** 2)}M`);
function when(ms) {
  if (!ms) return '?';
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function table(rows, socketsByPid, { mine, portFilter } = {}) {
  const lines = [`${pad('PID', 7)} ${pad('PPID', 7)} ${pad('started', 14)} ${pad('mem', 6)} name — ports — command line`];
  for (const p of rows) {
    const socks = socketsByPid.get(p.pid) || [];
    const shown = (portFilter ? socks.filter((s) => portOf(s.local) === portFilter || portOf(s.remote) === portFilter) : socks.filter((s) => s.state === 'LISTENING' || s.state === 'LISTEN' || s.proto === 'UDP'))
      .slice(0, 6).map((s) => portFilter ? `${s.proto} ${s.local}${s.remote && !/^(\*:\*|0\.0\.0\.0:0|\[::\]:0)$/.test(s.remote) ? ` → ${s.remote}` : ''}${s.state ? ` ${s.state}` : ''}` : `${s.proto === 'UDP' ? 'udp ' : ''}${s.local}`);
    const extra = socks.length > 6 && !portFilter ? ' …' : '';
    const indent = p.depth ? `${'  '.repeat(p.depth)}└ ` : '';
    const tag = mine?.has(p.pid) ? ' [claude-pro]' : '';
    lines.push(`${pad(p.pid, 7)} ${pad(p.ppid, 7)} ${pad(when(p.started), 14)} ${pad(mb(p.memory), 6)} ${indent}${p.name}${tag}${shown.length ? ` — ${shown.join(', ')}${extra}` : ''}${p.command ? ` — ${cut(p.command.replace(/\s+/g, ' '), processLimits.commandChars)}` : ''}`);
  }
  return lines.join('\n');
}

async function killPid(pid, tree) {
  if (isWin) {
    const r = await capture('taskkill', ['/F', ...(tree ? ['/T'] : []), '/PID', String(pid)], { timeoutMs: 15_000 });
    return r.code === 0 ? null : (r.err || r.out).trim().split('\n').pop();
  }
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return e.code === 'ESRCH' ? 'no such process' : e.message; }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { process.kill(pid, 0); } catch { return null; }
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  return null;
}

const exists = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export const ProcessesTool = {
  name: 'Processes',
  description: `Lists the processes on this machine, or kills some. Each row: PID, parent PID, start time, memory, name, the ports it listens on, command line.

- action "list" (default), filtered by name (part of the program name), command (part of the command line), pid, port (what listens on or is connected to that port, with the connections), and tree: true with pid for the process and all its descendants. Filters combine. Without one, the most recently started processes. limit: rows (default ${processLimits.rows}).
- action "kill": pids, with their child processes (tree: false for only the process itself). claude-pro and what it runs under (its terminal, shell, supervisor) and system-critical processes are refused; explorer.exe needs force: true.
- Use it instead of ps, tasklist, netstat, taskkill or PowerShell through Bash. Before killing what the user did not start for this task, check what it is.`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'kill'] },
      name: { type: 'string', description: 'Part of the program name (case-insensitive)' },
      command: { type: 'string', description: 'Part of the command line (case-insensitive)' },
      pid: { type: 'number' },
      port: { type: 'number', description: 'A local or remote port' },
      tree: { type: 'boolean', description: 'list: the pid and all its descendants; kill: with child processes (default true)' },
      pids: { type: 'array', items: { type: 'number' }, description: 'For kill' },
      force: { type: 'boolean' },
      limit: { type: 'number' },
    },
  },
  readOnly: false,
  summarize(input) {
    if (input.action === 'kill') return `kill ${(input.pids || [input.pid]).filter(Boolean).join(', ')}${input.tree === false ? ' (not its children)' : ''}`;
    return ['name', 'command', 'pid', 'port'].filter((k) => input[k] !== undefined && input[k] !== '').map((k) => `${k} ${input[k]}`).join(', ') + (input.tree ? ' tree' : '') || 'recent';
  },
  async call(input, ctx) {
    const signal = ctx?.signal;
    const action = input.action || 'list';
    let list;
    let socks;
    try {
      [list, socks] = await Promise.all([isWin ? windowsProcesses(signal) : posixProcesses(signal), sockets(signal).catch(() => [])]);
    } catch (e) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { isError: true, content: e.message };
    }
    const byPid = new Map(list.map((p) => [p.pid, p]));
    const mine = ownLine(byPid);
    const socketsByPid = new Map();
    for (const s of socks) {
      if (!socketsByPid.has(s.pid)) socketsByPid.set(s.pid, []);
      socketsByPid.get(s.pid).push(s);
    }

    if (action === 'kill') {
      const pids = [...new Set((Array.isArray(input.pids) && input.pids.length ? input.pids : [input.pid]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (!pids.length) return { isError: true, content: 'kill needs pids (the process ids, from a list)' };
      const tree = input.tree !== false;
      const lines = [];
      let failed = false;
      for (const pid of pids) {
        const p = byPid.get(pid);
        if (!p) { lines.push(`${pid}: no such process`); failed = true; continue; }
        const victims = [p, ...(tree ? descendants(list, pid) : [])];
        if (tree) victims.push(...await msysExtras(list, victims, signal));
        const label = `${pid} ${p.name}`;
        const own = victims.find((v) => mine.has(v.pid));
        const critical = victims.find((v) => CRITICAL.has(v.name.toLowerCase()) || v.pid <= 4);
        const guarded = victims.find((v) => NEEDS_FORCE.has(v.name.toLowerCase()));
        if (own) { lines.push(`${label}: refused, ${own.pid === pid ? 'it is' : `its tree holds ${own.pid} ${own.name}, which is`} claude-pro or what it runs under`); failed = true; continue; }
        if (critical) { lines.push(`${label}: refused, ${critical.pid === pid ? 'it is' : `its tree holds ${critical.pid} ${critical.name},`} a system process`); failed = true; continue; }
        if (guarded && !input.force) { lines.push(`${label}: refused without force: true (${guarded.name} is the desktop shell)`); failed = true; continue; }
        let err = await killPid(pid, tree);
        // (what Windows does not see as its children: taskkill /T would not reach it)
        for (const v of victims.slice(1)) if (exists(v.pid)) err = (await killPid(v.pid, true)) || err;
        await new Promise((r) => setTimeout(r, 200));
        const left = victims.filter((v) => exists(v.pid));
        if (!left.length) lines.push(`${label}: killed${victims.length > 1 ? ` with ${victims.length - 1} child process${victims.length === 2 ? '' : 'es'}` : ''}`);
        else { failed = true; lines.push(`${label}: ${left.length} of ${victims.length} still running (${left.slice(0, 5).map((v) => `${v.pid} ${v.name}`).join(', ')})${err ? `: ${err}` : ''}`); }
        if (tree) {
          const maybe = maybeLeft(list, victims).filter((v) => exists(v.pid));
          if (maybe.length) lines.push(`  possibly left running: a Git Bash that ran a script (npm start…) has a successor nothing links to (its parent gone, started within seconds of it). Check and kill them if they are its:\n${maybe.slice(0, 8).map((v) => `  ${v.pid} ${v.name} — ${cut(String(v.command || '').replace(/\s+/g, ' '), 140)}`).join('\n')}`);
        }
      }
      return { isError: failed, content: lines.join('\n'), display: { summary: lines.length === 1 ? lines[0] : `${lines.filter((l) => /killed/.test(l)).length} of ${lines.length} killed` } };
    }

    if (action !== 'list') return { isError: true, content: `unknown action "${action}": use list or kill` };
    const limit = Math.min(Math.max(1, Number(input.limit) || processLimits.rows), processLimits.maxRows);
    let rows = list;
    const filters = [];
    if (input.pid !== undefined) {
      const root = byPid.get(Number(input.pid));
      if (!root) return { isError: true, content: `no process ${input.pid}` };
      rows = input.tree ? [root, ...descendants(list, root.pid)] : [root];
      if (input.tree) rows.push(...await msysExtras(list, rows, signal));
      filters.push(`pid ${input.pid}${input.tree ? ' and its descendants' : ''}`);
    }
    if (input.name) { const q = String(input.name).toLowerCase(); rows = rows.filter((p) => p.name.toLowerCase().includes(q)); filters.push(`name ~ ${input.name}`); }
    if (input.command) { const q = String(input.command).toLowerCase(); rows = rows.filter((p) => p.command.toLowerCase().includes(q)); filters.push(`command ~ ${input.command}`); }
    const portFilter = input.port !== undefined ? Number(input.port) : null;
    if (portFilter !== null) {
      const using = new Set(socks.filter((s) => portOf(s.local) === portFilter || portOf(s.remote) === portFilter).map((s) => s.pid));
      rows = rows.filter((p) => using.has(p.pid));
      filters.push(`port ${portFilter}`);
    }
    const total = rows.length;
    if (!filters.length) rows = [...rows].sort((a, b) => (b.started || 0) - (a.started || 0));
    else if (!input.tree) rows = [...rows].sort((a, b) => (a.started || 0) - (b.started || 0));
    const shown = rows.slice(0, limit);
    const head = filters.length
      ? `${total} process${total === 1 ? '' : 'es'} with ${filters.join(', ')}${total > shown.length ? ` (first ${shown.length}; limit shows more)` : ''}:`
      : `${list.length} processes; the ${shown.length} started last (filter by name, command, pid or port):`;
    if (!total) return { content: `No process with ${filters.join(', ')}.`, display: { summary: 'None found' } };
    return { content: `${head}\n${table(shown, socketsByPid, { mine, portFilter })}`, display: { summary: `${total} process${total === 1 ? '' : 'es'}` } };
  },
};
