// Browser: drives a real browser through the DevTools protocol (see browser/session.js), with the page shown as
// its accessibility tree cut down to what can be acted on (browser/snapshot.js). After an action the model gets
// what changed, not the whole page again, and several actions can go in one call.

import fs from 'node:fs';
import path from 'node:path';
import { browserSession, BrowserError, CdpError, refId, safeUrl } from '../browser/session.js';
import { snapshotLines, renderLines, diffLines, renderDiff, findLines } from '../browser/snapshot.js';
import { CONFIG_DIR } from '../config.js';
import { resolvePath } from '../utils/paths.js';

export const browserToolLimits = { snapshotChars: 10_000, diffLines: 60, diffChars: 5_000, textChars: 30_000, evalChars: 20_000, findMatches: 30 };

const ACTIONS = ['tabs', 'open', 'switch', 'navigate', 'back', 'forward', 'reload', 'close', 'snapshot', 'find', 'text', 'click', 'type', 'press', 'hover', 'scroll', 'select', 'upload', 'wait', 'eval', 'screenshot', 'dialog', 'disconnect'];
// After these the page is another one: it is shown whole. After these it is the same page: what changed is shown.
const NAVIGATING = new Set(['open', 'switch', 'navigate', 'back', 'forward', 'reload']);
const ACTING = new Set(['click', 'type', 'press', 'hover', 'scroll', 'select', 'upload', 'wait', 'dialog']);

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The browser tool is left out when CLAUDE_PRO_BROWSER=off.
export const browserToolEnabled = (config) => String(config?.env?.CLAUDE_PRO_BROWSER ?? '').trim().toLowerCase() !== 'off';

const DESCRIPTION = `Drives a real browser (Edge, Chrome or another Chromium) through its DevTools protocol: the user's own browser, logged in as them, or claude-pro's own (browser: "own"). Use it for pages that need clicks, typing, a login or JavaScript; to read a public page, WebFetch is cheaper.

Actions, with their fields:
- tabs; open (url): a new tab; switch (tab: its id, or words of its title or address); navigate (url), back, forward, reload; close (tab)
- snapshot: the page's elements, one per line with a ref (e123) to act on; full: true adds the text and the links' addresses; ref: only that part. find (text): the lines that contain it (or /regex/). text (ref): the plain text
- click (ref, or x and y; double, button), type (text; ref, clear, submit: Enter after), press (key: Enter, Escape, Control+a…), hover (ref), scroll (dy in pixels, ref), select (ref, value) for a <select>, upload (ref, files)
- wait (text, gone; or ms), eval (script, ref): JavaScript in the page, its value comes back; screenshot (ref, full); dialog (accept, text): answer an alert, confirm or prompt; disconnect
- steps: [{action, …}, …] runs several actions in one call and stops at the first that fails
After actions you get what changed in the snapshot (+ added, ~ changed), or the new snapshot when the page changed a lot or is another page. A ref that is gone needs a new snapshot.

- The first call connects. The user's browser then asks them to allow remote debugging (once per session, the connection stays): tell them before. When no browser allows it, the error says how to turn it on; or offer browser: "own" (nothing to allow, but sites need a login there once).
- Work in tabs you opened or the one the user points to: do not read or change their other tabs.
- Before you publish, send, buy, delete or change settings, ask, unless the user asked for exactly that.`;

function snapshotFile(tab, text) {
  const dir = path.join(CONFIG_DIR, 'browser-snapshots');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${tab.id}.txt`);
    fs.writeFileSync(file, text);
    return file;
  } catch { return null; }
}

// A snapshot within the size limit; the whole of it in a file when it is longer.
function capped(tab, lines) {
  const text = renderLines(lines);
  if (!text) return '(nothing to show: the page is empty or still loading)';
  if (text.length <= browserToolLimits.snapshotChars) return text;
  const at = text.lastIndexOf('\n', browserToolLimits.snapshotChars);
  const shown = text.slice(0, at > 0 ? at : browserToolLimits.snapshotChars);
  const rest = text.slice(shown.length).split('\n').filter(Boolean).length;
  const file = snapshotFile(tab, text);
  return `${shown}\n… ${rest} more lines${file ? `: the whole snapshot is in ${file} (Grep it),` : ':'} or narrow it with find (text) or snapshot (ref)`;
}

function cappedText(text, max, what) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${what} cut at ${max} of ${text.length} characters: narrow it with ref]`;
}

const header = (tab) => `${tab.id} ${cut(tab.url || '', 200)}${tab.title ? ` — ${cut(tab.title, 80)}` : ''}`;

