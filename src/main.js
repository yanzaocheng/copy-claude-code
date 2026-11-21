import fs from 'node:fs';
import { VERSION, loadConfig, settingsFiles, configKey, configEntries, writeConfigSetting, unsetConfigSetting, applyRememberedChoices } from './config.js';
import { loadGatewayModels } from './gateway.js';
import { resolvePath } from './utils/paths.js';
import { SessionStore } from './session.js';
import { takeRestartState } from './restart.js';

const HELP = `Usage: claude-pro [options] [prompt]

A command line coding agent for many model providers: /connect connects them (Anthropic, OpenAI, DeepSeek,
Kimi, GLM, Qwen, OpenRouter, the 7bit.fun gateway, your own endpoint...), several at once.
Starts an interactive session by default; use -p for non-interactive output.

Options:
  -p, --print                      Print the response and exit (useful for pipes)
  -c, --continue                   Continue the most recent conversation in this directory
  -r, --resume [sessionId]         Resume a conversation (picker if no id given)
  --model <model>                  Model for this session: provider/model (deepseek/deepseek-v4-pro), or opus, sonnet, haiku
  --effort <level>                 Reasoning effort: none|minimal|low|medium|high|xhigh|max
  --output-format <format>         text | json | stream-json (with --print)
  --verify <command>               After the agent edits files, run this (e.g. "npm test") and send failures back to fix
  --append-system-prompt <text>    Append text to the system prompt
  --system-prompt <text>           Replace the system prompt
  --system-prompt-file <file>      Replace the system prompt with the contents of a file
  --verbose                        Show detailed tool output
  --no-mcp                         Do not start MCP servers
  --name <name>                    Name this session, as /rename does (other sessions reach it with @name)
  -v, --version                    Print version
  -h, --help                       Show help

There are no permission prompts: every tool runs immediately (full access). File edits are
checkpointed per prompt, and /rewind in a session undoes them. The old flags
--dangerously-skip-permissions, --permission-mode, --allowedTools and --disallowedTools
are accepted and ignored, and so are --plan (there is no plan mode: ask for a plan in the message) and --rc
(the gateway's remote control page is gone: claude-pro web is the console).

Commands:
  claude-pro web [--no-open]              Open the web console (settings, providers, every conversation, live sessions)
  claude-pro config list [--advanced]     Show ordinary settings (add --advanced for optional controls)
  claude-pro config set <KEY> <VALUE> [--project|--local]   Save a setting (default: ~/.claude-pro/settings.json)
  claude-pro config unset <KEY> [--project|--local]

In a session, /connect connects a model provider with its API key, /model picks a model of any connected one,
/disconnect forgets one.
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    // Old permission flags take a list of rules (Tool, Tool(content), "A B(c)"); skip over them.
    const RULES = /^\s*[\w-]+(\([^)]*\))?(\s*[,\s]\s*[\w-]+(\([^)]*\))?)*\s*$/;
    const skipRules = () => {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-') && RULES.test(argv[i + 1])) i++;
    };
    switch (a) {
      case '-p': case '--print': flags.print = true; break;
      case '-c': case '--continue': flags.continue = true; break;
      case '-r': case '--resume':
        flags.resume = true;
        if (argv[i + 1] && !argv[i + 1].startsWith('-') && /^[0-9a-f-]{8,}$/i.test(argv[i + 1])) flags.resumeId = next();
        break;
      case '--model': flags.model = next(); break;
      case '--effort': flags.effort = next(); break;
      case '--plan': break; // no plan mode any more: asking for a plan in the message does it
      case '--permission-mode': next(); break;
      case '--dangerously-skip-permissions': break; // nothing to skip: there are no prompts
      case '--allowedTools': case '--allowed-tools': case '--disallowedTools': case '--disallowed-tools': skipRules(); break;
      case '--output-format': flags.outputFormat = next(); break;
      case '--verify': flags.verify = next(); break;
      case '--append-system-prompt': flags.appendSystemPrompt = next(); break;
      case '--system-prompt': flags.systemPrompt = next(); break;
      case '--system-prompt-file': flags.systemPromptFile = next(); break;
      case '--verbose': flags.verbose = true; break;
      case '--no-mcp': flags.noMcp = true; break;
      case '--remote-control': case '--rc': break; // remote control (the gateway's page) is gone: accepted and ignored
      case '--name': flags.name = next(); break;
      case '-v': case '--version': flags.version = true; break;
      case '-h': case '--help': flags.help = true; break;
      default:
        if (a.startsWith('--') && a.includes('=')) { argv.splice(i + 1, 0, a.slice(a.indexOf('=') + 1)); argv[i] = a.slice(0, a.indexOf('=')); i--; break; }
        if (a.startsWith('-') && a !== '-') { process.stderr.write(`Unknown option: ${a}\n`); process.exit(2); }
        positional.push(a);
    }
  }
  return { flags, positional };
}

async function configCommand(args, cwd) {
  const [sub = 'list', ...tail] = args;
  const scopeFlag = tail.includes('--project') ? '--project' : tail.includes('--local') ? '--local' : null;
  const advanced = sub === 'advanced' || tail.includes('--advanced');
  const [key, ...rest] = tail.filter((r) => !['--project', '--local', '--advanced'].includes(r));
  const files = settingsFiles(cwd);
  const file = scopeFlag === '--project' ? files.project : scopeFlag === '--local' ? files.local : files.user;
  try {
    if (sub === 'list' || sub === 'advanced' || sub === 'get') {
      const cfg = loadConfig({ cwd });
      const remembered = applyRememberedChoices(cfg);
      if (sub === 'get' && key) {
        const name = configKey(key);
        console.log(`${name}=${cfg.setting(name) ?? ''}${cfg.sources[name] ? `    # ${cfg.sources[name]}` : ''}`);
      } else {
        for (const entry of configEntries(cfg, { advanced })) {
          console.log(`${entry.key}=${entry.value ?? '(default)'}    # ${entry.source}${advanced ? ` · ${entry.description}` : ''}`);
        }
      }
      if (sub !== 'get') {
        await loadGatewayModels(cfg);
        console.log(`\nbackend: ${cfg.endpointLabel}`);
        console.log(`model: ${cfg.model.label} (context ${cfg.model.contextWindow.toLocaleString()})${cfg.effort ? `, effort ${cfg.effort}` : ''}`);
        if (remembered.model || remembered.effort) {
          const what = Object.entries(remembered).map(([k, v]) => `${k} ${v}`).join(', ');
          console.log(`chosen with /model, /effort: ${what} (kept in ${files.user}; wins over the settings above, --model/--effort win over it)`);
        }
        console.log(`auto-compact at ${cfg.compactWindow().toLocaleString()} tokens (the window, less room for the summary)`);
        if (!advanced) console.log('More controls: claude-pro config list --advanced');
      }
      return 0;
    }
    if (sub === 'set') {
      const value = rest.join(' ');
      if (!key || !value) { console.error('Usage: claude-pro config set <KEY> <VALUE> [--project|--local]'); return 2; }
      const name = writeConfigSetting(file, key, value);
      console.log(`Set ${name} in ${file}`);
      return 0;
    }
    if (sub === 'unset') {
      if (!key) { console.error('Usage: claude-pro config unset <KEY> [--project|--local]'); return 2; }
      const name = unsetConfigSetting(file, key);
      console.log(`Removed ${name} from ${file}`);
      return 0;
    }
    console.error(`Unknown config command: ${sub}`);
  } catch (e) { console.error(e.message); }
  return 2;
}

