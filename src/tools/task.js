// Task tool: launches a sub-agent with its own context window and tool set.

export function makeTaskTool(agents) {
  const list = [...agents.values()]
    .map((a) => `- ${a.name}: ${a.description} (Tools: ${a.tools === '*' ? 'All tools' : a.tools.join(', ')})`)
    .join('\n');
  return {
    name: 'Task',
    readOnly: true, // sub-agents ask for their own permissions; multiple tasks may run in parallel
    description: `Launch a new agent to handle complex, multi-step tasks autonomously.

Available agent types and the tools they have access to:
${list}

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead

Usage notes:
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Each agent invocation is stateless. Your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent`,
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short (3-5 word) description of the task' },
        prompt: { type: 'string', description: 'The task for the agent to perform' },
        subagent_type: { type: 'string', description: 'The type of specialized agent to use for this task' },
      },
      required: ['description', 'prompt', 'subagent_type'],
    },
    summarize(input) { return input.description || ''; },
    label(input) { return input.subagent_type && input.subagent_type !== 'general-purpose' ? input.subagent_type : 'Task'; },
    async call(input, ctx) {
      const def = agents.get(input.subagent_type) || agents.get('general-purpose');
      if (!agents.has(input.subagent_type) && input.subagent_type) {
        return { isError: true, content: `Agent type '${input.subagent_type}' not found. Available agents: ${[...agents.keys()].join(', ')}` };
      }
      const started = Date.now();
      const { text, toolUses, tokens } = await ctx.spawnSubagent({ def, prompt: input.prompt, description: input.description, ctx });
      const secs = Math.round((Date.now() - started) / 100) / 10;
      const kTok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
      return {
        content: text || '(the agent returned no text)',
        display: { summary: `Done (${toolUses} tool use${toolUses === 1 ? '' : 's'} · ${kTok} tokens · ${secs}s)` },
      };
    },
  };
}
