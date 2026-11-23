// Slash commands for the interactive REPL.

import fs from 'node:fs';
import path from 'node:path';
import { c, glyphs, padEnd, truncate } from './ui/ansi.js';
import { SelectDialog, TextInputDialog } from './ui/dialogs.js';
import { renderTodos, resultLines, formatTokens, formatDuration } from './ui/render.js';
import { loadConfig, settingsFiles, configEntries, writeConfigSetting, unsetConfigSetting, rememberChoice, applyRememberedChoices, pickedModels, VERSION, APP_NAME, CONFIG_DIR } from './config.js';
import { loginWithKey, gatewayLogin, gatewayKeyPage, clearGatewayLogin, fetchGatewayAccount, fetchGatewayModels, keptGatewayModels, loadGatewayModels, cachedGatewayModel, gatewayEfforts, formatUsd } from './gateway.js';
import { GATEWAY_PROVIDER, PRESETS, providerInfo, connectedProviders, readConnections, saveConnection, removeConnection, normalizeBaseUrl, validBaseUrl, cleanProviderId, reservedProviderId, listProviderModels, testProviderModel, modelsDevCatalogue, enrichModels } from './providers.js';
import { SessionStore } from './session.js';
import { memoryFiles, listAutoMemories } from './context.js';
import { INIT_PROMPT } from './prompts.js';
import { loadCustomCommands, renderSkill, expandCommandBody, expandShellEmbeds } from './agents.js';
import { listBackgroundShells } from './tools/bash.js';
import { estimateTokens } from './agent.js';
import { quickQuery, cacheRefusals, defaultEffort, effortToSend, CLAUDE_EFFORTS } from './api.js';
import { hasRipgrep } from './utils/shell.js';
import { displayPath, normalizeDir, resolvePath } from './utils/paths.js';
import { cleanName, machineName } from './peers.js';
import { rewind, promptAt } from './checkpoints.js';
import { runSelfCheck } from './restart.js';

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const isGpt = (modelId) => /^gpt-/i.test(modelId);
// The levels /effort offers for a gateway model: use its advertised levels when available.
const effortLevels = (modelId, modelInfo = null) => {
  if (/^claude-/i.test(modelId)) return CLAUDE_EFFORTS;
  const remote = gatewayEfforts(modelInfo);
  return remote.length ? remote : EFFORTS;
};

// The models of the providers connected with /connect, for /model: each provider's list asked for anew (4 seconds at
// most), with what was kept at /connect about them (windows, prices); without an answer, the list kept then.
// `cached` (the web console's pickers): the kept lists only, nothing asked (its 刷新模型列表 button renews them).
async function providerModelChoices({ cached = false } = {}) {
  const groups = await Promise.all(connectedProviders().map(async (info) => {
    let listed = null;
    if (!cached) try {
      listed = (await listProviderModels({ ...info, ...info.connection, baseUrl: info.connection.baseUrl || info.baseUrl }, { timeoutMs: 4000, kinds: [info.connection.authHeader || 'x-api-key'] })).models;
    } catch { /* the kept list */ }
    const kept = info.connection.models || [];
    const models = listed?.length ? listed.map((m) => ({ ...kept.find((k) => k.id === m.id), ...m })) : kept;
    return models.map((m) => ({
      value: `${info.id}/${m.id}`,
      label: `${info.id}/${m.id}`,
      description: [info.name, m.name && m.name !== m.id ? m.name : '', m.window ? `${formatTokens(m.window)} context` : ''].filter(Boolean).join(' · '),
    }));
  }));
  return groups.flat();
}

// What /model offers: [{value, label, description}] in plain text, the
// default first. `value` is what /model <value> takes. Every connected provider's models, provider/model, 7bit.fun's
// among them (asked for anew each time, 4 seconds at most, so that a model just added is there without a restart;
// without an answer the list given last, else gpt-6.1-sol for its GPT models); the Claude aliases where a provider of
// Claude is connected. A provider that is not connected offers nothing.
// `cached`: the lists kept from before (see providerModelChoices); the gateway is asked only when none is kept yet.
// `picked` (the web console's menus, see pickedModels): a set of provider/model; when it has any, only those are
// offered by their full names (not the aliases), with the default and the model in use.
export async function modelChoices(cfg, { cached = false, picked = null } = {}) {
  const configured = cfg.configuredModelSpec;
  const opts = [{ value: 'default', label: 'Default', description: `${configured} → ${cfg.resolveModel(configured).label}` }];
  const tag = (m) => `${m.provider}/${m.id}`;
  const aliased = new Set();
  if (cfg.claudeProvider()) {
    for (const a of ['opus', 'sonnet', 'haiku']) {
      const target = cfg.resolveModel(cfg.aliasTarget(a));
      aliased.add(tag(target));
      opts.push({ value: a, label: a, description: `→ ${target.label}` });
    }
  }
  const others = providerModelChoices({ cached });
  const gateway = [];
  const login = gatewayLogin(cfg.gatewayUrl);
  if (login) {
    let served = cached ? keptGatewayModels(login) : null;
    if (!served) try { served = await fetchGatewayModels(login, { signal: AbortSignal.timeout(4000), fresh: !cached }); } catch { /* offline: the fallback below */ }
    for (const m of served?.length ? served : [{ id: 'gpt-6.1-sol' }]) {
      gateway.push({ value: `${GATEWAY_PROVIDER}/${m.id}`, label: `${GATEWAY_PROVIDER}/${m.id}`, description: ['7bit.fun', isGpt(m.id) ? 'OpenAI, through the gateway\'s Codex login' : m.display_name || ''].filter(Boolean).join(' · ') });
    }
  }
  const providers = await others;
  opts.push(...gateway.filter((o) => !aliased.has(o.value)), ...providers.filter((o) => !aliased.has(o.value)));
  if (!picked?.size) return opts;
  const kept = [opts[0], ...[...gateway, ...providers].filter((o) => picked.has(o.value))];
  // the model in use stays listed (it is shown as the current one), unless a ticked entry is that model already
  const chosen = cfg.modelOverride;
  const sameModel = (o) => { try { const m = cfg.resolveModel(o.value); return m.id === cfg.model.id && m.provider === cfg.model.provider; } catch { return false; } };
  if (chosen && !kept.some((o) => o.value === chosen || (o.value !== 'default' && sameModel(o)))) {
    const current = opts.find((o) => o.value === chosen) || { value: chosen, label: chosen, description: '' };
    kept.splice(1, 0, current);
  }
  return kept;
}

