// Wires config, permissions, tools, MCP servers and the main agent together.

import { loadConfig } from './config.js';
import { PermissionManager } from './permissions.js';
import { loadAgents } from './agents.js';
import { buildTools, toolsForSubagent } from './tools/index.js';
import { findShell } from './utils/shell.js';
import { mainSystemPrompt, subagentSystemPrompt } from './prompts.js';
import { Agent } from './agent.js';
import { McpManager } from './mcp.js';
import { HookRunner } from './hooks.js';

export async function createRuntime({ cwd, flags = {}, io }) {
  const config = loadConfig({ cwd, flags });
  let mode = flags.permissionMode;
  if (flags.dangerouslySkipPermissions) mode = 'bypassPermissions';
  const permissions = new PermissionManager(config, { mode });
  for (const r of flags.allowedTools || []) permissions.allow.push(r);
  for (const r of flags.disallowedTools || []) permissions.deny.push(r);

  const agents = loadAgents(cwd);
  const mcp = new McpManager(config.settings.mcpServers, { cwd });
  if (!flags.noMcp) await mcp.start((msg) => io.notice?.(msg, 'warn'));
  const shell = findShell(config);

  const hooks = new HookRunner(config);
  const runtime = { config, permissions, agents, mcp, shell, io, cwd, hooks };
  runtime.tools = buildTools(config, { agents, mcpTools: mcp.tools() });

  let promptCache = null;
  runtime.systemPrompt = () => {
    if (!promptCache) {
      promptCache = flags.systemPrompt || mainSystemPrompt({ cwd, model: config.mainModel, shellName: shell.name, extra: flags.appendSystemPrompt || '' });
    }
    return promptCache;
  };
  runtime.invalidateSystemPrompt = () => { promptCache = null; };

  runtime.spawnSubagent = async ({ def, prompt, description, ctx }) => {
    const model = def.model ? config.resolveModel(def.model) : config.subagentModel;
    const subIo = io.subagentIo ? io.subagentIo({ def, description, parentCtx: ctx }) : {};
    const sub = new Agent({
      config,
      permissions,
      tools: toolsForSubagent(runtime.tools, def),
      systemPrompt: subagentSystemPrompt({ cwd: ctx.cwd, model, shellName: shell.name, agentPrompt: def.prompt }),
      io: subIo,
      model,
      isSubagent: true,
      cwd: ctx.cwd,
      name: def.name,
      hooks,
    });
    const result = await sub.run(prompt, { signal: ctx.signal });
    if (result.interrupted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { text: result.text, toolUses: sub.toolUseCount, tokens: sub.usage.output + sub.lastContextTokens };
  };

  runtime.agent = new Agent({
    config,
    permissions,
    tools: runtime.tools,
    systemPrompt: runtime.systemPrompt,
    io,
    model: () => config.mainModel,
    cwd,
    spawnSubagent: runtime.spawnSubagent,
    hooks,
  });
  return runtime;
}
