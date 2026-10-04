// Skill tool: lets the model load a skill (packaged instructions for one kind of task) when
// the task at hand matches its description.

import { renderSkill } from '../agents.js';

export function makeSkillTool(skills) {
  return {
    name: 'Skill',
    readOnly: true,
    description: () => `Load a skill: a packaged set of instructions for a particular kind of task.

Available skills:
${[...skills.values()].map((s) => `- ${s.name}: ${s.description}`).join('\n')}

When the task matches a skill's description, call this tool with the skill name BEFORE doing the work, then follow the instructions it returns. Do not mention a skill without calling it, and do not call a skill that is already loaded in this conversation. Pass arguments in \`args\` when the user gave any.`,
    input_schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'The skill name, e.g. "pdf"' },
        args: { type: 'string', description: 'Optional arguments for the skill' },
      },
      required: ['skill'],
    },
    summarize(input) { return input.skill || ''; },
    async call(input) {
      const name = String(input.skill || '').replace(/^\//, '');
      const skill = skills.get(name);
      if (!skill) return { isError: true, content: `Unknown skill: ${name}. Available skills: ${[...skills.keys()].join(', ') || 'none'}` };
      return { content: renderSkill(skill, input.args || ''), display: { summary: `Loaded skill ${skill.name}` } };
    },
  };
}
