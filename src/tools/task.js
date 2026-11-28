// Task tool: launches a sub-agent with its own context window and tool set, in the
// foreground or (run_in_background) as a background task. TaskOutput / TaskStop manage
// background tasks.

import { taskResultText } from '../tasks.js';
import { EFFORTS } from '../agents.js';

// Wait for `promise`, at most `ms`, or until `signal` aborts. The timer is always cleared so a
// finished wait never keeps the process alive.
function waitFor(promise, ms, signal) {
  let timer, onAbort;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    onAbort = () => resolve();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, limit]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  });
}

// "fable-5-2" for claude-fable-5-2, as the footer names models.
const shortModel = (id) => String(id || '').replace(/^claude-/, '');

// `config`: to say which agents run on another model than the session's (those of the decision model, when the user
// set one, see Config.agentModelSpec). The description is built at each request: it follows /model.
export function makeTaskTool(agents, config = null) {
  // The model an agent runs on when it is not the session's, else null.
  const otherModel = (a) => {
    if (!config || !a.model) return null;
    const model = config.resolveModel(config.agentModelSpec(a));
    const own = config.model;
    return model.id === own.id && model.provider === own.provider ? null : model;
  };
  const tools = (a) => `(Tools: ${a.tools === '*' ? 'All tools' : a.tools.join(', ')})`;
  return {
    name: 'Task',
    readOnly: true, // sub-agents ask for their own permissions; multiple tasks may run in parallel
    description: () => {
      const others = new Map([...agents.values()].map((a) => [a.name, otherModel(a)]));
      const list = [...agents.values()]
        .map((a) => `- ${a.name}: ${a.description} ${tools(a)}${others.get(a.name) ? ` (Model: ${others.get(a.name).id})` : ''}`)
        .join('\n');
      const models = [...others.values()].some(Boolean)
        ? 'Every agent uses the model currently selected for this session, except those whose entry above names a model: they run on the model the user chose for decisions and reviews, and a run costs what that model costs.'
        : 'Every agent uses the model currently selected for this session.';
      return `Launch a new agent to handle complex, multi-step tasks autonomously.

Available agent types and the tools they have access to:
${list}

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead

Usage notes:
- When several independent tasks are worth delegating, start them in a single message with multiple tool uses so that they run concurrently. Do not split closely coupled work between agents: they do not see each other's work, and each one costs its own context and tokens
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Each agent invocation is stateless. Your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message.
- Once you have delegated a search or an investigation, do not also do it yourself: wait for the report, doing other work meanwhile. Never make up or predict the result of an agent that is still running; if the user asks before it is done, say that it is still running.
- ${models} An agent may still use its own effort level when the task needs it. Use the agent's report to find your way, but before you build an answer or a change on one of its findings, check that finding yourself (read the lines it cites).
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- Set run_in_background: true to start the agent and continue working while it runs (e.g. a long investigation, or several independent jobs). You get a task id back immediately, and the agent's final report arrives automatically in a <task-notification> once it finishes; you do not need to poll. Use TaskOutput to check on or wait for it early, and TaskStop to cancel it. Do not start background agents that edit the same files at the same time.`;
    },
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short (3-5 word) description of the task' },
        prompt: { type: 'string', description: 'The task for the agent to perform' },
        subagent_type: { type: 'string', description: 'The type of specialized agent to use for this task' },
        run_in_background: { type: 'boolean', description: 'Run the agent in the background and return immediately with a task id' },
        effort: { type: 'string', enum: EFFORTS, description: 'Optional effort level for this agent (default: the agent definition\'s, else the session\'s). Low suits quick lookups, high or above hard reasoning.' },
      },
      required: ['description', 'prompt', 'subagent_type'],
    },
    summarize(input) {
      const on = input.effort ? `effort ${input.effort}` : '';
      return `${input.description || ''}${on ? ` (${on})` : ''}${input.run_in_background ? ' (background)' : ''}`;
    },
    label(input) { return input.subagent_type && input.subagent_type !== 'general-purpose' ? input.subagent_type : 'Task'; },
    async call(input, ctx) {
      const def = agents.get(input.subagent_type) || agents.get('general-purpose');
      if (!agents.has(input.subagent_type) && input.subagent_type) {
        return { isError: true, content: `Agent type '${input.subagent_type}' not found. Available agents: ${[...agents.keys()].join(', ')}` };
      }
      const effort = input.effort ? String(input.effort).toLowerCase() : undefined;
      if (effort && !EFFORTS.includes(effort)) return { isError: true, content: `Unknown effort '${input.effort}'. Use one of: ${EFFORTS.join(', ')}.` };
      const choice = { effort };
      if (input.run_in_background) {
        if (!ctx.tasks) return { isError: true, content: 'Background agents are not available here; run the task in the foreground.' };
        // The task outlives this turn, so it gets its own signal and no live progress display.
        const base = { cwd: ctx.cwd, projectRoot: ctx.projectRoot, config: ctx.config, checkpoints: ctx.checkpoints, io: ctx.io, depth: ctx.agent?.depth ?? 0 };
        const task = ctx.tasks.start({
          description: input.description || def.name,
          subagentType: def.name,
          run: (signal) => ctx.spawnSubagent({ def, prompt: input.prompt, description: input.description, ctx: { ...base, signal }, ...choice }),
        });
        return {
          content: `Started background agent ${task.id} (${def.name}): ${input.description}. Its final report will arrive in a <task-notification> when it finishes. Continue with other work; use TaskOutput with task_id "${task.id}" only if you need to wait for it.`,
          display: { summary: `Running in background (${task.id})` },
        };
      }
      const started = Date.now();
      const { text, toolUses, tokens, model, cost } = await ctx.spawnSubagent({ def, prompt: input.prompt, description: input.description, ctx, ...choice });
      const secs = Math.round((Date.now() - started) / 100) / 10;
      const kTok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
      // An agent of another model than the session's (the decision model): which one, and what the run cost.
      const other = otherModel(def) && model ? `${shortModel(model.id)} · ` : '';
      const usd = other && cost > 0 ? ` · $${cost.toFixed(2)}` : '';
      return {
        content: text || '(the agent returned no text)',
        display: { summary: `Done (${other}${toolUses} tool use${toolUses === 1 ? '' : 's'} · ${kTok} tokens · ${secs}s${usd})` },
      };
    },
  };
}

