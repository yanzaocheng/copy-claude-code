// ListPeers and MessagePeer: talk to the other claude-pro sessions, on this machine and, through the gateway, on the
// user's other computers (see peers.js and remote.js).

import { resolvePath } from '../utils/paths.js';

const unavailable = { isError: true, content: 'Talking to other sessions is only available in an interactive session.' };

export const ListPeersTool = {
  name: 'ListPeers',
  description: 'List the other claude-pro sessions (each is an agent with its own conversation, working in its own directory): those running on this machine, and those on the user\'s other computers that are online at the gateway, with the name to send them a message with MessagePeer.',
  input_schema: { type: 'object', properties: {} },
  summarize() { return ''; },
  async call(input, ctx) {
    if (!ctx.io?.listAllPeers) return unavailable;
    const { me, local, remote, online } = await ctx.io.listAllPeers();
    const head = `You are "${me.name}" (${me.cwd})${online ? `; sessions on other computers know you as "${me.label}"` : ''}.`;
    const count = local.length + remote.length;
    if (!count) return { content: `${head}\nNo other session is running${online ? '' : ' on this machine (this session is not online at the gateway, so sessions on other computers are not listed)'}.`, display: { summary: 'No other session' } };
    const lines = [head];
    if (local.length) lines.push('On this machine:', ...local.map((p) => `- ${p.name}: working in ${p.cwd}`));
    if (remote.length) lines.push('On the user\'s other computers (through the gateway):', ...remote.map((p) => `- ${p.label}: working in ${p.cwd} on the computer "${p.machine}"${p.busy ? ' (busy now)' : ''}`));
    return { content: lines.join('\n'), display: { summary: `${count} other session${count === 1 ? '' : 's'}` } };
  },
};

export const MessagePeerTool = {
  name: 'MessagePeer',
  description: `Send a task or a question to another claude-pro session, on this machine or on one of the user's other computers (ListPeers lists them). The other session's agent works on it in its own conversation and directory, and the final text of its answer comes back to you later as a <peer-message kind="reply"> message: you do not wait for it here. Use it to delegate work that belongs to another session's project or context, or to ask it something only it knows. Write the message so that it stands on its own: the other agent has not seen your conversation.

Send it once and wait for the answer: do not send reminders or "please report" follow-ups while the other session works. Messages that arrive while it is busy are handled together after what it is doing, so they only add to its work; the answer comes by itself when it is done.`,
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'The name of the session as ListPeers shows it (computer/name for one on another computer)' },
      message: { type: 'string', description: 'The task or question, self-contained (may be left out when only sending files)' },
      files: { type: 'array', items: { type: 'string' }, description: 'Paths of files on this computer to send along (at most 20, 5 GB each; large ones go in the background and continue after a network outage). The other session saves them in its computer\'s Downloads folder, and is told where. With files and no message it only saves them and confirms, without working on anything.' },
    },
    required: ['to'],
  },
  summarize(input) { return `@${input.to}`; },
  async call(input, ctx) {
    if (!ctx.io?.sendToPeer) return unavailable;
    const files = (Array.isArray(input.files) ? input.files : []).map((p) => resolvePath(String(p), ctx.cwd));
    if (!String(input.message || '').trim() && !files.length) return { isError: true, content: 'Give a message, or files to send.' };
    try {
      const { peer, background } = await ctx.io.sendToPeer(input.to, String(input.message || ''), { byModel: true, files, background: true });
      const name = peer.label || peer.name;
      if (background) return { content: `Sending ${files.length} file${files.length === 1 ? '' : 's'} to ${name} in the background (the user sees the progress); the message goes out once they are uploaded, and the answer of ${name} comes back later as a message. Carry on meanwhile, or end your turn.`, display: { summary: `Sending ${files.length} file${files.length === 1 ? '' : 's'} to ${name}` } };
      return { content: `Sent to ${name}. Its answer will arrive later as a message; carry on meanwhile, or end your turn if you need the answer first.`, display: { summary: `Sent to ${name}` } };
    } catch (e) {
      return { isError: true, content: e.message };
    }
  },
};
