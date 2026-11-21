// The local web console's API (see server.js): each route is [method, pattern, handler(req, params, body, url)]
// answering with a value (sent as JSON) or {raw: {type, data, name?}} for a file, or throwing httpError.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import {
  CONFIG_DIR, INSTALL_DIR, SOURCE_CHECKOUT, VERSION, BASIC_SETTINGS, KNOWN_KEYS, loadConfig, settingsFiles,
  writeConfigSetting, unsetConfigSetting, rememberChoice, updateSettingsFile, applyRememberedChoices, pickedModels, savePickedModels,
} from '../config.js';
import {
  PRESETS, GATEWAY_PROVIDER, readConnections, saveConnection, removeConnection, providerInfo, connectedProviders,
  listProviderModels, testProviderModel, modelsDevCatalogue, enrichModels, cleanProviderId, reservedProviderId,
  normalizeBaseUrl, validBaseUrl,
} from '../providers.js';
import { gatewayLogin, loginWithKey, clearGatewayLogin, fetchGatewayAccount, fetchGatewayModels, keptGatewayList } from '../gateway.js';
import { checkForUpdate, installUpdate } from '../updater.js';
import { loadAgents, loadSkills, loadCustomCommands } from '../agents.js';
import { modelChoices as sessionModels, effortChoices as sessionEfforts, refreshModelLists } from '../commands.js';
import { setArchived, archivedSessions } from '../session.js';
import {
  listAllSessions, sessionDetail, sessionImage, sessionToolOutput, sessionMarkdown, renameSession, trashSession, listTrash, restoreSession,
  purgeTrash, runningSessions, findPeerById, peerRequest, usageReport, dirSize, projectsRoot, httpError,
} from './data.js';

const mask = (key) => {
  const k = String(key || '');
  if (!k) return '';
  return k.length <= 10 ? `${k.slice(0, 2)}…` : `${k.slice(0, 6)}…${k.slice(-4)}`;
};
const isWin = process.platform === 'win32';
const home = os.homedir();

// ---------------------------------------------------------------- projects and files

