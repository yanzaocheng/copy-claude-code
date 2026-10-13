// Slash commands for the interactive REPL.

import fs from 'node:fs';
import path from 'node:path';
import { c, padEnd, truncate, colorEnabled } from './ui/ansi.js';
import { SelectDialog } from './ui/dialogs.js';
import { renderTodos, resultLines, formatTokens, formatDuration } from './ui/render.js';
import { loadConfig, settingsFiles, updateSettingsFile, rememberChoice, applyRememberedChoices, KNOWN_KEYS, VERSION, APP_NAME, CONFIG_DIR } from './config.js';
import { loginWithBrowser, readGatewayLogin, clearGatewayLogin, fetchGatewayAccount, fetchGatewayModels, cachedGatewayModel, gatewayEfforts, formatUsd } from './gateway.js';
import { codexLoginSummary, codexModels, codexEfforts } from './codex/client.js';
import { readClaudeCodeLogin } from './claude-code.js';
import { SessionStore } from './session.js';
import { memoryFiles, listAutoMemories } from './context.js';
import { INIT_PROMPT } from './prompts.js';
import { loadCustomCommands, renderSkill, expandCommandBody, expandShellEmbeds } from './agents.js';
import { listBackgroundShells } from './tools/bash.js';
import { estimateTokens } from './agent.js';
import { quickQuery, cacheRefusals, defaultEffort, effortToSend, CLAUDE_EFFORTS } from './api.js';
import { hasRipgrep } from './utils/shell.js';
import { displayPath } from './utils/paths.js';
import { cleanName, machineName } from './peers.js';
import { rewind, promptAt } from './checkpoints.js';
import { canRestart, runSelfCheck } from './restart.js';
import { describeHost, normalizeDir } from './host.js';
import { qrLines } from './qr.js';

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const isGpt = (modelId) => /^gpt-/i.test(modelId);
// The levels /effort offers for a model: Claude's own (as in Claude Code); for a GPT model the gateway's metadata,
// else the local Codex cache; EFFORTS for other models (an Anthropic-compatible API may take any of them).
const effortLevels = (modelId, modelInfo = null) => {
  if (/^claude-/i.test(modelId)) return CLAUDE_EFFORTS;
  const remote = gatewayEfforts(modelInfo);
  if (remote.length) return remote;
  return isGpt(modelId) && codexEfforts(modelId).length ? codexEfforts(modelId) : EFFORTS;
};

// What /model offers (and the remote page, see App.remoteOptions): [{value, label, description}] in plain text, the
// default first. `value` is what /model <value> takes. The gateway's list of models is asked for (4 seconds at
// most); without an answer gpt-6.1-sol stands for its GPT models.
export async function modelChoices(cfg) {
  const configured = cfg.configuredModelSpec;
  const opts = [{ value: 'default', label: 'Default', description: `${configured} → ${cfg.resolveModel(configured).id}` }];
  if (cfg.usesCodex) {
    // The models the local Codex install lists.
    for (const m of codexModels({ ...process.env, ...cfg.env }).models.filter((x) => !x.hidden)) opts.push({ value: m.slug, label: m.slug, description: m.contextWindow ? `${formatTokens(m.contextWindow)} context` : '' });
  } else {
    opts.push(...['opus', 'sonnet', 'haiku'].map((a) => ({ value: a, label: a, description: `→ ${cfg.resolveModel(cfg.aliasTarget(a)).label}` })));
  }
  if (cfg.usesGateway) {
    // The other models the gateway serves (Fable, the GPT models, …); without an answer, gpt-6.1-sol.
    const login = readGatewayLogin(cfg.gatewayUrl);
    let served = null;
    try { if (login) served = await fetchGatewayModels(login, { signal: AbortSignal.timeout(4000) }); } catch { /* offline: the fallback below */ }
    const aliased = new Set(['opus', 'sonnet', 'haiku'].map((a) => cfg.resolveModel(cfg.aliasTarget(a)).id));
    for (const m of served?.length ? served : [{ id: 'gpt-6.1-sol' }]) {
      if (aliased.has(m.id)) continue;
      opts.push({ value: m.id, label: m.id, description: isGpt(m.id) ? 'OpenAI, through the gateway\'s Codex login' : m.display_name || '' });
    }
  }
  if (cfg.provider === 'api' && cfg.env.CLAUDE_CODE_SUBAGENT_MODEL) opts.push({ value: cfg.env.CLAUDE_CODE_SUBAGENT_MODEL, label: cfg.env.CLAUDE_CODE_SUBAGENT_MODEL, description: 'sub-agent model' });
  return opts;
}

// What /effort offers for the current model: {levels, options: [{value, label, description}]} in plain text (the
// levels, auto, default).
export async function effortChoices(cfg) {
  const id = cfg.mainModel.id;
  let info = null;
  if (cfg.usesGateway && isGpt(id)) {
    const login = readGatewayLogin(cfg.gatewayUrl);
    try { if (login) info = (await fetchGatewayModels(login, { signal: AbortSignal.timeout(4000) })).find((m) => m.id === id) || null; } catch { /* use local cache or generic levels */ }
  }
  const levels = effortLevels(id, info);
  const configured = (cfg.env.CLAUDE_CODE_EFFORT_LEVEL || '').trim().toLowerCase() || 'auto';
  const fallback = defaultEffort(id, cfg);
  return {
    levels,
    options: [
      ...levels.map((e) => ({ value: e, label: e, description: '' })),
      { value: 'auto', label: 'auto', description: fallback ? `model default: ${fallback}` : 'use API default' },
      { value: 'default', label: 'default', description: `configured: ${configured}` },
    ],
  };
}

