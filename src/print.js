// Non-interactive mode: `claude-pro -p "prompt"`. Prints only the final answer to stdout
// (or JSON), tool activity goes to stderr with --verbose.

import { createRuntime } from './runtime.js';
import { SessionStore } from './session.js';
import { describePause, shouldAnnounce } from './ratelimit.js';
import { c } from './ui/ansi.js';

export async function runPrint({ prompt, flags, cwd, stdout = process.stdout, stderr = process.stderr }) {
  const format = flags.outputFormat || 'text';
  const err = (s) => stderr.write(s + '\n');
  const emit = (obj) => stdout.write(JSON.stringify(obj) + '\n');
  // A pause can last hours: always say so, or the run looks hung. `who` names a sub-agent. A reporter
  // remembers the pause it announced, so the waits that only continue it (polling) are not repeated.
  const rateLimitReporter = (who = '') => {
    let paused = null;
    return (ev) => {
      if (ev.type === 'rate_limit_wait') {
        if (shouldAnnounce(paused, ev)) err(c.yellow(who + describePause(ev)));
        paused = { resumeAt: ev.resumeAt, waitingForLogin: Boolean(ev.waitingForLogin) };
      }
      if (ev.type === 'rate_limit_resume') {
        paused = null;
        err(c.yellow(`${who}The limit has cleared; continuing.`));
      }
    };
  };
  const mainRateLimit = rateLimitReporter();
  const io = {
    approvePlan: async () => 'reject', // non-interactive: a plan is only presented, never executed
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
    streamEvent: (ev) => {
      if (ev.type === 'retry' && flags.verbose) err(c.yellow(`API error (${ev.error.message}), retrying in ${Math.round(ev.delayMs / 1000)}s…`));
      mainRateLimit(ev);
    },
    compactProgress: (ev) => mainRateLimit(ev),
    // Sub-agents have no screen of their own here; their pauses are still reported, whether it is a
    // turn or the compaction of their own conversation that is paused.
    subagentIo: ({ def }) => {
      const report = rateLimitReporter(`[${def.name}] `);
      return { streamEvent: report, compactProgress: report };
    },
  };
  const runtime = await createRuntime({ cwd, flags, io });
  let store = new SessionStore(cwd);
  if (flags.resumeFile) {
    const loaded = SessionStore.load(flags.resumeFile);
    runtime.agent.messages = loaded.messages;
    runtime.agent.restoreFileState(loaded.messages, loaded.times);
    store = new SessionStore(cwd, flags.resumeId);
  }
  const ctrl = new AbortController();
  const onSigint = () => ctrl.abort();
  process.on('SIGINT', onSigint);
  const started = Date.now();
  let result;
  try {
    result = await runtime.agent.run(prompt, { signal: ctrl.signal });
    // Background agents report back before we exit, so their work is part of the answer.
    while (!result.interrupted && !ctrl.signal.aborted && (runtime.tasks.running().length || runtime.agent.notifications.length)) {
      if (!runtime.agent.notifications.length) {
        if (flags.verbose) err(c.gray(`… waiting for ${runtime.tasks.running().length} background agent(s)`));
        await Promise.race([runtime.tasks.waitAny(), new Promise((r) => ctrl.signal.addEventListener('abort', r, { once: true }))]);
        continue;
      }
      result = await runtime.agent.run(runtime.agent.drainNotifications(), { signal: ctrl.signal });
    }
  } catch (e) {
    if (format === 'json') emit({ type: 'result', is_error: true, error: e.message });
    else err(c.red(`Error: ${e.message}`));
    runtime.tasks.killAll(); runtime.mcp.close();
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
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
    stdout.write(result.text + '\n');
  }
  runtime.tasks.killAll(); runtime.mcp.close();
  return result.interrupted ? 130 : 0;
}
