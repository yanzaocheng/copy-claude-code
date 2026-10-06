// Wires config, session mode, tools, MCP servers and the main agent together.

import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, applyRememberedChoices } from './config.js';
import { ModeManager } from './modes.js';
import { CheckpointStore } from './checkpoints.js';
import { loadAgents, loadSkills } from './agents.js';
import { buildTools, toolsForSubagent } from './tools/index.js';
import { findShell, pruneStaleShellFiles } from './utils/shell.js';
import { mainSystemPrompt, subagentSystemPrompt } from './prompts.js';
import { Agent } from './agent.js';
import { isAbort } from './api.js';
import { McpManager } from './mcp.js';
import { HookRunner } from './hooks.js';
import { BackgroundTasks, taskNotification } from './tasks.js';
import { autoMemoryDir, pruneToolResults, pruneCheckpoints, projectDir } from './session.js';
import { loadAutoMemoryIndex } from './context.js';
import { canRestart } from './restart.js';

export async function createRuntime({ cwd, flags = {}, io }) {
  const config = loadConfig({ cwd, flags });
  applyRememberedChoices(config, flags); // what /model and /effort chose last time
  if (flags.verify) config.verifyOverride = flags.verify;
  pruneToolResults(cwd);
  pruneCheckpoints(cwd);
  pruneStaleShellFiles();
  // Full access: nothing is ever asked. The only mode switch is the read-only plan mode (--plan).
  const modes = new ModeManager(flags.plan ? 'plan' : 'full');
  const checkpoints = new CheckpointStore(path.join(projectDir(cwd), 'checkpoints', `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`));

  const agents = loadAgents(cwd);
  const mcp = new McpManager(config.settings.mcpServers, { cwd });
  if (!flags.noMcp) await mcp.start((msg) => io.notice?.(msg, 'warn'));
  const shell = findShell(config);

  const hooks = new HookRunner(config);
  const tasks = new BackgroundTasks();
  const memoryDir = autoMemoryDir(cwd);
  const runtime = { config, modes, checkpoints, agents, mcp, shell, io, cwd, hooks, tasks, memoryDir };
  runtime.skills = loadSkills(cwd);
  // The self-check builds the Restart tool too, so that a mistake in it is found before a restart relies on it.
  const restartable = canRestart() || process.env.CLAUDE_PRO_SELF_CHECK === '1';
  runtime.tools = buildTools(config, { agents, skills: runtime.skills, mcpTools: mcp.tools(), restart: restartable });

  let promptCache = null;
  runtime.systemPrompt = () => {
    if (!promptCache) {
      const autoMemory = config.autoMemoryEnabled ? { dir: memoryDir, index: loadAutoMemoryIndex(memoryDir) } : null;
      promptCache = flags.systemPrompt || mainSystemPrompt({ cwd, model: config.mainModel, shellName: shell.name, extra: flags.appendSystemPrompt || '', autoMemory, selfRestart: restartable });
    }
    return promptCache;
  };
  runtime.invalidateSystemPrompt = () => { promptCache = null; };

  runtime.spawnSubagent = async ({ def, prompt, description, ctx }) => {
    const model = def.model ? config.resolveModel(def.model) : config.subagentModel;
    const subIo = io.subagentIo ? io.subagentIo({ def, description, parentCtx: ctx }) : {};
    // The main agent is depth 0; an agent below the nesting limit may start sub-agents itself.
    const depth = (ctx.depth ?? ctx.agent?.depth ?? 0) + 1;
    const sub = new Agent({
      config,
      modes,
      checkpoints,
      depth,
      spawnSubagent: runtime.spawnSubagent,
      tools: toolsForSubagent(runtime.tools, def, { allowTask: depth < config.maxSubagentDepth }),
      systemPrompt: subagentSystemPrompt({ cwd: ctx.cwd, model, shellName: shell.name, agentPrompt: def.prompt }),
      io: subIo,
      model,
      isSubagent: true,
      cwd: ctx.cwd,
      name: def.name,
      hooks,
    });
    let result;
    try {
      result = await sub.run(prompt, { signal: ctx.signal });
    } catch (err) {
      // An API failure (rate limit, outage) must not throw away what the agent already found.
      const partial = isAbort(err) || ctx.signal?.aborted ? '' : sub.assistantText();
      if (partial) err.message += `\n\nThe agent failed before finishing (${sub.toolUseCount} tool uses). What it had written so far:\n${partial}`;
      throw err;
    }
    if (result.interrupted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { text: result.text, toolUses: sub.toolUseCount, tokens: sub.usage.output + sub.lastContextTokens };
  };

  runtime.agent = new Agent({
    config,
    modes,
    checkpoints,
    tools: runtime.tools,
    systemPrompt: runtime.systemPrompt,
    io,
    model: () => config.mainModel,
    cwd,
    spawnSubagent: runtime.spawnSubagent,
    hooks,
    tasks,
  });

  // A finished background agent's report is queued for the main agent; the UI decides
  // whether to start a new turn for it (when idle) or let the running turn pick it up.
  tasks.onDone((task) => {
    runtime.agent.notifications.push({ taskId: task.id, text: taskNotification(task) });
    io.backgroundTaskDone?.(task);
  });
  return runtime;
}
