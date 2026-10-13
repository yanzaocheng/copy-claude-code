import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The computer service (claude-pro host): against a fake gateway it registers, lists directories and opens
// terminals for the web page, registers again when the gateway forgets it, and follows the login; the commands that
// open a terminal on each platform; and the real `claude-pro host` processes: one at a time, status, stop.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-host-config-'));
process.env.CLAUDE_PRO_CONFIG_DIR = configDir;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'claude-pro.js');

const host = await import('../src/host.js');
const { VERSION } = await import('../src/config.js');
const { HostService, launchCommand, quoteWindowsArg, normalizeDir, passedEnv, terminalFor, readHostState, ensureHost } = host;

// ---------------------------------------------------------------- the fake gateway

const KEYS = new Set(['key-one', 'key-two']);
const gw = { hosts: new Map(), registrations: [], stream: null, pending: new Map(), cid: 0, deletes: [], noHosts: false, hostPosts: 0 };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b ? JSON.parse(b) : {})); });
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (!KEYS.has(key)) return json(res, 401, { error: { message: 'Missing or invalid gateway API key' } });
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/v1/remote/hosts') {
    gw.hostPosts++;
    if (gw.noHosts) return json(res, 404, { error: { message: 'not found' } }); // an older gateway
    const body = await readBody(req);
    gw.registrations.push({ key, body });
    gw.hosts.set(body.id, { key });
    return json(res, 200, { id: body.id, ok: true });
  }
  const m = /^\/v1\/remote\/hosts\/([\w-]+)(?:\/(commands|results))?$/.exec(url.pathname);
  if (!m) return json(res, 404, { error: { message: 'not found' } });
  const [, id, action] = m;
  if (!action && req.method === 'DELETE') {
    gw.deletes.push({ id, key });
    gw.hosts.delete(id);
    gw.stream?.end();
    return json(res, 200, { ok: true, id });
  }
  if (!gw.hosts.has(id)) return json(res, 404, { error: { message: 'no such computer' } });
  if (action === 'commands') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ping\n\n');
    gw.stream = res;
    req.on('close', () => { if (gw.stream === res) gw.stream = null; });
    return;
  }
  const body = await readBody(req);
  gw.pending.get(body.cid)?.(body);
  gw.pending.delete(body.cid);
  return json(res, 200, { ok: true, delivered: true });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const until = async (what, check, timeout = 15_000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

// What the page asks, as the gateway passes it on: resolves with the computer's result.
const command = (type, body) => new Promise((resolve, reject) => {
  if (!gw.stream) { reject(new Error('the computer is not connected')); return; }
  const cid = `c${++gw.cid}`;
  gw.pending.set(cid, resolve);
  gw.stream.write(`data: ${JSON.stringify({ cid, type, body })}\n\n`);
});

// ---------------------------------------------------------------- the service

test('the service: registers, lists directories, opens terminals, registers again when the gateway forgets it, follows the login', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-host-home-'));
  for (const d of ['beta', 'Alpha', '.hidden', 'dir10', 'dir2']) fs.mkdirSync(path.join(home, d));
  fs.writeFileSync(path.join(home, 'notes.txt'), 'not a directory');
  fs.symlinkSync(path.join(home, 'Alpha'), path.join(home, 'link-to-alpha'), 'junction');
  // a session ran in `project` lately (its session file's first line says where)
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-host-project-'));
  const sessions = path.join(configDir, 'projects', 'p1');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 's1.jsonl'), `${JSON.stringify({ type: 'meta', cwd: project, created: new Date().toISOString() })}\n`);

  let login = { url: base, apiKey: 'key-one', account: { email: 'me@example.com' } };
  const launches = [];
  let launchFails = null;
  const service = new HostService({
    id: 'host-test-0001',
    readLogin: () => login,
    loadConfig: () => ({ env: { CLAUDE_PRO_MACHINE_NAME: '家里' }, gatewayUrl: base }),
    terminal: { kind: 'wt', name: 'Windows Terminal', path: 'wt.exe' },
    launch: async (spec) => { if (launchFails) throw new Error(launchFails); launches.push(spec); },
    home,
  });
  const running = service.run();
  t.after(() => service.stop());
  await until('the command stream', () => gw.stream && service.online);
  assert.deepEqual(gw.registrations[0], { key: 'key-one', body: { id: 'host-test-0001', machine: '家里', host: os.hostname(), platform: process.platform, version: VERSION, home, terminal: 'Windows Terminal' } });
  assert.equal(readHostState().online, true, 'host.json says it is online');
  assert.equal(readHostState().pid, process.pid);

  // list: "" is the home directory; only directories (a link to one too), dot ones last, in any case, 2 before 10
  const listed = await command('list', { path: '' });
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.path, home);
  assert.deepEqual(listed.entries.map((e) => e.name), ['Alpha', 'beta', 'dir2', 'dir10', 'link-to-alpha', '.hidden']);
  assert.equal(listed.entries[0].path, path.join(home, 'Alpha'));
  assert.equal(listed.parent, path.dirname(home));
  assert.equal(listed.sep, path.sep);
  assert.equal(listed.truncated, false);
  assert.equal(listed.home, home);
  assert.ok(listed.roots.length >= 1);
  assert.equal(listed.recent[0].path, path.resolve(project), 'where a session ran lately');
  const inside = await command('list', { path: path.join(home, 'Alpha') });
  assert.deepEqual([inside.ok, inside.entries, inside.parent], [true, [], home]);
  assert.match((await command('list', { path: path.join(home, 'nope') })).error, /^目录不存在：/);
  assert.match((await command('list', { path: path.join(home, 'notes.txt') })).error, /^不是目录：/);
  assert.match((await command('list', { path: 'relative/dir' })).error, /^不是绝对路径：/);
  assert.match((await command('frobnicate', {})).error, /不认识命令 frobnicate/);

  // open: a directory that is not there only with create; the session's id and name on the command line
  const target = path.join(home, 'new', 'project');
  assert.match((await command('open', { sessionId: 'sess-0001-abc', cwd: target })).error, /^目录不存在：/);
  assert.equal(launches.length, 0);
  const opened = await command('open', { sessionId: 'sess-0001-abc', cwd: target, create: true, name: '前端 web' });
  assert.deepEqual(opened, { cid: opened.cid, ok: true, terminal: 'Windows Terminal' });
  assert.ok(fs.statSync(target).isDirectory(), 'created');
  const spec = launches[0];
  assert.equal(spec.cmd, 'wt.exe');
  assert.deepEqual(spec.args.slice(0, 4), ['-w', 'new', '-d', target]);
  assert.deepEqual(spec.args.slice(-4), ['--remote-id', 'sess-0001-abc', '--name', '前端-web']);
  assert.ok(spec.args.includes(host.ENTRY.replace(/;/g, '\\;')));
  assert.match((await command('open', { sessionId: 'bad id!', cwd: target })).error, /会话 id/);
  assert.match((await command('open', { sessionId: 'sess-0002-abc', cwd: path.join(home, 'notes.txt') })).error, /^不是目录：/);
  launchFails = 'no window today';
  assert.equal((await command('open', { sessionId: 'sess-0003-abc', cwd: target })).error, '无法用 Windows Terminal 打开终端：no window today');
  launchFails = null;

  // the gateway restarts and forgets the computer: it registers again
  gw.hosts.clear();
  gw.stream.end();
  await until('a second registration', () => gw.registrations.length === 2 && gw.stream && service.online);

  // another account: off the old one's list, on the new one's
  login = { url: base, apiKey: 'key-two', account: { email: 'other@example.com' } };
  service.checkLogin();
  await until('the new registration', () => gw.registrations.length === 3 && service.online);
  assert.equal(gw.registrations[2].key, 'key-two');
  assert.deepEqual(gw.deletes, [{ id: 'host-test-0001', key: 'key-one' }]);
  assert.equal(readHostState().account, 'other@example.com');

  // logged out: off the list, and waiting
  login = null;
  service.checkLogin();
  await until('offline', () => !service.online && gw.deletes.length === 2);
  assert.equal(gw.deletes[1].key, 'key-two');
  assert.equal(readHostState().online, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(gw.registrations.length, 3, 'nothing without a login');

  service.stop();
  await running;
});

