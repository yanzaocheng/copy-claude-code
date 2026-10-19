// Effort: the model changes its own reasoning effort in the middle of a request, typically raising it for a hard
// problem. The change lasts until the user's next message, which goes back to the effort the user chose.

import { defaultEffort } from '../api.js';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function makeEffortTool(config) {
  return {
    name: 'Effort',
    description: `Change your own reasoning effort (output_config.effort) for the rest of the user's current request. From your next step on, every request uses the new level; at the user's next message it goes back to the level the user chose.

Raise it when the task turns out to be hard and the current level is not enough: a bug you could not find after a couple of real attempts, a subtle concurrency or algorithmic problem, a design decision with many interacting constraints, a fix that keeps failing. Then work on with the higher level; do not ask the user first.

Do not raise it for routine work, and do not switch back and forth: the prompt cache is kept per effort level, so each change makes the next request write the whole conversation to the cache again (a one-off cost about the size of the conversation). Lowering it is worth it only when the hard part is done and a long stretch of routine work remains.`,
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: EFFORT_LEVELS, description: 'The new effort level' },
        reason: { type: 'string', description: 'Why, in a few words. Shown to the user.' },
      },
      required: ['level', 'reason'],
    },
    summarize(input) { return `${input.level}${input.reason ? `: ${input.reason}` : ''}`; },
    async call(input) {
      const level = String(input.level || '').trim().toLowerCase();
      if (!EFFORT_LEVELS.includes(level)) return { isError: true, content: `Unknown effort "${input.level}". Use one of: ${EFFORT_LEVELS.join(', ')}.` };
      const shown = () => config.effort || defaultEffort(config.model.id, config) || 'the model default';
      const before = shown();
      if (level === before) return { content: `The effort is already ${level}.` };
      config.effortBoost = null;
      const users = shown(); // the level the user chose, which the next message goes back to
      config.effortBoost = level === users ? null : level;
      if (!config.effortBoost) return { content: `Effort back to ${level}, the level the user chose.`, display: { summary: `Effort ${before} → ${level}` } };
      return {
        content: `Effort changed from ${before} to ${level} for the rest of this request; it goes back to ${users} at the user's next message.`,
        display: { summary: `Effort ${before} → ${level}` },
      };
    },
  };
}
