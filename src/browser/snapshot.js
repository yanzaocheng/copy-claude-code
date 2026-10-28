// A page as the model reads it: the browser's own accessibility tree (CDP Accessibility.getFullAXTree, shadow DOM
// included, hidden elements left out), cut down to what can be acted on and what gives it structure, one line per
// element, each with a ref (e + the element's backend node id, stable while the element lives) to act on it.

// Roles that are acted on. Their children are not shown: their text is the name.
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'treeitem', 'listbox', 'ListBoxOption',
  'DisclosureTriangle', 'PopUpButton', 'ToggleButton', 'ColorWell', 'Date', 'DateTime', 'InputTime',
]);
// Containers shown when something inside them is: they tell where an element is (a dialog, the main area, a post).
const CONTAINERS = new Set([
  'dialog', 'alertdialog', 'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'search', 'form', 'region',
  'article', 'tablist', 'menu', 'menubar', 'toolbar', 'tree', 'grid', 'table', 'Iframe',
]);
// Shown with their text even when nothing inside them is interactive: what the page says just now.
const MESSAGES = new Set(['alert', 'status', 'heading']);
const FRIENDLY = { DisclosureTriangle: 'button', PopUpButton: 'combobox', ToggleButton: 'button', ListBoxOption: 'option', Iframe: 'iframe' };
const VALUED = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const CHECKABLE = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

export const snapshotLimits = { nameChars: 100, valueChars: 100, textChars: 300 };

