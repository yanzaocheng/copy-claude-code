import { ReadTool, WriteTool, EditTool } from './files.js';
import { makeBashTool, BashOutputTool, KillShellTool } from './bash.js';
import { GlobTool, GrepTool } from './search.js';
import { makeWebFetchTool, WebSearchTool } from './web.js';
import { TodoWriteTool, ExitPlanModeTool, AskUserQuestionTool } from './interaction.js';
import { makeTaskTool, TaskOutputTool, TaskStopTool } from './task.js';
import { NotebookEditTool } from './notebook.js';
import { makeSkillTool } from './skill.js';
import { RestartTool } from './restart.js';
import { makeEffortTool } from './effort.js';
import { ListPeersTool, MessagePeerTool } from './peers.js';

// Build the full tool set for the main agent.
// `restart`: this session can restart itself (it runs under the supervisor), so it gets the Restart tool.
// `peers`: an interactive session, which can talk to the other sessions on this machine.
export function buildTools(config, { agents, skills, mcpTools = [], restart = false, peers = false }) {
  return [
    makeTaskTool(agents, config),
    ...(skills?.size ? [makeSkillTool(skills)] : []),
    TaskOutputTool,
    TaskStopTool,
    makeBashTool(config),
    GlobTool,
    GrepTool,
    ReadTool,
    EditTool,
    WriteTool,
    NotebookEditTool,
    makeWebFetchTool(config),
    WebSearchTool,
    TodoWriteTool,
    BashOutputTool,
    KillShellTool,
    ExitPlanModeTool,
    AskUserQuestionTool,
    makeEffortTool(config),
    ...(restart ? [RestartTool] : []),
    ...(peers ? [ListPeersTool, MessagePeerTool] : []),
    ...mcpTools,
  ];
}

// Effort: a sub-agent shares the main agent's settings, so it must not change them.
const NEVER_FOR_SUBAGENTS = new Set(['TaskOutput', 'TaskStop', 'TodoWrite', 'ExitPlanMode', 'AskUserQuestion', 'Restart', 'Effort', 'ListPeers', 'MessagePeer']);

// Tools for a sub-agent. `allowTask`: it is below the nesting limit, so it may start sub-agents of its own.
export function toolsForSubagent(allTools, def, { allowTask = false } = {}) {
  const base = allTools.filter((t) => !NEVER_FOR_SUBAGENTS.has(t.name) && (allowTask || t.name !== 'Task'));
  if (def.tools === '*' || !def.tools) return base;
  const wanted = new Set(def.tools);
  return base.filter((t) => wanted.has(t.name) || [...wanted].some((w) => w.startsWith('mcp__') && t.name.startsWith(w)));
}