export function buildCommands(app) {
  const commands = new Map();
  const add = (cmd) => commands.set(cmd.name, cmd);
  const log = (...lines) => app.screen.log(...lines);
  const out = (lines) => log(resultLines(Array.isArray(lines) ? lines : [lines]), '');

  // /model and /effort choices are kept for later sessions (rememberChoice); say so, or why they are not.
  const keep = (cfg, patch, forgotten) => {
    try {
      rememberChoice(cfg.provider, patch);
      return c.dim(forgotten ? ' · the configured default from now on' : ' · kept for later sessions');
    } catch (e) {
      return c.yellow(` · for this session only (${e.message})`);
    }
  };

  const reloadConfig = () => {
    const fresh = loadConfig({ cwd: app.cwd, flags: app.flags });
    const cfg = app.runtime.config;
    const model = cfg.mainModel.id;
    cfg.env = fresh.env;
    cfg.sources = fresh.sources;
    cfg.settings = fresh.settings;
    cfg.ignoredFromDotEnv = fresh.ignoredFromDotEnv;
    // What the system prompt is built from may have changed (memory switched off, say). It is not rebuilt in the
    // middle of a conversation, which would lose its prompt cache; it is, at the next /clear or compaction. A
    // different model is the exception: the prompt names it, and the new model has a cache of its own anyway.
    if (cfg.mainModel.id !== model) app.runtime.invalidateSystemPrompt();
    else app.runtime.deferSystemPromptRefresh();
  };

  // Claude Code asks before something makes the next request read the whole conversation without the prompt
  // cache, but only while that cache is still warm: once it has expired there is nothing left to lose. (A model
  // that answered the last request has the cache that is in use, so switching to it loses nothing.)
  const confirmCacheLoss = async (what, { model = null } = {}) => {
    const cache = app.agent.cache;
    if (!app.agent.messages.length || !cache.isWarm() || (model && model === cache.model)) return true;
    const choice = await app.showDialog(new SelectDialog({
      title: what,
      question: `The prompt cache is warm (about ${formatTokens(cache.expected)} tokens, ${formatDuration(cache.expiresAt - Date.now())} left). ${what} makes the next request read the whole conversation again without it, which costs more and takes longer. Go on?`,
      color: c.blue,
      options: [{ label: 'Yes, go on', value: 'yes' }, { label: 'No, leave it as it is', value: 'no' }],
      cancelValue: 'no',
    }));
    return choice === 'yes';
  };

  add({
    name: 'help',
    description: 'Show help and available commands',
    run() {
      const lines = [
        c.bold(`${APP_NAME} v${VERSION}`) + c.dim(' — a Claude Code style coding agent'),
        '',
        'Always review the agent\'s changes before committing them.',
        '',
        c.bold('Usage modes:'),
        `  • REPL: ${c.bold(APP_NAME)} (interactive session)`,
        `  • Non-interactive: ${c.bold(`${APP_NAME} -p "question"`)}`,
        `  Run ${c.bold(`${APP_NAME} -h`)} for all command line flags`,
        '',
        c.bold('Shortcuts:'),
        ...app.shortcutsHelp(),
        '',
        c.bold('Commands:'),
      ];
      for (const cmd of commands.values()) {
        if (cmd.hidden) continue;
        lines.push(`  ${c.bold(padEnd('/' + cmd.name + (cmd.argHint ? ' ' + cmd.argHint : ''), 28))} ${c.dim(cmd.description)}`);
      }
      log(lines, '');
    },
  });

  add({
    name: 'cd',
    argHint: '<directory>',
    argRequired: true,
    description: 'Change the working directory; the conversation goes on there (with that project\'s settings, CLAUDE.md and memory)',
    run(args) {
      const wanted = args.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
      if (!wanted) { out(`Working directory: ${app.cwd} ${c.dim('(/cd <directory> changes it)')}`); return; }
      // absolute, ~ for the home directory, D: for a drive; else from the working directory
      const dir = normalizeDir(wanted) ?? path.resolve(app.cwd, wanted);
      let st = null;
      try { st = fs.statSync(dir); } catch { /* below */ }
      if (!st) { out(c.red(`No such directory: ${dir}`)); return; }
      if (!st.isDirectory()) { out(c.red(`Not a directory: ${dir}`)); return; }
      const same = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
      if (same(dir, app.cwd)) { out(`Working directory: ${app.cwd} ${c.dim('(already)')}`); return; }
      const res = app.changeDirectory(dir);
      if (!res.ok) out(c.red(res.message));
    },
  });

  add({
    name: 'clear',
    aliases: ['reset', 'new'],
    description: 'Clear conversation history and free up context',
    run() {
      // the conversation it ends stays one esc esc away (the rewind menu), until the end of this process
      const previous = app.agent.messages.length ? { file: app.store.file, id: app.store.id } : null;
      app.agent.resetConversation();
      app.newSession();
      if (previous) app.previousSession = previous;
      app.runtime.invalidateSystemPrompt();
      app.screen.clearScreen();
      app.printWelcome();
    },
  });

  add({
    name: 'restart',
    aliases: ['reload'],
    argHint: '[force]',
    description: "Restart to load changes to the program's own source code (the conversation continues)",
    async run(args) {
      if (!canRestart()) {
        out(c.red(`Restarting needs an interactive session started with \`${APP_NAME}\` (not -p, and without CLAUDE_PRO_NO_SUPERVISOR). Quit and start it again.`));
        return;
      }
      const force = /\bforce\b/i.test(args);
      const blockers = app.restartBlockers();
      if (blockers.length && !force) {
        out(c.yellow(`A restart would kill: ${blockers.join('; ')}. Run /restart force to do it anyway.`));
        return;
      }
      if (!force) {
        out(c.dim('Checking that the new code starts…'));
        const check = await runSelfCheck();
        if (!check.ok) {
          out([c.red('Not restarting: the new code does not start.'), ...check.output.split('\n').slice(0, 15).map((l) => c.dim(l)), c.dim('Fix it, or run /restart force to restart anyway.')]);
          return;
        }
      }
      const res = app.requestRestart({ force: true });
      if (!res.ok) out(c.red(res.message));
    },
  });

  add({
    name: 'compact',
    argHint: '[instructions]',
    description: 'Clear history but keep a summary in context',
    async run(args) {
      if (!app.agent.messages.length) { out(c.dim('Nothing to compact yet.')); return; }
      app.busy = true;
      app.controller = new AbortController();
      app.turnStart = Date.now();
      app.turnTokens = 0;
      try {
        const summary = await app.agent.compact({ signal: app.controller.signal, instructions: args });
        if (summary && app.verbose) log(c.dim(summary), '');
      } catch (e) {
        if (!app.controller.signal.aborted) app.logError(e);
        else out(c.red('Compaction interrupted'));
      } finally {
        app.busy = false;
        app.controller = null;
        app.status = null;
        app.rateWait = null; // cancelled while paused for a rate limit: no countdown may outlive it
        app.sendWhatWaited(); // what was typed during a long compaction (or its pause) goes out now
      }
    },
  });

  add({
    name: 'config',
    argHint: '[set KEY VALUE | unset KEY] [--project|--local]',
    description: 'Show or change configuration (API URL, models, effort, …)',
    run(args) {
      const parts = args.split(/\s+/).filter(Boolean);
      const scope = parts.includes('--project') ? 'project' : parts.includes('--local') ? 'local' : 'user';
      const rest = parts.filter((p) => p !== '--project' && p !== '--local');
      const file = settingsFiles(app.cwd)[scope];
      if (rest[0] === 'set' && rest[1] && rest.length >= 3) {
        const value = rest.slice(2).join(' ');
        updateSettingsFile(file, (json) => { json.env = { ...(json.env || {}), [rest[1]]: value }; });
        reloadConfig();
        out([`Set ${c.bold(rest[1])} in ${file}`, ...(app.runtime.config.sources[rest[1]] !== file ? [c.yellow(`Note: overridden by ${app.runtime.config.sources[rest[1]]}`)] : [])]);
        return;
      }
      if (rest[0] === 'unset' && rest[1]) {
        updateSettingsFile(file, (json) => { if (json.env) delete json.env[rest[1]]; });
        reloadConfig();
        out(`Removed ${c.bold(rest[1])} from ${file}`);
        return;
      }
      const cfg = app.runtime.config;
      const lines = [c.bold('Configuration') + c.dim('  (precedence: .env < ~/.claude-pro/settings.json < .claude-pro/settings.json < .claude-pro/settings.local.json < shell env < flags)'), ''];
      for (const k of Object.keys(KNOWN_KEYS)) {
        const v = cfg.display(k);
        if (v === undefined) continue;
        lines.push(`${padEnd(k, 34)} ${c.bold(v)}  ${c.dim(cfg.sources[k] || '')}`);
      }
      if (cfg.ignoredFromDotEnv.length) lines.push('', c.dim(`Not applied from .env with the claude-code provider (it is the API provider's setup; Claude Code's defaults are used instead): ${cfg.ignoredFromDotEnv.join(', ')}. Set them with /config set or /effort to apply them here.`));
      lines.push('', c.dim('Other keys: ' + Object.keys(KNOWN_KEYS).filter((k) => cfg.env[k] === undefined).join(', ')));
      lines.push('', `${c.dim('Change with')} /config set KEY VALUE [--project|--local] ${c.dim('or edit')} ${settingsFiles(app.cwd).user}`);
      log(lines, '');
    },
  });

  add({
    name: 'model',
    argHint: '[model]',
    description: 'Set the AI model (kept for later sessions; /model default forgets it)',
    async run(args) {
      const cfg = app.runtime.config;
      let choice = args.trim();
      if (!choice) {
        const opts = (await modelChoices(cfg)).map((o) => ({ label: `${o.label}${o.description ? ` ${c.dim(o.description.startsWith('→') ? o.description : `(${o.description})`)}` : ''}`, value: o.value }));
        choice = await app.showDialog(new SelectDialog({ title: 'Select model', question: `Current: ${c.bold(cfg.mainModel.label)}. Any name works too: /model <name>`, options: opts }));
        if (!choice) return;
      }
      const forget = choice === '__default__' || choice === 'default';
      const next = cfg.resolveModel(forget ? cfg.configuredModelSpec : choice).id;
      const changed = next !== cfg.mainModel.id;
      if (changed && !(await confirmCacheLoss('Switching the model', { model: next }))) { out(c.dim('The model was not changed.')); return; }
      cfg.modelOverride = forget ? null : choice;
      if (changed) app.runtime.invalidateSystemPrompt(); // the prompt names the model; the new model starts a cache of its own anyway
      const kept = keep(cfg, { model: cfg.modelOverride }, forget);
      out(`Model set to ${c.bold(cfg.mainModel.label)} ${c.dim(`(${formatTokens(cfg.mainModel.contextWindow)} context)`)}${kept}`);
    },
  });

  add({
    name: 'effort',
    get argHint() {
      const cfg = app.runtime.config;
      const login = cfg.usesGateway ? readGatewayLogin(cfg.gatewayUrl) : null;
      return `[${effortLevels(cfg.mainModel.id, cachedGatewayModel(login, cfg.mainModel.id)).join('|')}|auto|default]`;
    },
    description: 'Set reasoning effort (output_config.effort; kept for later sessions)',
    async run(args) {
      const cfg = app.runtime.config;
      const id = cfg.mainModel.id;
      const { levels, options } = await effortChoices(cfg);
      let choice = args.trim().toLowerCase();
      if (!choice) {
        const fallback = defaultEffort(id, cfg);
        // A level this model does not take goes out as the nearest one it does.
        const sent = effortToSend(cfg, id, cfg.effort);
        const current = !cfg.effort ? c.bold(`auto (${fallback ? `model default: ${fallback}` : 'not sent'})`)
          : `${c.bold(cfg.effort)}${sent !== cfg.effort ? c.yellow(` (${id} does not take it: sent as ${sent})`) : ''}`;
        choice = await app.showDialog(new SelectDialog({
          title: `Reasoning effort · ${id}`,
          question: `Current: ${current}`,
          options: options.map((o) => ({ label: `${o.label}${o.description ? ` ${c.dim(`(${o.description})`)}` : ''}`, value: o.value })),
        }));
        if (!choice) return;
      }
      if (choice !== 'auto' && choice !== 'default' && !levels.includes(choice)) { out(c.red(`${id} does not take effort "${choice}". Use one of: ${levels.join(', ')}, auto, default`)); return; }
      const forget = choice === 'default';
      const wanted = (forget ? (cfg.env.CLAUDE_CODE_EFFORT_LEVEL || '') : choice).trim().toLowerCase();
      const next = wanted && wanted !== 'auto' && wanted !== 'default' ? wanted : null;
      if (next !== cfg.effort && !(await confirmCacheLoss('Changing the effort'))) { out(c.dim('The effort was not changed.')); return; }
      cfg.effortOverride = forget ? null : choice;
      cfg.effortBoost = null; // the user's choice replaces what the model set for itself with the Effort tool
      out(`Effort set to ${c.bold(cfg.effort || 'auto')}${keep(cfg, { effort: cfg.effortOverride }, forget)}`);
    },
  });

  // Switch the provider (kept in the user settings) and take up its own remembered /model and /effort.
  const switchProvider = (provider) => {
    const cfg = app.runtime.config;
    const files = settingsFiles(app.cwd);
    // The choice goes where the setting that wins is now: a project's settings file overrides the user's,
    // so writing only the user's file would change nothing in this project.
    const winning = cfg.sources.CLAUDE_PRO_PROVIDER;
    const file = [files.local, files.project].includes(winning) ? winning : files.user;
    const set = (f) => updateSettingsFile(f, (json) => { json.env = { ...(json.env || {}), CLAUDE_PRO_PROVIDER: provider }; });
    set(files.user); // the default for the other projects too
    if (file !== files.user) set(file);
    const model = cfg.mainModel.id;
    reloadConfig();
    cfg.modelOverride = null;
    cfg.effortOverride = null;
    cfg.effortBoost = null;
    applyRememberedChoices(cfg, app.flags);
    if (cfg.mainModel.id !== model) app.runtime.invalidateSystemPrompt();
    if (cfg.provider !== provider) return c.red(` · NOT switched: CLAUDE_PRO_PROVIDER=${cfg.provider} is set by ${cfg.sources.CLAUDE_PRO_PROVIDER}, which overrides the settings files; change it there`);
    return file !== files.user ? c.dim(` · also saved in ${displayPath(file, app.cwd)}, which overrides the user settings in this project`) : '';
  };
  const accountLine = (account) => `${account.name || ''}${account.email ? ` <${account.email}>` : ''} · balance ${c.bold(formatUsd(account.available_usd ?? account.balance_usd))}`;
  let pendingLogin = null;
  // Logged in to the gateway: this session goes online there at once (remote control, the other computers'
  // sessions), and the computer service starts (the web page opens new sessions through it).
  const goOnline = async () => {
    const remote = await app.syncRemote();
    app.ensureHost();
    if (!remote) return;
    out(remote.url
      ? `${c.green('⇄')} This session is online at the gateway: ${c.blue(remote.url)} ${c.dim('(/status shows it, with a QR code for a phone)')}`
      : c.dim(`⇄ This session goes online at the gateway as soon as ${remote.base} can be reached.`));
  };

  add({
    name: 'login',
    argHint: '[claude|gateway|codex]',
    description: 'Choose where model requests go: the Claude subscription, the codex-gateway account (browser login), or the Codex subscription',
    async run(args) {
      const cfg = app.runtime.config;
      let choice = args.trim().toLowerCase();
      if (choice === 'claude') choice = 'claude-code';
      if (!choice) {
        const saved = readGatewayLogin(cfg.gatewayUrl);
        const codex = codexLoginSummary({ ...process.env, ...cfg.env });
        choice = await app.showDialog(new SelectDialog({
          title: 'Log in',
          question: `Now: ${c.bold(cfg.provider)} (${cfg.endpointLabel})`,
          options: [
            { label: `Gateway ${cfg.gatewayUrl} ${c.dim(saved ? `(logged in as ${saved.account?.email || 'this machine'}; paid from the account balance)` : '(log in in the browser; paid from the account balance)')}`, value: 'gateway' },
            { label: `Claude subscription ${c.dim('(the local Claude Code login)')}`, value: 'claude-code' },
            { label: `Codex subscription ${c.dim(codex.ok ? `(the local Codex login${codex.plan ? `, ${codex.plan}` : ''})` : '(run `codex login` first)')}`, value: 'codex' },
          ],
        }));
        if (!choice) return;
      }
      if (!['claude-code', 'gateway', 'codex'].includes(choice)) { out(c.red(`Unknown choice "${choice}". Use claude, gateway or codex.`)); return; }
      if (choice !== cfg.provider && !(await confirmCacheLoss('Switching the provider'))) { out(c.dim('Nothing was changed.')); return; }

      if (choice === 'claude-code') {
        try { readClaudeCodeLogin(cfg); } catch (e) {
          // An expired token is renewed at the first request; a missing login is not.
          if (!/expired/i.test(e.message)) {
            out(c.red(`The Claude subscription login cannot be used: ${e.message}. Log in with the official \`claude\` once, then run /login again.`));
            return;
          }
        }
        const note = switchProvider('claude-code');
        out(`Using the ${c.bold('Claude subscription')}: ${cfg.mainModel.label}${note}`);
        return;
      }
      if (choice === 'codex') {
        const codex = codexLoginSummary({ ...process.env, ...cfg.env });
        if (!codex.ok) { out(c.red(`The Codex login cannot be used: ${codex.error}`)); return; }
        const note = switchProvider('codex');
        out(`Using the ${c.bold('Codex subscription')}${codex.email ? ` (${codex.email}${codex.plan ? `, ${codex.plan}` : ''})` : ''}: ${cfg.mainModel.label}${note}`);
        return;
      }

      // The gateway: a saved key that still works is used as it is; otherwise log in through the browser.
      const url = cfg.gatewayUrl;
      const saved = readGatewayLogin(url);
      if (saved) {
        try {
          const account = await fetchGatewayAccount(saved);
          const note = switchProvider('gateway');
          out([`Using the gateway ${c.bold(url)}: ${cfg.mainModel.label}${note}`, accountLine(account), c.dim(`Top up and usage: ${url}/user · another account: /logout, then /login`)]);
          await goOnline();
          return;
        } catch (e) {
          if (e.status !== 401 && e.status !== 403) { out(c.red(`Cannot reach the gateway ${url}: ${e.message}`)); return; }
          clearGatewayLogin(); // the key was revoked: log in again
        }
      }
      pendingLogin?.abort();
      const controller = new AbortController();
      pendingLogin = controller;
      try {
        const login = await loginWithBrowser({
          url,
          signal: controller.signal,
          onUrl: (page) => out([`Opening the gateway login in your browser. If it does not open, visit:`, c.blue(page), c.dim('Waiting for the browser (10 minutes at most)…')]),
        });
        const note = switchProvider('gateway');
        out([`Logged in to the gateway ${c.bold(url)}: ${cfg.mainModel.label}${note}`, accountLine(login.balance || login.account), c.dim(`Top up and usage: ${url}/user`)]);
        await goOnline();
      } catch (e) {
        if (e.name !== 'AbortError') out(c.red(`Gateway login failed: ${e.message}`));
      } finally {
        if (pendingLogin === controller) pendingLogin = null;
      }
    },
  });

  add({
    name: 'logout',
    description: 'Forget the gateway login of this machine (its sessions go offline there)',
    run() {
      const cfg = app.runtime.config;
      const had = clearGatewayLogin();
      const wasOnline = Boolean(app.remote);
      app.stopRemote(); // the other sessions of this computer and its computer service follow within seconds
      out(had
        ? `Logged out of the gateway ${cfg.gatewayUrl}.${wasOnline ? ' This session is offline there now.' : ''}${cfg.usesGateway ? ' Run /login to log in again or choose another provider.' : ''}`
        : c.dim('There was no gateway login. (The Claude and Codex subscription logins belong to their own CLIs.)'));
    },
  });

  add({
    name: 'status',
    description: 'Show version, model, API endpoint and session info',
    run() {
      const cfg = app.runtime.config;
      const modes = app.runtime.modes;
      const mem = memoryFiles(app.cwd);
      const mcp = app.runtime.mcp.status();
      const row = (k, v) => `${c.dim(padEnd(k, 18))} ${v}`;
      log([
        c.bold('Status'), '',
        row('Version', VERSION),
        row('Session ID', app.store.id),
        row('cwd', app.cwd),
        row('Provider', cfg.provider),
        row('Endpoint', cfg.endpointLabel),
        row('Auth', cfg.usesClaudeCode ? `existing Claude Code OAuth (${cfg.claudeCodeCredentialsFile})`
          : cfg.usesGateway ? (readGatewayLogin(cfg.gatewayUrl) ? `gateway key of ${readGatewayLogin(cfg.gatewayUrl).account?.email || 'this machine'} ${c.dim('(/cost shows the balance)')}` : c.red('not logged in (/login)'))
            : cfg.usesCodex ? (() => { const s = codexLoginSummary({ ...process.env, ...cfg.env }); return s.ok ? `Codex login${s.email ? ` of ${s.email}` : ''}${s.plan ? ` (${s.plan})` : ''} ${c.dim(s.file)}` : c.red(s.error); })()
              : cfg.authToken ? `ANTHROPIC_AUTH_TOKEN (${cfg.display('ANTHROPIC_AUTH_TOKEN')})` : cfg.apiKey ? `ANTHROPIC_API_KEY (${cfg.display('ANTHROPIC_API_KEY')})` : c.red('none')),
        row('Model', `${cfg.mainModel.label} ${c.dim(`(sent as "${cfg.mainModel.id}", ${formatTokens(cfg.mainModel.contextWindow)} context)`)}`),
        row('Sub-agent model', cfg.subagentModelChosen ? `chosen per task by difficulty ${c.dim(`(haiku, sonnet or opus; not chosen: ${cfg.subagentModel.label})`)}` : cfg.subagentModel.label),
        row('Small model', cfg.smallModel.label),
        row('Effort', cfg.effort || 'auto'),
        row('Max output', formatTokens(cfg.maxOutputTokens)),
        row('Prompt cache', cfg.promptCachingDisabled(cfg.mainModel.id) ? 'off (DISABLE_PROMPT_CACHING)' : `on · TTL ${cfg.cacheTtl('main')} for the conversation, ${cfg.cacheTtl('other')} for sub-agents and compaction${cacheRefusals(cfg, cfg.mainModel.id).length ? c.yellow(` · the endpoint refused: ${cacheRefusals(cfg, cfg.mainModel.id).join(', ')}`) : ''}${app.runtime.systemPromptStale ? c.dim(' · memory/config changes reach the system prompt at /clear or /compact') : ''}`),
        row('Auto-compact', cfg.autoCompactEnabled ? `at ${formatTokens(cfg.autoCompactThreshold())} tokens (window ${formatTokens(cfg.compactWindow())})` : 'disabled'),
        row('Mode', modes.mode === 'plan' ? 'plan (read-only; shift+tab to leave)' : 'full access (no permission prompts)'),
        row('Checkpoints', `${app.runtime.checkpoints.list().length} (/rewind)`),
        row('Shell', `${app.runtime.shell.name} ${c.dim(app.runtime.shell.path)}`),
        row('ripgrep', hasRipgrep(cfg) ? 'yes' : 'no (using JS fallback)'),
        row('Memory', mem.length ? mem.map((m) => m.file).join(', ') : c.dim('none')),
        row('MCP servers', mcp.length ? mcp.map((m) => `${m.name} (${m.status})`).join(', ') : c.dim('none')),
        '',
        ...remoteLines(row),
      ], '');
    },
  });

  // /status about the gateway: this session there (its page, and a QR code of it for a phone), its name for the
  // sessions on the other computers, and the computer service.
  function remoteLines(row) {
    const cfg = app.runtime.config;
    const remote = app.remoteState();
    const me = app.peerLabel();
    const lines = [
      row('Remote control', remote.text),
      ...(remote.url ? [row('', c.blue(remote.url))] : []),
      row('Name', `&${me} ${c.dim(`(on your other computers: &${machineName(cfg.env)}/${me}; /rename changes it)`)}`),
      row('Computer service', describeHost(cfg.env)),
    ];
    const qr = remote.url && app.remote?.online ? qrLines(remote.url, { color: colorEnabled }) : null;
    if (qr) {
      lines.push('', c.dim('  Scan with a phone to open this session (log in to the gateway there):'), ...qr.map((l) => `    ${l}`));
      lines.push(c.dim(`  Whoever can log in to this gateway account, or holds one of its API keys, can run anything on this computer through it.`));
    }
    return lines;
  }

  add({
    name: 'cost',
    aliases: ['usage'],
    description: 'Show token usage for this session (and the gateway balance)',
    async run() {
      const a = app.agent;
      const u = a.totalUsage();
      const b = a.subUsage;
      const cacheLines = a.cache.describe();
      out([
        `Total cost:    ${formatUsd(app.cost)} ${c.dim('for this conversation, at list prices (sub-agents, compaction and side requests included)')}`,
        `Total input:   ${formatTokens(u.input + u.cacheRead + u.cacheWrite)} tokens ${c.dim(`(${formatTokens(u.cacheRead)} cache read, ${formatTokens(u.cacheWrite)} cache write${u.cacheWrite1h ? `, ${formatTokens(u.cacheWrite1h)} of it for 1 hour` : ''})`)}`,
        `Total output:  ${formatTokens(u.output)} tokens`,
        `API requests:  ${u.requests}${u.compactions ? c.dim(` + ${u.compactions} to compact the conversation`) : ''}`,
        ...cacheLines.map((line, i) => (i ? c.dim(line) : line)),
        ...(b.runs ? [c.dim(`Sub-agents:    ${b.runs} run${b.runs === 1 ? '' : 's'}, ${b.requests + b.compactions} request${b.requests + b.compactions === 1 ? '' : 's'}, ${formatTokens(b.input + b.cacheRead + b.cacheWrite)} input (${formatTokens(b.cacheRead)} cached), ${formatTokens(b.output)} output; included in the totals`)] : []),
        `Session time:  ${formatDuration(Date.now() - app.sessionStart)}`,
      ]);
      const cfg = app.runtime.config;
      const saved = cfg.usesGateway && readGatewayLogin(cfg.gatewayUrl);
      if (!saved) return;
      try {
        const account = await fetchGatewayAccount(saved);
        out([
          `Gateway:       ${accountLine(account)}${Number(account.reserved_usd) ? c.dim(` (${formatUsd(account.reserved_usd)} held for requests in flight)`) : ''}`,
          c.dim(`               ${account.request_count} requests in all, ${formatTokens(account.input_tokens + account.cache_read_input_tokens + account.cache_creation_input_tokens)} input, ${formatTokens(account.output_tokens)} output · top up and usage: ${cfg.gatewayUrl}/user`),
        ]);
      } catch (e) {
        out(c.yellow(`Gateway: could not read the balance (${e.message})`));
      }
    },
  });

  add({
    name: 'context',
    description: 'Show context window usage',
    run() {
      const cfg = app.runtime.config;
      const a = app.agent;
      const window = cfg.mainModel.contextWindow;
      const threshold = cfg.autoCompactThreshold();
      const sys = estimateTokens(app.runtime.systemPrompt());
      const tools = estimateTokens(a.toolSchemas());
      const msgs = estimateTokens(a.messages);
      const used = a.lastContextTokens ? a.contextEstimate : sys + tools + msgs;
      const barW = 40;
      const fill = Math.min(barW, Math.round((used / window) * barW));
      const mark = Math.min(barW - 1, Math.round((threshold / window) * barW));
      let bar = '';
      for (let i = 0; i < barW; i++) bar += i < fill ? c.claude('█') : i === mark ? c.yellow('┃') : c.dim('░');
      out([
        `${bar}  ${c.bold(formatTokens(used))} / ${formatTokens(window)} tokens (${Math.round((used / window) * 100)}%)`,
        c.dim(`System prompt ~${formatTokens(sys)} · Tools ~${formatTokens(tools)} · Messages ~${formatTokens(msgs)} (${a.messages.length})`),
        cfg.autoCompactEnabled ? c.dim(`Auto-compact at ${formatTokens(threshold)} tokens (┃) — ${Math.max(0, Math.round((1 - used / threshold) * 100))}% left`) : c.dim('Auto-compact disabled'),
      ]);
    },
  });

  add({
    name: 'init',
    description: 'Initialize a CLAUDE.md file with codebase documentation',
    run() { return app.startTurn(INIT_PROMPT, { echo: false }); },
  });

  add({
    name: 'review',
    argHint: '[focus]',
    description: 'Review the current changes (git diff) for bugs',
    run(args) {
      return app.startTurn(`Review the uncommitted changes in this repository (run git status and git diff, including staged changes). Look for correctness bugs, edge cases, security issues and leftover debug code. Report concrete findings with file_path:line_number references, most severe first. Do not modify files.${args ? `\nFocus: ${args}` : ''}`, { echo: false });
    },
  });

  add({
    name: 'memory',
    description: 'Show memory files (CLAUDE.md and auto memory); use # to add memories',
    run() {
      const mem = memoryFiles(app.cwd);
      const lines = mem.length ? mem.map((m) => `${m.file} ${c.dim(`(${m.scope}, ${m.text.split('\n').length} lines)`)}`) : [c.dim('No CLAUDE.md files. Start a message with # to save one, or run /init.')];
      if (app.runtime.config.autoMemoryEnabled) {
        const files = listAutoMemories(app.runtime.memoryDir);
        lines.push('', `Auto memory: ${app.runtime.memoryDir} ${c.dim(`(${files.length} memor${files.length === 1 ? 'y' : 'ies'}; the agent maintains these itself)`)}`);
        lines.push(...files.slice(0, 30).map((f) => c.dim(`  ${f}`)));
        if (files.length > 30) lines.push(c.dim(`  … +${files.length - 30} more`));
      } else {
        lines.push('', c.dim('Auto memory is off (CLAUDE_PRO_DISABLE_AUTO_MEMORY).'));
      }
      out(lines);
    },
  });

  add({
    name: 'verify',
    argHint: '[command|off]',
    description: 'Run a command (e.g. npm test) after turns that edit files; failures go back to the agent',
    run(args) {
      const cfg = app.runtime.config;
      if (args.trim()) cfg.verifyOverride = args.trim();
      out(cfg.verifyCommand
        ? `Verify command: ${c.bold(cfg.verifyCommand)} ${c.dim(`(up to ${cfg.verifyMaxRounds} fix rounds; /verify off to disable)`)}`
        : c.dim('Verification is off. Turn it on with /verify <command>, --verify <command> or CLAUDE_PRO_VERIFY_COMMAND.'));
    },
  });

  add({
    name: 'tasks',
    argHint: '[kill ID]',
    description: 'List background agents, or stop one',
    run(args) {
      const tasks = app.runtime.tasks;
      const [action, id] = args.split(/\s+/).filter(Boolean);
      if (action === 'kill' && id) { out(tasks.kill(id) ? `Stopping ${c.bold(id)}` : c.red(`${id} is not running`)); return; }
      const list = tasks.list();
      out(list.length
        ? list.map((t) => `${c.bold(t.id)} ${t.status === 'running' ? c.yellow(t.status) : t.status === 'completed' ? c.green(t.status) : c.red(t.status)} ${c.dim(`${t.subagentType} · ${formatDuration((t.ended || Date.now()) - t.started)}`)} ${truncate(t.description, 60)}`)
        : [c.dim('No background agents. The agent starts them with Task run_in_background.')]);
    },
  });

  add({
    name: 'update',
    description: `Look for a newer ${APP_NAME} on npm now and install it`,
    async run() { out(c.dim(`Version ${VERSION} · checking npm…`)); await app.autoUpdate({ force: true }); },
  });

  add({
    name: 'peers',
    aliases: ['sessions'],
    argHint: '[name NEW-NAME]',
    description: 'List the other sessions, on this computer and (through the gateway) on your other computers; send one a task with &name ...',
    async run(args) {
      const [action, ...rest] = args.split(/\s+/).filter(Boolean);
      if (action === 'name' && rest.length) { out(`This session is now ${c.bold('&' + app.renameSession(rest.join('-')))}`); return; }
      const { me, local, remote, online } = await app.listAllPeers();
      out([
        `This session: ${c.bold('&' + me.name)} ${c.dim(displayPath(me.cwd, app.cwd))}${online ? c.dim(` · from other computers: &${me.label}`) : ''}`,
        ...local.map((p) => `${c.bold('&' + p.name)} ${c.dim(`${p.cwd} · pid ${p.pid}`)}`),
        ...(remote.length ? [c.dim('On your other computers, through the gateway:'), ...remote.map((p) => `${c.bold('&' + p.label)} ${c.dim(`${p.cwd}${p.busy ? ' · busy' : ''}`)}`)] : []),
        ...(local.length || remote.length ? [] : [c.dim('No other session is running.')]),
        c.dim(online
          ? 'Type "&" for the list, "&name task" to send a task; its answer is shown here. On another computer: "&computer/name task", or "&computer task" when it runs one session. /sendfile &name file... sends files (saved in its Downloads folder). /rename names this session. The agent can use ListPeers / MessagePeer too.'
          : 'Type "&" for the list, "&name task" to send a task; its answer is shown here. Sessions on your other computers show up here once this one is online at the gateway (/login; /status says why it is not).'),
      ]);
    },
  });

  add({
    name: 'sendfile',
    aliases: ['sf'],
    argHint: '&session <file...>',
    argRequired: true,
    description: 'Send files to another session, on this computer or on another one: it saves them in its Downloads folder',
    async run(args) { await app.sendFiles(args); },
  });

  add({
    name: 'tui',
    argHint: '[fullscreen | default]',
    description: 'The renderer: fullscreen (the input box fixed at the bottom, the conversation scrolled with the wheel or PgUp/PgDn) or default (it scrolls in the terminal)',
    run(args) {
      const want = args.trim().toLowerCase();
      if (!want) {
        out(`The ${c.bold(app.screen.full ? 'fullscreen' : 'default')} renderer is active. /tui fullscreen or /tui default switches (and is remembered).`);
        return;
      }
      if (want !== 'fullscreen' && want !== 'default') { out(c.red('Use /tui fullscreen or /tui default.')); return; }
      const file = settingsFiles(app.cwd).user;
      updateSettingsFile(file, (json) => { json.env = { ...(json.env || {}), CLAUDE_PRO_TUI: want }; });
      reloadConfig();
      app.screen.setFull(want === 'fullscreen');
      out(want === 'fullscreen'
        ? `Fullscreen: the input box stays at the bottom; scroll with the wheel, PgUp/PgDn, ctrl+Home/End; drag to select and copy; ctrl+f to find in the conversation. (Saved in ${file})`
        : `Default renderer: the conversation scrolls in the terminal. (Saved in ${file})`);
    },
  });

  add({
    name: 'rename',
    argHint: '<name>',
    argRequired: true,
    description: 'Name this session: the other sessions send it tasks with &name, and it is the title (tab, /resume, the web page)',
    run(args) {
      const name = args.trim();
      if (!name) { out(`This session is ${c.bold('&' + app.peerLabel())}. /rename NAME gives it another name.`); return; }
      const got = app.renameSession(name);
      const note = got !== cleanName(name) ? c.dim(' (another session on this computer has that name)') : '';
      out(`This session is now ${c.bold('&' + got)}${note}${app.remote ? c.dim(` · from your other computers: &${machineName(app.config.env)}/${got}`) : ''}`);
    },
  });

  add({
    name: 'plan',
    description: 'Toggle read-only plan mode (same as shift+tab)',
    run() {
      const mode = app.runtime.modes.toggle();
      out(mode === 'plan'
        ? [`${c.plan('Plan mode on')}: the agent can only read and research, then proposes a plan with ExitPlanMode.`, c.dim('Run /plan or press shift+tab to leave it.')]
        : `Plan mode off: ${c.bold('full access')}, tools run immediately.`);
    },
  });

  add({
    name: 'rewind',
    aliases: ['checkpoint'],
    description: 'Go back to an earlier prompt (or esc esc): restore the code and/or the conversation, or summarize part of it',
    async run() {
      const store = app.runtime.checkpoints;
      // Like Claude Code: the prompts of the session, the newest at the bottom and highlighted; above them the
      // conversation before a /clear of this process. "Never mind" comes back to this list.
      let entry;
      let mode;
      for (;;) {
        const entries = store.list().slice(0, 30).reverse();
        const previous = app.previousSession;
        if (!entries.length && !previous) { out(c.dim('No checkpoints yet: one is created for every prompt you send.')); return; }
        const options = entries.map((e) => {
          const n = store.filesSince(e.id).length;
          return {
            label: truncate(e.label || '(empty prompt)', 60),
            value: e.id,
            description: `${new Date(e.time).toLocaleTimeString()} · ${n ? `${n} file${n === 1 ? '' : 's'} changed since` : 'no file changes since'}${e.conversationValid ? '' : ' · conversation compacted since'}`,
          };
        });
        if (previous) options.unshift({ label: `/resume ${previous.id.slice(0, 8)} (previous session)`, value: 'previous', description: 'the conversation before /clear' });
        const id = await app.showDialog(new SelectDialog({
          title: 'Rewind',
          question: 'Go back to which prompt? (the code and/or the conversation as they were before it)',
          color: c.blue,
          options,
          selected: options.length - 1,
        }));
        if (!id) return;
        if (id === 'previous') {
          app.agent.resetConversation();
          app.loadSession(previous.file, previous.id);
          return;
        }
        entry = store.get(id);
        const files = store.filesSince(id);
        const valid = entry.conversationValid;
        const actions = [];
        if (files.length && valid) actions.push({ label: 'Restore code and conversation', value: 'both', description: `${files.length} file(s) go back and the chat continues from before this prompt` });
        if (valid) actions.push({ label: 'Restore conversation', value: 'conversation', description: files.length ? 'the chat continues from before this prompt; files stay as they are' : 'the chat continues from before this prompt' });
        if (files.length) actions.push({ label: 'Restore code', value: 'code', description: `${files.length} file(s) go back; the conversation stays as it is` });
        if (valid) actions.push({ label: 'Summarize from here', value: 'summarize-after', description: 'this prompt and everything after it become a summary, to free context' });
        if (valid && entry.messageIndex > 0) actions.push({ label: 'Summarize up to here', value: 'summarize-before', description: 'everything before this prompt becomes a summary; the rest stays as it is' });
        if (!actions.length) { out(c.dim('Nothing to restore for that prompt (the conversation was compacted and no files changed).')); return; }
        actions.push({ label: 'Never mind', value: 'cancel', description: 'back to the list' });
        mode = await app.showDialog(new SelectDialog({ title: 'Rewind', question: `At: ${c.bold(truncate(entry.label || '(empty prompt)', 60))}`, color: c.blue, options: actions, cancelValue: 'cancel' }));
        if (mode && mode !== 'cancel') break;
      }
      const id = entry.id;
      if (mode.startsWith('summarize-')) {
        const part = mode === 'summarize-after' ? 'after' : 'before';
        const prompt = promptAt(app.agent, entry);
        const index = entry.messageIndex;
        app.busy = true;
        app.controller = new AbortController();
        app.turnStart = Date.now();
        app.turnTokens = 0;
        try {
          await app.agent.summarizePart(index, { part, label: entry.label, signal: app.controller.signal });
          store.summarized(id, part, index);
          app.remote?.resync();
          if (part === 'after' && prompt) app.editor.set(prompt); // as Claude Code does: the prompt to send again or edit
        } catch (e) {
          if (!app.controller.signal.aborted) out(c.red(`Could not summarize: ${e.message}`));
          else out(c.red('Summarizing interrupted'));
        } finally {
          app.busy = false;
          app.controller = null;
          app.status = null;
          app.rateWait = null;
          app.sendWhatWaited();
        }
        return;
      }
      let result;
      try { result = rewind(app.agent, store, id, mode); } catch (e) { out(c.red(e.message)); return; }
      const lines = [];
      if (result.restore) {
        const r = result.restore;
        lines.push(`Restored ${r.restored.length} file${r.restored.length === 1 ? '' : 's'}${r.removed.length ? `, deleted ${r.removed.length} created since` : ''}${r.skipped.length ? `, ${c.red(`could not restore ${r.skipped.length}`)}` : ''}`);
        lines.push(...[...r.restored, ...r.removed].slice(0, 12).map((f) => c.dim(`  ${displayPath(f, app.cwd)}`)));
        lines.push(...r.skipped.slice(0, 5).map((f) => c.red(`  skipped: ${f}`)));
      }
      if (result.conversation) lines.push(`Conversation rewound to before: ${truncate(result.prompt, 60)}`);
      if (result.conversation) app.remote?.resync();
      out(lines);
      if (result.conversation && result.prompt) app.editor.set(result.prompt);
    },
  });

  add({
    name: 'resume',
    argHint: '[session id]',
    description: 'Resume a previous conversation',
    async run(args) {
      const sessions = SessionStore.list(app.cwd).filter((s) => s.id !== app.store.id);
      if (!sessions.length) { out(c.dim('No previous conversations in this directory.')); return; }
      let chosen = args ? sessions.find((s) => s.id.startsWith(args.trim())) : null;
      if (!chosen) {
        const id = await app.showDialog(new SelectDialog({
          title: 'Resume a conversation',
          options: sessions.slice(0, 20).map((s) => ({
            label: `${truncate(s.title, 60)}`,
            value: s.id,
            description: `${new Date(s.mtime).toLocaleString()} · ${s.count} messages · ${s.id.slice(0, 8)}`,
          })),
        }));
        if (!id) return;
        chosen = sessions.find((s) => s.id === id);
      }
      app.agent.resetConversation();
      app.loadSession(chosen.file, chosen.id);
    },
  });

  add({
    name: 'todos',
    description: 'Show the current todo list',
    run() {
      const todos = app.agent.todos;
      log(todos.length ? renderTodos(todos) : resultLines([c.dim('No todos')]), '');
    },
  });

  add({
    name: 'agents',
    description: 'List available sub-agent types',
    run() {
      const lines = [];
      for (const a of app.runtime.agents.values()) {
        lines.push(`${c.bold(a.name)} ${c.dim(`(${a.source === 'built-in' ? 'built-in' : a.source})`)}`, c.dim('  ' + truncate(a.description, app.width - 12)));
      }
      lines.push(c.dim(`Add custom agents as markdown files in .claude/agents/ or ${path.join(CONFIG_DIR, 'agents')}`));
      out(lines);
    },
  });

  add({
    name: 'mcp',
    description: 'Show MCP server status',
    run() {
      const status = app.runtime.mcp.status();
      if (!status.length) { out(c.dim('No MCP servers configured. Add them to .mcp.json or "mcpServers" in ~/.claude-pro/settings.json.')); return; }
      out(status.map((s) => `${s.status === 'connected' ? c.green('✔') : c.red('✘')} ${c.bold(s.name)} ${c.dim(s.status === 'connected' ? `${s.tools} tools${s.serverInfo?.name ? ` · ${s.serverInfo.name} ${s.serverInfo.version || ''}` : ''}` : s.error || s.status)}`));
    },
  });

  add({
    name: 'bashes',
    description: 'List background shells',
    run() {
      const list = listBackgroundShells();
      out(list.length ? list.map((b) => `${c.bold(b.id)} ${b.status}${b.exitCode !== null ? ` (exit ${b.exitCode})` : ''} ${c.dim(truncate(b.command, 60))}`) : [c.dim('No background shells')]);
    },
  });

  add({
    name: 'verbose',
    aliases: ['thinking'],
    description: 'Toggle verbose output (thinking, full tool results)',
    run() {
      app.verbose = !app.verbose;
      out(`Verbose mode ${app.verbose ? 'on' : 'off'}`);
    },
  });

  add({
    name: 'export',
    argHint: '[file]',
    description: 'Export the conversation to a markdown file',
    run(args) {
      const file = path.resolve(app.cwd, args || `conversation-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`);
      const parts = [];
      for (const m of app.agent.messages) {
        const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
        for (const b of blocks) {
          if (b.type === 'text' && !b.text.startsWith('<system-reminder>')) parts.push(m.role === 'user' ? `## User\n\n${b.text}` : `## Assistant\n\n${b.text}`);
          else if (b.type === 'tool_use') parts.push(`**Tool: ${b.name}**\n\n\`\`\`json\n${JSON.stringify(b.input, null, 2)}\n\`\`\``);
          else if (b.type === 'tool_result') {
            const t = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('\n');
            parts.push(`<details><summary>Result${b.is_error ? ' (error)' : ''}</summary>\n\n\`\`\`\n${t.slice(0, 5000)}\n\`\`\`\n</details>`);
          }
        }
      }
      fs.writeFileSync(file, `# ${APP_NAME} conversation ${app.store.id}\n\n${parts.join('\n\n')}\n`);
      out(`Exported to ${file}`);
    },
  });

  add({
    name: 'doctor',
    description: 'Check the installation and test the API connection',
    async run() {
      const cfg = app.runtime.config;
      const rg = hasRipgrep(cfg);
      const lines = [
        `${c.green('✔')} Node ${process.versions.node}`,
        `${app.runtime.shell.kind === 'bash' ? c.green('✔') : c.yellow('!')} Shell: ${app.runtime.shell.name} (${app.runtime.shell.path})`,
        `${rg ? c.green('✔') : c.yellow('!')} ripgrep ${rg ? 'found' : 'not found (Grep uses the built-in JS scanner, which is slower; set CLAUDE_PRO_RIPGREP_PATH to use an rg.exe)'}`,
        cfg.usesClaudeCode
          ? `${c.yellow('!')} Existing Claude Code OAuth: ${cfg.claudeCodeCredentialsFile} (checked by the request below)`
          : cfg.usesGateway ? `${readGatewayLogin(cfg.gatewayUrl) ? c.green('✔') : c.red('✘')} Gateway login for ${cfg.gatewayUrl}${readGatewayLogin(cfg.gatewayUrl) ? '' : ' missing (/login)'}`
            : cfg.usesCodex ? (() => { const s = codexLoginSummary({ ...process.env, ...cfg.env }); return `${s.ok ? c.green('✔') : c.red('✘')} Codex login ${s.ok ? s.file : s.error}`; })()
              : `${cfg.authToken || cfg.apiKey ? c.green('✔') : c.red('✘')} Credentials ${cfg.authToken ? 'ANTHROPIC_AUTH_TOKEN' : cfg.apiKey ? 'ANTHROPIC_API_KEY' : 'missing'}`,
      ];
      out(lines);
      app.busy = true;
      app.status = 'Testing API';
      app.turnStart = Date.now();
      app.controller = new AbortController();
      const started = Date.now();
      try {
        const reply = await quickQuery(cfg, { model: cfg.mainModel, system: 'Reply with exactly: pong', prompt: 'ping', maxTokens: 200, signal: app.controller.signal, waitForRateLimit: false });
        out(`${c.green('✔')} ${cfg.endpointLabel} · model ${cfg.mainModel.id} replied "${truncate(reply, 40)}" in ${Date.now() - started}ms`);
      } catch (e) {
        out(`${c.red('✘')} API request failed: ${e.message}`);
      } finally {
        app.busy = false;
        app.status = null;
        app.controller = null;
        app.sendWhatWaited();
      }
    },
  });

  add({
    name: 'exit',
    aliases: ['quit'],
    description: `Exit ${APP_NAME}`,
    run() { app.exit(0); },
  });

  // Custom commands from markdown files.
  for (const custom of loadCustomCommands(app.cwd).values()) {
    if (commands.has(custom.name)) continue;
    add({
      name: custom.name,
      argHint: custom.argumentHint,
      description: `${custom.description} ${c.dim(`(${custom.scope})`)}`,
      async run(args) {
        const bash = app.runtime.tools.find((t) => t.name === 'Bash');
        const body = await expandShellEmbeds(expandCommandBody(custom.body, args), async (command) => {
          const r = await bash.call({ command }, app.agent.makeCtx());
          return typeof r.content === 'string' ? r.content : '';
        });
        return app.startTurn(body, { echo: false });
      },
    });
  }

  // Skills can be run directly as /<skill-name> [arguments].
  for (const skill of app.runtime.skills.values()) {
    if (commands.has(skill.name)) continue;
    add({
      name: skill.name,
      argHint: '[arguments]',
      description: `${truncate(skill.description, 70)} ${c.dim('(skill)')}`,
      run(args) { return app.startTurn(renderSkill(skill, args), { echo: false }); },
    });
  }

  add({
    name: 'skills',
    description: 'List available skills',
    run() {
      const list = [...app.runtime.skills.values()];
      out(list.length
        ? list.flatMap((s) => [`${c.bold(s.name)} ${c.dim(`(${s.scope})`)}`, c.dim(`  ${truncate(s.description, app.width - 12)}`)])
        : [c.dim(`No skills. Add <name>/SKILL.md (with name and description in the frontmatter) under .claude/skills/ or ${path.join(CONFIG_DIR, 'skills')}.`)]);
    },
  });

  app.sessionStart = Date.now();
  return commands;
}
