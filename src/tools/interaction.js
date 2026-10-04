// Tools that interact with the session rather than the machine: TodoWrite,
// ExitPlanMode and AskUserQuestion.

export const TodoWriteTool = {
  name: 'TodoWrite',
  readOnly: true,
  description: `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.

## When to Use This Tool
Use this tool proactively in these scenarios:
1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool
Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

## Task States and Management
1. **Task States**:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully
   **IMPORTANT**: Task descriptions must have two forms:
   - content: The imperative form describing what needs to be done (e.g., "Run tests")
   - activeForm: The present continuous form shown during execution (e.g., "Running tests")
2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Exactly ONE task must be in_progress at any time (not less, not more)
   - Remove tasks that are no longer relevant from the list entirely
3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - Never mark a task as completed if tests are failing, the implementation is partial, or you hit unresolved errors

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.`,
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
      content: 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable',
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