// The web menu marks the default on its model's row instead of offering a separate Default entry.
export async function webModelChoices(cfg) {
  const models = (await modelChoices(cfg, { cached: true, picked: new Set(pickedModels()) })).filter((o) => o.value !== 'default');
  const find = (list, spec) => {
    const exact = list.find((o) => o.value === spec);
    if (exact) return exact;
    const { provider, id } = cfg.resolveModel(spec);
    return list.find((o) => o.value === `${provider}/${id}`) || list.find((o) => {
      // Full refs have already been matched; only aliases or the retained override can resolve to a different ref.
      if (o.value.includes('/') && o.value !== cfg.modelOverride) return false;
      const m = cfg.resolveModel(o.value);
      return m.provider === provider && m.id === id;
    });
  };
  let preferred = find(models, cfg.configuredModelSpec);
  if (!preferred) {
    // The default is not among the ticked models: listed anyway, first, by its full name as the ticked ones are, so
    // that the menu can go back to it.
    let ref = cfg.configuredModelSpec;
    try { const m = cfg.resolveModel(ref); ref = `${m.provider}/${m.id}`; } catch { /* as written */ }
    const entry = (await modelChoices(cfg, { cached: true, picked: new Set([ref]) })).find((o) => o.value === ref);
    preferred = entry || { value: ref, label: ref, description: '' };
    models.unshift(preferred);
  }
  const current = find(models, cfg.modelSpec);
  return models.map((o) => ({ ...o, isDefault: o === preferred, current: o === current }));
}

// Ask the gateway and every connected provider for their models now, and keep what they say (the gateway's list on
// disk, each provider's in its connection): what `cached` choices offer from then on. Resolves with what each said.
export async function refreshModelLists(cfg) {
  const out = { gateway: null, providers: [] };
  const jobs = [];
  const login = gatewayLogin(cfg.gatewayUrl);
  if (login) {
    jobs.push(fetchGatewayModels(login, { fresh: true, timeoutMs: 15_000 })
      .then((list) => { out.gateway = { count: list.length }; }, (e) => { out.gateway = { error: e.message }; }));
  }
  let catalogue = null;
  for (const info of connectedProviders(readConnections({ fresh: true }))) {
    jobs.push((async () => {
      try {
        const listed = await listProviderModels({ ...info, ...info.connection, baseUrl: info.connection.baseUrl || info.baseUrl }, { timeoutMs: 20_000, kinds: [info.connection.authHeader || 'x-api-key'] });
        if (!listed.models?.length) throw new Error('no models listed');
        if (info.modelsDev) catalogue ??= modelsDevCatalogue().catch(() => null);
        const kept = info.connection.models || [];
        const models = enrichModels(listed.models, info.modelsDev ? await catalogue : null, info.modelsDev)
          .map((m) => ({ ...kept.find((k) => k.id === m.id), ...m })).slice(0, 2000);
        saveConnection(info.id, { ...readConnections({ fresh: true })[info.id], models });
        out.providers.push({ id: info.id, name: info.name, count: models.length });
      } catch (e) {
        out.providers.push({ id: info.id, name: info.name, error: e.message });
      }
    })());
  }
  await Promise.all(jobs);
  return out;
}

