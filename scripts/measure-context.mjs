#!/usr/bin/env node
// Measure, on your own claude-pro sessions, what two proposed changes would save before deciding on them:
//   A. "file unchanged": a Read that returns exactly what an earlier Read of the same file and range returned,
//      while that earlier copy is still in the conversation (Claude Code answers such a Read with a short note);
//   B. "idle clearing": at a message that comes more than 65 minutes after the previous one (the 1-hour prompt
//      cache has expired, so the next request writes everything again anyway), replacing the results of all but
//      the last 5 tool uses, and all thinking blocks, with short placeholders (Claude Code has the same thresholds).
// It reads the session files (nothing is sent anywhere) and prints the estimated savings in the cost model used
// for the cache work: cache read 0.1, cache write 2.0 (1-hour TTL; --write=1.25 for 5 minutes), per input token.
//
//   node scripts/measure-context.mjs                       all sessions in <config dir>/projects
//   node scripts/measure-context.mjs path/to/session.jsonl  some sessions (files or directories)
//   options: --write=2 --idle=65 (minutes) --keep=5 --at-least=20000 (tokens) --top=5

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => Number(args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const WRITE = option('write', 2);
const IDLE_MS = option('idle', 65) * 60_000;
const KEEP = option('keep', 5);
const AT_LEAST = option('at-least', 20_000);
const TOP = option('top', 5);
const PREFIX = 13_000; // the system prompt and the tools, cached like the rest of the request
const CONFIG_DIR = process.env.CLAUDE_PRO_CONFIG_DIR || path.join(os.homedir(), '.claude-pro');

// The same rough estimate the program uses: 4 ASCII characters or 1.25 other characters per token.
function tokens(text) {
  let ascii = 0, other = 0;
  for (let i = 0; i < text.length; i++) (text.charCodeAt(i) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4 + other * 0.8);
}
const blocksOf = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []);
function blockTokens(b) {
  switch (b.type) {
    case 'text': return tokens(b.text || '');
    case 'thinking': return tokens(b.thinking || '');
    case 'redacted_thinking': return tokens(b.data || '');
    case 'tool_use': return tokens(JSON.stringify(b.input || {})) + 10;
    case 'tool_result': return typeof b.content === 'string' ? tokens(b.content) : blocksOf(b).reduce((n, c) => n + blockTokens(c), 0);
    case 'image': return 1600;
    default: return tokens(JSON.stringify(b));
  }
}
const messageTokens = (m) => blocksOf(m).reduce((n, b) => n + blockTokens(b), 0);
const resultText = (b) => (typeof b.content === 'string' ? b.content : blocksOf(b).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));

function sessionFiles(inputs) {
  const out = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
    else if (p.endsWith('.jsonl') && !p.includes(`${path.sep}tool-results${path.sep}`)) out.push(p);
  };
  for (const p of inputs.length ? inputs : [path.join(CONFIG_DIR, 'projects')]) walk(p);
  return out;
}

