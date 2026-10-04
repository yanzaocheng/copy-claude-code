// Interactive REPL: owns the terminal, renders the transcript and live region, and
// implements the agent's IO callbacks (streaming, tool display, permission prompts).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { c, ESC, stringWidth, truncate, padEnd } from './ansi.js';
import { Screen } from './screen.js';
import { Editor } from './editor.js';
import { SelectDialog } from './dialogs.js';
import { MarkdownStream, renderMarkdown } from './markdown.js';
import {
  DOT, toolHeader, renderToolResult, renderTodos, renderUserMessage, resultLines, formatTokens, formatDuration, toolLabel,
} from './render.js';
import { createRuntime } from '../runtime.js';
import { SessionStore } from '../session.js';
import { CONFIG_DIR, VERSION, APP_NAME } from '../config.js';
import { buildCommands } from '../commands.js';
import { resolvePath, displayPath } from '../utils/paths.js';
import { hasRipgrep } from '../utils/shell.js';
import { shutdownBackgroundShells } from '../tools/bash.js';
import { numberLines } from '../tools/files.js';
import { estimateTokens } from '../agent.js';
import { readClipboardImage, imageFromFile } from '../utils/clipboard.js';

const imageBlock = (img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'];
const VERBS = ['Thinking', 'Pondering', 'Crafting', 'Brewing', 'Computing', 'Conjuring', 'Cooking', 'Musing', 'Noodling', 'Percolating', 'Ruminating', 'Synthesizing', 'Working', 'Tinkering', 'Mulling', 'Deliberating', 'Churning', 'Forging', 'Hatching', 'Simmering'];
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.jsonl');

function loadHistory(cwd) {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.project === cwd).map((e) => e.display).slice(-500);
  } catch { return []; }
}

function appendHistory(cwd, text) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({ display: text, project: cwd, timestamp: Date.now() }) + '\n');
  } catch { /* ignore */ }
}

class FileIndex {
  constructor(cwd) { this.cwd = cwd; this.files = []; this.at = 0; this.loading = false; }
  refresh() {
    if (this.loading || Date.now() - this.at < 30_000) return;
    this.loading = true;
    const done = (list) => { this.files = list.slice(0, 50_000); this.at = Date.now(); this.loading = false; };
    if (hasRipgrep()) {
      const child = spawn('rg', ['--files', '--hidden', '--glob', '!.git'], { cwd: this.cwd, windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { if (out.length < 10_000_000) out += d; });
      child.on('close', () => done(out.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, '/'))));
      child.on('error', () => done([]));
    } else {
      (async () => {
        const list = [];
        try {
          for await (const f of fs.promises.glob('**/*', { cwd: this.cwd, exclude: (p) => /(^|[\\/])(node_modules|\.git)$/.test(p) })) {
            list.push(f.replace(/\\/g, '/'));
            if (list.length > 50_000) break;
          }
        } catch { /* ignore */ }
        done(list);
      })();
    }
  }
  search(q) {
    this.refresh();
    const query = q.toLowerCase();
    const dirs = new Set();
    for (const f of this.files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
      if (dirs.size > 5000) break;
    }
    const all = [...dirs, ...this.files];
    const scored = [];
    for (const f of all) {
      const lower = f.toLowerCase();
      const base = lower.replace(/\/$/, '').split('/').pop();
      let score = -1;
      if (!query) score = f.split('/').length;
      else if (base.startsWith(query)) score = 0;
      else if (lower.startsWith(query)) score = 1;
      else if (base.includes(query)) score = 2;
      else if (lower.includes(query)) score = 3;
      if (score >= 0) scored.push({ f, score: score * 1000 + f.length });
      if (scored.length > 2000) break;
    }
    return scored.sort((a, b) => a.score - b.score).slice(0, 12).map((s) => s.f);
  }
}

export class App {
  constructor({ flags, cwd, stdin = process.stdin, stdout = process.stdout, noProcessExit = false }) {
    this.flags = flags;
    this.cwd = cwd;
    this.stdin = stdin;
    this.stdout = stdout;
    this.noProcessExit = noProcessExit;
    this.screen = new Screen(stdout);
    this.busy = false;
    this.controller = null;
    this.queue = [];
    this.dialogs = [];
    this.active = []; // running tool entries, in call order
    this.pendingToolBlocks = new Map(); // streaming tool_use blocks, by index
    this.md = null;
    this.thinking = null;
    this.verbose = !!flags.verbose;
    this.showTodos = true;
    this.turnStart = 0;
    this.turnTokens = 0;
    this.verb = 'Thinking';
    this.status = null; // override spinner text (e.g. compacting)
    this.exitArmed = 0;
    this.notices = [];
    this.fileIndex = new FileIndex(cwd);
    this.store = new SessionStore(cwd);
    this.editor = new Editor({
      history: loadHistory(cwd),
      onSubmit: (value, raw, images) => { try { this.onSubmit(value, raw, images); } catch (e) { this.logError(e); } },
      imageFromPath: (p) => {
        const r = imageFromFile(resolvePath(p, this.cwd));
        if (r.error && !/not found|Not a file/.test(r.error)) this.flash(r.error, 'warn');
        if (r.image) this.flashMessage = null;
        return r.image || null;
      },
      getSuggestions: (text, cursor) => this.suggest(text, cursor),
      onChange: () => this.screen.schedule(),
    });
  }

