// Non-interactive mode: `ccc -p "prompt"`. Prints only the final answer to stdout
// (or JSON), tool activity goes to stderr with --verbose.

import { createRuntime } from './runtime.js';
import { SessionStore } from './session.js';
import { c } from './ui/ansi.js';

export async function runPrint({ prompt, flags, cwd }) {
  const format = flags.outputFormat || 'text';
  const err = (s) => process.stderr.write(s + '\n');
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const io = {
    askPermission: async ({ tool }) => {
      if (flags.verbose) err(c.yellow(`✗ ${tool.name} needs permission (use --allowedTools, --permission-mode acceptEdits or --dangerously-skip-permissions)`));
      return { behavior: 'deny', message: `Permission to use ${tool.name} was denied: this is a non-interactive session and the tool is not in the allowed list. Continue without it if possible.` };
    },
    approvePlan: async () => 'reject',
    askQuestion: async () => null,
    notice: (text) => err(c.yellow(text)),
    toolStart: (tu, tool, input, agent) => {
      if (flags.verbose) err(c.gray(`⏺ ${tool.name}(${tool.summarize?.(input, agent.makeCtx()) ?? ''})`));
      return {};
    },
    assistantMessage: (msg) => { if (format === 'stream-json') emit({ type: 'assistant', message: msg }); },
    messageAdded: (msg) => { store.message(msg); if (format === 'stream-json' && msg.role === 'user') emit({ type: 'user', message: msg }); },
    messagesReplaced: (msgs) => store.reset(msgs),
    compactStart: (auto) => { if (flags.verbose) err(c.gray(`✻ ${auto ? 'Auto-compacting' : 'Compacting'} conversation…`)); },
    streamEvent: (ev) => { if (ev.type === 'retry' && flags.verbose) err(c.yellow(`API error (${ev.error.message}), retrying in ${Math.round(ev.delayMs / 1000)}s…`)); },
  };
  const runtime = await createRuntime({ cwd, flags, io });
  let store = new SessionStore(cwd);
  if (flags.resumeFile) {
    const loaded = SessionStore.load(flags.resumeFile);
    runtime.agent.messages = loaded.messages;
    store = new SessionStore(cwd, flags.resumeId);
  }
  const ctrl = new AbortController();
  process.on('SIGINT', () => ctrl.abort());
  const started = Date.now();
  let result;
  try {
    result = await runtime.agent.run(prompt, { signal: ctrl.signal });
  } catch (e) {
    if (format === 'json') emit({ type: 'result', is_error: true, error: e.message });
    else err(c.red(`Error: ${e.message}`));
    runtime.mcp.close();
    return 1;
  }
  const a = runtime.agent;
  if (format === 'json' || format === 'stream-json') {
    emit({
      type: 'result',
      is_error: false,
      result: result.text,
      session_id: store.id,
      duration_ms: Date.now() - started,
      num_turns: a.usage.requests,
      usage: { input_tokens: a.usage.input, output_tokens: a.usage.output, cache_read_input_tokens: a.usage.cacheRead },
    });
  } else {
    process.stdout.write(result.text + '\n');
  }
  runtime.mcp.close();
  return result.interrupted ? 130 : 0;
}