// The page read once, in the two forms: `view`, what can be acted on (what a snapshot shows), and `all`, with the
// text and the links' addresses too (what find searches, and what the changes after an action are taken from, so
// that a message or a counter that changes shows up).
async function readPage(tab) {
  const trees = await browserSession.trees(tab);
  const title = trees.main?.find((n) => !n.parentId)?.name?.value; // the document's title, before the browser reports it
  if (title) tab.title = title;
  return {
    trees,
    view: snapshotLines(trees, { baseUrl: trees.baseUrl }),
    all: snapshotLines(trees, { full: true, baseUrl: trees.baseUrl }),
  };
}

function remember(tab, page) {
  tab.lines = page.view;
  tab.base = page.all;
  tab.lastUrl = tab.url;
}

// "e14 button "Click me"": a ref with what it was in the last snapshot (without its value and states then, which
// the action may have changed).
function named(tab, ref) {
  const line = tab?.lines?.find((l) => l.ref === `e${refId(ref)}`);
  if (!line) return String(ref);
  return `${line.ref} ${cut(line.text.replace(/^- /, '').replace(/ \[[^\]]+\]/g, '').replace(/: [^"\]]*$/, ''), 80)}`;
}

// A tab by id (t3) or by words of its title or address.
function findTab(spec) {
  const s = browserSession;
  const want = String(spec ?? '').trim();
  if (!want) throw new BrowserError('switch needs tab: an id from tabs, or words of its title or address');
  if (/^t\d+$/.test(want)) return s.tab(want);
  const q = want.toLowerCase();
  const hits = [...s.tabs.values()].filter((t) => `${t.title} ${t.url}`.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new BrowserError(`no tab's title or address contains ${JSON.stringify(want)}: list them with tabs`);
  throw new BrowserError(`${hits.length} tabs match ${JSON.stringify(want)}: ${hits.slice(0, 8).map((t) => `${t.id} ${cut(t.title || '', 40)} — ${safeUrl(t.url)}`).join('; ')}; pass the id`);
}

async function step(input, ctx) {
  const s = browserSession;
  const a = input.action;
  const need = (field) => {
    if (input[field] === undefined || input[field] === null || input[field] === '') throw new BrowserError(`${a} needs ${field}`);
    return input[field];
  };
  // While an alert, confirm or prompt is open the page runs nothing else: every command would wait for it.
  const current = s.current;
  if (current?.dialog && !['dialog', 'tabs', 'switch', 'open', 'close', 'disconnect'].includes(a)) {
    throw new BrowserError(`a ${current.dialog.type} dialog is open (${JSON.stringify(current.dialog.message)}): answer it first with dialog (accept: true or false${current.dialog.type === 'prompt' ? ', text' : ''})`);
  }
  switch (a) {
    case 'tabs': {
      const list = [...s.tabs.values()];
      return { line: `Tabs in ${s.browser.label} (${list.length}):\n${list.map((t) => `  ${t.id}${t === s.current ? ' [current]' : ''}${t.ours ? ' [yours]' : ''} ${cut(t.title || '(no title)', 60)} — ${safeUrl(t.url)}`).join('\n')}` };
    }
    case 'open': {
      const tab = await s.open(input.url);
      return { line: `Opened ${tab.id}${input.url ? ` at ${cut(String(input.url), 100)}` : ''}.`, report: 'page' };
    }
    case 'switch': {
      const tab = findTab(input.tab);
      await s.select(tab);
      return { line: `Switched to ${tab.id}.`, report: 'page' };
    }
    case 'navigate': await s.navigate(s.tab(), need('url')); return { line: `Went to ${cut(String(input.url), 100)}.`, report: 'page' };
    case 'back': await s.history(s.tab(), -1); return { line: 'Went back.', report: 'page' };
    case 'forward': await s.history(s.tab(), 1); return { line: 'Went forward.', report: 'page' };
    case 'reload': {
      const tab = s.tab();
      tab.loading = true;
      await s.send(tab, 'Page.reload', {});
      return { line: 'Reloaded.', report: 'page' };
    }
    case 'close': {
      const tab = input.tab ? findTab(input.tab) : s.tab();
      await s.closeTab(tab, input.force);
      return { line: `Closed ${tab.id}.` };
    }
    case 'snapshot': {
      const tab = s.tab();
      const page = await readPage(tab);
      remember(tab, page);
      const lines = input.ref || input.full ? snapshotLines(page.trees, { full: Boolean(input.full), root: input.ref ? refId(input.ref) : null, baseUrl: page.trees.baseUrl }) : page.view;
      if (input.ref && !lines.length) throw new BrowserError(`${input.ref} is not on the page (any more): take a snapshot without ref`);
      return { line: `${header(tab)}\n${capped(tab, lines)}`, report: 'shown' };
    }
    case 'find': {
      const tab = s.tab();
      const page = await readPage(tab);
      const r = findLines(page.all, String(need('text')), browserToolLimits.findMatches);
      if (!r.matches) return { line: `Nothing on the page matches ${JSON.stringify(input.text)} (try other words, or text for the page's plain text).` };
      return { line: `${r.matches} line${r.matches === 1 ? '' : 's'} match ${JSON.stringify(input.text)}:\n${r.text}${r.matches > browserToolLimits.findMatches ? `\n… ${r.matches - browserToolLimits.findMatches} more: narrow the words` : ''}` };
    }
    case 'text': {
      const text = await s.text(s.tab(), input.ref);
      return { line: text.trim() ? cappedText(text.trim(), browserToolLimits.textChars, 'the text') : '(no text)' };
    }
    case 'click': {
      const tab = s.tab();
      await s.click(tab, input);
      return { line: `Clicked ${input.ref ? named(tab, input.ref) : `at ${input.x},${input.y}`}${input.double ? ' twice' : ''}.`, report: 'changes' };
    }
    case 'type': {
      const tab = s.tab();
      if (!input.text && !input.clear) need('text');
      await s.type(tab, input);
      const what = input.text ? `Typed ${JSON.stringify(cut(String(input.text), 60))}` : 'Cleared';
      return { line: `${what}${input.ref ? ` ${input.text ? 'into' : ''} ${named(tab, input.ref)}` : ''}${input.submit ? ' and pressed Enter' : ''}.`.replace(/ {2}/g, ' '), report: 'changes' };
    }
    case 'press': await s.press(s.tab(), need('key')); return { line: `Pressed ${input.key}.`, report: 'changes' };
    case 'hover': { const tab = s.tab(); await s.hover(tab, need('ref')); return { line: `Hovering over ${named(tab, input.ref)}.`, report: 'changes' }; }
    case 'scroll': {
      const tab = s.tab();
      await s.scroll(tab, input);
      return { line: input.ref && input.dy === undefined ? `Scrolled ${named(tab, input.ref)} into view.` : `Scrolled ${input.dy ?? 'a screen'}${input.dy !== undefined ? ' px' : ''}${input.ref ? ` in ${named(tab, input.ref)}` : ''}.`, report: 'changes' };
    }
    case 'select': {
      const tab = s.tab();
      const label = await s.selectOption(tab, need('ref'), need('value'));
      return { line: `Selected ${JSON.stringify(label)} in ${named(tab, input.ref)}.`, report: 'changes' };
    }
    case 'upload': {
      const tab = s.tab();
      const files = (Array.isArray(input.files) ? input.files : [need('files')]).map((f) => resolvePath(String(f), ctx.cwd));
      const missing = files.filter((f) => !fs.existsSync(f));
      if (missing.length) throw new BrowserError(`no such file: ${missing.join(', ')}`);
      await s.upload(tab, need('ref'), files);
      return { line: `Gave ${files.length} file${files.length === 1 ? '' : 's'} to ${named(tab, input.ref)}.`, report: 'changes' };
    }
    case 'wait': return { line: `${cut(await s.waitFor(s.tab(), input), 200)}.`, report: 'changes' };
    case 'eval': {
      const value = await s.evaluate(s.tab(), String(need('script')), input.ref);
      return { line: `Result:\n${cappedText(String(value), browserToolLimits.evalChars, 'the result')}` };
    }
    case 'screenshot': {
      const tab = s.tab();
      const data = await s.screenshot(tab, input);
      return { line: `Screenshot of ${tab.id}${input.ref ? ` ${named(tab, input.ref)}` : input.full ? ' (the whole page)' : ''}:`, images: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }] };
    }
    case 'dialog': {
      const tab = s.tab();
      const d = tab.dialog;
      await s.dialog(tab, input);
      return { line: `Answered the ${d?.type || ''} dialog: ${input.accept === false ? 'dismissed' : 'accepted'}.`.replace(/ {2}/g, ' '), report: 'changes' };
    }
    case 'disconnect': {
      const own = s.browser?.own;
      s.close();
      return { line: `Disconnected (the tabs stay as they are; the next call connects again${own ? '' : ', and the user is asked again to allow it'}).` };
    }
    default:
      throw new BrowserError(`unknown action ${JSON.stringify(a)}: use one of ${ACTIONS.join(', ')}`);
  }
}

