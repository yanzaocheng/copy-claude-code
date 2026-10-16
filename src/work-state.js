// Validation and recovery helpers for the machine-readable state that survives compaction.

export const WORK_STATE_VERSION = 1;

const TEXT_FIELDS = ['objective', 'next_action'];
const LIST_FIELDS = ['constraints', 'decisions', 'files', 'edits', 'tests', 'failures', 'open_questions', 'tool_artifacts'];
const ALL_FIELDS = ['schema_version', ...TEXT_FIELDS, ...LIST_FIELDS];
const MAX_TEXT_CHARS = 4_000;
const MAX_LIST_ITEMS = 50;
const MAX_ITEM_CHARS = 2_000;

export function validateWorkState(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['state must be a JSON object'] };
  if (value.schema_version !== WORK_STATE_VERSION) errors.push(`schema_version must be ${WORK_STATE_VERSION}`);
  for (const key of TEXT_FIELDS) {
    if (typeof value[key] !== 'string') errors.push(`${key} must be a string`);
    else if (value[key].length > MAX_TEXT_CHARS) errors.push(`${key} is longer than ${MAX_TEXT_CHARS} characters`);
  }
  for (const key of LIST_FIELDS) {
    if (!Array.isArray(value[key])) {
      errors.push(`${key} must be an array`);
      continue;
    }
    if (value[key].length > MAX_LIST_ITEMS) errors.push(`${key} has more than ${MAX_LIST_ITEMS} items`);
    for (const [i, item] of value[key].entries()) {
      if (typeof item !== 'string') errors.push(`${key}[${i}] must be a string`);
      else if (item.length > MAX_ITEM_CHARS) errors.push(`${key}[${i}] is longer than ${MAX_ITEM_CHARS} characters`);
    }
  }
  if (errors.length) return { ok: false, errors };
  // Copy only the schema we understand. This keeps future model-added fields from becoming an
  // unbounded part of every later context window while retaining a stable versioned shape.
  return { ok: true, value: Object.fromEntries(ALL_FIELDS.map((key) => [key, key === 'schema_version' ? WORK_STATE_VERSION : value[key]])) };
}

export function workStateFromText(text) {
  const source = String(text ?? '');
  const match = /<work-state>\s*([\s\S]*?)\s*<\/work-state>/i.exec(source);
  if (!match) return { present: false, state: null, errors: [] };
  let value;
  try {
    value = JSON.parse(match[1].replace(/^```(?:json)?\s*|\s*```$/gi, '').trim());
  } catch (err) {
    return { present: true, state: null, errors: [`invalid JSON: ${err.message}`] };
  }
  const checked = validateWorkState(value);
  return { present: true, state: checked.ok ? checked.value : null, errors: checked.errors || [] };
}

export function latestWorkState(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    for (let j = blocks.length - 1; j >= 0; j--) {
      if (blocks[j]?.type !== 'text') continue;
      const parsed = workStateFromText(blocks[j].text);
      if (parsed.state) return parsed.state;
    }
  }
  return null;
}
