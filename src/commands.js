// Slash commands for the interactive REPL.

import fs from 'node:fs';
import path from 'node:path';
import { c, padEnd, truncate } from './ui/ansi.js';
import { SelectDialog } from './ui/dialogs.js';
import { renderTodos, resultLines, formatTokens, formatDuration } from './ui/render.js';
import { loadConfig, settingsFiles, updateSettingsFile, rememberChoice, KNOWN_KEYS, VERSION, APP_NAME, CONFIG_DIR } from './config.js';
import { SessionStore } from './session.js';
import { memoryFiles, listAutoMemories } from './context.js';
import { INIT_PROMPT } from './prompts.js';
import { loadCustomCommands, renderSkill, expandCommandBody, expandShellEmbeds } from './agents.js';
import { listBackgroundShells } from './tools/bash.js';
import { estimateTokens } from './agent.js';
import { quickQuery } from './api.js';
import { hasRipgrep } from './utils/shell.js';
import { displayPath } from './utils/paths.js';
import { rewind } from './checkpoints.js';
import { canRestart, runSelfCheck } from './restart.js';

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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
    cfg.env = fresh.env;
    cfg.sources = fresh.sources;
    cfg.settings = fresh.settings;
    cfg.ignoredFromDotEnv = fresh.ignoredFromDotEnv;
    // What the system prompt is built from may have changed (memory switched off, say). It is not rebuilt in the
    // middle of a conversation, which would lose its prompt cache; it is, at the next /clear or compaction.
    app.runtime.deferSystemPromptRefresh();
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
    name: 'clear',
    aliases: ['reset', 'new'],
    description: 'Clear conversation history and free up context',
    run() {
      app.agent.resetConversation();
      app.newSession();
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
        const configured = cfg.configuredModelSpec;
        const opts = [
          { label: `Default ${c.dim(`(${configured} → ${cfg.resolveModel(configured).id})`)}`, value: '__default__' },
          ...['opus', 'sonnet', 'haiku'].map((a) => ({ label: `${a} ${c.dim(`→ ${cfg.resolveModel(cfg.aliasTarget(a)).label}`)}`, value: a })),
        ];
        if (!cfg.usesClaudeCode && cfg.env.CLAUDE_CODE_SUBAGENT_MODEL) opts.push({ label: `${cfg.env.CLAUDE_CODE_SUBAGENT_MODEL} ${c.dim('(sub-agent model)')}`, value: cfg.env.CLAUDE_CODE_SUBAGENT_MODEL });
        choice = await app.showDialog(new SelectDialog({ title: 'Select model', question: `Current: ${c.bold(cfg.mainModel.label)}. Any name works too: /model <name>`, options: opts }));
        if (!choice) return;
      }
      const forget = choice === '__default__' || choice === 'default';
      const next = cfg.resolveModel(forget ? cfg.configuredModelSpec : choice).id;
      if (next !== cfg.mainModel.id && !(await confirmCacheLoss('Switching the model', { model: next }))) { out(c.dim('The model was not changed.')); return; }
      cfg.modelOverride = forget ? null : choice;
      app.runtime.invalidateSystemPrompt(); // the prompt names the model; the new model starts a cache of its own anyway
      const kept = keep(cfg, { model: cfg.modelOverride }, forget);
      out(`Model set to ${c.bold(cfg.mainModel.label)} ${c.dim(`(${formatTokens(cfg.mainModel.contextWindow)} context)`)}${kept}`);
    },
  });

  add({
    name: 'effort',
    argHint: `[${EFFORTS.join('|')}|auto|default]`,
    description: 'Set reasoning effort (output_config.effort; kept for later sessions)',
    async run(args) {
      const cfg = app.runtime.config;
      let choice = args.trim().toLowerCase();
      if (!choice) {
        const configured = (cfg.env.CLAUDE_CODE_EFFORT_LEVEL || '').trim().toLowerCase() || 'auto';
        choice = await app.showDialog(new SelectDialog({
          title: 'Reasoning effort',
          question: `Current: ${c.bold(cfg.effort || 'auto (not sent)')}`,
          options: [
            ...EFFORTS.map((e) => ({ label: e, value: e })),
            { label: 'auto (use API default)', value: 'auto' },
            { label: `default ${c.dim(`(configured: ${configured})`)}`, value: 'default' },
          ],
        }));
        if (!choice) return;
      }
      if (choice !== 'auto' && choice !== 'default' && !EFFORTS.includes(choice)) { out(c.red(`Unknown effort "${choice}". Use one of: ${EFFORTS.join(', ')}, auto, default`)); return; }
      const forget = choice === 'default';
      const wanted = (forget ? (cfg.env.CLAUDE_CODE_EFFORT_LEVEL || '') : choice).trim().toLowerCase();
      const next = wanted && wanted !== 'auto' && wanted !== 'default' ? wanted : null;
      if (next !== cfg.effort && !(await confirmCacheLoss('Changing the effort'))) { out(c.dim('The effort was not changed.')); return; }
      cfg.effortOverride = forget ? null : choice;
      out(`Effort set to ${c.bold(cfg.effort || 'auto')}${keep(cfg, { effort: cfg.effortOverride }, forget)}`);
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
        row('Auth', cfg.usesClaudeCode ? `existing Claude Code OAuth (${cfg.claudeCodeCredentialsFile})` : cfg.authToken ? `ANTHROPIC_AUTH_TOKEN (${cfg.display('ANTHROPIC_AUTH_TOKEN')})` : cfg.apiKey ? `ANTHROPIC_API_KEY (${cfg.display('ANTHROPIC_API_KEY')})` : c.red('none')),
        row('Model', `${cfg.mainModel.label} ${c.dim(`(sent as "${cfg.mainModel.id}", ${formatTokens(cfg.mainModel.contextWindow)} context)`)}`),
        row('Sub-agent model', cfg.subagentModel.label),
        row('Small model', cfg.smallModel.label),
        row('Effort', cfg.effort || 'auto'),
        row('Max output', formatTokens(cfg.maxOutputTokens)),
        row('Prompt cache', cfg.promptCachingDisabled(cfg.mainModel.id) ? 'off (DISABLE_PROMPT_CACHING)' : `on · TTL ${cfg.cacheTtl('main')} for the conversation, ${cfg.cacheTtl('other')} for sub-agents and compaction${app.runtime.systemPromptStale ? c.dim(' · memory/config changes reach the system prompt at /clear or /compact') : ''}`),
        row('Auto-compact', cfg.autoCompactEnabled ? `at ${formatTokens(cfg.autoCompactThreshold())} tokens (window ${formatTokens(cfg.compactWindow())})` : 'disabled'),
        row('Mode', modes.mode === 'plan' ? 'plan (read-only; shift+tab to leave)' : 'full access (no permission prompts)'),
        row('Checkpoints', `${app.runtime.checkpoints.list().length} (/rewind)`),
        row('Shell', `${app.runtime.shell.name} ${c.dim(app.runtime.shell.path)}`),
        row('ripgrep', hasRipgrep(cfg) ? 'yes' : 'no (using JS fallback)'),
        row('Memory', mem.length ? mem.map((m) => m.file).join(', ') : c.dim('none')),
        row('MCP servers', mcp.length ? mcp.map((m) => `${m.name} (${m.status})`).join(', ') : c.dim('none')),
      ], '');
    },
  });

  add({
    name: 'cost',
    aliases: ['usage'],
    description: 'Show token usage for this session',
    run() {
      const a = app.agent;
      const u = a.totalUsage();
      const b = a.subUsage;
      const cacheLines = a.cache.describe();
      out([
        `Total input:   ${formatTokens(u.input + u.cacheRead + u.cacheWrite)} tokens ${c.dim(`(${formatTokens(u.cacheRead)} cache read, ${formatTokens(u.cacheWrite)} cache write${u.cacheWrite1h ? `, ${formatTokens(u.cacheWrite1h)} of it for 1 hour` : ''})`)}`,
        `Total output:  ${formatTokens(u.output)} tokens`,
        `API requests:  ${u.requests}${u.compactions ? c.dim(` + ${u.compactions} to compact the conversation`) : ''}`,
        ...cacheLines.map((line, i) => (i ? c.dim(line) : line)),
        ...(b.runs ? [c.dim(`Sub-agents:    ${b.runs} run${b.runs === 1 ? '' : 's'}, ${b.requests + b.compactions} requests, ${formatTokens(b.input + b.cacheRead + b.cacheWrite)} input (${formatTokens(b.cacheRead)} cached), ${formatTokens(b.output)} output; included in the totals`)] : []),
        `Session time:  ${formatDuration(Date.now() - app.sessionStart)}`,
      ]);
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
    description: 'Undo: restore files and/or the conversation to before an earlier prompt',
    async run() {
      const store = app.runtime.checkpoints;
      const entries = store.list().slice(0, 30);
      if (!entries.length) { out(c.dim('No checkpoints yet: one is created for every prompt you send.')); return; }
      const id = await app.showDialog(new SelectDialog({
        title: 'Rewind',
        question: 'Go back to before which prompt?',
        color: c.blue,
        options: entries.map((e) => {
          const n = store.filesSince(e.id).length;
          return {
            label: truncate(e.label || '(empty prompt)', 60),
            value: e.id,
            description: `${new Date(e.time).toLocaleTimeString()} · ${n ? `${n} file${n === 1 ? '' : 's'} changed since` : 'no file changes since'}`,
          };
        }),
      }));
      if (!id) return;
      const entry = store.get(id);
      const files = store.filesSince(id);
      const options = [];
      if (files.length && entry.conversationValid) options.push({ label: 'Restore code and conversation', value: 'both', description: `${files.length} file(s) go back and the chat continues from before this prompt` });
      if (files.length) options.push({ label: 'Restore code only', value: 'code', description: `${files.length} file(s) go back; the conversation stays as it is` });
      if (entry.conversationValid) options.push({ label: files.length ? 'Restore conversation only' : 'Rewind the conversation', value: 'conversation', description: 'Files are left as they are' });
      if (!options.length) { out(c.dim('Nothing to restore for that prompt (the conversation was compacted and no files changed).')); return; }
      options.push({ label: 'Never mind', value: 'cancel' });
      const mode = await app.showDialog(new SelectDialog({ title: 'Rewind', question: `To before: ${c.bold(truncate(entry.label || '(empty prompt)', 60))}`, color: c.blue, options, cancelValue: 'cancel' }));
      if (!mode || mode === 'cancel') return;
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