test('the service: a key the gateway refuses is not tried again and again; a background one starts the new version when the files change', async () => {
  const service = new HostService({ id: 'host-test-0002', readLogin: () => ({ url: base, apiKey: 'revoked' }), loadConfig: () => ({ env: {}, gatewayUrl: base }), terminal: null, home: os.tmpdir(), background: true });
  const logs = [];
  service.log = (m) => logs.push(m);
  const running = service.run();
  await until('the refusal', () => logs.some((m) => /refused this computer's key/.test(m)));
  const registrations = gw.registrations.length;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(gw.registrations.length, registrations, 'not again');

  // the program's files changed: once they stay so for a check, it stops to start the new version
  service.code = 'an older version';
  service.checkCode();
  assert.equal(service.stopped, false, 'not at the first sight of a change');
  service.checkCode();
  await running;
  assert.equal(service.reloading, true);
});

test('a gateway without computers (yet): said once, and tried again in minutes, not seconds', async () => {
  gw.noHosts = true;
  const logs = [];
  const service = new HostService({ id: 'host-test-0003', readLogin: () => ({ url: base, apiKey: 'key-one' }), loadConfig: () => ({ env: {}, gatewayUrl: base }), terminal: null, home: os.tmpdir(), log: (m) => logs.push(m) });
  const running = service.run();
  try {
    await until('the note', () => logs.some((m) => /does not take computers \(yet\): trying again every 5 minutes/.test(m)));
    const tries = gw.hostPosts;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(gw.hostPosts, tries);
  } finally {
    service.stop();
    await running;
    gw.noHosts = false;
  }
});

// ---------------------------------------------------------------- opening a terminal, per platform

test('launch commands: Windows Terminal, a console window, Terminal.app, tmux, a desktop terminal', () => {
  const args = ['--remote-id', 'sess-1234', '--name', 'web'];
  const wt = launchCommand({ kind: 'wt', path: 'C:\\wt.exe' }, { cwd: 'D:\\a;b', node: 'C:\\node.exe', entry: 'C:\\cp\\bin\\claude-pro.js', args, envFile: 'C:\\cfg\\launch\\sess-1234.env' });
  assert.deepEqual(wt.args, ['-w', 'new', '-d', 'D:\\a\\;b', 'C:\\node.exe', '--env-file=C:\\cfg\\launch\\sess-1234.env', 'C:\\cp\\bin\\claude-pro.js', ...args]);
  assert.equal(wt.wait, 'exit');
  assert.equal(wt.options.windowsHide, false, 'its window must show');

  const con = launchCommand({ kind: 'console', path: 'powershell.exe' }, { cwd: 'C:\\My Projects\\x', node: 'C:\\Program Files\\nodejs\\node.exe', entry: 'C:\\cp\\bin\\claude-pro.js', args: ['--name', 'a "b"'] });
  assert.equal(con.options.env.CLAUDE_PRO_LAUNCH_FILE, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(con.options.env.CLAUDE_PRO_LAUNCH_ARGS, 'C:\\cp\\bin\\claude-pro.js --name "a \\"b\\""');
  assert.equal(con.options.env.CLAUDE_PRO_LAUNCH_DIR, 'C:\\My Projects\\x');
  assert.match(Buffer.from(con.args.at(-1), 'base64').toString('utf16le'), /Start-Process -ErrorAction Stop -FilePath \$env:CLAUDE_PRO_LAUNCH_FILE -ArgumentList \$env:CLAUDE_PRO_LAUNCH_ARGS -WorkingDirectory \$env:CLAUDE_PRO_LAUNCH_DIR/);
  assert.equal(con.options.detached, false, 'a console-less PowerShell does nothing');

  const mac = launchCommand({ kind: 'osascript', path: 'osascript' }, { cwd: "/Users/me/it's \"here\"", node: '/usr/local/bin/node', entry: '/opt/cp/bin/claude-pro.js', args, env: { CLAUDE_PRO_CONFIG_DIR: '/tmp/cfg' } });
  assert.equal(mac.args[1], `tell application "Terminal" to do script "cd '/Users/me/it'\\\\''s \\"here\\"' && exec 'env' 'CLAUDE_PRO_CONFIG_DIR=/tmp/cfg' '/usr/local/bin/node' '/opt/cp/bin/claude-pro.js' '--remote-id' 'sess-1234' '--name' 'web'"`);

  const tmux = launchCommand({ kind: 'tmux', path: '/usr/bin/tmux' }, { cwd: '/srv/app', node: '/usr/bin/node', entry: '/opt/cp/bin/claude-pro.js', args, sessionId: 'sess-1234' });
  assert.deepEqual(tmux.args, ['new-session', '-d', '-s', 'claude-pro-sess-1234', '-c', '/srv/app', "exec '/usr/bin/node' '/opt/cp/bin/claude-pro.js' '--remote-id' 'sess-1234' '--name' 'web'"]);

  const gnome = launchCommand({ kind: 'gnome-terminal', path: '/usr/bin/gnome-terminal' }, { cwd: '/srv/app', node: '/usr/bin/node', entry: '/opt/cp/bin/claude-pro.js', args });
  assert.deepEqual(gnome.args, ['--working-directory=/srv/app', '--', 'sh', '-c', 'cd "$0" && exec "$@"', '/srv/app', '/usr/bin/node', '/opt/cp/bin/claude-pro.js', ...args]);
  assert.equal(gnome.wait, 'spawn');
  const xterm = launchCommand({ kind: 'xterm', path: '/usr/bin/xterm' }, { cwd: '/srv/app', node: '/usr/bin/node', entry: '/e.js', args: [] });
  assert.deepEqual(xterm.args, ['-e', 'sh', '-c', 'cd "$0" && exec "$@"', '/srv/app', '/usr/bin/node', '/e.js']);
});

test('which terminal: Windows Terminal or a console window; Terminal.app; a desktop terminal, else tmux, else none', () => {
  const has = (...names) => (name) => (names.includes(name) ? `/bin/${name}` : null);
  assert.equal(terminalFor({ platform: 'win32', find: has('wt.exe') }).name, 'Windows Terminal');
  assert.equal(terminalFor({ platform: 'win32', find: has() }).kind, 'console');
  assert.equal(terminalFor({ platform: 'darwin', find: has('osascript') }).name, 'Terminal.app');
  assert.equal(terminalFor({ platform: 'linux', env: { DISPLAY: ':0' }, find: has('konsole', 'xterm', 'tmux') }).kind, 'konsole');
  assert.equal(terminalFor({ platform: 'linux', env: {}, find: has('konsole', 'tmux') }).kind, 'tmux', 'no desktop: tmux');
  assert.equal(terminalFor({ platform: 'linux', env: {}, find: has() }), null);
});

test('paths, quoting and the environment passed on', () => {
  assert.equal(normalizeDir('', { platform: 'win32', home: 'C:\\Users\\me' }), 'C:\\Users\\me');
  assert.equal(normalizeDir('d:', { platform: 'win32' }), 'D:\\');
  assert.equal(normalizeDir('d:/work/x/', { platform: 'win32' }), 'D:\\work\\x');
  assert.equal(normalizeDir('\\\\server\\share\\dir', { platform: 'win32' }), '\\\\server\\share\\dir');
  assert.equal(normalizeDir('work', { platform: 'win32' }), null);
  assert.equal(normalizeDir('\\no-drive', { platform: 'win32' }), null);
  assert.equal(normalizeDir('~/code', { platform: 'linux', home: '/home/me' }), '/home/me/code');
  assert.equal(normalizeDir('/srv/../etc/', { platform: 'linux' }), '/etc');
  assert.equal(normalizeDir('srv', { platform: 'linux' }), null);

  assert.equal(quoteWindowsArg('plain'), 'plain');
  assert.equal(quoteWindowsArg('two words'), '"two words"');
  assert.equal(quoteWindowsArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg(''), '""');

  assert.deepEqual(passedEnv({
    CLAUDE_PRO_CONFIG_DIR: 'C:\\cfg', CLAUDE_PRO_GATEWAY_URL: 'http://gw', ANTHROPIC_MODEL: 'opus', ANTHROPIC_AUTH_TOKEN: 'secret',
    ANTHROPIC_API_KEY: 'secret', CLAUDE_PRO_SUPERVISED: '1', CLAUDE_PRO_RESTART_FILE: 'x', PATH: '/bin', CLAUDE_PRO_LAUNCH_ARGS: 'x',
    CLAUDE_PRO_CWD_FILE: 'C:\\tmp\\cwd', CLAUDE_PRO_PID_FILE: 'C:\\tmp\\pid', CLAUDE_PRO_COMMAND: 'claude-pro host start',
  }), { CLAUDE_PRO_CONFIG_DIR: 'C:\\cfg', CLAUDE_PRO_GATEWAY_URL: 'http://gw', ANTHROPIC_MODEL: 'opus' });
});

// ---------------------------------------------------------------- the real processes

test('claude-pro host: one at a time, status, stop; a stopped one is not started again by a session', { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-host-cli-'));
  const env = { ...process.env, CLAUDE_PRO_CONFIG_DIR: dir, CLAUDE_PRO_GATEWAY_URL: base };
  delete env.NODE_TEST_CONTEXT;
  const cli = (...args) => spawnSync(process.execPath, [BIN, 'host', ...args], { env, encoding: 'utf8', timeout: 30_000 });
  const state = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'host.json'), 'utf8')); } catch { return {}; } };

  const first = spawn(process.execPath, [BIN, 'host'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { first.kill(); } catch { /* gone */ } });
  let out = '';
  first.stdout.on('data', (d) => { out += d; });
  await until('the first one', () => state().pid === first.pid && /not logged in to the gateway/.test(out), 20_000);
  assert.match(state().id, /^[\w-]{8,64}$/);

  const second = cli('run');
  assert.equal(second.status, 1);
  assert.match(second.stdout, /runs already \(pid \d+\): this one stops/);

  const status = cli('status');
  assert.match(status.stdout, new RegExp(`running, pid ${first.pid}`));
  assert.match(status.stdout, /log: .*host\.log/);

  const id = state().id;
  const stopped = cli('stop');
  assert.match(stopped.stdout, new RegExp(`Stopped claude-pro host \\(pid ${first.pid}\\)`));
  await until('the end of the first one', () => first.exitCode !== null || first.signalCode !== null, 10_000);
  assert.equal(state().disabled, true);
  assert.equal(state().id, id, 'the id stays');
  assert.match(cli('status').stdout, /stopped \(claude-pro host start\)/);

  // in the background: detached, without a window, into host.log; stopped again
  const started = cli('start');
  assert.match(started.stdout, /claude-pro host started in the background \(pid (\d+)\)/, started.stdout + started.stderr);
  const pid = Number(/pid (\d+)/.exec(started.stdout)[1]);
  t.after(() => { try { process.kill(pid); } catch { /* gone */ } });
  assert.match(started.stdout, /not logged in to the gateway/);
  assert.match(fs.readFileSync(path.join(dir, 'host.log'), 'utf8'), /started \(pid \d+, in the background/);
  assert.match(cli('status').stdout, new RegExp(`running, pid ${pid}`));
  assert.match(cli('stop').stdout, new RegExp(`Stopped claude-pro host \\(pid ${pid}\\)`));
  assert.equal(host.pidAlive(pid), false);

  // a session starting now does not start it again (ensureHost reads the CONFIG_DIR of this process: point it there)
  const saved = process.env.CLAUDE_PRO_CONFIG_DIR;
  process.env.CLAUDE_PRO_CONFIG_DIR = dir;
  try { assert.equal(ensureHost(), null); } finally { process.env.CLAUDE_PRO_CONFIG_DIR = saved; }
});