function analyse(file) {
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'message' && e.message) events.push({ kind: 'message', message: e.message, at: e.at || 0 });
      else if (e.type === 'reset' && Array.isArray(e.messages)) events.push({ kind: 'reset', messages: e.messages });
    } catch { /* a half-written line */ }
  }
  const s = { file, requests: 0, cost: 0, dupReads: 0, dupTokens: 0, savedA: 0, idleReturns: 0, cleared: 0, savedB: 0, largestHistory: 0 };
  let conversation = []; // {message, tokens}
  let history = PREFIX; // tokens in the conversation, prefix included
  let added = 0; // tokens added since the last request
  let rewritten = true; // the next request writes everything (first request, after a reset)
  let lastAt = 0; // when the last message was stored
  let pendingIdle = false; // the newest message came after a long pause
  let alive = []; // savings that are in every later request: {kind, tokens, fresh}
  let reads = new Map(); // file|offset|limit -> text of the latest Read result in the conversation
  const toolUses = new Map(); // tool_use id -> {name, input}

  const request = (at) => {
    s.requests++;
    const cold = rewritten || pendingIdle;
    s.cost += cold ? WRITE * history : 0.1 * (history - added) + WRITE * added;
    for (const item of alive) {
      const saved = item.tokens * (cold || item.fresh ? WRITE : 0.1);
      if (item.kind === 'A') s.savedA += saved; else s.savedB += saved;
      item.fresh = false;
    }
    s.largestHistory = Math.max(s.largestHistory, history);
    added = 0;
    rewritten = false;
    pendingIdle = false;
  };
  const push = (message) => {
    const t = messageTokens(message);
    conversation.push({ message, tokens: t });
    history += t;
    added += t;
  };

  for (const e of events) {
    if (e.kind === 'reset') { // compaction, /clear, a rewind: another conversation from here on
      conversation = [];
      history = PREFIX;
      added = 0;
      alive = [];
      reads = new Map();
      for (const m of e.messages) push(m);
      rewritten = true;
      continue;
    }
    const m = e.message;
    if (m.role === 'assistant') {
      request(e.at);
      for (const b of blocksOf(m)) if (b.type === 'tool_use') toolUses.set(b.id, { name: b.name, input: b.input || {} });
      push(m);
      lastAt = e.at || lastAt;
      continue;
    }
    // A user message: the user's own, or the results of tool calls.
    const blocks = blocksOf(m);
    const isTurn = !blocks.some((b) => b.type === 'tool_result');
    if (isTurn && lastAt && e.at && e.at - lastAt > IDLE_MS) {
      pendingIdle = true;
      // B: what clearing would take out of the conversation at this point
      const results = [];
      for (const { message } of conversation) for (const b of blocksOf(message)) if (b.type === 'tool_result') results.push(b);
      const keep = new Set(results.slice(-KEEP).map((b) => b.tool_use_id));
      let clearable = 0;
      for (const b of results) if (!keep.has(b.tool_use_id)) clearable += Math.max(0, blockTokens(b) - 15);
      for (const { message } of conversation) if (message.role === 'assistant') for (const b of blocksOf(message)) if (b.type === 'thinking' || b.type === 'redacted_thinking') clearable += blockTokens(b);
      if (clearable >= AT_LEAST) {
        s.idleReturns++;
        s.cleared += clearable;
        alive.push({ kind: 'B', tokens: clearable, fresh: false });
      }
    }
    for (const b of blocks) {
      if (b.type !== 'tool_result' || b.is_error) continue;
      const use = toolUses.get(b.tool_use_id);
      if (use?.name !== 'Read') continue;
      const key = `${use.input.file_path}|${use.input.offset ?? ''}|${use.input.limit ?? ''}`;
      const text = resultText(b);
      if (reads.get(key) === text) { // A: the same content is already in the conversation
        const t = Math.max(0, tokens(text) - 40);
        s.dupReads++;
        s.dupTokens += t;
        alive.push({ kind: 'A', tokens: t, fresh: true });
      }
      reads.set(key, text);
    }
    push(m);
    lastAt = e.at || lastAt;
  }
  return s;
}

const files = sessionFiles(args.filter((a) => !a.startsWith('--')));
if (!files.length) {
  console.log(`No session files found (looked in ${path.join(CONFIG_DIR, 'projects')}).`);
  process.exit(0);
}
const sessions = files.map(analyse).filter((s) => s.requests > 0);
const sum = (k) => sessions.reduce((n, s) => n + s[k], 0);
const M = (n) => `${(n / 1e6).toFixed(2)}M`;
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');
const total = sum('cost');

console.log(`Sessions: ${sessions.length} · requests: ${sum('requests')} · input cost model: ${M(total)} token-equivalents (cache write ${WRITE}, read 0.1)`);
console.log('');
console.log(`A. "File unchanged" for an identical re-read`);
console.log(`   duplicate reads: ${sum('dupReads')} (${M(sum('dupTokens'))} tokens of content)`);
console.log(`   saving: ${M(sum('savedA'))} = ${pct(sum('savedA'), total)} of the input cost`);
console.log('');
console.log(`B. Clearing old tool results and thinking after more than ${IDLE_MS / 60_000} minutes idle (keep the last ${KEEP} tool uses, at least ${AT_LEAST} tokens)`);
console.log(`   idle returns that qualify: ${sum('idleReturns')} · tokens cleared in all: ${M(sum('cleared'))}`);
console.log(`   saving: ${M(sum('savedB'))} = ${pct(sum('savedB'), total)} of the input cost (before the cost of reading files again)`);
const top = [...sessions].sort((a, b) => b.savedA + b.savedB - (a.savedA + a.savedB)).slice(0, TOP).filter((s) => s.savedA + s.savedB > 0);
if (top.length) {
  console.log('');
  console.log('Sessions that would save the most:');
  for (const s of top) console.log(`   ${path.basename(s.file)}  ${s.requests} requests, history up to ${Math.round(s.largestHistory / 1000)}k · A ${pct(s.savedA, s.cost)} · B ${pct(s.savedB, s.cost)}`);
}
console.log('');
console.log('Estimates from the session files: tokens are approximated, output and the cost of the new placeholders are left out, and B assumes the 1-hour cache (with --write=1.25 and --idle=5 for a 5-minute one). A and B are measured each on its own: together they save less than the sum, since B also clears duplicate reads.');