// What /effort offers for the current model: {levels, options: [{value, label, description}]} in plain text (the
// levels, auto, default).
export async function effortChoices(cfg, { cached = false } = {}) {
  const id = cfg.model.id;
  let info = null;
  if (isGpt(id) && cfg.model.provider === GATEWAY_PROVIDER) {
    const login = gatewayLogin(cfg.gatewayUrl);
    const kept = cached ? keptGatewayModels(login) : null;
    if (kept) info = kept.find((m) => m.id === id) || null;
    else try { if (login) info = (await fetchGatewayModels(login, { signal: AbortSignal.timeout(4000), fresh: !cached })).find((m) => m.id === id) || null; } catch { /* use local cache or generic levels */ }
  }
  const levels = effortLevels(id, info);
  const configured = cfg.configuredEffort;
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

  // /model and /effort choices are kept for later sessions (rememberChoice), for the provider in use; say so, or why
  // they are not.
  const keep = (cfg, patch, forgotten) => {
    try {
      rememberChoice(patch);
      return c.dim(forgotten ? ' · the configured default from now on' : ' · kept for later sessions');
    } catch (e) {
      return c.yellow(` · for this session only (${e.message})`);
    }
  };

  const reloadConfig = () => {
    const fresh = loadConfig({ cwd: app.cwd, flags: app.flags });
    const cfg = app.runtime.config;
    const model = cfg.model.id;
    cfg.env = fresh.env;
    cfg.sources = fresh.sources;
    cfg.settings = fresh.settings;
    // What the system prompt is built from may have changed (memory switched off, say). It is not rebuilt in the
    // middle of a conversation, which would lose its prompt cache; it is, at the next /clear or compaction. A
    // different model is the exception: the prompt names it, and the new model has a cache of its own anyway.
    if (cfg.model.id !== model) app.runtime.invalidateSystemPrompt();
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
      question: `The prompt cache is warm (about ${formatTokens(cache.expected)} tokens, ${formatDuration(cache.expiresAt - Date.now())} left). ${what} makes the next request read the whole conversation again without it, which costs more and takes longer. The restored conversation stays in context; only the model changes. Go on?`,
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
        c.bold(`${APP_NAME} v${VERSION}`) + c.dim(' — a command line coding agent'),
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
      if (!app.canRestart()) {
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
    argHint: '[advanced | set KEY VALUE | unset KEY] [--project|--local]',
    description: 'Show or change configuration (API URL, models, effort, …)',
    run(args) {
      const parts = args.split(/\s+/).filter(Boolean);
      const scope = parts.includes('--project') ? 'project' : parts.includes('--local') ? 'local' : 'user';
      const rest = parts.filter((p) => p !== '--project' && p !== '--local');
      const file = settingsFiles(app.cwd)[scope];
      if (rest[0] === 'set' && rest[1] && rest.length >= 3) {
        const value = rest.slice(2).join(' ');
        const key = writeConfigSetting(file, rest[1], value);
        reloadConfig();
        out([`Set ${c.bold(key)} in ${file}`, ...(app.runtime.config.sources[key] !== file ? [c.yellow(`Note: overridden by ${app.runtime.config.sources[key]}`)] : [])]);
        return;
      }
      if (rest[0] === 'unset' && rest[1]) {
        const key = unsetConfigSetting(file, rest[1]);
        reloadConfig();
        out(`Removed ${c.bold(key)} from ${file}`);
        return;
      }
      const cfg = app.runtime.config;
      const advanced = rest[0] === 'advanced' || rest.includes('--advanced');
      const lines = [c.bold(advanced ? 'Configuration · advanced' : 'Configuration'), ''];
      for (const entry of configEntries(cfg, { advanced })) {
        lines.push(`${padEnd(entry.key, 28)} ${c.bold(String(entry.value ?? '(default)'))}  ${c.dim(entry.source)}`);
        if (advanced) lines.push(c.dim(`  ${entry.description}`));
      }
      lines.push('', c.dim('Precedence: user settings < project settings < local settings; shell env applies only to advanced keys; --model/--effort win.'));
      if (cfg.modelOverride || cfg.effortOverride) lines.push(c.dim('The choices made with /model and /effort override the configured defaults above.'));
      if (!advanced) lines.push(c.dim('More controls: /config advanced'));
      lines.push('', `${c.dim('Change with')} /config set KEY VALUE [--project|--local] ${c.dim('or edit')} ${file}`);
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
        choice = await app.showDialog(new SelectDialog({ title: 'Select model', question: `Current: ${c.bold(cfg.model.label)}. Any name works too: /model <name>`, options: opts }));
        if (!choice) return;
      }
      const forget = choice === '__default__' || choice === 'default';
      const target = cfg.resolveModel(forget ? cfg.configuredModelSpec : choice);
      const sameProvider = target.provider === cfg.model.provider;
      const changed = target.id !== cfg.model.id || !sameProvider;
      // (Not asked at a pause for a rate limit: the cache runs out while waiting for the limit as well. Another
      // provider's model of the same name has no cache of this one.)
      if (changed && !app.agent.pausedForLimit && !(await confirmCacheLoss('Switching the model', { model: sameProvider ? target.id : target.label }))) { out(c.dim('The model was not changed.')); return; }
      cfg.modelOverride = forget ? null : choice;
      if (changed) app.runtime.invalidateSystemPrompt(); // the prompt names the model; the new model starts a cache of its own anyway
      const kept = keep(cfg, { model: cfg.modelOverride }, forget);
      await loadGatewayModels(cfg); // the window shown may come from the gateway's model list (see Config.resolveModel)
      // A turn paused for the other model's rate limit goes on with this one now (the one case in which /model runs
      // during a turn, see App.modelSwitchAtPause).
      const resumed = changed && app.agent.wakePause();
      out(`Model set to ${c.bold(cfg.model.label)} ${c.dim(`(${formatTokens(cfg.model.contextWindow)} context)`)}${kept}${resumed ? c.dim(' · the paused request goes on with it now') : changed ? c.dim(' · restored conversation remains in context for the next request') : ''}`);
    },
  });

  add({
    name: 'effort',
    get argHint() {
      const cfg = app.runtime.config;
      const login = gatewayLogin(cfg.gatewayUrl);
      return `[${effortLevels(cfg.model.id, cfg.model.provider === GATEWAY_PROVIDER ? cachedGatewayModel(login, cfg.model.id) : null).join('|')}|auto|default]`;
    },
    description: 'Set reasoning effort (output_config.effort; kept for later sessions)',
    async run(args) {
      const cfg = app.runtime.config;
      const id = cfg.model.id;
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
      const wanted = (forget ? cfg.configuredEffort : choice).trim().toLowerCase();
      const next = wanted && wanted !== 'auto' && wanted !== 'default' ? wanted : null;
      if (next !== cfg.effort && !(await confirmCacheLoss('Changing the effort'))) { out(c.dim('The effort was not changed.')); return; }
      cfg.effortOverride = forget ? null : choice;
      cfg.effortBoost = null; // the user's choice replaces what the model set for itself with the Effort tool
      out(`Effort set to ${c.bold(cfg.effort || 'auto')}${keep(cfg, { effort: cfg.effortOverride }, forget)}`);
    },
  });

  // After the gateway was connected: the configuration read again, with the remembered /model and /effort.
  const afterLogin = () => {
    const cfg = app.runtime.config;
    const model = cfg.model.id;
    reloadConfig();
    cfg.modelOverride = null;
    cfg.effortOverride = null;
    cfg.effortBoost = null;
    applyRememberedChoices(cfg, app.flags);
    if (cfg.model.id !== model) app.runtime.invalidateSystemPrompt();
  };
  const accountLine = (account) => `${account.name || ''}${account.email ? ` <${account.email}>` : ''} · balance ${c.bold(formatUsd(account.available_usd ?? account.balance_usd))}`;
  const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
  // A check that goes over the network (a key, a model): the footer says so meanwhile, and Esc cancels it, as /doctor's.
  const checking = async (status, fn) => {
    app.busy = true;
    app.status = status;
    app.turnStart = Date.now();
    app.controller = new AbortController();
    try {
      return await fn(app.controller.signal);
    } finally {
      app.busy = false;
      app.status = null;
      app.controller = null;
      app.screen.schedule();
    }
  };
  // The gateway connected: this session goes online there at once, for tasks from your other computers and contacts.
  const goOnline = async () => {
    const remote = await app.syncRemote();
    if (!remote) return;
    const page = 'sessions on your other computers and your contacts can send it tasks';
    out(remote.registered
      ? `${c.green('⇄')} This session is online at the gateway: ${page}.`
      : c.dim(`⇄ This session goes online at the gateway as soon as ${remote.base} can be reached.`));
  };

  // Connecting the gateway (7bit.fun in /connect): a key of the user's account, made on the gateway's page and pasted
  // here (/login did this until 2026-11-19, and before that sent the browser to the gateway). As with the other
  // providers, a saved key is kept with Enter or replaced by pasting another; a refused one is asked for again, with
  // what the gateway said, three times at most.
  async function connectGateway() {
    const cfg = app.runtime.config;
    const url = cfg.gatewayUrl;
    const page = gatewayKeyPage(url);
    let saved = gatewayLogin(url);
    let error = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const typed = await app.showDialog(new TextInputDialog({
        title: `Connect ${hostOf(url)}`,
        body: [
          `Make an API key on ${c.blue(page)} (创建新密钥) and paste it here.`,
          c.dim('The key is checked with the gateway, then kept in ~/.claude-pro/gateway.json, readable by you alone.'),
        ],
        question: 'API key:',
        placeholder: saved ? 'Enter: keep the saved key · or paste another (Ctrl+V)' : 'paste the key (Ctrl+V)',
        secret: true,
        allowEmpty: Boolean(saved),
        error,
      }));
      if (typed === null) { out(c.dim(saved ? `${hostOf(url)}: the saved key is kept.` : `${hostOf(url)} was not connected. /connect connects it.`)); return; }
      try {
        let account;
        if (typed) account = (await checking('Checking the key', (signal) => loginWithKey({ url, apiKey: typed, signal }))).balance;
        else account = await checking('Checking the saved key', (signal) => fetchGatewayAccount(saved, { signal }));
        afterLogin();
        out([`${c.green('✔')} Connected the gateway ${c.bold(url)}: ${cfg.model.label}`, accountLine(account), c.dim(`Top up and usage: ${page}`)]);
        await goOnline();
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (e.status !== 401 && e.status !== 403) { out(c.red(`Cannot reach the gateway ${url}: ${e.message}`)); return; }
        if (!typed) { clearGatewayLogin(); saved = null; }
        error = `The gateway refused ${typed ? 'that' : 'the saved'} key (${e.status}${e.message ? `: ${e.message}` : ''}). ${typed ? `Check it on ${page}.` : 'Paste another.'}`;
      }
    }
    out(c.red(`${hostOf(url)} was not connected: the gateway refused the key three times. Check it on ${page}, then /connect again.`));
  }

  // After a provider was disconnected: the model in use, when its provider is not connected any more, gives way to the
  // default (which follows the providers still connected, see Config.defaultModelSpec). Returns what to say, or ''.
  function fallBack() {
    const cfg = app.runtime.config;
    if (cfg.providerConnected(cfg.model.provider)) return '';
    cfg.modelOverride = null;
    try { rememberChoice({ model: null }); } catch { /* the settings file cannot be written: for this session */ }
    app.runtime.invalidateSystemPrompt();
    const now = cfg.model;
    return cfg.providerConnected(now.provider)
      ? ` The model is ${c.bold(now.label)} now (the default).`
      : ` No connected provider serves a model now: /connect connects one.`;
  }

  // Forgetting the gateway's key (7bit.fun in /disconnect; /logout until 2026-11-19): this session goes offline there,
  // and the other sessions of this computer follow within seconds (see App.syncRemote).
  function disconnectGateway() {
    const cfg = app.runtime.config;
    const had = clearGatewayLogin();
    const wasOnline = Boolean(app.remote);
    app.stopRemote();
    out(had
      ? `Disconnected 7bit.fun: its key is forgotten.${wasOnline ? ' This session is offline there now.' : ''}${fallBack()}`
      : c.dim(`7bit.fun (${cfg.gatewayUrl}) was not connected.`));
  }

  // ---------------------------------------------------------------- /connect: the providers of models

  // A provider's key, checked by asking for its models with it (the header the key goes in is found on the way); asked
  // again when refused, three times at most. Resolves with {apiKey, authHeader, listed}, or null (cancelled, refused,
  // unreachable: said).
  async function askProviderKey(info, existing) {
    const base = normalizeBaseUrl(info.baseUrl, info.protocol);
    let error = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const keep = Boolean(existing?.apiKey);
      const typed = await app.showDialog(new TextInputDialog({
        title: `Connect ${info.name}`,
        body: [
          info.keyPage ? `Make an API key on ${c.blue(info.keyPage)} and paste it here.` : `The API key for ${base}${info.keyless ? ' (none needed: Enter)' : ''}.`,
          c.dim(`${info.protocol === 'openai' ? 'OpenAI Chat Completions' : 'Anthropic Messages API'} · ${base} · kept in ~/.claude-pro/providers.json, readable by you alone.`),
        ],
        question: 'API key:',
        placeholder: keep ? 'Enter: keep the saved key · or paste another (Ctrl+V)' : info.keyless ? 'Enter: no key' : 'paste the key (Ctrl+V)',
        secret: true,
        allowEmpty: keep || Boolean(info.keyless),
        error,
      }));
      if (typed === null) { out(c.dim(`${info.name} was not connected.`)); return null; }
      const apiKey = typed || existing?.apiKey || '';
      try {
        const r = await checking(`Checking the key with ${info.name}`, (signal) => listProviderModels({ ...info, apiKey }, { signal }));
        return { apiKey, authHeader: r.authHeader, listed: r.models };
      } catch (e) {
        if (e.name === 'AbortError') return null;
        if (!e.refused) { out(c.red(`Cannot reach ${info.name}: ${e.message}`)); return null; }
        error = `${info.name} refused that key: ${e.message}`;
      }
    }
    out(c.red(`${info.name} was not connected: it refused the key three times.`));
    return null;
  }

  // Connect a provider: its key, the model to use now (or none), one request to that model (the protocol, the key, the
  // model: nothing is saved before it answers), then the connection is saved and /model switches to the model.
  async function connectProvider(info) {
    const existing = readConnections()[info.id];
    const key = await askProviderKey(info, existing);
    if (!key) return;
    const catalogue = info.modelsDev ? await checking('Reading models.dev', (signal) => modelsDevCatalogue({ signal })).catch(() => null) : null;
    const models = enrichModels(key.listed, catalogue, info.modelsDev);
    const cfg = app.runtime.config;
    const KEEP = '__keep__';
    // ("keep" only where the model in use can be used: with nothing else connected, one of this provider's is the model)
    const canKeep = cfg.providerConnected(cfg.model.provider) && cfg.model.provider !== info.id;
    const choice = models.length
      ? await app.showDialog(new SelectDialog({
        title: `Connect ${info.name} · model`,
        question: `${canKeep ? 'Use one of its models now?' : 'Which of its models?'} (/model switches any time; its models are ${info.id}/<model>)`,
        options: [
          ...(canKeep ? [{ label: `Keep using ${cfg.model.label}`, value: KEEP }] : []),
          ...models.map((m) => ({ label: m.id, value: m.id, description: [m.name, m.window ? `${formatTokens(m.window)} context` : '', m.price ? `$${m.price.input} / $${m.price.output} per M tokens` : ''].filter(Boolean).join(' · ') })),
        ],
        otherOption: true,
      }))
      : await app.showDialog(new TextInputDialog({
        title: `Connect ${info.name} · model`,
        body: [`${info.name} lists no models here: name the one to use, as ${info.name} documents it.`],
        question: 'Model:',
      }));
    if (choice === null || choice === undefined) { out(c.dim(`${info.name} was not connected.`)); return; }
    // One request: to the model chosen; with "keep", to the first one listed when the endpoint is the user's own (its
    // protocol is not known to work) or the key's header is not known yet (an Anthropic endpoint without a list).
    let authHeader = key.authHeader;
    let quirks = {};
    const tryModel = choice !== KEEP ? choice : (info.custom || !authHeader) ? models[0]?.id : null;
    if (tryModel) {
      try {
        ({ authHeader, quirks } = await checking(`Trying ${tryModel}`, (signal) => testProviderModel({ ...info, apiKey: key.apiKey, authHeader, model: tryModel }, { signal })));
      } catch (e) {
        if (e.name === 'AbortError') return;
        out(c.red(`${info.name} was not connected: ${tryModel} answered ${e.message}`));
        return;
      }
    }
    const kept = models.length ? models : choice !== KEEP ? [{ id: choice }] : [];
    saveConnection(info.id, {
      ...(info.custom ? { custom: true, name: info.name, protocol: info.protocol, baseUrl: info.baseUrl } : {}),
      // (another account of a provider stays one, with the name the user gave it)
      ...(existing?.preset ? { preset: existing.preset, ...(existing.baseUrl ? { protocol: existing.protocol, baseUrl: existing.baseUrl } : {}) } : {}),
      ...(existing?.name && !info.custom ? { name: existing.name } : {}),
      apiKey: key.apiKey,
      authHeader: info.protocol === 'openai' ? 'bearer' : authHeader || 'x-api-key',
      ...(Object.keys(quirks).length ? { quirks } : {}),
      // the model chosen: the default when this provider is the first connected (see Config.defaultModelSpec)
      ...(choice !== KEEP ? { model: choice } : existing?.model ? { model: existing.model } : {}),
      models: kept,
    });
    out([`${c.green('✔')} Connected ${c.bold(info.name)}${kept.length ? c.dim(` · ${kept.length} model${kept.length === 1 ? '' : 's'}`) : ''}`, c.dim(`Its models are ${info.id}/<model> in /model · /disconnect ${info.id} forgets the key.`)]);
    if (choice !== KEEP) await commands.get('model').run(`${info.id}/${choice}`);
  }

  // A provider of the user's own: a name (what its models are named after), the address, then as a built-in one.
  async function connectCustom(protocol) {
    const kind = protocol === 'openai' ? 'OpenAI-compatible' : 'Anthropic-compatible';
    const name = await app.showDialog(new TextInputDialog({
      title: `Your own provider (${kind})`,
      body: ['A name for it: its models are named <name>/<model> in /model (letters, digits and -).'],
      question: 'Name:',
      validate: (text) => {
        const id = cleanProviderId(text);
        if (!id) return 'Letters, digits and - only.';
        return reservedProviderId(id) ? `"${id}" is a built-in provider: pick it from the /connect list, or give another name.` : null;
      },
    }));
    if (!name) return;
    const id = cleanProviderId(name);
    const existing = readConnections()[id];
    const examples = protocol === 'openai' ? ['https://api.example.com/v1', 'http://localhost:1234/v1   (LM Studio)', 'http://localhost:8000/v1   (vLLM)'] : ['https://api.example.com/anthropic'];
    const typed = await app.showDialog(new TextInputDialog({
      title: `${name} (${kind})`,
      body: [`The address it takes requests at (${protocol === 'openai' ? 'POST <address>/chat/completions' : 'POST <address>/v1/messages'}), for example:`, ...examples.map((e) => c.dim(`  ${e}`))],
      question: 'Base URL:',
      initial: existing?.baseUrl || '',
      placeholder: 'https://…',
      validate: (text) => (validBaseUrl(normalizeBaseUrl(text, protocol)) ? null : 'An http(s) address.'),
    }));
    if (!typed) return;
    await connectProvider({ id, name: name.trim(), protocol, baseUrl: normalizeBaseUrl(typed, protocol), custom: true, keyless: true });
  }

  add({
    name: 'connect',
    argHint: '[provider]',
    description: 'Connect a model provider with its API key: 7bit.fun, Anthropic, OpenAI, DeepSeek, Kimi, GLM, Qwen, your own…',
    async run(args) {
      const connections = readConnections();
      const gatewayIn = Boolean(gatewayLogin(app.runtime.config.gatewayUrl));
      let choice = args.trim().toLowerCase();
      if (!choice) {
        const mark = (on) => (on ? c.green('✔ ') : '  ');
        const protocolName = (p) => (p === 'openai' ? 'OpenAI' : 'Anthropic');
        choice = await app.showDialog(new SelectDialog({
          title: 'Connect a provider',
          question: 'Several can be connected at once (✔): their models are all in /model. Picking a connected one again replaces its key.',
          options: [
            { label: `${mark(gatewayIn)}7bit.fun`, value: GATEWAY_PROVIDER, description: 'the gateway: Claude and GPT models, balance, the web page, your other computers' },
            ...PRESETS.map((p) => ({ label: `${mark(Boolean(connections[p.id]))}${p.name}`, value: p.id, description: `${protocolName(p.protocol)} protocol · ${hostOf(p.baseUrl)}` })),
            ...Object.entries(connections).filter(([, conn]) => conn?.custom).map(([id, conn]) => ({ label: `${mark(true)}${conn.name || id}`, value: id, description: `your own · ${protocolName(conn.protocol)} protocol · ${hostOf(conn.baseUrl)}` })),
            // (the other accounts added in the web console: their key replaced here)
            ...Object.entries(connections).filter(([id, conn]) => conn?.preset && providerInfo(id, connections)).map(([id, conn]) => ({ label: `${mark(true)}${conn.name || id}`, value: id, description: `${id}/<model> · another account` })),
            { label: '  Your own (Anthropic-compatible)', value: '__custom_anthropic__', description: 'any endpoint with POST /v1/messages' },
            { label: '  Your own (OpenAI-compatible)', value: '__custom_openai__', description: 'any endpoint with POST /chat/completions: relays, LM Studio, vLLM…' },
          ],
        }));
        if (!choice) return;
      }
      if (choice === GATEWAY_PROVIDER || choice === 'gateway' || choice === '7bit.fun') return connectGateway();
      if (choice === '__custom_anthropic__') return connectCustom('anthropic');
      if (choice === '__custom_openai__') return connectCustom('openai');
      const info = providerInfo(choice, connections);
      if (!info) { out(c.red(`There is no provider "${choice}". /connect lists them.`)); return; }
      await connectProvider(info.custom ? { ...info, keyless: true } : info);
    },
  });

  add({
    name: 'disconnect',
    argHint: '[provider]',
    description: 'Forget a provider\'s key (7bit.fun\'s too: this computer\'s sessions go offline there)',
    async run(args) {
      const cfg = app.runtime.config;
      let id = args.trim().toLowerCase();
      if (!id) {
        const options = connectedProviders().map((p) => ({ label: p.name, value: p.id, description: `${p.id}/<model>` }));
        if (gatewayLogin(cfg.gatewayUrl)) options.unshift({ label: '7bit.fun', value: GATEWAY_PROVIDER, description: 'the gateway: its models, and this computer\'s sessions online there' });
        if (!options.length) { out(c.dim('No provider is connected. /connect connects one.')); return; }
        id = await app.showDialog(new SelectDialog({
          title: 'Disconnect a provider',
          question: 'Its key is forgotten, and its models cannot be used until it is connected again.',
          options,
        }));
        if (!id) return;
      }
      if (id === GATEWAY_PROVIDER || id === 'gateway' || id === '7bit.fun') { disconnectGateway(); return; }
      const info = providerInfo(id);
      if (!removeConnection(id)) { out(c.dim(`${info?.name || id} is not connected.`)); return; }
      out(`Disconnected ${info?.name || id}: its key is forgotten.${fallBack()}`);
    },
  });

  add({
    name: 'status',
    description: 'Show version, model, API endpoint and session info',
    run() {
      const cfg = app.runtime.config;
      const mem = memoryFiles(app.cwd);
      const mcp = app.runtime.mcp.status();
      const row = (k, v) => `${c.dim(padEnd(k, 18))} ${v}`;
      log([
        c.bold('Status'), '',
        row('Version', VERSION),
        row('Session ID', app.store.id),
        row('cwd', app.cwd),
        row('Provider', `${cfg.providerName(cfg.model.provider)} ${c.dim(`(${cfg.model.provider}/…)`)}${cfg.providerConnected(cfg.model.provider) ? '' : c.red(' not connected (/connect)')}`),
        row('Endpoint', cfg.endpointLabel),
        row('Connected', [...(gatewayLogin(cfg.gatewayUrl) ? [`7bit.fun ${c.dim(`(${gatewayLogin(cfg.gatewayUrl).account?.email || 'key of this machine'}; /cost shows the balance)`)}`] : []), ...connectedProviders().map((p) => p.name)].join(', ') || c.red('no provider (/connect)')),
        row('Model', `${cfg.model.label} ${c.dim(`(sent as "${cfg.model.id}", ${formatTokens(cfg.model.contextWindow)} context)`)}`),
        row('Effort', cfg.effort || 'auto'),
        row('System prompt', app.flags.systemPrompt !== undefined ? 'command line override' : 'built-in default'),
        row('Max output', formatTokens(cfg.maxOutputTokens)),
        row('Prompt cache', cfg.promptCachingDisabled() ? 'off (DISABLE_PROMPT_CACHING)' : `on · TTL ${cfg.cacheTtl('main')} for the conversation, ${cfg.cacheTtl('other')} for sub-agents and compaction${cacheRefusals(cfg, cfg.model).length ? c.yellow(` · the endpoint refused: ${cacheRefusals(cfg, cfg.model).join(', ')}`) : ''}${app.runtime.systemPromptStale ? c.dim(' · memory/config changes reach the system prompt at /clear or /compact') : ''}`),
        row('Auto-compact', `at ${formatTokens(cfg.compactWindow())} tokens (the window, less room for the summary)`),
        row('Access', 'full (no permission prompts)'),
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

  // /status about this session's name for the other sessions, and, where 7bit.fun is connected, whether it is online
  // there (its web page) and its name on the other computers.
  function remoteLines(row) {
    const cfg = app.runtime.config;
    const me = app.peerLabel();
    if (!gatewayLogin(cfg.gatewayUrl)) return [row('Name', `@${me} ${c.dim('(for the other sessions of this computer; /rename changes it)')}`)];
    return [
      row('Remote session', app.remoteState().text),
      row('Name', `@${me} ${c.dim(`(on your other computers: @${machineName(cfg.env)}/${me}; /rename changes it)`)}`),
    ];
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
      const trace = a.trace?.summary();
      const toolCalls = trace?.tools?.reduce((n, item) => n + item.calls, 0) || 0;
      const toolSuccesses = trace?.tools?.reduce((n, item) => n + item.successes, 0) || 0;
      out([
        `Total cost:    ${formatUsd(app.cost)} ${c.dim('for this conversation, at list prices (sub-agents, compaction and side requests included)')}`,
        `Total input:   ${formatTokens(u.input + u.cacheRead + u.cacheWrite)} tokens ${c.dim(`(${formatTokens(u.cacheRead)} cache read, ${formatTokens(u.cacheWrite)} cache write${u.cacheWrite1h ? `, ${formatTokens(u.cacheWrite1h)} of it for 1 hour` : ''})`)}`,
        `Total output:  ${formatTokens(u.output)} tokens`,
        `API requests:  ${u.requests}${u.compactions ? c.dim(` + ${u.compactions} to compact the conversation`) : ''}${u.keepalives ? c.dim(` + ${u.keepalives} to keep the prompt cache warm`) : ''}`,
        ...cacheLines.map((line, i) => (i ? c.dim(line) : line)),
        ...(a.keepAlive?.describe() ? [c.dim(`  ${a.keepAlive.describe()}`)] : []),
        ...(trace ? [`Trace:         ${trace.requests} requests · ${toolCalls} tool calls${toolCalls ? ` · ${Math.round((toolSuccesses / toolCalls) * 100)}% tool success` : ''} · ${trace.compactions} compactions · ${trace.verification_runs} verifications`] : []),
        ...(b.runs ? [c.dim(`Sub-agents:    ${b.runs} run${b.runs === 1 ? '' : 's'}, ${b.requests + b.compactions} request${b.requests + b.compactions === 1 ? '' : 's'}, ${formatTokens(b.input + b.cacheRead + b.cacheWrite)} input (${formatTokens(b.cacheRead)} cached), ${formatTokens(b.output)} output; included in the totals`)] : []),
        `Session time:  ${formatDuration(Date.now() - app.sessionStart)}`,
      ]);
      const cfg = app.runtime.config;
      const saved = gatewayLogin(cfg.gatewayUrl);
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
    name: 'trace',
    argHint: '[recent count]',
    description: 'Show runtime quality metrics and the privacy-preserving trace file',
    run(args) {
      const trace = app.runtime.trace;
      if (!trace) { out(c.dim('Runtime trace is unavailable.')); return; }
      const summary = trace.summary();
      const lines = [
        `Trace file:    ${summary.file || c.dim('(not persisted: no session id)')}`,
        `Enabled:       ${summary.enabled ? 'yes' : 'no'}`,
        `Turns:         ${summary.turns}`,
        `Requests:      ${summary.requests} (${summary.request_successes} succeeded, ${summary.request_failures} failed)`,
        `Cache:         ${summary.cache_hits} hits${summary.cache_misses ? `, ${summary.cache_misses} misses` : ''}${summary.cache_hit_rate == null ? '' : ` (${Math.round(summary.cache_hit_rate * 100)}% request hit rate)`}`,
        `Compactions:   ${summary.compactions}${summary.compaction_failures ? ` (${summary.compaction_failures} failed)` : ''}`,
        `Verification:  ${summary.verification_runs}${summary.verification_runs ? ` (${Math.round((summary.verification_pass_rate || 0) * 100)}% passed)` : ''}`,
      ];
      if (summary.tools.length) {
        lines.push('', 'Tools:');
        for (const tool of summary.tools) lines.push(`  ${padEnd(tool.name, 18)} ${tool.calls} calls · ${Math.round((tool.success_rate || 0) * 100)}% success · ${Math.round(tool.avg_duration_ms)}ms avg · ${formatTokens(tool.output_tokens_estimate)} output tokens est.`);
      }
      const count = Math.max(0, Math.min(50, parseInt(args, 10) || 0));
      if (count) {
        lines.push('', `Recent events (${count}):`);
        lines.push(...trace.recent(count).map((event) => c.dim(JSON.stringify(event))));
      }
      out(lines);
    },
  });

  add({
    name: 'context',
    description: 'Show context window usage',
    run() {
      const cfg = app.runtime.config;
      const a = app.agent;
      const window = cfg.model.contextWindow;
      const threshold = cfg.compactWindow();
      const sys = estimateTokens(app.runtime.systemPrompt());
      const tools = estimateTokens(a.toolSchemas());
      const msgs = estimateTokens(a.messages);
      const used = a.lastContextTokens ? a.contextEstimate : sys + tools + msgs;
      const barW = 40;
      const fill = Math.min(barW, Math.round((used / window) * barW));
      const mark = Math.min(barW - 1, Math.round((threshold / window) * barW));
      let bar = '';
      for (let i = 0; i < barW; i++) bar += i < fill ? c.claude('█') : i === mark ? c.yellow('┃') : c.dim(glyphs.track);
      out([
        `${bar}  ${c.bold(formatTokens(used))} / ${formatTokens(window)} tokens (${Math.round((used / window) * 100)}%)`,
        c.dim(`System prompt ~${formatTokens(sys)} · Tools ~${formatTokens(tools)} · Messages ~${formatTokens(msgs)} (${a.messages.length})`),
        c.dim(`Auto-compact at ${formatTokens(threshold)} tokens (┃) — ${Math.max(0, Math.round((1 - used / threshold) * 100))}% left`),
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
    description: 'Run a command (e.g. npm test) after turns that edit files; failures go back to the agent (off unless set)',
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
    async run() { out(c.dim(`Version ${VERSION} · checking npm…`)); await app.updateFromNpm(); },
  });

  add({
    name: 'peers',
    aliases: ['sessions'],
    argHint: '[name NEW-NAME]',
    description: 'List the other sessions, on this computer and (through the gateway) on your other computers; send one a task with @name ...',
    async run(args) {
      const [action, ...rest] = args.split(/\s+/).filter(Boolean);
      if (action === 'name' && rest.length) { out(`This session is now ${c.bold('@' + app.renameSession(rest.join('-')))}`); return; }
      const { me, local, remote, contacts = [], online } = await app.listAllPeers();
      out([
        `This session: ${c.bold('@' + me.name)} ${c.dim(displayPath(me.cwd, app.cwd))}${online ? c.dim(` · from other computers: @${me.label}`) : ''}`,
        ...local.map((p) => `${c.bold('@' + p.name)} ${c.dim(`${p.cwd} · pid ${p.pid}`)}`),
        ...(remote.length ? [c.dim('On your other computers, through the gateway:'), ...remote.map((p) => `${c.bold('@' + p.label)} ${c.dim(`${p.cwd}${p.busy ? ' · busy' : ''}`)}`)] : []),
        ...(contacts.length ? [c.dim('Of your contacts (other people, /contacts):'), ...contacts.map((p) => `${c.bold('@' + p.label)}${p.busy ? c.dim(' · busy') : ''}`)] : []),
        ...(local.length || remote.length || contacts.length ? [] : [c.dim('No other session is running.')]),
        c.dim(online
          ? 'Type "@" for the combined file/session list, "@name task" to send a task; its answer is shown here. On another computer: "@computer/name task", or "@computer task" when it runs one session. /rename names this session. The agent can use ListPeers / MessagePeer too.'
          : 'Type "@" for the combined file/session list, "@name task" to send a task; its answer is shown here. Sessions on your other computers show up here once this one is online at the gateway (/connect 7bit.fun; /status says why it is not).'),
      ]);
    },
  });

  // The local web console, and its 远程访问 (https://<通讯号>.7bit.fun with a password, see web/remote-access.js).
  add({
    name: 'web',
    argHint: '[remote [on|off|password|logout]]',
    description: 'Open the web console in your browser; /web remote on reaches it from your phone at <通讯号>.7bit.fun with a password',
    async run(args) {
      const [what = '', action = ''] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const web = await import('./web/server.js');
      if (what === 'remote') return remoteAccess(web, action);
      if (what) { out(c.red('/web, or /web remote [on|off|password|logout]')); return; }
      out(c.dim('Starting the web console…'));
      try {
        const { url, port } = await web.ensureWebServer();
        const opened = web.openBrowser(url);
        out(`${c.green('✔')} Web console: ${c.blue(`http://127.0.0.1:${port}`)}${opened ? c.dim(' (opened in your browser)') : ''}`);
        if (!opened) out(c.dim(`Open this link to log in: ${url}`));
      } catch (e) {
        out(c.red(`Could not start the web console: ${e.message}`));
      }
    },
  });

  async function askPassword(ra) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const first = await app.showDialog(new TextInputDialog({
        title: '远程访问密码',
        body: [`在手机或别的电脑上打开控制台时要输入它。至少 ${ra.MIN_PASSWORD} 位（空格不算）；它能让人在这台电脑上执行命令，请用强密码。`, c.dim('只在这台电脑上保存它的哈希，网关不知道它。')],
        question: '密码:',
        secret: true,
        validate: (t) => (t.replace(/\s+/g, '').length < ra.MIN_PASSWORD ? `至少 ${ra.MIN_PASSWORD} 位` : null),
      }));
      if (first === null) return null;
      const again = await app.showDialog(new TextInputDialog({ title: '远程访问密码', body: ['再输一次。'], question: '密码:', secret: true }));
      if (again === null) return null;
      if (again === first) return first;
      out(c.yellow('两次输入不一样，再来一次。'));
    }
    return null;
  }

  // What the console server says of 远程访问 (GET /api/remote), started if need be.
  async function remoteStatus(web, { start = true, waitOnline = 0 } = {}) {
    let state = null;
    try { state = JSON.parse(fs.readFileSync(web.stateFile(), 'utf8')); } catch { /* not started */ }
    if (start) state = { ...state, ...(await web.ensureWebServer()) };
    const until = Date.now() + waitOnline;
    for (;;) {
      try {
        const token = JSON.parse(fs.readFileSync(web.stateFile(), 'utf8')).token;
        const res = await fetch(`http://127.0.0.1:${state.port}/api/remote`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
        const view = await res.json();
        if (Date.now() >= until || view.tunnel?.status === 'online' || view.tunnel?.status === 'error') return view;
      } catch (e) { if (Date.now() >= until) throw e; }
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  async function remoteAccess(web, action) {
    const ra = await import('./web/remote-access.js');
    const cfg = app.runtime.config;
    if (action === 'off') {
      ra.setEnabled(false);
      out(`${c.green('✔')} 远程访问已关闭：${c.dim('外网打不开这台电脑的控制台了（本机的 /web 照常可用）。')}`);
      return;
    }
    if (action === 'logout') {
      ra.endAllSessions();
      out(`${c.green('✔')} 所有远程登录的设备都已退出，下次要重新输密码。`);
      return;
    }
    if (action === 'password') {
      const pw = await askPassword(ra);
      if (!pw) { out(c.dim('密码没有改。')); return; }
      ra.setPassword(pw);
      out(`${c.green('✔')} 密码已修改，所有远程登录的设备都已退出。`);
      return;
    }
    if (action === 'on') {
      const login = gatewayLogin(cfg.gatewayUrl);
      if (!login) { out(c.red(`远程访问通过 7bit.fun 网关：先 /connect 7bit.fun 连上网关。`)); return; }
      if (!ra.hasPassword()) {
        const pw = await askPassword(ra);
        if (!pw) { out(c.dim('远程访问没有开启。')); return; }
        ra.setPassword(pw);
      }
      // the address's prefix: chosen by the user the first time, not the one the gateway made up
      let prefix;
      try { prefix = await ra.addressPrefix(login); } catch (e) { out(c.red(`读不到域名前缀：${e.message}`)); return; }
      while (prefix.auto) {
        const wanted = await app.showDialog(new TextInputDialog({
          title: '远程访问域名',
          body: [`选一个域名前缀：https://<前缀>.${prefix.domain}`, '3–20 个小写字母、数字或 -，字母开头、不以 - 结尾；要唯一（它也是你在网关的通讯号）。'],
          question: '前缀:',
        }));
        if (wanted === null || !String(wanted).trim()) { out(c.dim('远程访问没有开启。')); return; }
        try { prefix = await ra.addressPrefix(login, String(wanted).trim().toLowerCase()); } catch (e) { out(c.yellow(e.message)); }
      }
      ra.setEnabled(true);
      out(c.dim('正在连接网关…'));
    } else if (action) { out(c.red('/web remote [on|off|password|logout]')); return; }
    const d = ra.readRemote();
    if (!d.enabled) {
      out([`远程访问：${c.dim('关闭')}`, c.dim('/web remote on 开启：第一次选一个域名前缀，在手机上打开 https://<前缀>.7bit.fun，输入密码就能用这台电脑的 claude-pro 控制台。')]);
      return;
    }
    let view;
    try { view = await remoteStatus(web, { waitOnline: action === 'on' ? 12_000 : 0 }); } catch (e) { out(c.red(`控制台没有启动：${e.message}`)); return; }
    const t = view.tunnel || {};
    const lines = [];
    if (t.status === 'online') lines.push(`${c.green('✔')} 远程访问已开启：${c.bold(c.blue(`https://${t.host}`))}`, c.dim('在手机上打开它，输入密码。电脑休眠或关机时打不开；claude-pro 的任何会话启动时都会把它重新接上。'));
    else if (t.status === 'error') lines.push(c.red(`远程访问没有接上：${t.error}`));
    else lines.push(c.yellow(`远程访问正在连接网关…${t.error ? c.dim(`（${t.error}）`) : ''}`));
    lines.push(c.dim(`登录着的设备 ${view.sessions?.length || 0} 台 · /web remote logout 让它们全部退出 · /web remote password 改密码 · /web remote off 关闭`));
    out(lines);
  }

  // 通讯录 at the gateway: other people's accounts whose claude-pro sessions and this account's may send each other
  // tasks, once both sides agreed. Each account has a public 通讯号 (handle) that the others add it by.
  const CONTACT_LABELS = { incoming: c.yellow('asks to be your contact'), outgoing: c.dim('waiting for them to accept'), accepted: c.green('contact'), blocked: c.red('blocked') };
  add({
    name: 'contacts',
    argHint: '[add|accept|reject|remove|block|trust|handle] [通讯号] [auto|confirm]',
    description: 'Your contacts at the gateway: other people whose claude-pro sessions and yours may send each other tasks once both agree',
    async run(args) {
      const [action = '', handle = '', extra = ''] = args.trim().split(/\s+/).filter(Boolean).map((s, i) => (i === 0 ? s.toLowerCase() : s));
      const remote = await app.syncRemote();
      if (!remote?.registered) { out(c.red(`Contacts live at the gateway, and this session is not online there: ${app.remoteState().text}`)); return; }
      const actions = ['add', 'accept', 'reject', 'remove', 'block', 'trust', 'handle'];
      if (action && !actions.includes(action)) { out(c.red(`Unknown action "${action}". /contacts ${actions.join('|')} 通讯号`)); return; }
      if (action && !handle) { out(c.red(`/contacts ${action} needs a 通讯号${action === 'handle' ? ' (your new one)' : ''}.`)); return; }
      const trust = extra.toLowerCase() || 'auto';
      if (action === 'trust' && !['auto', 'confirm'].includes(trust)) { out(c.red('/contacts trust 通讯号 auto (their tasks run without asking) or confirm (each one is asked).')); return; }
      let data;
      try {
        data = await remote.contacts(action, action === 'trust' ? { handle, trust } : action ? { handle } : undefined);
      } catch (e) {
        out(c.red(e.status === 404 && !action ? `The gateway ${remote.base} has no contacts yet (${e.message}).` : e.message));
        return;
      }
      const done = {
        add: `Asked ${handle}: once they accept, your sessions can send each other tasks.`,
        accept: `${handle} is your contact now.`,
        reject: `Declined ${handle}.`,
        remove: `${handle} is no longer in your contacts.`,
        block: `Blocked ${handle}: they cannot ask you nor send your sessions tasks.`,
        trust: trust === 'auto' ? `Tasks from ${handle} run without asking now.` : `Each task from ${handle} is asked about now.`,
        handle: `Your 通讯号 is ${data.handle} now.`,
      }[action];
      const added = action === 'add' && data.contacts?.find((x) => x.handle === handle.toLowerCase().replace(/^@/, ''))?.status === 'accepted';
      if (done) out(c.green('✔ ') + (added ? `${handle} had asked you already: you are contacts now.` : done));
      if (action === 'accept' || action === 'remove' || action === 'block' || added) app.refreshRemotePeers();
      if (action && action !== 'handle') return;
      const rows = Array.isArray(data.contacts) ? data.contacts : [];
      out([
        `Your 通讯号: ${c.bold(data.handle)} ${c.dim('(the name others add you by; /contacts handle NEW changes it)')}`,
        ...rows.map((x) => {
          const online = x.status === 'accepted' ? c.dim(` · ${x.online ? `${x.online} session${x.online === 1 ? '' : 's'} online` : 'no session online'} · tasks: ${x.trust === 'auto' ? 'run without asking' : 'asked about each time'}`) : '';
          return `  ${c.bold(x.handle)} ${CONTACT_LABELS[x.status] || x.status}${online}`;
        }),
        ...(rows.length ? [] : [c.dim('  No contacts yet.')]),
        c.dim('/contacts add 通讯号 asks someone; accept / reject / remove / block 通讯号; trust 通讯号 auto|confirm. A contact sees only the name, computer and state of your online sessions; their tasks are asked about here before they run, unless you set trust to auto. In /peers their sessions show as @通讯号:computer/name.'),
      ]);
    },
  });

  add({
    name: 'rename',
    argHint: '<name>',
    argRequired: true,
    description: 'Name this session: the other sessions send it tasks with @name, and it is the title (tab, /resume, the web page)',
    run(args) {
      const name = args.trim();
      if (!name) { out(`This session is ${c.bold('@' + app.peerLabel())}. /rename NAME gives it another name.`); return; }
      const got = app.renameSession(name);
      const note = got !== cleanName(name) ? c.dim(' (another session on this computer has that name)') : '';
      out(`This session is now ${c.bold('@' + got)}${note}${app.remote ? c.dim(` · from your other computers: @${machineName(app.config.env)}/${got}`) : ''}`);
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
          // as Claude Code does: the prompt to send again or edit; not over what was typed while it summarized
          if (part === 'after' && prompt) {
            if (!app.editor.text.trim()) app.editor.set(prompt);
            else out(c.dim('The prompt was not put back in the input box: it holds what you typed meanwhile.'));
          }
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
      const list = listBackgroundShells(app.config.owner);
      out(list.length ? list.map((b) => `${c.bold(b.id)} ${b.status}${b.exitCode !== null ? ` (exit ${b.exitCode})` : ''} ${c.dim(truncate(b.command, 60))}`) : [c.dim('No background shells')]);
    },
  });

  add({
    name: 'verbose',
    description: 'Toggle detailed tool output and compaction summaries',
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
        ...(gatewayLogin(cfg.gatewayUrl) ? [`${c.green('✔')} 7bit.fun connected ${c.dim(`(7bit/…, ${cfg.gatewayUrl})`)}`] : []),
        ...connectedProviders().map((p) => `${c.green('✔')} ${p.name} connected ${c.dim(`(${p.id}/…, ${normalizeBaseUrl(p.connection.baseUrl || p.baseUrl, p.protocol)})`)}`),
        ...(cfg.providerConnected(cfg.model.provider) ? [] : [`${c.red('✘')} ${cfg.model.label} is a model of ${cfg.providerName(cfg.model.provider)}, which is not connected (/connect)`]),
      ];
      out(lines);
      app.busy = true;
      app.status = 'Testing API';
      app.turnStart = Date.now();
      app.controller = new AbortController();
      const started = Date.now();
      try {
        const reply = await quickQuery(cfg, { model: cfg.model, system: 'Reply with exactly: pong', prompt: 'ping', maxTokens: 200, signal: app.controller.signal, waitForRateLimit: false });
        out(`${c.green('✔')} ${cfg.endpointLabel} · model ${cfg.model.id} replied "${truncate(reply, 40)}" in ${Date.now() - started}ms`);
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