// The page after what was done: what changed since the last snapshot, or the page itself.
async function pageState(tab, kind) {
  const s = browserSession;
  await s.settle(tab);
  if (tab.dialog) return `A ${tab.dialog.type} dialog is open: ${JSON.stringify(tab.dialog.message)}. Answer it with dialog (accept: true or false${tab.dialog.type === 'prompt' ? ', text' : ''}).`;
  const page = await readPage(tab);
  let body = null;
  if (kind === 'changes' && tab.base && tab.lastUrl === tab.url) {
    const d = diffLines(tab.base, page.all);
    if (!d.changed.length && !d.gone.length) body = 'Nothing changed on the page.';
    else {
      const text = renderDiff(d);
      if (d.changed.length <= browserToolLimits.diffLines && text.length <= browserToolLimits.diffChars) body = `Changes:\n${text}`;
    }
  }
  remember(tab, page);
  return `${header(tab)}\n${body ?? capped(tab, page.view)}`;
}

async function run(input, ctx) {
  const s = browserSession;
  const steps = Array.isArray(input.steps) && input.steps.length ? input.steps : [input];
  if (steps.some((x) => !x || typeof x !== 'object' || !x.action)) {
    return { isError: true, content: 'Each call needs an action (or steps: a list of {action, …}).' };
  }
  if (steps.length === 1 && steps[0].action === 'disconnect' && !s.connected) return { content: 'Not connected to a browser.' };
  const out = [];
  try {
    const target = await s.connect(input.browser || steps.find((x) => x.browser)?.browser, ctx.config?.env, (b) => {
      ctx.onProgress?.(`Waiting for the user to allow remote debugging in ${b.label} ("Allow remote debugging?" → Allow)…`);
    });
    if (target) out.push(`Connected to ${target.label}${target.others?.length ? ` (${target.others.join(', ')} allow${target.others.length === 1 ? 's' : ''} it too: pass browser to use ${target.others.length === 1 ? 'it' : 'one of them'})` : ''}.`);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return { isError: true, content: `Cannot use the browser: ${e.message}` };
  }
  let failed = false;
  let pending = null; // what to show of the page at the end: 'page' | 'changes'
  const images = [];
  for (const [i, x] of steps.entries()) {
    const n = steps.length > 1 ? `${i + 1}. ` : '';
    try {
      const r = await step(x, ctx);
      out.push(`${n}${r.line}`);
      if (r.images) images.push(...r.images);
      if (r.report === 'page') pending = 'page';
      else if (r.report === 'changes') pending = pending === 'page' ? 'page' : 'changes';
      else if (r.report === 'shown') pending = null; // a snapshot shows the page already
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      failed = true;
      out.push(`${n}${x.action} failed: ${e instanceof BrowserError || e instanceof CdpError ? e.message : `${e.message}`}`);
      if (i < steps.length - 1) out.push(`(the ${steps.length - i - 1} step${steps.length - i - 1 === 1 ? '' : 's'} after it did not run)`);
      break;
    }
  }
  const tab = s.connected ? s.current : null;
  if (pending && tab) {
    try { out.push(await pageState(tab, pending)); } catch (e) {
      if (e?.name === 'AbortError') throw e;
      out.push(`(the page could not be read: ${e.message})`);
    }
  }
  if (tab && !tab.dialog) await s.release(tab);
  const text = [...s.takeNotes(), ...out].join('\n');
  const last = out.find((l) => /failed:/.test(l)) || out[out.length - 1] || '';
  return {
    content: images.length ? [{ type: 'text', text }, ...images] : text,
    isError: failed,
    display: { summary: cut(last.split('\n')[0], 120) },
  };
}

