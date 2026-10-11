// ListPeers and MessagePeer: talk to the other claude-pro sessions running on this machine (see peers.js).

const unavailable = { isError: true, content: 'Talking to other sessions is only available in an interactive session.' };

export const ListPeersTool = {
  name: 'ListPeers',
  description: 'List the other claude-pro sessions running on this machine (each is an agent with its own conversation, working in its own directory), with the name to send them a message with MessagePeer.',
  input_schema: { type: 'object', properties: {} },
  summarize() { return ''; },
  async call(input, ctx) {
    const node = ctx.io?.peers;
    if (!node) return unavailable;
    const peers = node.peers();
    const me = `You are "${node.name}" (${node.cwd}).`;
    if (!peers.length) return { content: `${me}\nNo other session is running.`, display: { summary: 'No other session' } };
    return {
      content: `${me}\nOther sessions:\n${peers.map((p) => `- ${p.name}: working in ${p.cwd}`).join('\n')}`,
      display: { summary: `${peers.length} other session${peers.length === 1 ? '' : 's'}` },
    };
  },
};

export const MessagePeerTool = {
  name: 'MessagePeer',
  description: `Send a task or a question to another claude-pro session running on this machine (ListPeers lists them). The other session's agent works on it in its own conversation and directory, and the final text of its answer comes back to you later as a <peer-message kind="reply"> message: you do not wait for it here. Use it to delegate work that belongs to another session's project or context, or to ask it something only it knows. Write the message so that it stands on its own: the other agent has not seen your conversation.

Send it once and wait for the answer: do not send reminders or "please report" follow-ups while the other session works. Messages that arrive while it is busy are handled together after what it is doing, so they only add to its work; the answer comes by itself when it is done.`,
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'The name of the session (as ListPeers shows it)' },
      message: { type: 'string', description: 'The task or question, self-contained' },
    },
    required: ['to', 'message'],
  },
  summarize(input) { return `@${input.to}`; },
  async call(input, ctx) {
    const node = ctx.io?.peers;
    if (!node) return unavailable;
    try {
      const { peer } = await ctx.io.sendToPeer(input.to, input.message, { byModel: true });
      return { content: `Sent to ${peer.name}. Its answer will arrive later as a message; carry on meanwhile, or end your turn if you need the answer first.`, display: { summary: `Sent to ${peer.name}` } };
    } catch (e) {
      return { isError: true, content: e.message };
    }
  },
};
