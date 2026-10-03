import { ReadTool, WriteTool, EditTool } from './files.js';
import { makeBashTool, BashOutputTool, KillShellTool } from './bash.js';
import { GlobTool, GrepTool } from './search.js';
import { makeWebFetchTool, WebSearchTool } from './web.js';
import { TodoWriteTool, ExitPlanModeTool, AskUserQuestionTool } from './interaction.js';
import { makeTaskTool } from './task.js';
import { NotebookEditTool } from './notebook.js';

// Build the full tool set for the main agent.
export function buildTools(config, { agents, mcpTools = [] }) {
  return [
    makeTaskTool(agents),
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
    ...mcpTools,
  ];
}

const NEVER_FOR_SUBAGENTS = new Set(['Task', 'TodoWrite', 'ExitPlanMode', 'AskUserQuestion']);

export function toolsForSubagent(allTools, def) {
  const base = allTools.filter((t) => !NEVER_FOR_SUBAGENTS.has(t.name));
  if (def.tools === '*' || !def.tools) return base;
  const wanted = new Set(def.tools);
  return base.filter((t) => wanted.has(t.name) || [...wanted].some((w) => w.startsWith('mcp__') && t.name.startsWith(w)));
}
