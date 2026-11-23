// Restart: the model restarts this program after changing the program's own source code, so that the change
// takes effect and the conversation goes on in the new process.

import { APP_NAME, INSTALL_DIR } from '../config.js';
import { canRestart, runSelfCheck, MAX_RESTARTS } from '../restart.js';

export const RestartTool = {
  name: 'Restart',
  description: `Restart this program (${APP_NAME}) so that changes you made to its own source code take effect, and carry on in the new process. Its source is in ${INSTALL_DIR} (src/ and bin/). Editing those files does not change the process you are running in: it keeps the old code until it restarts.

Use it after you have changed the program's own code, to fix a bug you ran into or to add something you need. Do not use it for anything else.

How it works:
- First the new code is started in a separate throwaway process (every module loads, the interface comes up, the tools and the system prompt are well formed). If that fails, nothing is restarted and the error is returned to you: fix it and call Restart again.
- Then the restart happens as soon as your current turn ends, so finish the turn with a short message to the user. The conversation, your todo list, the model and effort settings, queued messages and whatever the user was typing carry over, and you get a message saying the new code is loaded.
- Use \`then\` to say what to do right after the restart (typically: check that the change works). Without it you simply carry on.
- Background agents are killed by a restart, so the tool refuses while any are running unless you pass force. Background shells (Bash run_in_background) keep running: the new process takes them over, with the same ids and their unread output.
- Restarting more than ${MAX_RESTARTS} times within five minutes is refused: that is a loop. Stop and tell the user.`,
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'What changed, in a few words. Shown to the user.' },
      then: { type: 'string', description: 'What to do right after the restart, for example how to check the change.' },
      force: { type: 'boolean', description: 'Restart even though background agents are running (they are killed).' },
    },
    required: ['reason'],
  },
  summarize(input) { return input.reason || ''; },
  async call(input, ctx) {
    const io = ctx.io;
    if (!(io?.canRestart ? io.canRestart() : canRestart()) || typeof io?.requestRestart !== 'function') {
      return { isError: true, content: `Restart is not available here: it needs an interactive session started with \`${APP_NAME}\` (not -p, and not with CLAUDE_PRO_NO_SUPERVISOR set). Ask the user to restart the program themselves.` };
    }
    const blockers = io.restartBlockers?.() || [];
    if (blockers.length && !input.force) {
      return { isError: true, content: `A restart would kill what is still running: ${blockers.join('; ')}. Wait for it to finish (TaskOutput), stop it (TaskStop), or call Restart again with force: true.` };
    }
    const check = await runSelfCheck({ signal: ctx.signal });
    if (!check.ok) {
      return { isError: true, content: `Not restarting: the new code does not start.\n\n${check.output}\n\nFix this and call Restart again.`, display: { summary: 'The new code does not start' } };
    }
    const res = io.requestRestart({ reason: input.reason, then: input.then, continueTurn: true, force: true });
    if (!res.ok) return { isError: true, content: res.message };
    const secs = Math.max(1, Math.round(check.ms / 1000));
    return {
      content: `The new code starts fine (checked in ${secs}s). ${APP_NAME} restarts as soon as this turn ends and the conversation continues in the new process${input.then ? ` with your note: "${input.then}"` : ''}. Finish this turn now with a short message to the user; do not change anything more and do not call Restart again.`,
      display: { summary: `Restarting when this turn ends: ${input.reason}` },
    };
  },
};