// Read piped stdin. When a prompt was given on the command line, stdin is optional: if
// nothing arrives quickly (e.g. an inherited pipe that never closes) we carry on without it.
function readStdin({ optional }) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks = [];
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    if (optional) timer = setTimeout(done, 300);
    process.stdin.on('data', (d) => { clearTimeout(timer); chunks.push(d); });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

// Commands that are gone. Said so instead of taking them as a prompt: an autostart entry or a script that still
// runs `claude-pro host start` must not turn into an agent run with full access.
const REMOVED_COMMANDS = new Set(['host', 'attach', 'connect']);

export async function main(argv) {
  let cwd = process.cwd();
  if (argv[0] === 'config') return configCommand(argv.slice(1), cwd);
  if (argv[0] === 'web') return (await import('./web/server.js')).webCommand(argv.slice(1));
  if (REMOVED_COMMANDS.has(argv[0])) {
    process.stderr.write(`claude-pro ${argv[0]} was removed (the computer service, attach and connect are no longer part of claude-pro). To send this as a prompt, quote it: claude-pro "${argv.join(' ')}"\n`);
    return 2;
  }
  if (argv[0] === '--self-check') return (await import('./selfcheck.js')).selfCheck(); // see restart.js
  const { flags, positional } = parseArgs(argv);
  if (flags.version) { console.log(`${VERSION} (claude-pro)`); return 0; }
  if (flags.help) { process.stdout.write(HELP); return 0; }

  if (flags.systemPromptFile !== undefined) {
    if (!flags.systemPromptFile || flags.systemPromptFile.startsWith('-')) {
      process.stderr.write('--system-prompt-file requires a file path\n');
      return 2;
    }
    const file = resolvePath(flags.systemPromptFile, cwd);
    try {
      flags.systemPrompt = fs.readFileSync(file, 'utf8');
    } catch (e) {
      process.stderr.write(`Cannot read system prompt file ${file}: ${e.message}\n`);
      return 2;
    }
  }

  let prompt = positional.join(' ');

  // Started by a restart of a running session: that session is picked up again, whatever the command line
  // that started the first one said (-c, --resume, a first prompt).
  const interactive = !(flags.print || !process.stdout.isTTY || !process.stdin.isTTY);
  const restart = interactive ? takeRestartState() : null;
  if (restart) {
    flags.restart = restart;
    flags.continue = false;
    flags.resume = false;
    flags.resumeId = undefined;
    prompt = '';
    // the session's working directory, which /cd may have changed (the supervisor starts every process where the
    // first one started)
    if (typeof restart.cwd === 'string' && restart.cwd !== cwd) {
      try {
        if (fs.statSync(restart.cwd).isDirectory()) { process.chdir(restart.cwd); cwd = process.cwd(); }
      } catch { /* gone meanwhile: where the first one started */ }
    }
  }

  if (flags.continue || (flags.resume && flags.resumeId)) {
    const sessions = SessionStore.list(cwd);
    const found = flags.resumeId ? sessions.find((s) => s.id.startsWith(flags.resumeId)) : sessions[0];
    if (!found) {
      process.stderr.write(flags.resumeId ? `No conversation found with id ${flags.resumeId}\n` : 'No conversation found to continue\n');
      return 1;
    } else {
      flags.resumeFile = found.file;
      flags.resumeId = found.id;
    }
  }

  // mintty (Git Bash's default window) connects programs through pipes, not a console.
  // -r without an id opens the picker of an interactive session; a -p run has none, and went on as a new conversation
  if (flags.resume && !flags.resumeId && (flags.print || !process.stdout.isTTY || !process.stdin.isTTY)) {
    process.stderr.write('Error: -r without a conversation id needs an interactive session to pick one. Give the id (-r <id>), or use -c for the newest conversation.\n');
    return 2;
  }
  if (!flags.print && !process.stdin.isTTY && process.env.TERM_PROGRAM === 'mintty') {
    process.stderr.write('Interactive mode needs a real console. In mintty/Git Bash run `winpty claude-pro` (or `winpty node bin/claude-pro.js`), or use Windows Terminal. For scripts use `claude-pro -p`.\n');
    return 1;
  }
  if (flags.print || !process.stdout.isTTY || !process.stdin.isTTY) {
    const stdin = await readStdin({ optional: !!prompt.trim() });
    if (stdin.trim()) prompt = prompt ? `${stdin.trimEnd()}\n\n${prompt}` : stdin;
    if (!prompt.trim()) { process.stderr.write('Error: no prompt given. Usage: claude-pro -p "your prompt"\n'); return 2; }
    const { runPrint } = await import('./print.js');
    return await runPrint({ prompt, flags, cwd });
  }
  if (!fs.existsSync(cwd)) return 1;
  const { runRepl } = await import('./ui/repl.js');
  return await runRepl({ flags, cwd, initialPrompt: prompt });
}
