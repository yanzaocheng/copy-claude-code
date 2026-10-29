// Modal dialogs rendered in the live region: selection menus (questions, the model and session pickers, /rewind),
// with a typed answer of their own when they offer "Other".

import { c, padEnd, stringWidth, truncate, wordWrap } from './ansi.js';
import { Editor } from './editor.js';

function box(lines, width, color) {
  const w = Math.max(20, width - 1);
  const inner = w - 4;
  const out = [color('╭' + '─'.repeat(w - 2) + '╮')];
  for (const l of lines) {
    for (const part of stringWidth(l) > inner ? wordWrap(l, inner) : [l]) {
      out.push(color('│') + ' ' + padEnd(part, inner) + ' ' + color('│'));
    }
  }
  out.push(color('╰' + '─'.repeat(w - 2) + '╯'));
  return out;
}

// The rows `lines` take inside box(), which wraps the long ones.
function boxRows(lines, width) {
  const inner = Math.max(20, width - 1) - 4;
  return lines.reduce((n, l) => n + (stringWidth(l) > inner ? wordWrap(l, inner).length : 1), 0);
}

export class SelectDialog {
  // options: [{label, value, description?}]
  // selected: the option highlighted at first.
  constructor({ title, body = [], question, options, color = c.permission, multi = false, footer, onResolve, cancelValue = null, otherOption = false, selected = 0 }) {
    this.title = title;
    this.body = body;
    this.question = question;
    this.options = otherOption ? [...options, { label: 'Other (type your own answer)', value: '__other__' }] : options;
    this.color = color;
    this.multi = multi;
    this.footer = footer;
    this.onResolve = onResolve;
    this.cancelValue = cancelValue;
    this.selected = Math.max(0, Math.min(selected, this.options.length - 1));
    this.checked = new Set();
    this.other = null; // Editor when typing a custom answer
  }

  resolve(value) {
    const cb = this.onResolve;
    this.onResolve = null;
    cb?.(value);
  }

  handleKey(str, key = {}) {
    if (this.other) {
      if (key.name === 'escape') { this.other = null; return true; }
      if (key.name === 'return' && !key.meta) {
        const text = this.other.expanded().trim(); // a long paste is a placeholder in the text
        if (text) this.resolve(this.multi ? [...this.checkedValues(), text] : text);
        return true;
      }
      return this.other.handleKey(str, key);
    }
    const n = this.options.length;
    if (key.name === 'up' || (key.ctrl && key.name === 'p') || str === 'k') { this.selected = (this.selected - 1 + n) % n; return true; }
    if (key.name === 'down' || (key.ctrl && key.name === 'n') || str === 'j' || (key.name === 'tab' && !key.shift)) { this.selected = (this.selected + 1) % n; return true; }
    if (key.name === 'escape') { this.resolve(this.cancelValue); return true; }
    if (/^[1-9]$/.test(str || '') && +str <= n) {
      this.selected = +str - 1;
      if (!this.multi) return this.choose();
      return true;
    }
    if (this.multi && str === ' ') {
      if (this.options[this.selected].value === '__other__') return this.choose();
      if (this.checked.has(this.selected)) this.checked.delete(this.selected); else this.checked.add(this.selected);
      return true;
    }
    if (key.name === 'return') return this.choose();
    return true; // modal: swallow everything else
  }

  choose() {
    const opt = this.options[this.selected];
    if (opt.value === '__other__') {
      this.other = new Editor();
      return true;
    }
    if (this.multi) {
      this.resolve(this.checked.size ? this.checkedValues() : [opt.value]);
    } else {
      this.resolve(opt.value);
    }
    return true;
  }

  // The checked options' values, in the order they are shown (a plain sort() put option 10 before option 2).
  checkedValues() {
    return [...this.checked].sort((a, b) => a - b).map((i) => this.options[i].value);
  }

  render(width, maxHeight = 40) {
    const lines = [];
    if (this.title) lines.push(c.bold(this.color(this.title)), '');
    lines.push(...this.body);
    if (this.body.length) lines.push('');
    if (this.question) lines.push(this.question);
    const inner = Math.max(20, width - 1) - 4;
    // Show a window of options around the selection when they don't all fit.
    const perOption = this.options.some((o) => o.description) ? 2 : 1;
    const room = Math.max(3, Math.floor((maxHeight - boxRows(lines, width) - 4 - (this.other ? 5 : 0)) / perOption));
    let first = 0;
    if (this.options.length > room) first = Math.min(Math.max(0, this.selected - Math.floor(room / 2)), this.options.length - room);
    const last = Math.min(this.options.length, first + room);
    if (first > 0) lines.push(c.dim(`  ↑ ${first} more`));
    for (let i = first; i < last; i++) {
      const o = this.options[i];
      const sel = i === this.selected;
      const mark = this.multi ? (this.checked.has(i) ? c.green('[✔] ') : '[ ] ') : '';
      const label = `${sel ? '❯' : ' '} ${i + 1}. ${mark}${o.label}`;
      lines.push(sel ? this.color(truncate(label, inner)) : truncate(label, inner));
      if (o.description) lines.push(c.dim('      ' + truncate(o.description, inner - 6)));
    }
    if (last < this.options.length) lines.push(c.dim(`  ↓ ${this.options.length - last} more`));
    let cursor = null;
    if (this.other) {
      lines.push('');
      const r = this.other.render(width - 4, { placeholder: 'Type your answer, Enter to submit, Esc to go back' });
      const top = boxRows(lines, width) + 1; // the rows above it once box() has wrapped the long ones, and its top border
      lines.push(...r.lines.map((l) => truncate(l, inner)));
      if (r.cursor) cursor = { row: top + r.cursor.row, col: 2 + r.cursor.col };
    }
    const out = box(lines, width, this.color);
    const hint = this.footer ?? (this.multi ? 'Space to toggle · Enter to confirm · Esc to cancel' : 'Enter to confirm · Esc to cancel');
    out.push(c.dim('  ' + hint));
    return { lines: out, cursor };
  }
}
