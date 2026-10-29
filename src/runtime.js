// Wires config, session mode, tools, MCP servers and the main agent together.

import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, applyRememberedChoices, SOURCE_CHECKOUT } from './config.js';
import { CheckpointStore } from './checkpoints.js';
import { loadAgents, loadSkills } from './agents.js';
import { buildTools, toolsForSubagent } from './tools/index.js';
import { findShell, pruneStaleShellFiles } from './utils/shell.js';
import { mainSystemPrompt, subagentSystemPrompt, PROMPT_CODE_VERSION } from './prompts.js';
import { Agent } from './agent.js';
import { isAbort } from './api.js';
import { McpManager } from './mcp.js';
import { HookRunner } from './hooks.js';
import { BackgroundTasks, taskNotification } from './tasks.js';
import { autoMemoryDir, pruneToolResults, pruneCheckpoints, projectDir } from './session.js';
import { loadAutoMemoryIndex, takeEnvSnapshot, takeEnvSnapshotAsync, localDate } from './context.js';
import { canRestart } from './restart.js';
import { RuntimeTrace } from './trace.js';
import { loadActivePrompt } from './prompt-profiles.js';

export async function createRuntime({ cwd, flags = {}, io, sessionId = '' }) {
  const config = loadConfig({ cwd, flags });
  const trace = new RuntimeTrace({ cwd, sessionId, enabled: config.traceEnabled, dir: config.traceDir, maxBytes: config.traceMaxBytes });
  applyRememberedChoices(config, flags); // what /model and /effort chose last time
  if (flags.verify) config.verifyOverride = flags.verify;
  pruneToolResults(cwd);
  pruneCheckpoints(cwd);
  pruneStaleShellFiles();
  // Full access: nothing is ever asked.
  const checkpoints = new CheckpointStore(path.join(projectDir(cwd), 'checkpoints', `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`));

  const agents = loadAgents(cwd);
  const mcp = new McpManager(config.settings.mcpServers, { cwd });
  if (!flags.noMcp) await mcp.start((msg) => io.notice?.(msg, 'warn'));
  const shell = findShell(config);

  const hooks = new HookRunner(config);
  const tasks = new BackgroundTasks();
  const memoryDir = autoMemoryDir(cwd);
  const runtime = { config, checkpoints, agents, mcp, shell, io, cwd, hooks, tasks, memoryDir, trace };
  runtime.skills = loadSkills(cwd);
  // The self-check builds the Restart tool too, so that a mistake in it is found before a restart relies on it.
  const restartable = canRestart() || process.env.CLAUDE_PRO_SELF_CHECK === '1';
  // The agent fixes its own code (and restarts for it) only in a source checkout: an installed copy is replaced by
  // the next update, so there it reports its defects instead.
  const selfEdit = restartable && SOURCE_CHECKOUT;
  runtime.tools = buildTools(config, { agents, skills: runtime.skills, mcpTools: mcp.tools(), restart: selfEdit, peers: Boolean(io?.peers) || process.env.CLAUDE_PRO_SELF_CHECK === '1' });

  // The system prompt is built once and kept for the conversation: a prompt that changes in the middle of it
  // cannot be read from the prompt cache. So a change to what it is built from (memory, configuration) waits
  // for the next place where the conversation starts over anyway, /clear or a compaction, which is how Claude
  // Code treats edits to CLAUDE.md. The date and git state in it are a snapshot, shared with the sub-agents.
  let promptCache = null;
  let promptStale = false; // what the prompt is built from has changed since it was built
  const snapshots = new Map(); // directory -> {date, git}
  const snapshotFor = (dir) => {
    const key = path.resolve(dir);
    if (!snapshots.has(key)) snapshots.set(key, takeEnvSnapshot(key)); // blocks on git: prepareSnapshot usually came first
    return snapshots.get(key);
  };
  // The snapshot of the project's directory for the prompt built next, taken without blocking: at the start, and
  // waited for before a turn and after a compaction (see beforeTurn, refreshSystemPrompt), when the prompt is to be
  // built again. Taken at the build itself, git blocked the program there.
  let snapshotGen = 0; // invalidateSystemPrompt: a snapshot taken before is not the one wanted any more
  let preparing = null;
  runtime.prepareSnapshot = () => {
    const key = path.resolve(cwd);
    if (promptCache || snapshots.has(key)) return Promise.resolve();
    if (preparing?.gen === snapshotGen) return preparing.promise;
    const gen = snapshotGen;
    const promise = takeEnvSnapshotAsync(key).then((s) => { if (gen === snapshotGen && !snapshots.has(key)) snapshots.set(key, s); }, () => {});
    preparing = { gen, promise };
    return promise;
  };
  // Whether the prompt can be built without waiting for git.
  runtime.systemPromptReady = () => Boolean(promptCache) || snapshots.has(path.resolve(cwd));
  runtime.systemPrompt = () => {
    if (!promptCache) {
      const autoMemory = config.autoMemoryEnabled ? { dir: memoryDir, index: loadAutoMemoryIndex(memoryDir) } : null;
      const savedPrompt = flags.systemPrompt === undefined ? loadActivePrompt() : null;
      promptCache = flags.systemPrompt !== undefined
        ? flags.systemPrompt
        : savedPrompt?.text != null
          ? savedPrompt.text
          : mainSystemPrompt({ cwd, model: config.model, shellName: shell.name, extra: flags.appendSystemPrompt || '', autoMemory, mcpInstructions: mcp.promptInstructions(), selfRestart: selfEdit, installedCopy: !SOURCE_CHECKOUT, autoCompact: config.autoCompactEnabled, snapshot: snapshotFor(cwd) });
      promptStale = false;
    }
    return promptCache;
  };
  // Build the prompt again at the next request: for a new conversation (/clear), another model, a compaction.
  runtime.invalidateSystemPrompt = () => { promptCache = null; promptStale = false; snapshots.clear(); snapshotGen++; preparing = null; notedDate = null; };
  // Something it is built from changed in the middle of a conversation: note it, and leave the prompt as it is.
  runtime.deferSystemPromptRefresh = () => { if (promptCache) promptStale = true; };
  Object.defineProperty(runtime, 'systemPromptStale', { get: () => promptStale });
  // A resumed conversation continues behind the system prompt it started with (as in Claude Code): its history
  // was cached behind that one, and nothing is gained from building the prompt again. Not when the prompt was
  // built for another model (it names the model, and each model's cache is its own anyway), and not when the code
  // that builds it has changed since (`code`, the PROMPT_CODE_VERSION saved with it; null for a session from before
  // it was saved): the new code's prompt is wanted then, e.g. after a Restart for an edit to the prompt. The date in
  // it is brought up to date by a note to the model, which comes after everything that is cached.
  runtime.resumeSystemPrompt = (saved, code) => {
    if (flags.systemPrompt !== undefined || flags.systemPromptFile !== undefined || typeof saved !== 'string' || !saved.trim()) return false;
    if (code !== PROMPT_CODE_VERSION) return false;
    // --append-system-prompt is the last thing in the prompt: one built with other text is not what this run asked for
    const extra = flags.appendSystemPrompt || '';
    if (extra && !saved.endsWith(`\n\n${extra}`)) return false;
    const modelIn = (text) => /^You are powered by the model (.+)\.$/m.exec(text)?.[1];
    if (modelIn(saved) !== config.model.id) return false;
    // a prompt from before the project's directory got another name (see projectDir) points the model to the old
    // memory directory, where it would write again
    const memoryAt = /memory for this project at `([^`]+)`/.exec(saved)?.[1];
    if (memoryAt && path.resolve(memoryAt) !== path.resolve(memoryDir)) return false;
    promptCache = saved;
    promptStale = false;
    const then = /^Today's date: (\d{4}-\d{2}-\d{2})$/m.exec(saved)?.[1];
    const today = localDate();
    if (then && then !== today) {
      runtime.agent.addReminder(`Today's date is ${today}. This conversation was resumed from an earlier session, so the date in the environment block of your instructions (${then}) is out of date.`);
      notedDate = today;
    }
    return true;
  };
  // A conversation that goes on past midnight keeps the date its system prompt was built with (rebuilding the
  // prompt would throw its cache away). The model is told the new date instead, once a day, in a note that goes
  // with the next user message, after everything that is cached. Called before each of the main agent's turns.
  let notedDate = null;
  runtime.noteDateChange = (today = localDate()) => {
    const then = promptCache && /^Today's date: (\d{4}-\d{2}-\d{2})$/m.exec(promptCache)?.[1];
    if (!then || then === today || notedDate === today) return false;
    notedDate = today;
    runtime.agent.addReminder(`Today's date is ${today}. This conversation started on ${then}, so the date in the environment block of your instructions is out of date.`);
    return true;
  };

  // Every agent uses the model selected for this session; effort may still be specific to the task.
  runtime.spawnSubagent = async ({ def, prompt, description, ctx, effort }) => {
    const spec = config.modelSpec;
    const model = config.resolveModel(spec);
    const subIo = io.subagentIo ? io.subagentIo({ def, description, parentCtx: ctx }) : {};
    // The main agent is depth 0; an agent below the nesting limit may start sub-agents itself.
    const depth = (ctx.depth ?? ctx.agent?.depth ?? 0) + 1;
    const subTools = toolsForSubagent(runtime.tools, def, { allowTask: depth < config.maxSubagentDepth });
    const sub = new Agent({
      config,
      checkpoints,
      depth,
      spawnSubagent: runtime.spawnSubagent,
      tools: subTools,
      systemPrompt: subagentSystemPrompt({ cwd: ctx.cwd, model, shellName: shell.name, agentPrompt: def.prompt, snapshot: snapshotFor(ctx.cwd), mcpInstructions: subTools.some((tool) => tool.mcp) ? mcp.promptInstructions() : '', readOnly: Boolean(def.readOnly) }),
      io: subIo,
      model: () => config.resolveModel(spec), // the model of now, with the window the gateway's model list gives it
      isSubagent: true,
      cwd: ctx.cwd,
      name: def.name,
      hooks,
      effort: effort || def.effort,
      compactWindow: def.autoCompactWindow,
      trace,
    });
    let result;
    try {
      result = await sub.run(prompt, { signal: ctx.signal });
    } catch (err) {
      // An API failure (rate limit, outage) must not throw away what the agent already found.
      const partial = isAbort(err) || ctx.signal?.aborted ? '' : sub.assistantText();
      if (partial) err.message += `\n\nThe agent failed before finishing (${sub.toolUseCount} tool uses). What it had written so far:\n${partial}`;
      throw err;
    } finally {
      runtime.agent.addSubUsage(sub.usage); // whatever became of it, it was billed
      // Its edits count for the agent that sent it: the main agent verifies after edits (see verifyCommand), and
      // an implementation handed to a sub-agent used to go unverified.
      if (sub.editsThisRun > 0 && ctx.agent) ctx.agent.editsThisRun += sub.editsThisRun;
    }
    if (result.interrupted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { text: result.text, toolUses: sub.toolUseCount, tokens: sub.usage.output + sub.lastContextTokens };
  };

  runtime.agent = new Agent({
    config,
    checkpoints,
    tools: runtime.tools,
    systemPrompt: runtime.systemPrompt,
    io,
    model: () => config.model,
    cwd,
    spawnSubagent: runtime.spawnSubagent,
    hooks,
    tasks,
    // a compaction starts the conversation over, from a prompt built again
    refreshSystemPrompt: async () => { runtime.invalidateSystemPrompt(); await runtime.prepareSnapshot(); },
    beforeTurn: async () => { runtime.noteDateChange(); await runtime.prepareSnapshot(); },
    trace,
  });

  // A finished background agent's report is queued for the main agent; the UI decides
  // whether to start a new turn for it (when idle) or let the running turn pick it up.
  tasks.onDone((task) => {
    runtime.agent.notifications.push({ taskId: task.id, text: taskNotification(task) });
    io.backgroundTaskDone?.(task);
  });
  return runtime;
}