export const TaskOutputTool = {
  name: 'TaskOutput',
  readOnly: true,
  description: `Gets the status and result of a background agent started with Task run_in_background.
- By default waits (block: true) until the agent finishes or the timeout passes.
- You normally do not need this: a finished agent's report arrives automatically in a <task-notification>. Use it when you cannot continue without the result.`,
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The background task id, e.g. agent_1' },
      block: { type: 'boolean', description: 'Wait for the task to finish (default true)' },
      timeout: { type: 'number', description: 'Maximum time to wait in milliseconds (default 120000, max 600000)' },
    },
    required: ['task_id'],
  },
  summarize(input) { return input.task_id; },
  async call(input, ctx) {
    const task = ctx.tasks?.get(input.task_id);
    if (!task) return { isError: true, content: `No background task with id ${input.task_id}. Known: ${ctx.tasks?.list().map((t) => t.id).join(', ') || 'none'}` };
    if (task.status === 'running' && input.block !== false) {
      const timeout = Math.min(Math.max(1000, input.timeout || 120_000), 600_000);
      await waitFor(task.promise, timeout, ctx.signal);
      if (ctx.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    if (task.status === 'running') {
      return { content: `<status>running</status>\nTask ${task.id} ("${task.description}") is still running after ${Math.round((Date.now() - task.started) / 1000)}s.`, display: { summary: 'Still running' } };
    }
    // The result is delivered here, so drop the pending notification for it.
    if (ctx.agent) ctx.agent.notifications = ctx.agent.notifications.filter((n) => n.taskId !== task.id);
    return { content: `<status>${task.status}</status>\n<result>\n${taskResultText(task)}\n</result>`, isError: task.status === 'failed', display: { summary: task.status } };
  },
};

export const TaskStopTool = {
  name: 'TaskStop',
  description: 'Stops a running background agent by its task id.',
  input_schema: {
    type: 'object',
    properties: { task_id: { type: 'string', description: 'The background task id to stop' } },
    required: ['task_id'],
  },
  summarize(input) { return input.task_id; },
  async call(input, ctx) {
    const task = ctx.tasks?.get(input.task_id);
    if (!task) return { isError: true, content: `No background task with id ${input.task_id}` };
    if (!ctx.tasks.kill(task.id)) return { content: `Task ${task.id} is not running (status: ${task.status})` };
    return { content: `Stopped background agent ${task.id} ("${task.description}")` };
  },
};