const clean = (s) => String(s ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const prop = (node, name) => node.properties?.find((p) => p.name === name)?.value?.value;

// The text inside a node (its StaticText descendants), for an editor or a message whose name is empty.
function innerText(node, byId, max = 400) {
  let out = '';
  const walk = (n) => {
    if (!n || out.length > max) return;
    if (n.role?.value === 'StaticText') { out += `${out ? ' ' : ''}${n.name?.value || ''}`; return; }
    for (const id of n.childIds || []) walk(byId.get(id));
  };
  walk(node);
  return clean(out);
}

function shortUrl(url, base) {
  try {
    const u = new URL(url);
    const b = base ? new URL(base) : null;
    return b && u.origin === b.origin ? `${u.pathname}${u.search}${u.hash}` : url;
  } catch { return url; }
}

// One line for a kept node.
function describe(node, role, byId, { full, baseUrl }) {
  const shown = FRIENDLY[role] || role;
  let name = clean(node.name?.value);
  if (!name && MESSAGES.has(role) && role !== 'heading') name = innerText(node, byId);
  let s = `- ${shown}${name ? ` ${quote(cut(name, snapshotLimits.nameChars))}` : ''}`;
  if (node.backendDOMNodeId) s += ` [ref=e${node.backendDOMNodeId}]`;
  const level = prop(node, 'level');
  if (role === 'heading' && level) s += ` [level=${level}]`;
  if (prop(node, 'disabled')) s += ' [disabled]';
  const checked = prop(node, 'checked');
  if (CHECKABLE.has(role)) s += checked === 'true' || checked === true ? ' [checked]' : checked === 'mixed' ? ' [checked=mixed]' : ' [unchecked]';
  const pressed = prop(node, 'pressed');
  if (pressed === 'true' || pressed === true) s += ' [pressed]';
  const expanded = prop(node, 'expanded');
  if (expanded !== undefined && role !== 'combobox') s += expanded ? ' [expanded]' : ' [collapsed]';
  if (prop(node, 'selected') && (role === 'tab' || role === 'option' || role === 'treeitem')) s += ' [selected]';
  if (prop(node, 'focused') && role !== 'RootWebArea') s += ' [focused]';
  if (prop(node, 'invalid') === 'true') s += ' [invalid]';
  if (VALUED.has(role)) {
    let value = clean(node.value?.value);
    if (!value && prop(node, 'editable') === 'richtext') value = innerText(node, byId);
    if (value) s += `: ${cut(value, snapshotLimits.valueChars)}`;
  }
  if (full && role === 'link') {
    const url = prop(node, 'url');
    if (url) s += ` → ${cut(shortUrl(url, baseUrl), 120)}`;
  }
  return s;
}

// The snapshot as lines: [{text, ref, depth, kind}]. `trees`: {main: nodes, frames: Map(ownerBackendId -> nodes)},
// the frames being the iframes that run in the page's process (a cross-site iframe has its own and is marked so).
// `full`: also the text of the page and the links' addresses. `root`: a backend node id to show only that part.
export function snapshotLines(trees, { full = false, root = null, baseUrl = '' } = {}) {
  const lines = [];
  const indexes = [];
  const index = (nodes) => {
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    indexes.push(byId);
    return byId;
  };
  const visitTree = (nodes, depth, start) => {
    if (!nodes?.length) return;
    const byId = index(nodes);
    let begin = start;
    if (!begin) begin = nodes.find((n) => !n.parentId) || nodes[0];
    visit(begin, byId, depth);
  };
  const visit = (node, byId, depth) => {
    if (!node) return;
    const role = node.role?.value || '';
    if (role === 'InlineTextBox' || role === 'LineBreak' || role === 'ListMarker') return;
    if (role === 'StaticText') {
      if (!full || node.ignored) return;
      const text = clean(node.name?.value);
      if (!text) return;
      const last = lines[lines.length - 1];
      // the text of one paragraph comes in pieces (a link or a bold word in between): one line for the run
      if (last?.kind === 'text' && last.depth === depth && last.parent === node.parentId) {
        last.raw = `${last.raw} ${text}`;
        last.text = `- text: ${quote(cut(last.raw, snapshotLimits.textChars))}`;
      } else {
        lines.push({ text: `- text: ${quote(cut(text, snapshotLimits.textChars))}`, raw: text, ref: null, depth, kind: 'text', parent: node.parentId });
      }
      return;
    }
    const interactive = INTERACTIVE.has(role) || (prop(node, 'editable') && prop(node, 'focusable') && !prop(node, 'readonly') && role !== 'RootWebArea' && role !== 'StaticText' && byId.get(node.parentId) && !prop(byId.get(node.parentId), 'editable'));
    const container = CONTAINERS.has(role) && (role !== 'region' && role !== 'form' ? true : Boolean(clean(node.name?.value)));
    const message = MESSAGES.has(role);
    const image = full && (role === 'img' || role === 'image') && clean(node.name?.value);
    const kept = !node.ignored && (interactive || container || message || image);
    const at = lines.length;
    if (kept) lines.push({ text: describe(node, interactive && !INTERACTIVE.has(role) ? 'textbox' : role, byId, { full, baseUrl }), ref: node.backendDOMNodeId ? `e${node.backendDOMNodeId}` : null, depth, kind: interactive ? 'control' : container ? 'container' : 'message' });
    if (kept && (interactive || message || image) && role !== 'listbox' && role !== 'treeitem') return;
    const childDepth = kept ? depth + 1 : depth;
    if (role === 'Iframe' && node.backendDOMNodeId) {
      const frame = trees.frames?.get(node.backendDOMNodeId);
      if (frame === 'remote') lines.push({ text: '- (a cross-site frame: its content is not shown)', ref: null, depth: childDepth, kind: 'message' });
      else if (frame) visitTree(frame, childDepth);
    } else {
      for (const id of node.childIds || []) visit(byId.get(id), byId, childDepth);
    }
    // a container with nothing to show inside is left out
    if (kept && container && lines.length === at + 1) lines.pop();
  };
  if (root) {
    const all = [trees.main, ...(trees.frames ? [...trees.frames.values()].filter(Array.isArray) : [])];
    for (const nodes of all) {
      const start = nodes?.find((n) => n.backendDOMNodeId === root);
      if (start) { visitTree(nodes, 0, start); break; }
    }
  } else {
    visitTree(trees.main, 0);
  }
  return lines.map(({ text, ref, depth, kind }) => ({ text, ref, depth, kind }));
}

export const renderLines = (lines) => lines.map((l) => `${'  '.repeat(l.depth)}${l.text}`).join('\n');

// What changed between two snapshots of a page (by ref, else by text): the added and changed lines in the order of
// the new snapshot (indented as there), and how many lines are gone. The focus moving is no change: every click
// moves it.
export function diffLines(before, after) {
  // a line without a ref (text) is known by what it says, and the same text twice by its count: a second "Saved"
  // is a change
  const keyed = (lines) => {
    const count = new Map();
    return lines.map((l) => {
      if (l.ref) return [l.ref, l];
      const k = `${l.depth}:${l.text}`;
      const n = (count.get(k) || 0) + 1;
      count.set(k, n);
      return [`${k}#${n}`, l];
    });
  };
  const same = (t) => t.replace(' [focused]', '');
  const oldKeyed = keyed(before);
  const old = new Map(oldKeyed.map(([k, l]) => [k, same(l.text)]));
  const seen = new Set();
  const out = [];
  for (const [k, l] of keyed(after)) {
    seen.add(k);
    if (!old.has(k)) out.push({ ...l, mark: '+' });
    else if (old.get(k) !== same(l.text)) out.push({ ...l, mark: '~' });
  }
  const gone = oldKeyed.filter(([k]) => !seen.has(k)).map(([, l]) => l);
  return { changed: out, gone };
}

export function renderDiff({ changed, gone }) {
  const lines = changed.map((l) => `${l.mark} ${'  '.repeat(l.depth)}${l.text}`);
  if (gone.length) {
    const names = gone.slice(0, 5).map((l) => cut(l.text.replace(/^- /, '').replace(/ \[ref=e\d+\]/, ''), 60)).join('; ');
    lines.push(`- ${gone.length} line${gone.length === 1 ? '' : 's'} gone${names ? ` (${names}${gone.length > 5 ? '; …' : ''})` : ''}`);
  }
  return lines.join('\n');
}

// The lines that contain `query` (text, or /regex/flags), each under the containers it is in.
export function findLines(lines, query, max = 30) {
  let test;
  const re = /^\/(.+)\/([a-z]*)$/.exec(query);
  if (re) {
    const rx = new RegExp(re[1], re[2].includes('i') ? re[2] : `${re[2]}i`);
    test = (s) => rx.test(s);
  } else {
    const q = query.toLowerCase();
    test = (s) => s.toLowerCase().includes(q);
  }
  const out = [];
  let matches = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!test(lines[i].text.replace(/ \[ref=e\d+\]/, ''))) continue;
    if (++matches > max) continue;
    const path = [];
    for (let j = i - 1, d = lines[i].depth; j >= 0 && d > 0; j--) {
      if (lines[j].depth < d) { path.unshift(lines[j].text.replace(/^- /, '')); d = lines[j].depth; }
    }
    out.push(`${lines[i].text}${path.length ? `   (in: ${path.map((p) => cut(p, 60)).join(' › ')})` : ''}`);
  }
  return { text: out.join('\n'), matches };
}
