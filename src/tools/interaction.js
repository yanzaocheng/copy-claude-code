// Tools that interact with the session rather than the machine: TodoWrite,
// ExitPlanMode and AskUserQuestion.

export const TodoWriteTool = {
  name: 'TodoWrite',
  readOnly: true,
  description: `Create and update a task list for the current request. It helps you keep track of a task with several steps and shows the user where you are.

When to use it: a task with several distinct steps, several tasks the user listed, or when the user asks for a list. Skip it for a single straightforward task, a few trivial steps, or a conversational request. Each update is a request that re-reads the conversation, so use the list where it helps, not as a formality.

How:
- Each item has \`content\`, the imperative form ("Run tests"), and \`activeForm\`, the present continuous form shown while it is in progress ("Running tests").
- Statuses are pending, in_progress and completed; keep exactly one item in_progress while you work.
- Keep it current: mark an item completed once it is done, in the same response as the next tool calls you make anyway rather than in a response of its own. Add follow-up items you discover and remove ones that no longer apply.
- Mark an item completed only when it is fully done: not while tests fail, the work is partial or an error is unresolved.`,
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The updated todo list',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string', minLength: 1 },
          },
          required: ['content', 'status', 'activeForm'],
        },
      },
    },
    required: ['todos'],
  },
  summarize() { return ''; },
  async call(input, ctx) {
    const todos = Array.isArray(input.todos) ? input.todos.filter((t) => t && t.content) : [];
    ctx.agent.todos = todos.every((t) => t.status === 'completed') ? [] : todos;
    return {
      content: 'The todo list is updated.',
      display: { todos },
    };
  },
};

export const ExitPlanModeTool = {
  name: 'ExitPlanMode',
  readOnly: true,
  description: `Use this tool when you are in plan mode and have finished planning the implementation steps of a task that requires writing code, and are ready to code. This will prompt the user to approve your plan.
Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.`,
  input_schema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The plan you came up with, that you want to run by the user for approval. Supports markdown. The plan should be pretty concise.' },
    },
    required: ['plan'],
  },
  summarize() { return ''; },
  async call(input, ctx) {
    if (ctx.modes.mode !== 'plan') return { isError: true, content: 'You are not in plan mode. Proceed with the task.' };
    const choice = await ctx.io.approvePlan(input.plan);
    if (choice === 'full') {
      ctx.modes.setMode('full');
      return { content: 'User has approved your plan. You can now start coding. Start with updating your todo list if applicable.', display: { plan: input.plan, approved: true } };
    }
    return {
      content: 'The user wants to keep planning. Do not start implementation. Wait for the user to explain what should change in the plan.',
      display: { plan: input.plan, approved: false },
      stopTurn: true,
    };
  },
};

export const AskUserQuestionTool = {
  name: 'AskUserQuestion',
  readOnly: true,
  description: `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`,
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The complete question to ask the user' },
            header: { type: 'string', description: 'Very short label (max 12 chars)' },
            multiSelect: { type: 'boolean' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, description: { type: 'string' } },
                required: ['label', 'description'],
              },
            },
          },
          required: ['question', 'header', 'options', 'multiSelect'],
        },
      },
    },
    required: ['questions'],
  },
  summarize(input) { return (input.questions || []).map((q) => q.header).join(', '); },
  async call(input, ctx) {
    const answers = {};
    for (const q of input.questions || []) {
      const a = await ctx.io.askQuestion(q);
      if (a === null) return { content: 'The user declined to answer the questions.', stopTurn: true, display: { summary: 'Declined' } };
      answers[q.question] = a;
    }
    const text = Object.entries(answers).map(([q, a]) => `"${q}"="${a}"`).join(', ');
    return { content: `User has answered your questions: ${text}. You can now continue with the user's answers in mind.`, display: { summary: Object.values(answers).join(' · ') } };
  },
};
