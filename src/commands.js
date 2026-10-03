// Slash commands for the interactive REPL.

import fs from 'node:fs';
import path from 'node:path';
import { c, padEnd, truncate } from './ui/ansi.js';
import { SelectDialog } from './ui/dialogs.js';
import { renderTodos, resultLines, formatTokens, formatDuration } from './ui/render.js';
import { loadConfig, settingsFiles, updateSettingsFile, KNOWN_KEYS, VERSION, APP_NAME, CONFIG_DIR } from './config.js';
import { SessionStore } from './session.js';
import { memoryFiles } from './context.js';
import { INIT_PROMPT } from './prompts.js';
import { loadCustomCommands } from './agents.js';
import { listBackgroundShells } from './tools/bash.js';
import { estimateTokens } from './agent.js';
import { quickQuery } from './api.js';
import { hasRipgrep } from './utils/shell.js';

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function buildCommands(app) {
  const commands = new Map();
  const add = (cmd) => commands.set(cmd.name, cmd);
  const log = (...lines) => app.screen.log(...lines);
  const out = (lines) => log(resultLines(Array.isArray(lines) ? lines : [lines]), '');

  const reloadConfig = () => {
    const fresh = loadConfig({ cwd: app.cwd, flags: app.flags });
    const cfg = app.runtime.config;
    cfg.env = fresh.env;
    cfg.sources = fresh.sources;
    cfg.settings = fresh.settings;
    app.runtime.invalidateSystemPrompt();
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
      const lines = [c.bold('Configuration') + c.dim('  (precedence: .env < ~/.ccc/settings.json < .ccc/settings.json < .ccc/settings.local.json < shell env < flags)'), ''];
      for (const k of Object.keys(KNOWN_KEYS)) {
        const v = cfg.display(k);
        if (v === undefined) continue;
        lines.push(`${padEnd(k, 34)} ${c.bold(v)}  ${c.dim(cfg.sources[k] || '')}`);
      }
      lines.push('', c.dim('Other keys: ' + Object.keys(KNOWN_KEYS).filter((k) => cfg.env[k] === undefined).join(', ')));
      lines.push('', `${c.dim('Change with')} /config set KEY VALUE [--project|--local] ${c.dim('or edit')} ${settingsFiles(app.cwd).user}`);
      log(lines, '');
    },
  });

  add({
    name: 'model',
    argHint: '[model]',
    description: 'Set the AI model for this session',
    async run(args) {
      const cfg = app.runtime.config;
      let choice = args.trim();
      if (!choice) {
        const opts = [
          { label: `Default ${c.dim(`(${cfg.env.ANTHROPIC_MODEL || 'sonnet'} → ${cfg.resolveModel(cfg.env.ANTHROPIC_MODEL || 'sonnet').id})`)}`, value: '__default__' },
          ...['opus', 'sonnet', 'haiku'].map((a) => ({ label: `${a} ${c.dim(`→ ${cfg.resolveModel(cfg.aliasTarget(a)).label}`)}`, value: a })),
        ];
        if (cfg.env.CLAUDE_CODE_SUBAGENT_MODEL) opts.push({ label: `${cfg.env.CLAUDE_CODE_SUBAGENT_MODEL} ${c.dim('(sub-agent model)')}`, value: cfg.env.CLAUDE_CODE_SUBAGENT_MODEL });
        choice = await app.showDialog(new SelectDialog({ title: 'Select model', question: `Current: ${c.bold(cfg.mainModel.label)}. Any name works too: /model <name>`, options: opts }));
        if (!choice) return;
      }
      cfg.modelOverride = choice === '__default__' || choice === 'default' ? null : choice;
      app.runtime.invalidateSystemPrompt();
      out(`Model set to ${c.bold(cfg.mainModel.label)} ${c.dim(`(${formatTokens(cfg.mainModel.contextWindow)} context)`)}`);
    },
  });

  add({
    name: 'effort',
    argHint: `[${EFFORTS.join('|')}|auto]`,
    description: 'Set reasoning effort (output_config.effort)',
    async run(args) {
      const cfg = app.runtime.config;
      let choice = args.trim().toLowerCase();
      if (!choice) {
        choice = await app.showDialog(new SelectDialog({
          title: 'Reasoning effort',
          question: `Current: ${c.bold(cfg.effort || 'auto (not sent)')}`,
          options: [...EFFORTS.map((e) => ({ label: e, value: e })), { label: 'auto (use API default)', value: 'auto' }],
        }));
        if (!choice) return;
      }
      if (choice !== 'auto' && !EFFORTS.includes(choice)) { out(c.red(`Unknown effort "${choice}". Use one of: ${EFFORTS.join(', ')}, auto`)); return; }
      cfg.effortOverride = choice;
      out(`Effort set to ${c.bold(cfg.effort || 'auto')}`);
    },
  });

  add({
    name: 'status',
    description: 'Show version, model, API endpoint and session info',
    run() {
      const cfg = app.runtime.config;
      const perms = app.runtime.permissions;
      const mem = memoryFiles(app.cwd);
      const mcp = app.runtime.mcp.status();
      const row = (k, v) => `${c.dim(padEnd(k, 18))} ${v}`;
      log([
        c.bold('Status'), '',
        row('Version', VERSION),
        row('Session ID', app.store.id),
        row('cwd', app.cwd),
        row('API base URL', cfg.baseURL),
        row('Auth', cfg.authToken ? `ANTHROPIC_AUTH_TOKEN (${cfg.display('ANTHROPIC_AUTH_TOKEN')})` : cfg.apiKey ? `ANTHROPIC_API_KEY (${cfg.display('ANTHROPIC_API_KEY')})` : c.red('none')),
        row('Model', `${cfg.mainModel.label} ${c.dim(`(sent as "${cfg.mainModel.id}", ${formatTokens(cfg.mainModel.contextWindow)} context)`)}`),
        row('Sub-agent model', cfg.subagentModel.label),
        row('Small model', cfg.smallModel.label),
        row('Effort', cfg.effort || 'auto'),
        row('Max output', formatTokens(cfg.maxOutputTokens)),
        row('Auto-compact', cfg.autoCompactEnabled ? `at ${formatTokens(cfg.autoCompactThreshold())} tokens (window ${formatTokens(cfg.compactWindow())})` : 'disabled'),
        row('Permission mode', perms.mode),
        row('Shell', `${app.runtime.shell.name} ${c.dim(app.runtime.shell.path)}`),
        row('ripgrep', hasRipgrep() ? 'yes' : 'no (using JS fallback)'),
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
      const u = app.agent.usage;
      out([
        `Total input:   ${formatTokens(u.input + u.cacheRead + u.cacheWrite)} tokens ${c.dim(`(${formatTokens(u.cacheRead)} cache read, ${formatTokens(u.cacheWrite)} cache write)`)}`,
        `Total output:  ${formatTokens(u.output)} tokens`,
        `API requests:  ${u.requests}`,
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
    description: 'Show memory files (CLAUDE.md); use # to add memories',
    run() {
      const mem = memoryFiles(app.cwd);
      out(mem.length ? mem.map((m) => `${m.file} ${c.dim(`(${m.scope}, ${m.text.split('\n').length} lines)`)}`) : [c.dim('No memory files. Start a message with # to save a memory, or run /init.')]);
    },
  });

  add({
    name: 'permissions',
    aliases: ['allowed-tools'],
    argHint: '[allow|deny|remove RULE]',
    description: 'View or edit permission rules',
    run(args) {
      const perms = app.runtime.permissions;
      const [action, ...ruleParts] = args.split(/\s+/).filter(Boolean);
      const rule = ruleParts.join(' ');
      const file = settingsFiles(app.cwd).local;
      if ((action === 'allow' || action === 'deny') && rule) {
        perms[action].push(rule);
        updateSettingsFile(file, (json) => {
          json.permissions = json.permissions || {};
          json.permissions[action] = [...new Set([...(json.permissions[action] || []), rule])];
        });
        out(`Added ${action} rule ${c.bold(rule)} ${c.dim(`(${file})`)}`);
        return;
      }
      if (action === 'remove' && rule) {
        perms.allow = perms.allow.filter((r) => r !== rule);
        perms.deny = perms.deny.filter((r) => r !== rule);
        updateSettingsFile(file, (json) => {
          if (!json.permissions) return;
          for (const k of ['allow', 'deny']) if (json.permissions[k]) json.permissions[k] = json.permissions[k].filter((r) => r !== rule);
        });
        out(`Removed ${c.bold(rule)}`);
        return;
      }
      out([
        `Mode: ${c.bold(perms.mode)} ${c.dim('(shift+tab to cycle)')}`,
        `Allow: ${perms.allow.length ? perms.allow.join(', ') : c.dim('none')}`,
        `Deny:  ${perms.deny.length ? perms.deny.join(', ') : c.dim('none')}`,
        c.dim('Examples: /permissions allow Bash(npm test:*) · /permissions deny Read(./.env) · /permissions remove Edit'),
      ]);
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
      if (!status.length) { out(c.dim('No MCP servers configured. Add them to .mcp.json or "mcpServers" in ~/.ccc/settings.json.')); return; }
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
      const lines = [
        `${c.green('✔')} Node ${process.versions.node}`,
        `${app.runtime.shell.kind === 'bash' ? c.green('✔') : c.yellow('!')} Shell: ${app.runtime.shell.name} (${app.runtime.shell.path})`,
        `${hasRipgrep() ? c.green('✔') : c.yellow('!')} ripgrep ${hasRipgrep() ? 'found' : 'not found (Grep uses a slower JS fallback)'}`,
        `${cfg.authToken || cfg.apiKey ? c.green('✔') : c.red('✘')} Credentials ${cfg.authToken ? 'ANTHROPIC_AUTH_TOKEN' : cfg.apiKey ? 'ANTHROPIC_API_KEY' : 'missing'}`,
      ];
      out(lines);
      app.busy = true;
      app.status = 'Testing API';
      app.turnStart = Date.now();
      app.controller = new AbortController();
      const started = Date.now();
      try {
        const reply = await quickQuery(cfg, { model: cfg.mainModel, system: 'Reply with exactly: pong', prompt: 'ping', maxTokens: 200, signal: app.controller.signal });
        out(`${c.green('✔')} API ${cfg.baseURL} · model ${cfg.mainModel.id} replied "${truncate(reply, 40)}" in ${Date.now() - started}ms`);
      } catch (e) {
        out(`${c.red('✘')} API request failed: ${e.message}`);
      } finally {
        app.busy = false;
        app.status = null;
        app.controller = null;
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
        const argv = args.split(/\s+/).filter(Boolean);
        let body = custom.body.replace(/\$ARGUMENTS/g, args).replace(/\$(\d)/g, (m, n) => argv[+n - 1] ?? '');
        if (!custom.body.includes('$ARGUMENTS') && args) body += `\n\nARGUMENTS: ${args}`;
        // !`command` expands to the command's output.
        const bash = app.runtime.tools.find((t) => t.name === 'Bash');
        for (const m of [...body.matchAll(/!`([^`]+)`/g)]) {
          const r = await bash.call({ command: m[1] }, app.agent.makeCtx());
          body = body.replace(m[0], typeof r.content === 'string' ? r.content : '');
        }
        return app.startTurn(body, { echo: false });
      },
    });
  }

  app.sessionStart = Date.now();
  return commands;
}

