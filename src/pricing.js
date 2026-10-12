// What a request costs, in USD, for the running total of a conversation (the footer, /cost). The prices are the
// official per-million-token ones the gateway bills at (its pricing.mjs); a gateway upstream group's multiplier
// (1 unless the account is set otherwise) is not known here. A Claude model that is not in the table is priced
// as the current model of its family, as the gateway serves it. longContext: a prompt (input + cache reads +
// cache writes) above `threshold` tokens is billed at those prices.

const PRICES = [
  { id: 'claude-fable-5-1', family: 'fable', input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  { id: 'claude-opus-5-5', family: 'opus', input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  { id: 'claude-sonnet-5-5', family: 'sonnet', input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
  {
    id: 'claude-haiku-5-5', family: 'haiku', input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01,
    longContext: { threshold: 100_000, input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 },
  },
  {
    id: 'gpt-6-astra', input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 12.5,
    longContext: { threshold: 272_000, input: 20, output: 75, cacheWrite5m: 25, cacheWrite1h: 25, cacheRead: 2 },
  },
  {
    id: 'gpt-6-1-sol', input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 2.5,
    longContext: { threshold: 272_000, input: 4, output: 15, cacheWrite5m: 5, cacheWrite1h: 5, cacheRead: 0.2 },
  },
  {
    id: 'gpt-6-luna', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.125,
    longContext: { threshold: 272_000, input: 0.2, output: 0.75, cacheWrite5m: 0.25, cacheWrite1h: 0.25, cacheRead: 0.02 },
  },
];

// claude-opus-5-5, anthropic/claude-opus-5-5[1m], claude-haiku-5-5-20261001, gpt-6.1-sol:high -> the table's id form
function cleanModel(model) {
  const value = String(model || '').trim().toLowerCase();
  return (value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value)
    .replace(/\[1m\]$/, '')
    .replace(/[:@](none|minimal|low|medium|high|xhigh|max|ultra)$/, '')
    .replace(/(\d)\.(\d)/g, '$1-$2')
    .replace(/-\d{8}$/, '');
}

// The prices of a model, or null when it has none here (a model of another endpoint).
export function priceOf(model) {
  const id = cleanModel(model);
  const exact = PRICES.find((p) => p.id === id);
  if (exact) return exact;
  const family = id.startsWith('claude-') && id.match(/\b(fable|opus|sonnet|haiku)\b/)?.[1];
  return (family && PRICES.find((p) => p.family === family)) || null;
}

// USD for one request's usage as the API reports it; null for a model with no price.
export function costOf(model, usage = {}) {
  const price = priceOf(model);
  if (!price) return null;
  const n = (v) => Math.max(0, Number(v) || 0);
  const input = n(usage.input_tokens);
  const read = n(usage.cache_read_input_tokens);
  const oneHour = n(usage.cache_creation?.ephemeral_1h_input_tokens);
  const writes = Math.max(n(usage.cache_creation_input_tokens), n(usage.cache_creation?.ephemeral_5m_input_tokens) + oneHour);
  const p = price.longContext && input + read + writes > price.longContext.threshold ? price.longContext : price;
  return (input * p.input + n(usage.output_tokens) * p.output + read * p.cacheRead + (writes - oneHour) * p.cacheWrite5m + oneHour * p.cacheWrite1h) / 1e6;
}
