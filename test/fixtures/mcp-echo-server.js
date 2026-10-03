#!/usr/bin/env node
// Tiny stdio MCP server used by the tests: tools "echo" and "add".
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const tools = [
  { name: 'echo', description: 'Echo back the given text, reversed', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
];

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo-server', version: '1.0.0' } } });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
      break;
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (name === 'echo') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: [...String(args.text)].reverse().join('') }] } });
      else if (name === 'add') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(args.a + args.b) }] } });
      else send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true } });
      break;
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