  get agent() { return this.runtime.agent; }
  get config() { return this.runtime.config; }
  get width() { return this.screen.width; }

  // ---------------------------------------------------------------- lifecycle

  async start(initialPrompt) {
    const stdin = this.stdin;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    this.stdout.write(ESC.bracketedPasteOn);
    const cleanup = () => this.restoreTerminal();
    process.on('exit', cleanup);
    process.on('SIGTERM', () => this.exit(143));
    process.on('SIGHUP', () => this.exit(129));

    this.runtime = await createRuntime({ cwd: this.cwd, flags: this.flags, io: this });
    this.commands = buildCommands(this);
    // Keys typed while starting up stay buffered in stdin until we listen.
    stdin.on('keypress', (str, key) => {
      try { this.onKey(str, key || {}); } catch (e) { this.logError(e); }
    });
    stdin.resume();
    this.runtime.modes.listeners.add(() => this.screen.schedule());
    this.printWelcome();

    if (this.flags.resumeFile) this.loadSession(this.flags.resumeFile, this.flags.resumeId);
    else if (this.flags.resume) await this.commands.get('resume').run('');

    this.screen.setLive((w) => this.renderLive(w));
    this.spinnerTimer = setInterval(() => { if (this.busy || this.active.length) this.screen.schedule(); }, 120);
    if (initialPrompt?.trim()) this.onSubmit(initialPrompt, initialPrompt);
    this.fileIndex.refresh();
    return new Promise((resolve) => { this.resolveExit = resolve; });
  }

  restoreTerminal() {
    if (this.restored) return;
    this.restored = true;
    try {
      this.screen.close();
      this.stdout.write(ESC.bracketedPasteOff + ESC.showCursor);
      if (this.stdin.isTTY) this.stdin.setRawMode(false);
    } catch { /* ignore */ }
  }

  exit(code = 0) {
    if (this.exiting) return;
    this.exiting = true;
    this.controller?.abort();
    clearInterval(this.spinnerTimer);
    shutdownBackgroundShells();
    this.runtime?.tasks.killAll();
    this.runtime?.mcp.close();
    const u = this.agent?.usage;
    if (u && u.requests) {
      this.screen.log(c.dim(`Total usage: ${formatTokens(u.input + u.cacheRead)} input (${formatTokens(u.cacheRead)} cached), ${formatTokens(u.output)} output, ${u.requests} requests`));
    }
    if (this.agent?.messages.length) this.screen.log(c.dim(`Resume this session with: ${APP_NAME} --resume ${this.store.id}`));
    this.restoreTerminal();
    this.stdin.pause();
    this.resolveExit?.(code);
    if (!this.noProcessExit) setTimeout(() => process.exit(code), 50).unref();
  }

  printWelcome() {
    const cfg = this.config;
    const w = Math.min(this.width - 1, 76);
    const inner = w - 4;
    const row = (s) => c.claude('│') + ' ' + padEnd(truncate(s, inner), inner) + ' ' + c.claude('│');
    const model = cfg.mainModel;
    const lines = [
      c.claude('╭' + '─'.repeat(w - 2) + '╮'),
      row(`${c.claude('✻')} Welcome to ${c.bold(APP_NAME)}! ${c.dim(`v${VERSION} · a Claude Code style agent`)}`),
      row(''),
      row(c.dim('  /help for help, /status for your current setup')),
      row(''),
      row(c.dim(`  cwd:    ${this.cwd}`)),
      row(c.dim(`  model:  ${model.label}${cfg.effort ? ` · effort ${cfg.effort}` : ''} · ${formatTokens(model.contextWindow)} context`)),
      row(c.dim(`  api:    ${cfg.baseURL}`)),
      c.claude('╰' + '─'.repeat(w - 2) + '╯'),
    ];
    lines.push('', c.dim(' Full access: every tool runs immediately, nothing is ever asked. File edits are checkpointed;'), c.dim(' /rewind puts files and/or the conversation back (shell-command changes are not tracked).'));
    if (!cfg.authToken && !cfg.apiKey) {
      lines.push('', c.yellow(' ⚠ No API credentials found. Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in .env, ~/.claude-pro/settings.json or the environment.'));
    }
    const mcp = this.runtime.mcp.status();
    if (mcp.length) {
      const ok = mcp.filter((m) => m.status === 'connected').length;
      lines.push(c.dim(` MCP: ${ok}/${mcp.length} servers connected${ok < mcp.length ? ' · /mcp for details' : ''}`));
    }
    lines.push('', c.dim(' Tips for getting started:'), c.dim(' 1. Ask questions, edit files, or run commands'), c.dim(' 2. Be as specific as you would with another engineer for the best results'), c.dim(` 3. Run /init to create a CLAUDE.md file with instructions for ${APP_NAME}`), '');
    this.screen.log(lines);
  }

  // ---------------------------------------------------------------- input

