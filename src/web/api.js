// The local web console's API (see server.js): each route is [method, pattern, handler(req, params, body, url)]
// answering with a value (sent as JSON) or {raw: {type, data, name?}} for a file, or throwing httpError.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import {
  CONFIG_DIR, INSTALL_DIR, SOURCE_CHECKOUT, VERSION, BASIC_SETTINGS, KNOWN_KEYS, loadConfig, settingsFiles,
  writeConfigSetting, unsetConfigSetting, rememberChoice, updateSettingsFile,
} from '../config.js';
import {
  PRESETS, GATEWAY_PROVIDER, readConnections, saveConnection, removeConnection, providerInfo, connectedProviders,
  listProviderModels, testProviderModel, modelsDevCatalogue, enrichModels, cleanProviderId, reservedProviderId,
  normalizeBaseUrl, validBaseUrl,
} from '../providers.js';
import { gatewayLogin, loginWithKey, clearGatewayLogin, fetchGatewayAccount, fetchGatewayModels } from '../gateway.js';
import { checkForUpdate } from '../updater.js';
import { loadAgents, loadSkills, loadCustomCommands } from '../agents.js';
import {
  listAllSessions, sessionDetail, sessionImage, sessionMarkdown, renameSession, trashSession, listTrash, restoreSession,
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
      const list = await fetchGatewayModels(login, { signal: AbortSignal.timeout(8000) });
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

// claude-pro in a new terminal window or tab, in `cwd`, with `args` (ids and flags only: nothing a shell would
// take apart). Windows Terminal when there is one, else a console window; elsewhere only the command to run.
function launchTerminal(cwd, args, title) {
  const bin = path.join(INSTALL_DIR, 'bin', 'claude-pro.js');
  const command = `cd "${cwd}" && claude-pro${args.length ? ` ${args.join(' ')}` : ''}`;
  if (!isWin) return { opened: false, command };
  const wt = windowsTerminal();
  const child = wt
    ? spawn(wt, ['-w', '0', 'new-tab', '-d', cwd, '--title', String(title || 'claude-pro').replace(/;/g, ',').slice(0, 40), process.execPath, bin, ...args], { detached: true, stdio: 'ignore', windowsHide: false })
    : spawn('cmd.exe', ['/c', 'start', '""', '/D', `"${cwd}"`, `"${process.execPath}"`, `"${bin}"`, ...args], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  child.on('error', () => {});
  child.unref();
  return { opened: true, how: wt ? 'Windows Terminal' : 'cmd', command };
}

function openInTerminal(dir, id) {
  const session = listAllSessions().find((s) => s.dir === dir && s.id === id);
  if (!session) throw httpError(404, '会话不存在');
  const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : home;
  return launchTerminal(cwd, ['--resume', id], session.title);
}

// A new session in `cwd` (its first message, if any, is sent by the page once the session is up: no quoting through
// a terminal's command line).
function newSession(body) {
  let cwd = String(body?.cwd || '').trim().replace(/^~(?=$|[\\/])/, home);
  if (!cwd) throw httpError(400, '请填写目录');
  cwd = path.resolve(cwd);
  let st;
  try { st = fs.statSync(cwd); } catch { throw httpError(400, `目录不存在：${cwd}`); }
  if (!st.isDirectory()) throw httpError(400, `不是目录：${cwd}`);
  return { ...launchTerminal(cwd, [], path.basename(cwd) || cwd), cwd };
}

// ---------------------------------------------------------------- routes

const running = async () => {
  const list = await runningSessions();
  return new Map(list.filter((r) => r.status?.sessionId).map((r) => [r.status.sessionId, r]));
};

export const routes = [
  ['GET', /^\/api\/overview$/, () => overview()],
  ['GET', /^\/api\/update$/, () => checkForUpdate().catch((e) => ({ status: 'error', error: e.message }))],

  ['GET', /^\/api\/sessions$/, async () => {
    const live = await running();
    return { sessions: listAllSessions().map(({ file, ...s }) => ({ ...s, running: live.has(s.id) ? live.get(s.id).peerId : null })) };
  }],
  ['GET', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)$/, async (req, [dir, id]) => {
    const detail = sessionDetail(dir, id);
    const live = await running();
    return { ...detail, running: live.has(id) ? live.get(id).peerId : null };
  }],
  ['GET', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/image\/(\d+)$/, (req, [dir, id, n]) => {
    const image = sessionImage(dir, id, Number(n));
    if (!image) throw httpError(404, 'no such image');
    return { raw: { type: image.mediaType, data: image.data } };
  }],
  ['GET', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/export$/, (req, [dir, id]) => ({ raw: { type: 'text/markdown; charset=utf-8', data: sessionMarkdown(dir, id), name: `claude-pro-${id.slice(0, 8)}.md` } })],
  ['POST', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/rename$/, async (req, [dir, id], body) => {
    if ((await running()).has(id)) throw httpError(409, '会话正在运行：请在它的终端里用 /rename，或在「运行中」里给它发 /rename');
    return { name: renameSession(dir, id, body?.name) };
  }],
  ['POST', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)\/open$/, (req, [dir, id]) => openInTerminal(dir, id)],
  ['DELETE', /^\/api\/sessions\/([\w.-]+)\/([\w-]+)$/, async (req, [dir, id]) => {
    if ((await running()).has(id)) throw httpError(409, '会话正在运行，不能删除');
    return trashSession(dir, id);
  }],
  ['GET', /^\/api\/trash$/, () => ({ items: listTrash() })],
  ['POST', /^\/api\/trash\/([\w.-]+)\/restore$/, (req, [trashId]) => restoreSession(trashId)],
  ['DELETE', /^\/api\/trash\/([\w.-]+)$/, (req, [trashId]) => ({ removed: purgeTrash({ trashId }) })],
  ['DELETE', /^\/api\/trash$/, () => ({ removed: purgeTrash({ all: true }) })],

  ['GET', /^\/api\/live$/, async () => ({ sessions: await runningSessions() })],
  ['POST', /^\/api\/live\/new$/, (req, m, body) => newSession(body)],
  ['POST', /^\/api\/live\/([0-9a-f]{12})\/(send|interrupt|dialog|options|suggest|list|output)$/, async (req, [peerId, type], body) => {
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

  ['GET', /^\/api\/usage$/, (req, m, b, url) => usageReport({ days: Math.min(90, Math.max(7, Number(url.searchParams.get('days')) || 30)) })],
];

function checkedProject(project) {
  if (!project || !knownProjects().some((p) => same(p.cwd, project)) || !fs.existsSync(project)) throw httpError(400, '请选择一个已知的项目');
  return path.resolve(project);
}
