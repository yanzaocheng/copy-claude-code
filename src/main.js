import fs from 'node:fs';
import { VERSION, KNOWN_KEYS, loadConfig, settingsFiles, updateSettingsFile, applyRememberedChoices } from './config.js';
import { SessionStore } from './session.js';
import { takeRestartState } from './restart.js';

const HELP = `Usage: claude-pro [options] [prompt]

A Claude Code style coding agent for APIs or existing local Claude Code OAuth credentials.
Starts an interactive session by default; use -p for non-interactive output.

Options:
  -p, --print                      Print the response and exit (useful for pipes)
  -c, --continue                   Continue the most recent conversation in this directory
  -r, --resume [sessionId]         Resume a conversation (picker if no id given)
  --provider <backend>            api (default) | claude-code (direct HTTP with existing local login)
  --model <model>                  Model for this session (name or alias: opus, sonnet, haiku)
  --effort <level>                 Reasoning effort: none|minimal|low|medium|high|xhigh|max
  --plan                           Start in read-only plan mode (research first, then ExitPlanMode)
  --output-format <format>         text | json | stream-json (with --print)
  --verify <command>               After the agent edits files, run this (e.g. "npm test") and send failures back to fix
  --append-system-prompt <text>    Append text to the system prompt
  --system-prompt <text>           Replace the system prompt
  --verbose                        Show thinking and full tool output
  --no-mcp                         Do not start MCP servers
  --name <name>                    Name this session, as /rename does (other sessions reach it with &name)
  --remote-id <id>                 Go online at the gateway at once with this id (the gateway's web page opens
                                   sessions this way, through claude-pro host)
  -v, --version                    Print version
  -h, --help                       Show help

There are no permission prompts: every tool runs immediately (full access). File edits are
checkpointed per prompt, and /rewind in a session undoes them. The old flags
--dangerously-skip-permissions, --permission-mode, --allowedTools and --disallowedTools
are accepted and ignored (--permission-mode plan is the same as --plan), and so is
--remote-control (--rc): a session is online at the gateway whenever this computer is logged in to it.

Commands:
  claude-pro config list                  Show effective configuration and where each value comes from
  claude-pro config set <KEY> <VALUE> [--project|--local]   Save a setting (default: ~/.claude-pro/settings.json)
  claude-pro config unset <KEY> [--project|--local]
  claude-pro host [start|stop|status|install|uninstall]   The computer service: lets the gateway's web page
                                          open sessions on this computer (claude-pro host --help)
`;

const REMOTE_ID = /^[A-Za-z0-9_-]{8,64}$/;

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
      case '--provider': flags.provider = next(); break;
      case '--effort': flags.effort = next(); break;
      case '--plan': flags.plan = true; break;
      case '--permission-mode': if (next() === 'plan') flags.plan = true; break;
      case '--dangerously-skip-permissions': break; // nothing to skip: there are no prompts
      case '--allowedTools': case '--allowed-tools': case '--disallowedTools': case '--disallowed-tools': skipRules(); break;
      case '--output-format': flags.outputFormat = next(); break;
      case '--verify': flags.verify = next(); break;
      case '--append-system-prompt': flags.appendSystemPrompt = next(); break;
      case '--system-prompt': flags.systemPrompt = next(); break;
      case '--verbose': flags.verbose = true; break;
      case '--no-mcp': flags.noMcp = true; break;
      case '--remote-control': case '--rc': break; // online by default now
      case '--name': flags.name = next(); break;
      case '--remote-id': {
        const id = next();
        if (!REMOTE_ID.test(id || '')) { process.stderr.write(`--remote-id takes 8 to 64 letters, digits, _ or -, not "${id ?? ''}"\n`); process.exit(2); }
        flags.remoteId = id;
        break;
      }
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

function configCommand(args, cwd) {
  const [sub, key, ...rest] = args;
  const scopeFlag = rest.find((r) => r === '--project' || r === '--local') || (key === '--project' || key === '--local' ? key : null);
  const files = settingsFiles(cwd);
  const file = scopeFlag === '--project' ? files.project : scopeFlag === '--local' ? files.local : files.user;
  if (!sub || sub === 'list' || sub === 'get') {
    const cfg = loadConfig({ cwd });
    const remembered = applyRememberedChoices(cfg);
    const keys = sub === 'get' && key ? [key] : Object.keys(KNOWN_KEYS);
    for (const k of keys) {
      const v = cfg.display(k);
      if (v === undefined && sub !== 'get') continue;
      console.log(`${k}=${v ?? ''}${cfg.sources[k] ? `    # ${cfg.sources[k]}` : ''}`);
    }
    if (sub !== 'get') {
      console.log(`\nprovider: ${cfg.provider} (${cfg.endpointLabel})`);
      console.log(`main model: ${cfg.mainModel.label} (context ${cfg.mainModel.contextWindow.toLocaleString()})${cfg.effort ? `, effort ${cfg.effort}` : ''}`);
      if (remembered.model || remembered.effort) {
        const what = Object.entries(remembered).map(([k, v]) => `${k} ${v}`).join(', ');
        console.log(`chosen with /model, /effort: ${what} (kept in ${files.user}; wins over the settings above, --model/--effort win over it)`);
      }
      console.log(`sub-agent model: ${cfg.subagentModelChosen ? `chosen per task (not chosen: ${cfg.subagentModel.label})` : cfg.subagentModel.label}; small model: ${cfg.smallModel.label}`);
      console.log(`auto-compact at ${cfg.autoCompactThreshold().toLocaleString()} tokens (window ${cfg.compactWindow().toLocaleString()})`);
    }
    return 0;
  }
  if (sub === 'set') {
    const value = rest.filter((r) => r !== '--project' && r !== '--local').join(' ');
    if (!key || !value) { console.error('Usage: claude-pro config set <KEY> <VALUE> [--project|--local]'); return 2; }
    if (!KNOWN_KEYS[key]) console.error(`note: ${key} is not a known key; saving anyway`);
    updateSettingsFile(file, (json) => { json.env = { ...(json.env || {}), [key]: value }; });
    console.log(`Set ${key} in ${file}`);
    return 0;
  }
  if (sub === 'unset') {
    updateSettingsFile(file, (json) => { if (json.env) delete json.env[key]; });
    console.log(`Removed ${key} from ${file}`);
    return 0;
  }
  console.error(`Unknown config command: ${sub}`);
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

export async function main(argv) {
  let cwd = process.cwd();
  if (argv[0] === 'config') return configCommand(argv.slice(1), cwd);
  if (argv[0] === 'host') return (await import('./host.js')).hostCommand(argv.slice(1));
  if (argv[0] === '--self-check') return (await import('./selfcheck.js')).selfCheck(); // see restart.js
  const { flags, positional } = parseArgs(argv);
  if (flags.version) { console.log(`${VERSION} (claude-pro)`); return 0; }
  if (flags.help) { process.stdout.write(HELP); return 0; }

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
    }
    flags.resumeFile = found.file;
    flags.resumeId = found.id;
  }

  // mintty (Git Bash's default window) connects programs through pipes, not a console.
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