export function makeBrowserTool() {
  return {
    name: 'Browser',
    description: DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        steps: { type: 'array', items: { type: 'object' }, description: 'Several actions in order, each {action, …its fields}' },
        browser: { type: 'string', description: 'edge, chrome, brave, chromium, own, or a DevTools address' },
        tab: { type: 'string', description: 'A tab id (t3), or words of its title or address' },
        url: { type: 'string' },
        ref: { type: 'string', description: 'An element ref from a snapshot (e123)' },
        text: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' },
        script: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        full: { type: 'boolean' },
        clear: { type: 'boolean' },
        submit: { type: 'boolean' },
        double: { type: 'boolean' },
        gone: { type: 'boolean' },
        force: { type: 'boolean' },
        accept: { type: 'boolean' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        x: { type: 'number' },
        y: { type: 'number' },
        dx: { type: 'number' },
        dy: { type: 'number' },
        ms: { type: 'number' },
        timeout: { type: 'number', description: 'For wait, in ms (default 10000)' },
      },
    },
    summarize(input) {
      const one = (x) => [x.action, x.tab, x.ref, x.url ? safeUrl(String(x.url)) : '', x.key, x.text !== undefined ? JSON.stringify(cut(String(x.text), 40)) : '', x.value !== undefined ? JSON.stringify(String(x.value)) : '', x.script ? cut(String(x.script).replace(/\s+/g, ' '), 40) : ''].filter(Boolean).join(' ');
      if (Array.isArray(input.steps) && input.steps.length) return `${input.steps.length} steps: ${input.steps.map((x) => one(x || {})).join(', ')}`;
      return one(input);
    },
    async call(input, ctx) {
      return browserSession.run(ctx.signal, () => run(input, ctx));
    },
  };
}