// The directories the conversations ran in (their projects), with their state directory: what the memory and
// extension pages list, and where their files may be edited.
function knownProjects() {
  const byCwd = new Map();
  for (const s of listAllSessions()) {
    if (!s.cwd) continue;
    const key = isWin ? s.cwd.toLowerCase() : s.cwd;
    const p = byCwd.get(key);
    if (!p) byCwd.set(key, { cwd: s.cwd, dir: s.dir, sessions: 1, lastUsed: s.mtime });
    else { p.sessions++; p.lastUsed = Math.max(p.lastUsed, s.mtime); }
  }
  return [...byCwd.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

const same = (a, b) => (isWin ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

const windowsDrivePath = (p) => typeof p === 'string' && /^[a-z]:[\\/]/i.test(p);
const explorerPath = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
const isFile = (p) => { try { return fs.statSync(p, { throwIfNoEntry: false })?.isFile() === true; } catch { return false; } };

function vscodePath() {
  if (!isWin) return null;
  const editions = [['Microsoft VS Code', 'Code.exe'], ['Microsoft VS Code Insiders', 'Code - Insiders.exe']];
  const roots = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(windowsDrivePath);
  for (const [folder, exe] of editions) {
    for (const root of roots) {
      const file = path.join(root, folder, exe);
      if (isFile(file)) return file;
    }
  }
  // A non-default install can be on PATH via its executable directory or via VS Code's bin directory.
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!windowsDrivePath(dir)) continue;
    for (const root of path.basename(dir).toLowerCase() === 'bin' ? [dir, path.dirname(dir)] : [dir]) {
      for (const [, exe] of editions) {
        const file = path.join(root, exe);
        if (isFile(file)) return file;
      }
    }
  }
  return null;
}

let vscodeCache;
function vscodeAvailable() {
  if (!vscodeCache || Date.now() >= vscodeCache.until) vscodeCache = { found: Boolean(vscodePath()), until: Date.now() + 60_000 };
  return vscodeCache.found;
}

async function openProject(body) {
  const { cwd, target } = body || {};
  if (!isWin) throw httpError(409, '当前主机不支持这个操作');
  if (target !== 'explorer' && target !== 'vscode') throw httpError(400, '不支持这个打开方式');
  if (!windowsDrivePath(cwd)) throw httpError(400, '项目必须是 Windows 本地目录');
  const known = knownProjects().some((p) => same(p.cwd, cwd)) || (await runningSessions()).some((s) => {
    const dir = s.status?.cwd || s.cwd;
    return dir && same(dir, cwd);
  });
  if (!known) throw httpError(404, '工作区里没有这个项目');
  let dir;
  try {
    dir = fs.realpathSync.native(cwd);
    if (!windowsDrivePath(dir) || !fs.statSync(dir).isDirectory()) throw new Error();
  } catch { throw httpError(404, '项目目录不存在或不是本地文件夹'); }
  const label = target === 'explorer' ? '资源管理器' : 'VS Code';
  const exe = target === 'explorer' ? explorerPath() : vscodePath();
  if (!exe) throw httpError(409, '没有检测到已安装的 VS Code');
  // The browser never supplies the executable or a command line; only the checked directory is passed.
  await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // (set, Code.exe runs as plain Node and takes the folder for a script)
    const child = spawn(exe, [dir], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', env });
    child.once('error', () => reject(httpError(500, `无法启动${label}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { opened: true };
}

// On the local Windows console only: the host's native directory picker, not a browser upload prompt.
let folderDialog;
function pickProjectDirectory() {
  if (!isWin) throw httpError(409, '这台电脑没有可用的系统目录选择器');
  if (folderDialog) throw httpError(409, '目录选择窗口已经打开');
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 claude-pro 项目目录'
try {
  $owner.Show()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }
} finally { $dialog.Dispose(); $owner.Dispose() }
`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NoLogo', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  folderDialog = new Promise((resolve, reject) => {
    execFile(powershell, args, { windowsHide: true, timeout: 180_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) reject(httpError(503, '系统目录选择器不可用，请从目录列表选择'));
      else resolve({ cwd: stdout || null });
    });
  }).finally(() => { folderDialog = null; });
  return folderDialog;
}

async function projectDirectories(cwd) {
  if (!cwd) {
    const paths = [home, process.cwd(), ...knownProjects().map((p) => p.cwd)];
    const roots = new Map();
    for (const dir of paths) {
      if (!path.isAbsolute(dir) || (isWin && !windowsDrivePath(dir))) continue;
      const root = path.parse(dir).root;
      roots.set(isWin ? root.toLowerCase() : root, root);
    }
    return { cwd: null, dirs: [...new Set([...paths.slice(0, 2), ...roots.values()])].filter((dir) => !isWin || windowsDrivePath(dir)).map((dir) => ({ path: dir, name: dir })) };
  }
  if (!path.isAbsolute(cwd) || (isWin && !windowsDrivePath(cwd))) throw httpError(400, '不是本机目录');
  try {
    const dir = await fs.promises.realpath(cwd);
    if (isWin && !windowsDrivePath(dir)) throw httpError(400, '不是本机目录');
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => ({ name: e.name, path: path.join(dir, e.name) })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { cwd: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs };
  } catch (e) { throw httpError(e.status || 404, '无法读取这个目录，请选择其他目录'); }
}

const inside = (file, dir) => {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// Whether the console may read and write `file`: instructions, memory, settings and extensions, of the user and of
// the known projects. Never the keys (gateway.json, providers.json), the conversations or anything else.
function editable(file) {
  const f = path.resolve(file);
  const ext = path.extname(f).toLowerCase();
  const extDirs = (root) => ['skills', 'agents', 'commands'].some((d) => inside(f, path.join(root, d))) && ext === '.md';
  if (same(f, path.join(CONFIG_DIR, 'CLAUDE.md')) || same(f, path.join(CONFIG_DIR, 'settings.json'))) return true;
  if (extDirs(CONFIG_DIR)) return true;
  if (inside(f, projectsRoot()) && ext === '.md' && path.basename(path.dirname(f)) === 'memory' && same(path.dirname(path.dirname(path.dirname(f))), projectsRoot())) return true;
  for (const p of knownProjects()) {
    const cwd = p.cwd;
    if (!inside(f, cwd)) continue;
    const names = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json', path.join('.claude', 'CLAUDE.md'), path.join('.claude-pro', 'settings.json'), path.join('.claude-pro', 'settings.local.json')];
    if (names.some((n) => same(f, path.join(cwd, n)))) return true;
    if (extDirs(path.join(cwd, '.claude')) || extDirs(path.join(cwd, '.claude-pro'))) return true;
  }
  return false;
}

function checkedPath(p) {
  if (typeof p !== 'string' || !p.trim()) throw httpError(400, 'path is required');
  const file = path.resolve(p);
  if (!editable(file)) throw httpError(403, '这个文件不能在控制台里打开');
  return file;
}

function readFileInfo(file) {
  let text = null;
  let mtime = null;
  try { text = fs.readFileSync(file, 'utf8'); mtime = fs.statSync(file).mtimeMs; } catch { /* not there yet */ }
  return { path: file, exists: text !== null, text: text ?? '', mtime };
}

// ---------------------------------------------------------------- overview

async function overview() {
  const config = loadConfig({ cwd: home });
  const login = gatewayLogin(config.gatewayUrl);
  const running = await runningSessions();
  const sessions = listAllSessions();
  let account = null;
  let accountError = null;
  if (login) {
    try { account = await fetchGatewayAccount(login, { signal: AbortSignal.timeout(6000) }); } catch (e) { accountError = e.message; }
  }
  return {
    version: VERSION, installDir: INSTALL_DIR, sourceCheckout: SOURCE_CHECKOUT, configDir: CONFIG_DIR, node: process.version,
    platform: `${os.type()} ${os.release()}`, host: os.hostname(),
    model: config.setting('model'), modelLabel: safe(() => config.model.label), effort: config.setting('effort'),
    remembered: rememberedChoice(),
    providers: connectedProviders().map((p) => ({ id: p.id, name: p.name, models: p.connection.models?.length || 0 })),
    gateway: login ? { url: login.url, account: login.account || null, key: mask(login.apiKey), balance: account?.available_usd ?? account?.balance_usd ?? null, accountError } : null,
    running: running.length,
    busy: running.filter((r) => r.status?.turn).length,
    sessions: sessions.length,
    projects: new Set(sessions.map((s) => s.dir)).size,
    storage: dirSize(projectsRoot()),
  };
}

const safe = (fn) => { try { return fn(); } catch { return null; } };

function rememberedChoice() {
  try {
    const json = JSON.parse(fs.readFileSync(settingsFiles(home).user, 'utf8').replace(/^\uFEFF/, ''));
    return json?.remembered?.gateway || {};
  } catch { return {}; }
}

// ---------------------------------------------------------------- settings

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

// Every setting with its value in effect, where that comes from, and what each settings file holds. `project`: the
// directory whose project settings count (default: none, the user's own).
function settingsView(project) {
  const cwd = project && fs.existsSync(project) ? project : home;
  const config = loadConfig({ cwd });
  const all = settingsFiles(cwd);
  // without a project, only the user's file (the home directory's "project" settings would be the same file)
  const files = cwd === home ? { user: all.user } : all;
  const perFile = Object.fromEntries(Object.entries(files).map(([scope, file]) => [scope, { file, json: readJsonFile(file) }]));
  const inFile = (json, key) => {
    if (!json) return undefined;
    if (Object.hasOwn(BASIC_SETTINGS, key)) return json[key] ?? (BASIC_SETTINGS[key].legacy ? json.env?.[BASIC_SETTINGS[key].legacy] : undefined);
    return json.env?.[key];
  };
  const entry = (key, basic) => ({
    key, basic,
    description: basic ? BASIC_SETTINGS[key].description : KNOWN_KEYS[key],
    default: basic ? BASIC_SETTINGS[key].default : null,
    userOnly: Boolean(basic && BASIC_SETTINGS[key].userOnly),
    value: safe(() => config.setting(key)) ?? null,
    source: config.sources[key] || 'default',
    scopes: Object.fromEntries(Object.entries(perFile).map(([scope, f]) => [scope, inFile(f.json, key) ?? null])),
  });
  return {
    project: project && cwd === project ? cwd : null,
    files,
    remembered: rememberedChoice(),
    entries: [...Object.keys(BASIC_SETTINGS).map((k) => entry(k, true)), ...Object.keys(KNOWN_KEYS).map((k) => entry(k, false))],
  };
}

function scopeFile(scope, project) {
  const cwd = project && fs.existsSync(project) ? project : null;
  if (scope === 'user') return settingsFiles(home).user;
  if (!cwd) throw httpError(400, '项目设置需要先选一个项目');
  const files = settingsFiles(cwd);
  if (!files[scope]) throw httpError(400, 'scope must be user, project or local');
  return files[scope];
}

// ---------------------------------------------------------------- providers

function providersView() {
  const connections = readConnections({ fresh: true });
  const config = loadConfig({ cwd: home });
  const login = gatewayLogin(config.gatewayUrl);
  const shown = (info) => {
    const c = info.connection;
    return {
      id: info.id, name: info.name, protocol: info.protocol, baseUrl: info.baseUrl, keyPage: info.keyPage || null, keyless: Boolean(info.keyless), custom: Boolean(info.custom),
      connected: Boolean(c && (c.apiKey || info.keyless || info.custom)),
      key: c ? mask(c.apiKey) : '', model: c?.model || null, savedAt: c?.savedAt || null,
      models: (c?.models || []).map((m) => ({ id: m.id, name: m.name || null, window: m.window || null, price: m.price || null })),
    };
  };
  const custom = Object.keys(connections).filter((id) => !PRESETS.some((p) => p.id === id)).map((id) => providerInfo(id, connections)).filter(Boolean);
  return {
    gateway: { id: GATEWAY_PROVIDER, url: config.gatewayUrl, connected: Boolean(login), key: login ? mask(login.apiKey) : '', account: login?.account || null, keyPage: `${config.gatewayUrl.replace(/\/+$/, '')}/user#keys` },
    presets: PRESETS.map((p) => shown(providerInfo(p.id, connections))),
    custom: custom.map(shown),
    model: config.setting('model'),
    effort: config.setting('effort'),
    remembered: rememberedChoice(),
  };
}

// The provider a request names: a built-in one or one of the user's ({custom: {name, protocol, baseUrl}}).
function requestedProvider(body) {
  if (body?.custom) {
    const id = cleanProviderId(body.custom.name);
    if (!id) throw httpError(400, '名字只能用字母、数字和 -');
    if (reservedProviderId(id)) throw httpError(400, `"${id}" 是内置的供应商，请在列表里选它，或换个名字`);
    const protocol = body.custom.protocol === 'openai' ? 'openai' : 'anthropic';
    const baseUrl = normalizeBaseUrl(body.custom.baseUrl, protocol);
    if (!validBaseUrl(baseUrl)) throw httpError(400, '地址要以 http:// 或 https:// 开头');
    return { id, name: body.custom.name.trim(), protocol, baseUrl, custom: true, connection: readConnections({ fresh: true })[id] || null };
  }
  const info = providerInfo(String(body?.id || ''), readConnections({ fresh: true }));
  if (!info) throw httpError(404, '没有这个供应商');
  return info;
}

async function checkProvider(body) {
  const info = requestedProvider(body);
  const apiKey = String(body.apiKey || '').trim() || info.connection?.apiKey || '';
  if (!apiKey && !info.keyless) throw httpError(400, '请填写 API Key');
  let listed;
  try {
    listed = await listProviderModels({ ...info, apiKey }, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw httpError(e.refused ? 400 : 502, e.refused ? `${info.name} 拒绝了这个 Key：${e.message}` : `连不上 ${info.name}：${e.message}`);
  }
  const catalogue = info.modelsDev ? await modelsDevCatalogue().catch(() => null) : null;
  const models = enrichModels(listed.models, catalogue, info.modelsDev);
  return { id: info.id, name: info.name, authHeader: listed.authHeader, models, current: info.connection?.model || null };
}

// As /connect does: one request to the model chosen, then the connection is saved (nothing before it answers).
async function connectProvider(body) {
  const info = requestedProvider(body);
  const existing = info.connection;
  const apiKey = String(body.apiKey || '').trim() || existing?.apiKey || '';
  if (!apiKey && !info.keyless) throw httpError(400, '请填写 API Key');
  const model = String(body.model || '').trim();
  if (!model) throw httpError(400, '请选择一个模型');
  let authHeader = body.authHeader || existing?.authHeader || null;
  let quirks = {};
  try {
    ({ authHeader, quirks } = await testProviderModel({ ...info, apiKey, authHeader, model }, { signal: AbortSignal.timeout(60_000) }));
  } catch (e) {
    throw httpError(400, `${model} 没有通过测试：${e.message}`);
  }
  const models = Array.isArray(body.models) && body.models.length ? body.models.filter((m) => m && typeof m.id === 'string').slice(0, 2000) : [{ id: model }];
  saveConnection(info.id, {
    ...(info.custom ? { custom: true, name: info.name, protocol: info.protocol, baseUrl: info.baseUrl } : {}),
    apiKey,
    authHeader: info.protocol === 'openai' ? 'bearer' : authHeader || 'x-api-key',
    ...(Object.keys(quirks || {}).length ? { quirks } : {}),
    model,
    models,
  });
  if (body.useNow) rememberChoice({ model: `${info.id}/${model}` });
  return providersView();
}

// The model lists kept for the console's 模型列表 (what the pickers offer), nothing asked: the gateway's (as fetched
// last, see keptGatewayList) and each connected provider's (as /connect or 刷新模型列表 kept it), with what is known
// of each model: window, output limit, effort levels, price per million tokens.
function keptModelLists() {
  const config = loadConfig({ cwd: home });
  const groups = [];
  const login = gatewayLogin(config.gatewayUrl);
  if (login) {
    const kept = keptGatewayList(login);
    groups.push({
      id: GATEWAY_PROVIDER, name: '7bit.fun', at: kept?.at || null,
      models: (kept?.list || []).map((m) => ({
        ref: `${GATEWAY_PROVIDER}/${m.id}`, id: m.id, name: m.display_name || null, vendor: m.vendor || m.owned_by || null,
        window: m.max_input_tokens || null, maxOutput: m.max_tokens || null, efforts: m.supported_reasoning_levels || [],
        price: m.pricing && Number.isFinite(m.pricing.input_per_million_usd) ? { input: m.pricing.input_per_million_usd, output: m.pricing.output_per_million_usd } : null,
      })),
    });
  }
  for (const p of connectedProviders(readConnections({ fresh: true }))) {
    const at = Date.parse(p.connection.savedAt || '');
    groups.push({
      id: p.id, name: p.name, at: Number.isFinite(at) ? at : null,
      models: (p.connection.models || []).map((m) => ({
        ref: `${p.id}/${m.id}`, id: m.id, name: m.name || null, vendor: null, window: m.window || null, maxOutput: m.maxOutput || null, efforts: [],
        price: m.price ? { input: m.price.input, output: m.price.output } : null,
      })),
    });
  }
  return { groups, picked: pickedModels(), current: config.setting('model'), remembered: rememberedChoice() };
}

// The models the console offers for the default model: those of the connected providers and of the gateway.
async function modelChoices() {
  const config = loadConfig({ cwd: home });
  const out = [];
  for (const p of connectedProviders()) {
    for (const m of p.connection.models || []) out.push({ ref: `${p.id}/${m.id}`, provider: p.name, window: m.window || null });
  }
  const login = gatewayLogin(config.gatewayUrl);
  if (login) {
    try {
      const list = keptGatewayList(login)?.list || await fetchGatewayModels(login, { signal: AbortSignal.timeout(8000) });
      for (const m of list || []) out.push({ ref: `7bit/${m.id}`, provider: '7bit.fun', window: m.max_input_tokens || null, efforts: m.supported_reasoning_levels || null });
    } catch { /* the gateway's models are left out */ }
  }
  return { models: out, current: config.setting('model'), remembered: rememberedChoice() };
}

// ---------------------------------------------------------------- memory and extensions

function memoryView() {
  const projects = knownProjects().map((p) => {
    const memDir = path.join(projectsRoot(), p.dir, 'memory');
    let files = [];
    try { files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md')).map((f) => ({ name: f, path: path.join(memDir, f), size: fs.statSync(path.join(memDir, f)).size })); } catch { /* none */ }
    // (the home directory's own CLAUDE.md is not read: there the user's ~/.claude-pro/CLAUDE.md stands for it)
    const instructions = same(p.cwd, home) ? [] : ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'AGENTS.md', 'CLAUDE.local.md'].map((n) => path.join(p.cwd, n))
      .map((f) => ({ path: f, name: path.relative(p.cwd, f), exists: fs.existsSync(f) }));
    return { ...p, exists: fs.existsSync(p.cwd), memoryDir: memDir, memory: files.sort((a, b) => (a.name === 'MEMORY.md' ? -1 : b.name === 'MEMORY.md' ? 1 : a.name.localeCompare(b.name))), instructions };
  });
  const user = path.join(CONFIG_DIR, 'CLAUDE.md');
  return { user: { path: user, exists: fs.existsSync(user) }, projects };
}

function extensionsView(project) {
  const cwd = project && fs.existsSync(project) ? project : home;
  const config = loadConfig({ cwd });
  const files = settingsFiles(cwd);
  const mcp = [];
  for (const [scope, file] of [...Object.entries(files), ['.mcp.json', path.join(cwd, '.mcp.json')]]) {
    if (scope !== 'user' && cwd === home) continue;
    const json = readJsonFile(file);
    for (const [name, spec] of Object.entries(json?.mcpServers || {})) mcp.push({ name, scope, file, spec: redactSpec(spec) });
  }
  const hooks = [];
  for (const [scope, file] of Object.entries(files)) {
    if (scope !== 'user' && cwd === home) continue;
    const json = readJsonFile(file);
    for (const [event, entries] of Object.entries(json?.hooks || {})) hooks.push({ event, scope, file, entries });
  }
  const scopeOf = (source) => (typeof source === 'string' && inside(path.resolve(source), CONFIG_DIR) ? 'user' : source === 'built-in' ? 'built-in' : 'project');
  return {
    project: cwd === home ? null : cwd,
    skills: [...loadSkills(cwd).values()].map((s) => ({ name: s.name, description: s.description, scope: s.scope, path: s.file })),
    agents: [...loadAgents(cwd).values()].map((a) => ({ name: a.name, description: a.description, tools: a.tools, scope: scopeOf(a.source), path: a.source === 'built-in' ? null : a.source })),
    commands: [...loadCustomCommands(cwd).values()].map((c) => ({ name: c.name, description: c.description, scope: c.scope, path: commandPath(cwd, c) })),
    mcp, hooks, settingsFiles: files,
    mcpLoaded: Object.keys(config.settings.mcpServers || {}),
  };
}

function commandPath(cwd, cmd) {
  const rel = `${cmd.name.split(':').join(path.sep)}.md`;
  const roots = cmd.scope === 'user' ? [path.join(CONFIG_DIR, 'commands')] : [path.join(cwd, '.claude-pro', 'commands'), path.join(cwd, '.claude', 'commands')];
  return roots.map((r) => path.join(r, rel)).find((f) => fs.existsSync(f)) || null;
}

// An MCP server's settings without the values of its environment and headers (tokens live there).
function redactSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const out = { ...spec };
  for (const k of ['env', 'headers']) if (out[k] && typeof out[k] === 'object') out[k] = Object.fromEntries(Object.keys(out[k]).map((n) => [n, '•••']));
  return out;
}

const TEMPLATES = {
  skill: (name) => `---\nname: ${name}\ndescription: 什么时候用这个技能（模型据此决定是否加载）\n---\n\n# ${name}\n\n步骤和说明写在这里。\n`,
  agent: (name) => `---\nname: ${name}\ndescription: 什么时候把任务交给这个子 agent\ntools: Read, Grep, Glob, Bash\n---\n\n你是一个……（子 agent 的系统提示词）\n`,
  command: (name) => `---\ndescription: 这个命令做什么\nargument-hint: [参数]\n---\n\n要发给模型的内容，$ARGUMENTS 会换成命令后面的参数。\n`,
};

function newExtension({ kind, scope, name, project }) {
  if (!TEMPLATES[kind]) throw httpError(400, 'kind must be skill, agent or command');
  const clean = String(name || '').trim();
  if (!/^[\w.-]{1,60}$/.test(clean)) throw httpError(400, '名字只能用字母、数字、_ . -');
  let root;
  if (scope === 'user') root = CONFIG_DIR;
  else {
    if (!project || !fs.existsSync(project)) throw httpError(400, '项目级的需要先选一个项目');
    root = path.join(project, '.claude-pro');
  }
  const file = kind === 'skill' ? path.join(root, 'skills', clean, 'SKILL.md') : path.join(root, kind === 'agent' ? 'agents' : 'commands', `${clean}.md`);
  if (fs.existsSync(file)) throw httpError(409, '已经有同名的了');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, TEMPLATES[kind](clean));
  return { path: file };
}

// ---------------------------------------------------------------- opening a conversation in a terminal

let wtPath;
function windowsTerminal() {
  if (wtPath !== undefined) return wtPath;
  try { wtPath = execFileSync('where', ['wt.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim() || null; } catch { wtPath = null; }
  return wtPath;
}

// The sessions the console runs in its own process (see host.js): set by the server.
let host = null;
export function useHost(h) { host = h; }

let updateCache, updateCheck, updateTask;
async function webUpdateStatus({ fresh = false } = {}) {
  if (updateTask?.status === 'restarting' && host?.source && host.failed === host.source.key) {
    updateCache = { result: { status: 'installed', version: updateTask.version, error: '新版未能通过启动检查，控制台仍在运行旧版' }, until: Date.now() + 60_000 };
    updateTask = null;
  }
  if (updateTask) return { ...updateTask, runningVersion: VERSION };
  if (fresh || !updateCache || Date.now() >= updateCache.until) {
    updateCheck ||= checkForUpdate()
      .catch(() => ({ status: 'error', error: '暂时无法连接 npm 检查更新' }))
      .then((result) => { updateCache = { result, until: Date.now() + (result.status === 'error' ? 60_000 : 15 * 60_000) }; })
      .finally(() => { updateCheck = null; });
    await updateCheck;
  }
  return { ...(updateTask || updateCache.result), runningVersion: VERSION };
}

async function startWebUpdate(expectedVersion) {
  let info = await webUpdateStatus();
  if (info.status === 'updating' || info.status === 'restarting') return info;
  if (info.status !== 'available' && info.status !== 'installed') info = await webUpdateStatus({ fresh: true });
  if (info.status !== 'available' && info.status !== 'installed') return info;
  if (info.version !== expectedVersion) throw httpError(409, '可用版本已变化，请重新检查更新');
  if (!host) throw httpError(503, '控制台还在启动，请稍后再试');
  if (info.status === 'installed') {
    updateTask = { status: 'restarting', version: info.version };
    host.requestHandover();
    return webUpdateStatus();
  }
  const peers = await runningSessions();
  if (updateTask) return webUpdateStatus();
  if (peers.some((p) => p.status?.busy || p.status?.turn || p.status?.dialog) || !host.beginUpdate()) {
    throw httpError(409, '还有会话正在工作，请等会话空闲后再更新');
  }
  const version = info.version;
  updateTask = { status: 'updating', version };
  void (async () => {
    let r;
    try { r = await installUpdate(version); } catch (e) { host.log(e, 'update'); }
    if (r?.status === 'updated' || r?.status === 'installed') {
      updateTask = { status: 'restarting', version: r.version };
      host.endUpdate(true);
    } else {
      if (r?.error) host.log(r.error, 'update');
      const error = r?.status === 'locked' ? '另一个会话正在安装更新，请稍后重试' : 'npm 安装失败，可重试，或在终端运行 /update 查看详情';
      updateCache = { result: { status: 'available', version, error }, until: Date.now() + 60_000 };
      updateTask = null;
      host.endUpdate(false);
    }
  })();
  return webUpdateStatus();
}

// A session in `cwd` (a saved conversation: `resumeFile`, `resumeId`), run by the console itself: up in ~0.1 s.
async function launchSession(cwd, { resumeFile = null, resumeId = null, initialChoices = null } = {}) {
  if (!host) throw httpError(503, '控制台还在启动，请稍后再试');
  if (host.updating) throw httpError(409, '正在安装更新，请稍后再试');
  if (host.restarting || host.recovering) throw httpError(409, '控制台正在恢复会话，请稍后再试');
  const app = await host.launch({ cwd, resumeFile, resumeId, initialChoices });
  if (app.exiting || !app.runtime) throw httpError(500, '会话没能启动（详情在 ~/.claude-pro/web-errors.log）');
  return { opened: true, peerId: app.peers?.id || null, sessionId: app.store?.id || null };
}

// claude-pro in `cwd` in a new terminal tab (Windows Terminal when there is one, else a console window), with `args`
// (ids and flags only: nothing a shell would take apart). Elsewhere than Windows only the command to run is given.
function launchTerminal(cwd, args, title) {
  const bin = path.join(INSTALL_DIR, 'bin', 'claude-pro.js');
  const command = `cd "${cwd}" && claude-pro${args.length ? ` ${args.join(' ')}` : ''}`;
  if (!isWin) return { opened: false, command };
  const wt = windowsTerminal();
  const env = { ...process.env };
  delete env.CLAUDE_PRO_BACKGROUND; // (inherited when a session of an older version, in a hidden window, started this server)
  const child = wt
    ? spawn(wt, ['-w', '0', 'new-tab', '-d', cwd, '--title', String(title || 'claude-pro').replace(/;/g, ',').slice(0, 40), process.execPath, bin, ...args], { detached: true, stdio: 'ignore', windowsHide: false, env })
    : spawn('cmd.exe', ['/c', 'start', '""', '/D', `"${cwd}"`, `"${process.execPath}"`, `"${bin}"`, ...args], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, env });
  child.on('error', () => {});
  child.unref();
  return { opened: true, how: wt ? 'Windows Terminal' : 'cmd', command };
}

// A saved conversation goes on: in the console (`terminal` false), or in a terminal tab.
const pendingSessions = new Map();

function sessionOperation(id, kind, work) {
  const pending = pendingSessions.get(id);
  if (pending) {
    if (kind === 'open' && pending.kind === kind) return pending.promise;
    throw httpError(409, '会话正在执行另一个操作，请稍后再试');
  }
  const promise = Promise.resolve().then(work).finally(() => pendingSessions.delete(id));
  pendingSessions.set(id, { kind, promise });
  return promise;
}

function openSession(dir, id, { terminal = false } = {}) {
  const session = listAllSessions().find((s) => s.dir === dir && s.id === id);
  if (!session) throw httpError(404, '会话不存在');
  return sessionOperation(id, terminal ? 'terminal' : 'open', async () => {
    if (host?.recovering || host?.restarting) throw httpError(409, '控制台正在恢复会话，请稍后再试');
    const live = (await running()).get(id);
    if (live && !terminal) return { opened: true, peerId: live.peerId, sessionId: id };
    if (live) throw httpError(409, '这个会话已经在运行');
    const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : home;
    if (!terminal) return launchSession(cwd, { resumeFile: session.file, resumeId: id });
    return launchTerminal(cwd, ['--resume', id], session.title);
  });
}

// A new session in `cwd` (its first message, if any, is sent by the page once the session is up: no quoting through
// a terminal's command line).
async function newSession(body) {
  let cwd = String(body?.cwd || '').trim().replace(/^~(?=$|[\\/])/, home);
  if (!cwd) throw httpError(400, '请填写目录');
  cwd = path.resolve(cwd);
  let st;
  try { st = fs.statSync(cwd); } catch { throw httpError(400, `目录不存在：${cwd}`); }
  if (!st.isDirectory()) throw httpError(400, `不是目录：${cwd}`);
  return { ...(await launchSession(cwd, { initialChoices: readInitialChoices(body) })), cwd };
}

function readInitialChoices(values) {
  const choices = {};
  for (const key of ['model', 'effort']) {
    const value = values?.[key];
    if (value == null || value === '') continue;
    // (a provider's model id may hold @, as Cloudflare's @cf/...: only blanks and control characters are refused)
    if (typeof value !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,200}$/.test(value)) throw httpError(400, '无效的模型或思考强度');
    choices[key] = value === 'default' ? null : value;
  }
  try { loadConfig({ cwd: home, flags: choices }); } catch { throw httpError(400, '无效的模型或思考强度'); }
  return choices;
}

async function newSessionOptions(url) {
  const cwd = url.searchParams.get('cwd') || home;
  if (!path.isAbsolute(cwd) || (isWin && !windowsDrivePath(cwd))) throw httpError(400, '无效的项目目录');
  const config = loadConfig({ cwd });
  applyRememberedChoices(config);
  const choices = readInitialChoices(Object.fromEntries(url.searchParams));
  if ('model' in choices) config.modelOverride = choices.model;
  if ('effort' in choices) config.effortOverride = choices.effort;
  const kind = url.searchParams.get('kind');
  const base = { model: config.modelSpec, effort: config.effort || 'auto', modelChoice: config.modelOverride || 'default', effortChoice: config.effortOverride || 'default' };
  if (kind === 'models') return { ...base, models: await sessionModels(config, { cached: true, picked: new Set(pickedModels()) }) };
  if (kind === 'efforts') return { ...base, efforts: (await sessionEfforts(config, { cached: true })).options };
  return base;
}

// ---------------------------------------------------------------- routes

const running = async () => {
  const list = await runningSessions();
  return new Map(list.filter((r) => r.status?.sessionId).map((r) => [r.status.sessionId, r]));
};

export const routes = [
  ['GET', /^\/api\/overview$/, () => overview()],
  ['GET', /^\/api\/update$/, (req, m, body, url) => webUpdateStatus({ fresh: url.searchParams.get('check') === '1' })],
  ['POST', /^\/api\/update$/, (req, m, body) => startWebUpdate(body?.version)],

  ['GET', /^\/api\/sessions$/, async () => {
    const live = await runningSessions();
    const peersById = new Map(live.filter((r) => r.status?.sessionId).map((r) => [r.status.sessionId, r.peerId]));
    return {
      sessions: listAllSessions().map(({ file, ...s }) => ({ ...s, running: peersById.get(s.id) ?? null })),
      live,
      projectOpen: { explorer: isWin, vscode: vscodeAvailable() },
    };
  }],
  ['GET', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)$/, async (req, [dir, id]) => {
    const detail = sessionDetail(dir, id);
    const live = await running();
    return { ...detail, archived: Boolean(archivedSessions()[id]), running: live.has(id) ? live.get(id).peerId : null };
  }],
  ['GET', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/image\/(\d+)$/, (req, [dir, id, n]) => {
    const image = sessionImage(dir, id, Number(n));
    if (!image) throw httpError(404, 'no such image');
    return { raw: { type: image.mediaType, data: image.data } };
  }],
  ['GET', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/output\/([\w-]+)$/, (req, [dir, id, tool]) => sessionToolOutput(dir, id, tool)],
  ['GET', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/export$/, (req, [dir, id]) => ({ raw: { type: 'text/markdown; charset=utf-8', data: sessionMarkdown(dir, id), name: `claude-pro-${id.slice(0, 8)}.md` } })],
  ['POST', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/rename$/, async (req, [dir, id], body) => {
    if ((await running()).has(id)) throw httpError(409, '会话正在运行：请在它的终端里用 /rename，或在「运行中」里给它发 /rename');
    return { name: renameSession(dir, id, body?.name) };
  }],
  ['POST', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/open$/, (req, [dir, id], body) => openSession(dir, id, { terminal: body?.terminal === true || body?.background === false })],
  ['DELETE', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)$/, (req, [dir, id]) => sessionOperation(id, 'delete', async () => {
    if (host?.recovering || host?.restarting) throw httpError(409, '控制台正在恢复会话，请稍后再试');
    if ((await running()).has(id)) throw httpError(409, '会话正在运行，请先关闭它再删除');
    return trashSession(dir, id);
  })],
  // 归档: put conversations away from the workspace (or back), several at once (a whole project)
  ['POST', /^\/api\/sessions\/archive$/, (req, m, body) => {
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)) : [];
    if (!ids.length) throw httpError(400, 'ids required');
    setArchived(ids, body?.archived !== false);
    return { ok: true, count: ids.length };
  }],
  ['GET', /^\/api\/trash$/, () => ({ items: listTrash() })],
  ['POST', /^\/api\/trash\/([\w.-]+)\/restore$/, (req, [trashId]) => restoreSession(trashId)],
  ['DELETE', /^\/api\/trash\/([\w.-]+)$/, (req, [trashId]) => ({ removed: purgeTrash({ trashId }) })],
  ['DELETE', /^\/api\/trash$/, () => ({ removed: purgeTrash({ all: true }) })],

  ['GET', /^\/api\/live$/, async () => ({ sessions: await runningSessions() })],
  ['GET', /^\/api\/live\/new\/options$/, (req, m, body, url) => newSessionOptions(url)],
  ['POST', /^\/api\/live\/new$/, (req, m, body) => newSession(body)],
  ['POST', /^\/api\/live\/([0-9a-f]{12})\/(send|interrupt|dialog|options|suggest|list|output|end)$/, async (req, [peerId, type], body) => {
    if (host?.updating && type === 'send') throw httpError(409, '正在安装更新，请稍后再试');
    if (type === 'end' && ![...(host?.apps || [])].some((app) => !app.exiting && app.peers?.id === peerId)) {
      throw httpError(409, '请在对应的终端结束这个会话');
    }
    const peer = findPeerById(peerId);
    const r = await peerRequest(peer, 'POST', '/command', { type, body: body || {} }, { timeout: type === 'options' ? 20_000 : 10_000 });
    if (r.status === 404) throw httpError(409, '这个会话的 claude-pro 版本较旧，不支持网页操作');
    if (!r.body?.ok) throw httpError(409, r.body?.error || '会话没有执行这个操作');
    return r.body;
  }],

  ['GET', /^\/api\/settings$/, (req, m, b, url) => settingsView(url.searchParams.get('project'))],
  ['POST', /^\/api\/settings$/, (req, m, body) => {
    const file = scopeFile(body?.scope || 'user', body?.project);
    if (body?.unset) unsetConfigSetting(file, String(body.key));
    else {
      try { writeConfigSetting(file, String(body?.key), body?.value); } catch (e) { throw httpError(400, e.message); }
    }
    return settingsView(body?.project);
  }],
  ['POST', /^\/api\/remembered$/, (req, m, body) => {
    rememberChoice({ ...(body && 'model' in body ? { model: body.model || null } : {}), ...(body && 'effort' in body ? { effort: body.effort || null } : {}) });
    return { remembered: rememberedChoice() };
  }],

  ['GET', /^\/api\/providers$/, () => providersView()],
  ['GET', /^\/api\/models$/, () => modelChoices()],
  ['GET', /^\/api\/models\/kept$/, () => keptModelLists()],
  ['POST', /^\/api\/models\/picked$/, (req, m, body) => ({ picked: savePickedModels(body?.models) })],
  ['POST', /^\/api\/models\/refresh$/, async () => ({ ...(await refreshModelLists(loadConfig({ cwd: home }))), view: providersView() })],
  ['POST', /^\/api\/providers\/check$/, (req, m, body) => checkProvider(body)],
  ['POST', /^\/api\/providers\/connect$/, (req, m, body) => connectProvider(body)],
  ['DELETE', /^\/api\/providers\/([a-z0-9-]+)$/, (req, [id]) => {
    if (!removeConnection(id)) throw httpError(404, '这个供应商没有连接');
    return providersView();
  }],
  ['POST', /^\/api\/gateway$/, async (req, m, body) => {
    const config = loadConfig({ cwd: home });
    try { await loginWithKey({ url: config.gatewayUrl, apiKey: body?.apiKey, signal: AbortSignal.timeout(15_000) }); } catch (e) { throw httpError(e.status === 401 || e.status === 403 ? 400 : 502, e.message); }
    return providersView();
  }],
  ['DELETE', /^\/api\/gateway$/, () => { clearGatewayLogin(); return providersView(); }],

  ['GET', /^\/api\/memory$/, () => memoryView()],
  ['GET', /^\/api\/projects$/, () => ({ projects: knownProjects() })],
  ['POST', /^\/api\/projects\/open$/, (req, m, body) => openProject(body)],
  ['POST', /^\/api\/projects\/pick$/, () => pickProjectDirectory()],
  ['GET', /^\/api\/projects\/directories$/, (req, m, body, url) => projectDirectories(url.searchParams.get('cwd'))],
  ['GET', /^\/api\/file$/, (req, m, b, url) => readFileInfo(checkedPath(url.searchParams.get('path')))],
  ['PUT', /^\/api\/file$/, (req, m, body) => {
    const file = checkedPath(body?.path);
    const text = String(body?.text ?? '');
    if (/\.json$/i.test(file) && text.trim()) {
      try { JSON.parse(text); } catch (e) { throw httpError(400, `不是有效的 JSON：${e.message}`); }
    }
    if (body?.mtime && fs.existsSync(file) && Math.abs(fs.statSync(file).mtimeMs - body.mtime) > 1) throw httpError(409, '文件在你打开之后被别的程序改过了：请重新打开再改');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return readFileInfo(file);
  }],
  ['DELETE', /^\/api\/file$/, (req, m, b, url) => {
    const file = checkedPath(url.searchParams.get('path'));
    if (/settings(\.local)?\.json$/i.test(file)) throw httpError(400, '设置文件不能在这里删除');
    const trash = path.join(CONFIG_DIR, 'trash', 'files', `${Date.now()}__${path.basename(file)}`);
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.renameSync(file, trash);
    return { trashed: trash };
  }],

  ['GET', /^\/api\/extensions$/, (req, m, b, url) => extensionsView(url.searchParams.get('project'))],
  ['POST', /^\/api\/extensions$/, (req, m, body) => newExtension(body || {})],
  ['POST', /^\/api\/mcp$/, (req, m, body) => {
    // add, replace or remove one MCP server in a settings file (user, or a project's .mcp.json)
    const name = String(body?.name || '').trim();
    if (!/^[\w.-]{1,60}$/.test(name)) throw httpError(400, '名字只能用字母、数字、_ . -');
    const file = body?.scope === 'project' ? path.join(checkedProject(body.project), '.mcp.json') : settingsFiles(home).user;
    updateSettingsFile(file, (json) => {
      json.mcpServers = json.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : {};
      if (body.remove) delete json.mcpServers[name];
      else {
        if (!body.spec || typeof body.spec !== 'object' || Array.isArray(body.spec)) throw httpError(400, 'spec must be an object');
        const old = json.mcpServers[name] || {};
        const spec = { ...body.spec };
        // values left as ••• keep what was saved (the page never sees them)
        for (const k of ['env', 'headers']) {
          if (spec[k] && typeof spec[k] === 'object') spec[k] = Object.fromEntries(Object.entries(spec[k]).map(([n, v]) => [n, v === '•••' ? old[k]?.[n] ?? '' : v]));
        }
        json.mcpServers[name] = spec;
      }
      if (!Object.keys(json.mcpServers).length) delete json.mcpServers;
    });
    return extensionsView(body?.project);
  }],

  ['GET', /^\/api\/usage$/, (req, m, b, url) => usageReport({ days: Math.min(90, Math.max(1, Math.round(Number(url.searchParams.get('days'))) || 30)) })],
];

function checkedProject(project) {
  if (!project || !knownProjects().some((p) => same(p.cwd, project)) || !fs.existsSync(project)) throw httpError(400, '请选择一个已知的项目');
  return path.resolve(project);
}
