// What a compaction asks the model for, and the message that then stands for the summarized conversation. Kept out
// of prompts.js, whose text is hashed into PROMPT_CODE_VERSION: a change here does not make every running
// conversation rebuild its system prompt and write its prompt cache again.

// The system prompt of the plain summary request (see Agent.requestSummary).
export const SUMMARY_SYSTEM = 'You are a helpful AI assistant tasked with summarizing conversations.';

export function compactPrompt(instructions) {
  return `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools: the conversation above is complete, and the only thing wanted now is the structured state and summary below.

What you write now takes the place of the conversation above (or of the part of it named below). Whoever carries on the work (you, without the conversation) has only that, the files on disk, and the user's own messages, which are kept word for word (the newest ones; in a long conversation the oldest may be shortened or left out). So do not repeat the user's messages: write what is needed to go on with the work as if nothing had been lost.

First write exactly one <work-state> block containing one valid JSON object. Do not use markdown fences inside the block. Use this schema exactly; use an empty string or [] when a field has no value:
<work-state>
{"schema_version":1,"objective":"","constraints":[],"decisions":[],"files":[],"edits":[],"tests":[],"failures":[],"open_questions":[],"next_action":"","tool_artifacts":[]}
</work-state>
All array items must be strings. Keep paths, commands, error messages and next actions precise. The state is machine-validated, so do not add prose before or after the JSON inside <work-state>.

Then write in <summary> tags a handoff with what the work-state does not hold, concise and specific, without repeating its items:
1. Where the work stands: what is done and verified, what is half done, and what was left running or unfinished (a server, a background agent, edits not yet tested).
2. Why things were decided as they were, and what was tried and did not work, so that it is not tried again.
3. What still holds from earlier in the conversation and is not plain from the user's newest messages: requests, preferences and corrections (the oldest messages may be gone).
4. Facts that would be costly to find again: exact error messages, values, IDs, URLs, short code snippets.
5. The next step, in line with the user's latest request.

Do your reasoning in your thinking, not in the reply: only the work-state and the summary are kept, so text outside them is thrown away. What is kept is read again with every later request, and every line of it takes time to write (a long summary makes the compaction take minutes longer), so leave out what the work can go on without.
Write the summary in the same language the user has been using.
Do NOT call any tools. Respond with text only.${instructions ? `\n\nAdditional instructions from the user for this summary:\n${instructions}` : ''}`;
}

// The instruction for /rewind's "Summarize from here" (part 'after') and "Summarize up to here" ('before'): only
// that part of the conversation is summarized, the rest stays in it word for word.
export function partialCompactPrompt(part, label, instructions = '') {
  const at = label ? `the user's message that begins "${String(label).slice(0, 200)}"` : 'the point the user chose';
  const scope = part === 'before'
    ? `Summarize ONLY the part of the conversation BEFORE ${at}. That message and everything after it stay in the conversation word for word: do not summarize them. The summary replaces only what comes before that message, so it has to carry everything from that earlier part that the rest of the conversation builds on.`
    : `Summarize ONLY the part of the conversation that starts with ${at} (that message included) and goes on to the end. Everything before that message stays in the conversation word for word: do not summarize it. The summary replaces only that later part.`;
  return compactPrompt(`${scope}${instructions ? `\n${instructions}` : ''}`);
}

// The user's own messages go through a compaction word for word, as in Codex (Agent's keptUserMessages picks them):
// a summary that had to retell them all took minutes longer to write and lost their wording. They come after the
// summary, so that the summary's <work-state> is the first one in the text (workStateFromText reads the first).
const KEPT_HEADER = "The user's messages, oldest first (the newest word for word; older ones may be shortened or left out):";

function keptSection(messages) {
  if (!messages?.length) return '';
  // A closing tag inside a message would end it early when it is read back.
  const item = (text) => `<user-message>\n${String(text).replaceAll('</user-message', '<\\/user-message')}\n</user-message>`;
  return `\n\n${KEPT_HEADER}\n<user-messages>\n${messages.map(item).join('\n')}\n</user-messages>`;
}

// The user's messages that a summary message (continuationMessage, partialSummaryMessage) kept, oldest first.
export function keptUserMessagesIn(text) {
  const source = String(text ?? '');
  const start = source.indexOf(`${KEPT_HEADER}\n<user-messages>\n`);
  if (start < 0) return [];
  const section = /<user-messages>\n([\s\S]*?)\n<\/user-messages>/.exec(source.slice(start))?.[1];
  return section ? [...section.matchAll(/<user-message>\n([\s\S]*?)\n<\/user-message>/g)].map((m) => m[1]) : [];
}

// The message that stands in the conversation for the part a partial summary replaced.
export function partialSummaryMessage(part, summary, workState = null, userMessages = []) {
  const state = workState ? `\n\nThe validated structured work state for this summarized section is:\n<work-state>\n${JSON.stringify(workState, null, 2)}\n</work-state>` : '';
  return part === 'before'
    ? `[Summarized conversation] The earlier part of this conversation was summarized at the user's request; the messages after this one are as they were. The summary of the earlier part:${state}\n${summary}${keptSection(userMessages)}`
    : `[Summarized conversation] The later part of this conversation, from the user's message where this summary stands to where it was, was summarized at the user's request. The summary of that part:${state}\n${summary}${keptSection(userMessages)}`;
}

export function continuationMessage(summary, { auto, workState = null, workStateWarning = '', userMessages = [] }) {
  const state = workState ? `\n\nThe validated structured work state is:\n<work-state>\n${JSON.stringify(workState, null, 2)}\n</work-state>` : '';
  const warning = workStateWarning ? `\n\n<system-reminder>${workStateWarning}</system-reminder>` : '';
  return `This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:${state}${warning}
${summary}${keptSection(userMessages)}${auto ? '\n\nPlease continue the conversation from where we left it off without asking the user any further questions. Continue with the last task that you were asked to work on.' : ''}`;
}
