import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDE_PRO_CONFIG_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-trace-config-'));

const { RuntimeTrace } = await import('../src/trace.js');
const { Agent } = await import('../src/agent.js');
const { Config } = await import('../src/config.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-trace-'));
const reply = (content, stopReason = 'end_turn') => ({ message: { role: 'assistant', content }, stopReason });
const toolUse = (id, name, input) => reply([{ type: 'tool_use', id, name, input }], 'tool_use');

 test('RuntimeTrace persists structural metrics without prompt, argument, output or command values', () => {
  const cwd = tmp();
  const dir = path.join(cwd, 'trace-files');
  const trace = new RuntimeTrace({ cwd, sessionId: 'session-one', dir, maxBytes: 100_000 });
  const turnId = trace.turnStart({ agent: 'main', depth: 0, content: [{ type: 'text', text: 'PRIVATE_PROMPT secret-token' }] });
  const request = trace.requestStart({
    turnId,
    agent: 'main',
    model: 'mock',
    effort: 'high',
    context_tokens: 1234,
    cache: { bucket: 'main', messages: true },
  });
  trace.requestEvent(request, { type: 'retry', delayMs: 10 });
  trace.requestEnd(request, {
    model: 'mock',
    stopReason: 'end_turn',
    context_tokens: 1400,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
    cache: { caching: true, ttl: '1h', fingerprint: { system: 'system-fp', tools: 'tools-fp' } },
  });
  const tool = trace.toolStart({ turnId, agent: 'main', name: 'Bash', input: { command: 'echo secret-token', password: 'PRIVATE_PASSWORD' }, parallel: true, toolUseId: 'toolu-1' });
  trace.toolEnd(tool, { ok: true, output: 'PRIVATE_OUTPUT secret-token', large_output_persisted: true });
  trace.verification({ turnId, command: 'TOKEN=PRIVATE_TOKEN npm test', attempt: 1, ok: true, output: 'PRIVATE_VERIFY_OUTPUT' });
  trace.compact({ turnId, auto: true, before_context_tokens: 50_000, after_context_tokens: 2_000, summary_chars: 120, work_state_valid: true, duration_ms: 12 });
  trace.turnEnd({ turnId, finalStatus: 'completed' });

  const text = fs.readFileSync(trace.file, 'utf8');
  assert.doesNotMatch(text, /PRIVATE_PROMPT|secret-token|PRIVATE_PASSWORD|PRIVATE_OUTPUT|PRIVATE_TOKEN|PRIVATE_VERIFY_OUTPUT/);
  assert.match(text, /"type":"tool_start"/);
  assert.match(text, /"input":\{"type":"object"/);
  assert.match(text, /"cache_hit":true/);
  assert.match(text, /"large_output_persisted":true/);
  const summary = trace.summary();
  assert.equal(summary.requests, 1);
  assert.equal(summary.cache_hits, 1);
  assert.equal(summary.compactions, 1);
  assert.equal(summary.verification_passes, 1);
  assert.deepEqual(summary.tools[0].calls, 1);
  assert.equal(summary.tools[0].parallel_calls, 1);
  assert.equal(summary.tools[0].large_output_persisted, 1);
  assert.equal(trace.recent(2).length, 2);
});

test('RuntimeTrace changes files and resets aggregates when the session changes', () => {
  const cwd = tmp();
  const trace = new RuntimeTrace({ cwd, sessionId: 'first', dir: cwd });
  const first = trace.file;
  trace.turnStart({ content: 'one' });
  trace.setSessionId('second');
  assert.notEqual(trace.file, first);
  assert.equal(trace.summary().turns, 0);
  trace.turnStart({ content: 'two' });
  assert.ok(fs.existsSync(trace.file));
  assert.ok(fs.existsSync(first));
});

test('Agent records validation failures and tool timing in the shared trace', async () => {
  const cwd = tmp();
  const config = new Config({ CLAUDE_PRO_GATEWAY_MODEL: 'mock' }, {}, { hooks: {}, mcpServers: {} }, cwd);
  const trace = new RuntimeTrace({ cwd, sessionId: 'agent-session', dir: cwd });
  const Required = {
    name: 'Required',
    readOnly: true,
    description: 'test',
    input_schema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
    async call() { return { content: 'ok' }; },
  };
  const agent = new Agent({ config, tools: [Required], systemPrompt: 'system', io: {}, model: config.model, cwd, trace });
  let calls = 0;
  agent.callModel = async () => ++calls === 1
    ? toolUse('toolu-invalid', 'Required', {})
    : reply([{ type: 'text', text: 'done' }]);
  const result = await agent.run('test');
  assert.equal(result.text, 'done');
  const tool = trace.summary().tools.find((item) => item.name === 'Required');
  assert.equal(tool.calls, 1);
  assert.equal(tool.failures, 1);
  assert.equal(tool.validation_errors, 1);
  assert.equal(trace.summary().turns, 1);
  const events = fs.readFileSync(trace.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === 'turn_end').length, 1);
  assert.equal(events.find((event) => event.type === 'turn_end').final_status, 'completed');
});
