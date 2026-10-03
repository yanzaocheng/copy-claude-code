// Formatting of transcript items: user prompts, tool calls and results, diffs, todos.

import { c, stringWidth, truncate, padEnd, wordWrap, wrapLine } from './ansi.js';
import { displayPath } from '../utils/paths.js';
import { renderMarkdown } from './markdown.js';

export const DOT = '⏺';
const RESULT_PREFIX = '  ⎿  ';
const RESULT_INDENT = '     ';

export function toolLabel(tool, input) {
  return tool.label?.(input) || tool.name;
}

export function toolHeader(tool, input, ctx, { status = 'done', width = 100, dot: showDot = true } = {}) {
  const dot = status === 'error' ? c.red(DOT) : status === 'running' ? (Date.now() % 1000 < 500 ? c.gray(DOT) : ' ') : status === 'rejected' ? c.red(DOT) : c.green(DOT);
  let summary = '';
  try { summary = tool.summarize?.(input || {}, ctx) ?? ''; } catch { summary = ''; }
  summary = summary.replace(/\s*\n\s*/g, ' ');
  const label = c.bold(toolLabel(tool, input));
  const head = showDot ? `${dot} ${label}` : label;
  if (!summary) return head;
  return truncate(`${head}(${summary})`, Math.max(20, width - 2)) + (stringWidth(`${head}(${summary})`) > width - 2 ? ')' : '');
}

export function resultLines(lines) {
  return lines.map((l, i) => (i === 0 ? c.gray(RESULT_PREFIX) : RESULT_INDENT) + l);
}

function numberWidth(hunks) {
  let max = 1;
  for (const h of hunks) for (const l of h.lines) max = Math.max(max, l.oldNo || 0, l.newNo || 0);
  return String(max).length;
}

export function renderDiff(preview, width, maxLines = 40) {
  const out = [];
  const w = Math.max(20, width - RESULT_INDENT.length - 1);
  if (preview.kind === 'create') {
    const nw = String(preview.lines.length).length;
    preview.lines.slice(0, maxLines).forEach((line, i) => {
      out.push(c.diffAdd(padEnd(truncate(`${String(i + 1).padStart(nw)} + ${line.replace(/\t/g, '  ')}`, w), w)));
    });
    if (preview.lines.length > maxLines) out.push(c.dim(`… +${preview.lines.length - maxLines} lines`));
    return out;
  }
  const nw = numberWidth(preview.hunks);
  let count = 0;
  preview.hunks.forEach((h, hi) => {
    if (hi > 0) out.push(c.dim(' '.repeat(nw) + ' ...'));
    for (const l of h.lines) {
      if (count++ >= maxLines) continue;
      const text = l.line.replace(/\t/g, '  ');
      if (l.op === '-') out.push(c.diffDel(padEnd(truncate(`${String(l.oldNo).padStart(nw)} - ${text}`, w), w)));
      else if (l.op === '+') out.push(c.diffAdd(padEnd(truncate(`${String(l.newNo).padStart(nw)} + ${text}`, w), w)));
      else out.push(truncate(`${c.dim(String(l.newNo).padStart(nw))}   ${text}`, w));
    }
  });
  if (count > maxLines) out.push(c.dim(`… +${count - maxLines} more diff lines`));
  return out;
}

export function renderTodos(todos, { prefix = true } = {}) {
  const lines = todos.map((t) => {
    if (t.status === 'completed') return c.dim(c.strike(`☒ ${t.content}`));
    if (t.status === 'in_progress') return c.bold(`◼ ${t.content}`);
    return `☐ ${t.content}`;
  });
  if (!lines.length) lines.push(c.dim('(todo list cleared)'));
  return prefix ? resultLines(lines) : lines;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
}

// Lines shown under a tool header once it has finished.
export function renderToolResult(entry, { verbose = false, width = 100, cwd }) {
  const { tool, result } = entry;
  const r = result || {};
  const d = r.display || {};
  const w = Math.max(20, width - RESULT_INDENT.length - 1);
  if (entry.rejected) {
    return resultLines([c.red(entry.rejectMessage ? truncate(entry.rejectMessage.split('\n')[0], w) : 'Rejected by user')]);
  }
  if (r.interrupted) {
    const partial = d.output ? d.output.trimEnd().split('\n').slice(-3) : [];
    return resultLines([...partial.map((l) => c.dim(truncate(l, w))), c.red('Interrupted by user')]);
  }
  if (d.todos) return renderTodos(d.todos);
  if (d.plan !== undefined) {
    const md = renderMarkdown(d.plan, { width: w });
    return resultLines([d.approved ? c.green('User approved the plan') : c.yellow('User asked to keep planning'), ...(verbose ? md : [])]);
  }
  if (d.preview && !r.isError) {
    const lines = [d.summary ? `${d.summary}` : ''];
    if (d.preview.kind === 'create' && !verbose) return resultLines([d.summary || `Created ${displayPath(d.preview.path, cwd)}`]);
    lines.push(...renderDiff(d.preview, width - RESULT_INDENT.length, verbose ? 400 : 30));
    return resultLines(lines);
  }
  if (tool.name === 'Bash' && !r.isError && d.output !== undefined) {
    const all = d.output ? d.output.split('\n') : [];
    if (!all.length) return resultLines([c.dim('(No content)')]);
    const max = verbose ? 200 : 5;
    const shown = all.slice(0, max).flatMap((l) => wrapLine(l, w)).slice(0, verbose ? 400 : 8);
    if (all.length > max) shown.push(c.dim(`… +${all.length - max} lines`));
    return resultLines(shown);
  }
  if (r.isError) {
    const text = contentText(r.content).trim() || 'Error';
    const all = text.split('\n');
    const max = verbose ? 100 : 6;
    const shown = all.slice(0, max).flatMap((l) => wordWrap(l, w)).map((l) => c.red(l));
    if (all.length > max) shown.push(c.dim(`… +${all.length - max} lines`));
    return resultLines(shown);
  }
  if (d.summary) {
    const lines = [d.summary];
    if (verbose && typeof r.content === 'string') lines.push(...r.content.split('\n').slice(0, 60).map((l) => c.dim(truncate(l, w))));
    return resultLines(lines);
  }
  const text = contentText(r.content).trim();
  const all = text ? text.split('\n') : [];
  if (!all.length) return resultLines([c.dim('(No content)')]);
  const max = verbose ? 100 : 3;
  const shown = all.slice(0, max).map((l) => truncate(l, w));
  if (all.length > max) shown.push(c.dim(`… +${all.length - max} lines`));
  return resultLines(shown);
}

export function renderUserMessage(text, width) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  lines.forEach((l, i) => {
    const wrapped = wordWrap(l, Math.max(10, width - 3));
    wrapped.forEach((wl, j) => out.push((i === 0 && j === 0 ? c.gray('> ') : '  ') + c.gray(wl)));
  });
  if (out.length > 30) return [...out.slice(0, 25), c.dim(`  … +${out.length - 25} lines`)];
  return out;
}

export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
