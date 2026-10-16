import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestWorkState, validateWorkState, workStateFromText } from '../src/work-state.js';

const valid = {
  schema_version: 1,
  objective: 'fix the parser',
  constraints: ['keep the public API'],
  decisions: ['use a strict versioned shape'],
  files: ['src/work-state.js'],
  edits: ['added validation'],
  tests: ['node --test test/work-state.test.js'],
  failures: [],
  open_questions: [],
  next_action: 'run the tests',
  tool_artifacts: [],
};

test('work-state validation accepts the versioned schema and drops unknown fields', () => {
  const result = validateWorkState({ ...valid, future_field: 'ignored' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, valid);
});

test('work-state validation rejects missing fields and non-string list items', () => {
  const result = validateWorkState({ ...valid, files: ['ok', 42], next_action: null });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /next_action must be a string/);
  assert.match(result.errors.join(' '), /files\[1\] must be a string/);
});

test('work-state parsing accepts JSON in the tagged block and finds the newest valid state', () => {
  const parsed = workStateFromText(`<work-state>\n\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n</work-state>`);
  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.state, valid);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '<work-state>{"schema_version":1}</work-state>' }] },
    { role: 'user', content: [{ type: 'text', text: `<work-state>${JSON.stringify(valid)}</work-state>` }] },
  ];
  assert.deepEqual(latestWorkState(messages), valid);
});
