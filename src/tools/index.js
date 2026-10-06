import { ReadTool, WriteTool, EditTool } from './files.js';
import { makeBashTool, BashOutputTool, KillShellTool } from './bash.js';
import { GlobTool, GrepTool } from './search.js';
import { makeWebFetchTool, WebSearchTool } from './web.js';
import { TodoWriteTool, ExitPlanModeTool, AskUserQuestionTool } from './interaction.js';
import { makeTaskTool, TaskOutputTool, TaskStopTool } from './task.js';
import { NotebookEditTool } from './notebook.js';
import { makeSkillTool } from './skill.js';
import { RestartTool } from './restart.js';

// Build the full tool set for the main agent.
// `restart`: this session can restart itself (it runs under the supervisor), so it gets the Restart tool.
export function buildTools(config, { agents, skills, mcpTools = [], restart = false }) {
  return [
    makeTaskTool(agents),
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
    ...(restart ? [RestartTool] : []),
    ...mcpTools,
  ];
}

const NEVER_FOR_SUBAGENTS = new Set(['TaskOutput', 'TaskStop', 'TodoWrite', 'ExitPlanMode', 'AskUserQuestion', 'Restart']);

// Tools for a sub-agent. `allowTask`: it is below the nesting limit, so it may start sub-agents of its own.
export function toolsForSubagent(allTools, def, { allowTask = false } = {}) {
  const base = allTools.filter((t) => !NEVER_FOR_SUBAGENTS.has(t.name) && (allowTask || t.name !== 'Task'));
  if (def.tools === '*' || !def.tools) return base;
  const wanted = new Set(def.tools);
  return base.filter((t) => wanted.has(t.name) || [...wanted].some((w) => w.startsWith('mcp__') && t.name.startsWith(w)));
}