  onKey(str, key) {
    if (this.exiting) return;
    if (key.ctrl && key.name === 'c') { this.onCtrlC(); return; }
    const dialog = this.dialogs[0];
    if (dialog) {
      dialog.handleKey(str, key);
      this.screen.schedule();
      return;
    }
    if (key.name === 'tab' && key.shift) { this.runtime.modes.toggle(); this.screen.schedule(); return; }
    // alt+v like Claude Code on Windows (ctrl+v is the terminal's own text paste there).
    if ((key.meta || key.ctrl) && key.name === 'v') { this.pasteImage(); return; }
    if (key.ctrl && key.name === 'o') {
      this.verbose = !this.verbose;
      this.notice(this.verbose ? 'Verbose mode on: showing thinking and full tool output' : 'Verbose mode off', 'info');
      return;
    }
    if (key.ctrl && key.name === 't') { this.showTodos = !this.showTodos; this.screen.schedule(); return; }
    if (key.ctrl && key.name === 'l') { this.screen.clearScreen(); return; }
    if (key.ctrl && key.name === 'd' && !this.editor.text) { this.exit(0); return; }
    if (key.name === 'escape' && this.busy) { this.interrupt(); return; }
    this.exitArmed = 0;
    this.editor.handleKey(str, key);
    this.screen.schedule();
  }

  onCtrlC() {
    if (this.dialogs.length) {
      // Cancel the dialog and interrupt the run.
      for (const d of this.dialogs.splice(0)) d.resolve(d.cancelValue);
      this.interrupt();
      return;
    }
    if (this.busy) { this.interrupt(); return; }
    if (this.editor.text) { this.editor.clear(); this.screen.schedule(); return; }
    if (Date.now() - this.exitArmed < 1500) { this.exit(0); return; }
    this.exitArmed = Date.now();
    this.screen.schedule();
    setTimeout(() => this.screen.schedule(), 1600);
  }

  interrupt() {
    if (!this.controller || this.controller.signal.aborted) return;
    this.controller.abort();
    this.screen.schedule();
  }

  suggest(text, cursor) {
    if (text.startsWith('/') && !/\s/.test(text) && cursor === text.length) {
      const q = text.slice(1).toLowerCase();
      const all = [...this.commands.values()].filter((cmd) => !cmd.hidden);
      const pref = all.filter((cmd) => cmd.name.startsWith(q) || cmd.aliases?.some((a) => a.startsWith(q)));
      const incl = q ? all.filter((cmd) => !pref.includes(cmd) && cmd.name.includes(q)) : [];
      const items = [...pref, ...incl].map((cmd) => ({
        value: '/' + cmd.name,
        label: '/' + cmd.name + (cmd.argHint ? ' ' + cmd.argHint : ''),
        description: cmd.description,
        submitOnEnter: !cmd.argRequired,
      }));
      if (items.length === 1 && items[0].value === text && !items[0].submitOnEnter) return null;
      return { items, from: 0, to: text.length };
    }
    const before = text.slice(0, cursor);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (m) {
      const q = m[2];
      const files = this.fileIndex.search(q);
      if (!files.length) return null;
      return { items: files.map((f) => ({ value: '@' + f, label: f, noSpace: f.endsWith('/') })), from: cursor - q.length - 1, to: cursor };
    }
    return null;
  }

  onSubmit(value, raw, images = []) {
    const text = value.trim();
    if (!text) { this.screen.schedule(); return; }
    appendHistory(this.cwd, raw);
    if (this.busy) {
      if (text.startsWith('/')) { this.notice('Wait for the current task to finish (or press Esc) before running commands.', 'warn'); return; }
      this.queue.push({ text: value, images });
      this.screen.schedule();
      return;
    }
    if (images.length) { this.startTurn(value, { images }); return; }
    if (text === '?') { this.screen.log(this.shortcutsHelp()); return; }
    if (raw.startsWith('!')) { this.runBashMode(value.slice(1).trim()); return; }
    if (raw.startsWith('#')) { this.addMemory(value.slice(1).trim()); return; }
    if (text.startsWith('/')) {
      const [name, ...rest] = text.slice(1).split(/\s+/);
      const args = text.slice(1 + name.length).trim();
      const cmd = this.commands.get(name.toLowerCase()) || [...this.commands.values()].find((x) => x.aliases?.includes(name.toLowerCase()));
      if (cmd) {
        this.screen.log(renderUserMessage(text, this.width));
        Promise.resolve(cmd.run(args, rest)).catch((e) => this.logError(e)).finally(() => this.screen.schedule());
        return;
      }
      if (!/^\/[\w:-]+$/.test(text.split(/\s/)[0])) { this.startTurn(value); return; } // e.g. a path like /usr/bin
      this.notice(`Unknown command: /${name}. Type /help for the list of commands.`, 'warn');
      return;
    }
    this.startTurn(value);
  }

  shortcutsHelp() {
    const rows = [
      ['! for bash mode', 'double tap esc to clear input'],
      ['/ for commands', 'shift + tab to cycle permission modes'],
      ['@ for file paths', 'ctrl + o to toggle verbose output'],
      ['# to memorize', 'ctrl + t to toggle todos'],
      ['\\⏎ or alt+⏎ for newline', 'ctrl + l to redraw, ctrl + d to exit'],
      ['alt + v to paste an image', ''],
    ];
    return rows.map(([a, b]) => c.dim('  ' + padEnd(a, 30) + b));
  }

  // ---------------------------------------------------------------- turns

  // Expand @file mentions into attached file contents, like Claude Code.
  attachments(text) {
    const blocks = [];
    const seen = new Set();
    for (const m of text.matchAll(/(?:^|\s)@("[^"]+"|[^\s"]+)/g)) {
      const ref = m[1].replace(/^"|"$/g, '').replace(/[,.;:!?)]+$/, '');
      const file = resolvePath(ref, this.agent.cwd);
      if (seen.has(file)) continue;
      seen.add(file);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.isDirectory()) {
        const entries = fs.readdirSync(file, { withFileTypes: true }).slice(0, 200).map((e) => (e.isDirectory() ? e.name + '/' : e.name));
        blocks.push({ type: 'text', text: `<system-reminder>Called the Bash tool with the following input: {"command":"ls ${file}"}\nResult:\n${entries.join('\n')}</system-reminder>` });
        this.screen.log(c.dim(`  ⎿  Listed directory ${displayPath(file, this.cwd)}/`));
      } else if (st.size < 512 * 1024) {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split(/\r?\n/);
        blocks.push({ type: 'text', text: `<system-reminder>Called the Read tool with the following input: {"file_path":"${file.replace(/\\/g, '\\\\')}"}\nResult of calling the Read tool:\n${numberLines(lines.slice(0, 2000), 1)}</system-reminder>` });
        this.agent.fileState.set(file, { mtimeMs: st.mtimeMs });
        this.screen.log(c.dim(`  ⎿  Read ${displayPath(file, this.cwd)} (${lines.length} lines)`));
      }
    }
    return blocks;
  }

  async startTurn(prompt, { echo = true, display, images = [] } = {}) {
    if (echo) this.screen.log(renderUserMessage(display ?? prompt, this.width));
    const content = [{ type: 'text', text: prompt }, ...images.map(imageBlock), ...this.attachments(prompt)];
    await this.runAgent(content);
  }

  // alt+v (ctrl+v where the terminal passes it through): attach an image from the clipboard.
  async pasteImage() {
    if (this.readingClipboard) return;
    this.readingClipboard = true;
    this.flash('Reading image from clipboard…');
    try {
      const r = await readClipboardImage();
      if (r.image) {
        const label = this.editor.insertImage(r.image);
        const size = r.image.width ? `${r.image.width}×${r.image.height}, ` : '';
        this.flash(`${label} attached (${size}${formatTokens(r.image.bytes).replace(/k$/, 'KB')})`);
      } else {
        this.flash(r.error || 'No image found in clipboard. Copy an image (e.g. Win+Shift+S) and press alt+v again.', 'warn');
      }
    } catch (e) {
      this.flash(`Could not read the clipboard: ${e.message}`, 'warn');
    } finally {
      this.readingClipboard = false;
      this.screen.schedule();
    }
  }

  // A short-lived message in the footer (not written to the transcript).
  flash(text, kind = 'info') {
    this.flashMessage = { text, kind, until: Date.now() + 4000 };
    this.screen.schedule();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.screen.schedule(), 4100);
  }

  async runAgent(content) {
    this.busy = true;
    this.controller = new AbortController();
    this.turnStart = Date.now();
    this.turnTokens = 0;
    this.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    this.screen.schedule();
    try {
      const result = await this.agent.run(content, { signal: this.controller.signal });
      if (result.interrupted) {
        this.flushStreaming();
        this.flushActive(true);
        this.screen.log(resultLines([c.red('Interrupted by user')]), '');
      }
    } catch (e) {
      this.flushStreaming();
      this.logError(e);
    } finally {
      this.flushStreaming();
      this.flushActive(true);
      this.busy = false;
      this.controller = null;
      this.status = null;
      this.screen.schedule();
    }
    if (this.queue.length && !this.exiting) {
      const next = this.queue.splice(0);
      this.startTurn(next.map((q) => q.text).join('\n\n'), { images: next.flatMap((q) => q.images) });
    } else if (this.agent.notifications.length && !this.exiting) {
      // A background agent finished after the turn's last check: report it now.
      this.runAgent(this.agent.drainNotifications());
    }
  }

  // A background agent ended. If nothing is running, start a turn so the model sees its
  // report right away; otherwise the running turn picks it up at its next step.
  backgroundTaskDone(task) {
    const secs = Math.round((task.ended - task.started) / 1000);
    const color = task.status === 'completed' ? c.green : c.red;
    this.screen.log(`${color(DOT)} ${c.bold('Background agent')} ${task.id} ${c.dim(`"${task.description}"`)} ${task.status} ${c.dim(`(${formatDuration(secs * 1000)})`)}`, '');
    if (!this.busy && !this.exiting && this.agent.notifications.length) this.runAgent(this.agent.drainNotifications());
    else this.screen.schedule();
  }

  async runBashMode(command) {
    if (!command) return;
    this.screen.log(c.magenta('! ') + command);
    const tool = this.runtime.tools.find((t) => t.name === 'Bash');
    this.busy = true;
    this.controller = new AbortController();
    this.status = 'Running';
    this.turnStart = Date.now();
    this.turnTokens = 0;
    const ctx = this.agent.makeCtx(this.controller.signal);
    const entry = { tool, input: { command }, status: 'running', progress: '', sub: [], subCount: 0, ctx, started: Date.now() };
    this.active.push(entry);
    let result;
    try {
      ctx.onProgress = (p) => { entry.progress = p; };
      result = await tool.call({ command }, ctx);
    } catch {
      const partial = (entry.progress || '').replace(/\r\n/g, '\n').trimEnd();
      result = { isError: true, content: `${partial ? partial + '\n' : ''}Interrupted by user`, interrupted: true };
    }
    this.active = this.active.filter((e) => e !== entry);
    const out = typeof result.content === 'string' ? result.content : '';
    let lines = out.split('\n');
    if (lines.length > 40) lines = [...lines.slice(0, 20), c.dim(`… +${lines.length - 40} lines`), ...lines.slice(-20)];
    this.screen.log(resultLines(lines.map((l) => (result.isError && l === lines[lines.length - 1] ? c.red(l) : c.dim(l)))), '');
    this.agent.pushMessage({
      role: 'user',
      content: [{ type: 'text', text: `<bash-input>${command}</bash-input>\n<bash-stdout>${out}</bash-stdout>\n<system-reminder>The user ran this command directly in bash mode. Take its output into account in later answers.</system-reminder>` }],
    });
    this.busy = false;
    this.controller = null;
    this.status = null;
    this.screen.schedule();
  }

  addMemory(text) {
    if (!text) return;
    const files = {
      project: path.join(this.cwd, 'CLAUDE.md'),
      local: path.join(this.cwd, 'CLAUDE.local.md'),
      user: path.join(CONFIG_DIR, 'CLAUDE.md'),
    };
    this.showDialog(new SelectDialog({
      title: 'Save memory',
      body: [c.dim(truncate(text, this.width - 10))],
      question: 'Where should this memory be saved?',
      color: c.blue,
      options: [
        { label: `Project memory  ${c.dim(displayPath(files.project, this.cwd))}`, value: 'project', description: 'Checked in and shared with your team' },
        { label: `Project memory (local)  ${c.dim(displayPath(files.local, this.cwd))}`, value: 'local', description: 'Just for you in this project' },
        { label: `User memory  ${c.dim(displayPath(files.user, this.cwd))}`, value: 'user', description: 'Your instructions for all projects' },
      ],
    })).then((choice) => {
      if (!choice) return;
      const file = files[choice];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let existing = '';
      try { existing = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
      fs.appendFileSync(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}- ${text}\n`);
      this.runtime.invalidateSystemPrompt();
      this.screen.log(resultLines([c.dim(`Saved to ${displayPath(file, this.cwd)}`)]));
    });
  }

  loadSession(file, id) {
    const loaded = SessionStore.load(file);
    this.store = new SessionStore(this.cwd, id);
    this.agent.messages = loaded.messages;
    this.agent.lastContextTokens = estimateTokens(loaded.messages);
    this.screen.log(c.dim(`Resumed session ${id} (${loaded.messages.length} messages)`), '');
    this.printTranscript(loaded.messages.slice(-30));
  }

  printTranscript(messages) {
    const toolMap = new Map(this.runtime.tools.map((t) => [t.name, t]));
    const ctx = this.agent.makeCtx();
    for (const m of messages) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      for (const b of blocks) {
        if (m.role === 'user' && b.type === 'text' && !b.text.startsWith('<system-reminder>')) this.screen.log(renderUserMessage(b.text.slice(0, 2000), this.width));
        if (m.role === 'assistant' && b.type === 'text') this.screen.log(renderMarkdown(b.text, { width: this.width - 1, firstPrefix: `${DOT} `, indent: '  ' }), '');
        if (m.role === 'assistant' && b.type === 'tool_use') {
          const tool = toolMap.get(b.name) || { name: b.name };
          this.screen.log(toolHeader(tool, b.input, ctx, { width: this.width }));
        }
      }
    }
    this.screen.log('');
  }

  newSession() {
    this.store = new SessionStore(this.cwd);
  }

  // ---------------------------------------------------------------- dialogs

  showDialog(dialog) {
    return new Promise((resolve) => {
      const prev = dialog.onResolve;
      dialog.onResolve = (v) => {
        this.dialogs = this.dialogs.filter((d) => d !== dialog);
        prev?.(v);
        resolve(v);
        this.screen.schedule();
      };
      this.dialogs.push(dialog);
      this.screen.schedule();
    });
  }

  async approvePlan(plan) {
    this.flushStreaming();
    const md = renderMarkdown(plan, { width: this.width - 8 });
    const max = Math.max(8, this.screen.height - 14);
    const body = md.length > max ? [...md.slice(0, max), c.dim(`… +${md.length - max} lines (the full plan is printed above)`)] : md;
    if (md.length > max) this.screen.log(c.plan(`${DOT} Plan:`), ...md.map((l) => '  ' + l), '');
    const choice = await this.showDialog(new SelectDialog({
      title: 'Ready to code?',
      body: ["Here is the plan:", '', ...body],
      question: 'Would you like to proceed?',
      color: c.plan,
      cancelValue: 'reject',
      options: [
        { label: 'Yes, start coding', value: 'full' },
        { label: 'No, keep planning', value: 'reject' },
      ],
    }));
    return choice;
  }

  async askQuestion(q) {
    const answer = await this.showDialog(new SelectDialog({
      title: q.header || 'Question',
      question: c.bold(q.question),
      color: c.blue,
      multi: !!q.multiSelect,
      otherOption: true,
      options: (q.options || []).map((o) => ({ label: o.label, value: o.label, description: o.description })),
    }));
    if (answer === null || answer === undefined) return null;
    return Array.isArray(answer) ? answer.join(', ') : answer;
  }

  // ---------------------------------------------------------------- agent IO

  isMain(agent) { return !agent || agent === this.runtime?.agent; }

  streamEvent(ev, agent) {
    if (!this.isMain(agent)) return;
    const w = this.width - 1;
    switch (ev.type) {
      case 'block_start':
        if (ev.block.type === 'text') {
          this.flushThinking();
          this.md = new MarkdownStream({ width: w, firstPrefix: `${DOT} `, indent: '  ' });
        } else if (ev.block.type === 'thinking') {
          this.thinking = { start: Date.now(), text: '', md: this.verbose ? new MarkdownStream({ width: w, firstPrefix: c.dim('✻ '), indent: '  ', style: (s) => c.dim(c.italic(s)) }) : null };
        } else if (ev.block.type === 'tool_use') {
          this.flushThinking();
          this.pendingToolBlocks.set(ev.index, { name: ev.block.name, partial: '' });
        }
        break;
      case 'text':
        this.turnTokens += estimateTokens(ev.text);
        if (this.md) {
          const lines = this.md.write(ev.text);
          if (lines.length) this.screen.log(lines);
        }
        break;
      case 'thinking':
        this.turnTokens += estimateTokens(ev.text);
        if (this.thinking) {
          this.thinking.text += ev.text;
          if (this.thinking.md) {
            const lines = this.thinking.md.write(ev.text);
            if (lines.length) this.screen.log(lines);
          }
        }
        break;
      case 'tool_input': {
        this.turnTokens += 1;
        const p = this.pendingToolBlocks.get(ev.index);
        if (p) p.partial = ev.partial;
        break;
      }
      case 'block_stop':
        if (ev.block.type === 'text' && this.md) {
          const lines = this.md.end();
          if (lines.length) this.screen.log(lines);
          this.screen.log('');
          this.md = null;
        } else if (ev.block.type === 'thinking') {
          this.flushThinking();
        } else if (ev.block.type === 'tool_use') {
          this.pendingToolBlocks.delete(ev.index);
        }
        break;
      case 'retry':
        this.notice(`API error: ${truncate(ev.error.message, 200)} · retrying in ${Math.round(ev.delayMs / 1000)}s (attempt ${ev.attempt}/${ev.maxRetries})`, 'warn');
        break;
      case 'reset':
        this.md = null;
        this.thinking = null;
        this.pendingToolBlocks.clear();
        break;
      default:
        break;
    }
    this.screen.schedule();
  }

  flushThinking() {
    const t = this.thinking;
    if (!t) return;
    this.thinking = null;
    if (t.md) {
      const lines = t.md.end();
      if (lines.length) this.screen.log(lines);
      this.screen.log('');
    } else if (t.text.trim()) {
      const secs = Math.max(1, Math.round((Date.now() - t.start) / 1000));
      this.screen.log(c.dim(c.italic(`✻ Thought for ${secs}s (ctrl+o to show thinking)`)), '');
    }
  }

  flushStreaming() {
    this.flushThinking();
    if (this.md) {
      const lines = this.md.end();
      if (lines.length) this.screen.log(lines, '');
      this.md = null;
    }
    this.pendingToolBlocks.clear();
  }

  toolBatchStart() {
    this.flushStreaming();
  }

  toolStart(tu, tool, input, agent) {
    if (!this.isMain(agent)) return {};
    const entry = { tu, tool, input, status: 'running', progress: '', sub: [], subCount: 0, ctx: agent.makeCtx(), started: Date.now() };
    this.active.push(entry);
    this.screen.schedule();
    return {
      progress: (p) => {
        if (typeof p === 'string') entry.progress = p;
        else if (p?.type === 'subtool') { entry.sub.push(p.header); entry.subCount++; }
        this.screen.schedule();
      },
      done: (result) => {
        entry.result = result;
        entry.status = result.isError ? 'error' : 'done';
        this.flushActive();
      },
    };
  }

  toolRejected(tu, tool, message, agent) {
    if (!this.isMain(agent)) return;
    const ctx = agent.makeCtx();
    const entry = { tu, tool, input: tu.input, status: 'rejected', rejected: true, rejectMessage: message, ctx };
    this.screen.log(toolHeader(tool, tu.input, ctx, { status: 'rejected', width: this.width }), renderToolResult(entry, { width: this.width, cwd: this.cwd }), '');
  }

  // Move finished tool entries (in call order) from the live region to the transcript.
  flushActive(all = false) {
    while (this.active.length && (all || this.active[0].status !== 'running')) {
      const e = this.active.shift();
      if (e.status === 'running') { e.status = 'error'; e.result = { isError: true, content: 'Interrupted', interrupted: true }; }
      const status = e.result?.isError ? 'error' : 'done';
      this.screen.log(toolHeader(e.tool, e.input, e.ctx, { status, width: this.width }), renderToolResult(e, { verbose: this.verbose, width: this.width, cwd: this.cwd }), '');
    }
    this.screen.schedule();
  }

  // IO object for a sub-agent: reports its tool calls into the parent's Task entry.
  subagentIo({ def, parentCtx }) {
    const app = this;
    return {
      approvePlan: async () => 'reject',
      askQuestion: async () => null,
      notice: (text, kind) => app.notice(`[${def.name}] ${text}`, kind),
      toolStart(tu, tool, input, agent) {
        parentCtx.onProgress?.({ type: 'subtool', header: toolHeader(tool, input, agent.makeCtx(), { status: 'done', width: app.width - 8, dot: false }) });
        return {};
      },
      streamEvent(ev) {
        if (ev.type === 'text' || ev.type === 'thinking') app.turnTokens += estimateTokens(ev.text);
        if (ev.type === 'retry') app.notice(`[${def.name}] API error, retrying: ${truncate(ev.error.message, 120)}`, 'warn');
      },
      takeQueued: () => [],
    };
  }

  takeQueued() {
    if (!this.queue.length) return [];
    const items = this.queue.splice(0);
    for (const q of items) this.screen.log(renderUserMessage(q.text, this.width));
    // Content blocks for the agent: each queued message's text followed by its images.
    return items.flatMap((q) => [{ type: 'text', text: q.text }, ...q.images.map(imageBlock)]);
  }

  messageAdded(msg, agent) { if (this.isMain(agent)) this.store.message(msg); }
  messagesReplaced(msgs, agent) { if (this.isMain(agent)) this.store.reset(msgs); }
  usage() { this.screen.schedule(); }

  compactStart(auto, agent) {
    if (!this.isMain(agent)) return;
    this.flushStreaming();
    this.status = auto ? 'Auto-compacting conversation' : 'Compacting conversation';
    this.compactTokens = 0;
    this.screen.schedule();
  }

  compactProgress(ev) {
    if (ev.type === 'text' || ev.type === 'thinking') { this.turnTokens += estimateTokens(ev.text); this.screen.schedule(); }
  }

  compactEnd(summary, agent, err) {
    if (!this.isMain(agent)) return;
    this.status = null;
    if (err) return;
    this.lastSummary = summary;
    this.screen.log(c.dim('✻ Conversation compacted (the summary is in context; /context to see usage)'), '');
  }

  notice(text, kind = 'info') {
    const color = kind === 'warn' ? c.yellow : kind === 'error' ? c.red : c.dim;
    this.screen.log(color(`  ${text}`));
  }

  logError(e) {
    const msg = e?.message || String(e);
    this.screen.log(c.red(`${DOT} API Error: ${msg}`), '');
    if (process.env.CLAUDE_PRO_DEBUG && e?.stack) this.screen.log(c.dim(e.stack));
  }

  // ---------------------------------------------------------------- live region

  spinnerLine() {
    const frame = SPINNER[Math.floor(Date.now() / 120) % SPINNER.length];
    const secs = formatDuration(Date.now() - this.turnStart);
    const verb = this.status || (this.thinking ? 'Thinking' : this.verb);
    const aborted = this.controller?.signal.aborted;
    const parts = [secs];
    if (this.turnTokens) parts.push(`↓ ${formatTokens(this.turnTokens)} tokens`);
    parts.push(aborted ? 'interrupting…' : 'esc to interrupt');
    return c.claude(`${frame} ${verb}…`) + ' ' + c.dim(`(${parts.join(' · ')})`);
  }

  renderActiveEntry(e, w) {
    const lines = [toolHeader(e.tool, e.input, e.ctx, { status: 'running', width: w })];
    if (e.tool.name === 'Task' || e.sub.length) {
      const shown = e.sub.slice(-3);
      const more = e.subCount - shown.length;
      const sub = shown.map((h) => c.dim(truncate(h, w - 8)));
      if (more > 0) sub.push(c.dim(`+${more} more tool use${more === 1 ? '' : 's'}`));
      if (!sub.length) sub.push(c.dim('Initializing…'));
      lines.push(...resultLines(sub));
    } else if (e.progress) {
      const out = e.progress.replace(/\r\n/g, '\n').trimEnd().split('\n');
      const tail = out.slice(-5).map((l) => c.dim(truncate(l.replace(/\r/g, ''), w - 8)));
      if (out.length > 5) tail.unshift(c.dim(`… +${out.length - 5} lines`));
      lines.push(...resultLines(tail));
    } else {
      const secs = Math.floor((Date.now() - e.started) / 1000);
      if (secs >= 2) lines.push(...resultLines([c.dim(`Running… (${secs}s)`)]));
    }
    return lines;
  }

  renderLive(width) {
    const w = width - 1;
    const lines = [];
    let cursor = null;
    if (this.busy) {
      // In-progress assistant text.
      if (this.md) {
        const partial = this.md.partial();
        lines.push(...partial.slice(-Math.floor(this.screen.height / 2)));
      }
      if (this.thinking?.md) lines.push(...this.thinking.md.partial().slice(-3));
      else if (this.thinking && this.thinking.text) {
        const last = this.thinking.text.trimEnd().split('\n').pop() || '';
        lines.push(c.dim(c.italic(truncate(`✻ ${last}`, w))));
      }
      for (const [, p] of this.pendingToolBlocks) {
        const m = /"(?:file_path|command|pattern|url|description|query)"\s*:\s*"((?:\\.|[^"\\])*)/.exec(p.partial);
        const tool = this.runtime.tools.find((t) => t.name === p.name) || { name: p.name };
        const arg = m ? m[1].replace(/\\n/g, ' ').replace(/\\(.)/g, '$1') : '';
        lines.push(`${c.gray(DOT)} ${c.bold(toolLabel(tool, {}))}${arg ? `(${truncate(arg, w - 20)})` : ''} ${c.dim(p.partial.length > 200 ? `(${formatTokens(Math.round(p.partial.length / 4))} tokens…)` : '…')}`);
      }
      for (const e of this.active) lines.push(...this.renderActiveEntry(e, w));
      if (!this.dialogs.length) {
        if (lines.length) lines.push('');
        lines.push(this.spinnerLine());
        const todos = this.agent.todos;
        if (this.showTodos && todos.length) lines.push(...renderTodos(todos).map((l) => truncate(l, w)));
      }
    } else if (this.active.length) {
      for (const e of this.active) lines.push(...this.renderActiveEntry(e, w));
    }
    if (this.dialogs.length) {
      if (lines.length) lines.push('');
      const r = this.dialogs[0].render(width, this.screen.height - lines.length - 1);
      const top = lines.length;
      lines.push(...r.lines);
      if (r.cursor) cursor = { row: top + r.cursor.row, col: r.cursor.col };
      return { lines, cursor };
    }
    if (this.queue.length) {
      for (const q of this.queue) lines.push(c.dim('  ⎿ queued: ') + c.gray(truncate(q.text.replace(/\s+/g, ' '), w - 14)));
    }
    if (lines.length) lines.push('');
    const placeholder = this.busy ? 'Type a message to queue it for the agent…' : (this.agent.messages.length ? '' : 'Try "explain this codebase" or "fix the failing test"');
    const r = this.editor.render(width, { placeholder });
    const top = lines.length;
    lines.push(...r.lines);
    if (r.cursor) cursor = { row: top + r.cursor.row, col: r.cursor.col };
    if (this.editor.suggestions) lines.push(...this.editor.renderSuggestions(w));
    else if (this.editor.text === '?') lines.push(...this.shortcutsHelp());
    else lines.push(this.footer(w));
    return { lines, cursor };
  }

  footer(w) {
    const mode = this.runtime.modes.mode;
    let left;
    const flash = this.flashMessage && Date.now() < this.flashMessage.until ? this.flashMessage : null;
    if (this.exitArmed && Date.now() - this.exitArmed < 1500) left = c.dim('  Press Ctrl-C again to exit');
    else if (flash) left = (flash.kind === 'warn' ? c.yellow : c.dim)('  ' + truncate(flash.text, w - 4));
    else if (mode === 'plan') left = '  ' + c.plan('⏸ plan mode on (read-only)') + c.dim(' (shift+tab to leave)');
    else if (this.editor.mode === 'bash') left = c.magenta('  ! for bash mode');
    else if (this.editor.mode === 'memory') left = c.blue('  # to memorize');
    else left = c.dim('  ? for shortcuts');
    const cfg = this.config;
    const threshold = cfg.autoCompactThreshold(cfg.mainModel);
    const used = this.agent.contextEstimate;
    let right = '';
    const pctLeft = Math.max(0, Math.round((1 - used / threshold) * 100));
    if (pctLeft <= 30 && cfg.autoCompactEnabled) right = c.yellow(`Context left until auto-compact: ${pctLeft}%`);
    else if (this.runtime.tasks.running().length) right = c.dim(`${this.runtime.tasks.running().length} background agent${this.runtime.tasks.running().length === 1 ? '' : 's'} running · /tasks`);
    else if (this.verbose) right = c.dim('verbose');
    const gap = w - stringWidth(left) - stringWidth(right) - 1;
    return gap > 0 ? left + ' '.repeat(gap) + right : left;
  }
}

export async function runRepl({ flags, cwd, initialPrompt }) {
  const app = new App({ flags, cwd });
  process.on('uncaughtException', (e) => {
    app.restoreTerminal();
    process.stderr.write(`\nUnexpected error: ${e?.stack || e}\n`);
    process.exit(1);
  });
  return await app.start(initialPrompt);
}
