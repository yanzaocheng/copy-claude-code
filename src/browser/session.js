// The browser the Browser tool drives: one DevTools connection per claude-pro process, kept for the whole session,
// because a browser whose remote debugging was turned on in its settings asks the user to allow every new
// connection. Only the tabs it works in are attached (the others, asleep ones included, are never touched: tab
// titles come from the browser, not from the pages), and every command has a time limit.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Cdp, CdpError, abortError } from './cdp.js';
import { closeRenderer } from './render.js';
import { CONFIG_DIR } from '../config.js';

export const browserLimits = {
  connectMs: 120_000, // the user may take a while to click Allow
  commandMs: 15_000,
  settleMs: 5_000, // after an action: until the network is quiet, at most this long
  quietMs: 400,
  navigationMs: 20_000,
  waitMs: 10_000,
  waitMaxMs: 60_000,
  evalMs: 30_000,
};

export class BrowserError extends Error {}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(abortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

// ---- Which browser

// The browsers whose own (default) profile can be connected to once the user has turned on remote debugging in
// it (chrome://inspect/#remote-debugging and the like, Chrome and Edge 144+): it then writes DevToolsActivePort.
export function knownBrowsers({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const inspect = (scheme) => `${scheme}://inspect/#remote-debugging`;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      { name: 'edge', label: 'Microsoft Edge', dir: path.join(local, 'Microsoft', 'Edge', 'User Data'), inspect: inspect('edge') },
      { name: 'chrome', label: 'Google Chrome', dir: path.join(local, 'Google', 'Chrome', 'User Data'), inspect: inspect('chrome') },
      { name: 'brave', label: 'Brave', dir: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'), inspect: inspect('brave') },
      { name: 'chromium', label: 'Chromium', dir: path.join(local, 'Chromium', 'User Data'), inspect: inspect('chrome') },
    ];
  }
  const mac = platform === 'darwin';
  const base = mac ? path.join(home, 'Library', 'Application Support') : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return [
    { name: 'edge', label: 'Microsoft Edge', dir: path.join(base, mac ? 'Microsoft Edge' : 'microsoft-edge'), inspect: inspect('edge') },
    { name: 'chrome', label: 'Google Chrome', dir: path.join(base, mac ? path.join('Google', 'Chrome') : 'google-chrome'), inspect: inspect('chrome') },
    { name: 'brave', label: 'Brave', dir: path.join(base, 'BraveSoftware', 'Brave-Browser'), inspect: inspect('brave') },
    { name: 'chromium', label: 'Chromium', dir: path.join(base, mac ? 'Chromium' : 'chromium'), inspect: inspect('chrome') },
  ];
}

const OWN = { name: 'own', label: "claude-pro's own browser", get dir() { return path.join(CONFIG_DIR, 'browser-profile'); } };

function portOpen(port, ms = 400) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(ms, () => done(false));
  });
}

// The DevTools address a running browser wrote into its profile, when its port answers.
async function readEndpoint(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8'); } catch { return null; }
  const [portLine, wsPath] = text.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || !wsPath?.startsWith('/')) return null;
  return (await portOpen(port)) ? `ws://127.0.0.1:${port}${wsPath}` : null;
}

// A DevTools address given as ws://…, http://host:port or a port (a browser started with --remote-debugging-port).
async function explicitEndpoint(spec, signal) {
  if (/^wss?:\/\//i.test(spec)) return spec;
  const base = /^\d+$/.test(spec) ? `http://127.0.0.1:${spec}` : /^https?:\/\//i.test(spec) ? spec : null;
  if (!base) return null;
  let info;
  try {
    const res = await fetch(new URL('/json/version', base), { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
    info = await res.json();
  } catch (e) {
    if (signal?.aborted) throw abortError();
    throw new BrowserError(`no DevTools endpoint answers at ${base}: ${e.message}`);
  }
  if (!info?.webSocketDebuggerUrl) throw new BrowserError(`${base} is not a DevTools endpoint (no webSocketDebuggerUrl in /json/version)`);
  return info.webSocketDebuggerUrl;
}

function onPath(cmd) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, cmd);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

// Chrome before Edge: Edge signs a new profile in with the Windows account and syncs that account's data into it.
export function browserExecutables() {
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'].map(onPath);
}

// claude-pro's own browser: a Chrome (or Edge) with its own profile under the config directory, started with
// --remote-debugging-port, so nobody is asked anything; it stays open when claude-pro exits, logins included.
async function ownEndpoint(signal) {
  const dir = OWN.dir;
  const running = await readEndpoint(dir);
  if (running) return running;
  const exe = browserExecutables().find((p) => p && fs.existsSync(p));
  if (!exe) throw new BrowserError('no Chrome or Edge is installed to start claude-pro\'s own browser with');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.unlinkSync(path.join(dir, 'DevToolsActivePort')); } catch { /* none yet */ }
  const child = spawn(exe, ['--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    await sleep(250, signal);
    const url = await readEndpoint(dir);
    if (url) return url;
  }
  throw new BrowserError(`${path.basename(exe)} did not open its DevTools port within 20 s`);
}

const howToTurnOn = (b) => `${b.label} does not allow remote debugging now. The user turns it on at ${b.inspect} (allow remote debugging for this browser instance; ${b.label} then asks once per session to allow the connection). Or use browser: "own".`;

// The browser to connect to: `spec` (the call's browser field), else CLAUDE_PRO_BROWSER, else the first known
// browser that allows remote debugging, else claude-pro's own when it is running.
export async function resolveBrowser(spec, env, signal) {
  const wanted = String(spec || env?.CLAUDE_PRO_BROWSER || '').trim();
  const w = wanted.toLowerCase();
  if (w && w !== 'auto') {
    if (w === 'off') throw new BrowserError('the browser is turned off for claude-pro (CLAUDE_PRO_BROWSER=off)');
    if (w === 'own') return { ...OWN, dir: OWN.dir, url: await ownEndpoint(signal), own: true };
    const known = knownBrowsers().find((b) => b.name === w);
    if (known) {
      const url = await readEndpoint(known.dir);
      if (!url) throw new BrowserError(howToTurnOn(known));
      return { ...known, url };
    }
    const url = await explicitEndpoint(wanted, signal);
    if (url) {
      let where = wanted;
      try { where = new URL(url).host; } catch { /* as given */ }
      return { name: wanted, label: `the browser at ${where}`, url };
    }
    throw new BrowserError(`unknown browser "${wanted}": use edge, chrome, brave, chromium, own, or a DevTools address (ws://…, http://host:port, a port)`);
  }
  const found = [];
  for (const b of knownBrowsers()) {
    const url = await readEndpoint(b.dir);
    if (url) found.push({ ...b, url });
  }
  if (found.length) return { ...found[0], others: found.slice(1).map((b) => b.name) };
  const own = await readEndpoint(OWN.dir);
  if (own) return { ...OWN, dir: OWN.dir, url: own, own: true };
  const installed = knownBrowsers().filter((b) => fs.existsSync(b.dir));
  throw new BrowserError(`no browser allows remote debugging. The user can turn it on in theirs (${(installed.length ? installed : knownBrowsers().slice(0, 2)).map((b) => `${b.label}: ${b.inspect}`).join('; ')}: allow remote debugging for this browser instance; the browser then asks once per session to allow the connection). Or use browser: "own" for claude-pro's own browser (its own profile: nothing to allow, but sites need a login there once).`);
}

// ---- Keys

const KEYS = {
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'],
  Space: [32, 'Space', ' '], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'],
  ArrowRight: [39, 'ArrowRight'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
  Insert: [45, 'Insert'],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, [112 + i, `F${i + 1}`]])),
};
const ALIASES = { esc: 'Escape', return: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ' ': 'Space', spacebar: 'Space' };
const MODIFIERS = { alt: [1, 'Alt', 'AltLeft', 18], option: [1, 'Alt', 'AltLeft', 18], control: [2, 'Control', 'ControlLeft', 17], ctrl: [2, 'Control', 'ControlLeft', 17], meta: [4, 'Meta', 'MetaLeft', 91], cmd: [4, 'Meta', 'MetaLeft', 91], command: [4, 'Meta', 'MetaLeft', 91], shift: [8, 'Shift', 'ShiftLeft', 16] };
// macOS takes editing shortcuts from its text system, which synthetic key events do not reach: they need commands.
const MAC_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

function keyEvent(name) {
  const named = KEYS[name] || KEYS[ALIASES[name.toLowerCase()]] || Object.entries(KEYS).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  if (named) return { keyCode: named[0], key: named[1] === 'Space' ? ' ' : named[1], code: named[1], text: named[2] };
  if ([...name].length === 1) {
    const upper = name.toUpperCase();
    const code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : undefined;
    return { keyCode: /[a-z\d]/i.test(name) ? upper.charCodeAt(0) : 0, key: name, code, text: name };
  }
  throw new BrowserError(`unknown key "${name}": use a character or Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, with Control+, Shift+, Alt+, Meta+ (Mod+ is Meta on macOS, Control elsewhere)`);
}

// What covers an element, for the model: the nearest ancestor with a role, a label or a landmark tag, and its text.
const COVER_LABEL = `function() {
  let what = '';
  for (let n = this, i = 0; n && n.nodeType === 1 && i < 10; n = n.parentElement || n.getRootNode().host, i++) {
    const role = n.getAttribute('role');
    const label = n.getAttribute('aria-label');
    if (role || label || ['header', 'nav', 'dialog', 'footer', 'aside', 'form'].includes(n.localName)) {
      what = (role || n.localName) + (label ? ' "' + label.slice(0, 50) + '"' : '');
      break;
    }
  }
  const text = (this.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
  return (what || '<' + this.localName + '>') + (text ? ' (text: "' + text + '")' : '');
}`;

const CONTAINS = `function(hit) {
  for (let n = hit; n; n = n.parentNode || n.host) if (n === this) return true;
  if (this.labels) for (const label of this.labels) for (let n = hit; n; n = n.parentNode || n.host) if (n === label) return true;
  return false;
}`;

const quadArea = (q) => Math.abs((q[0] * q[3] - q[1] * q[2]) + (q[2] * q[5] - q[3] * q[4]) + (q[4] * q[7] - q[5] * q[6]) + (q[6] * q[1] - q[7] * q[0])) / 2;

export function refId(ref) {
  const m = /^e?(\d+)$/.exec(String(ref ?? '').trim());
  if (!m) throw new BrowserError(`"${ref}" is not a ref: use the [ref=e…] of a snapshot line`);
  return Number(m[1]);
}

const exceptionText = (d) => (d.exception?.description || d.exception?.value || d.text || 'error').toString().split('\n').slice(0, 6).join('\n');

// ---- The session

class BrowserSession {
  constructor() {
    this.cdp = null;
    this.browser = null;
    this.lock = Promise.resolve();
    this.signal = null;
    this.reset();
  }

  reset() {
    this.tabs = new Map(); // targetId -> tab
    this.byId = new Map(); // t3f9a -> tab (see relabel)
    this.sessions = new Map(); // sessionId -> tab
    this.nextTab = 1;
    this.current = null;
    this.notes = [];
  }

  get connected() { return Boolean(this.cdp && !this.cdp.closed); }

  // One call at a time (the main agent and sub-agents share the browser), with that call's abort signal.
  run(signal, fn) {
    const next = this.lock.then(async () => {
      this.signal = signal;
      try { return await fn(); } finally { this.signal = null; }
    });
    this.lock = next.catch(() => {});
    return next;
  }

  async connect(spec, env, onWaiting) {
    if (this.connected) {
      const w = String(spec || '').trim().toLowerCase();
      if (!w || w === this.browser.name) return null;
      this.close(); // another browser was asked for
    }
    const target = await resolveBrowser(spec, env, this.signal);
    const cdp = await Cdp.connect(target.url, { signal: this.signal, timeoutMs: browserLimits.connectMs, onWaiting: target.own ? null : () => onWaiting?.(target) });
    this.reset();
    this.cdp = cdp;
    this.browser = target;
    cdp.on((method, params, sessionId) => this.onEvent(method, params, sessionId));
    await cdp.send('Target.setDiscoverTargets', { discover: true }, { signal: this.signal });
    const { targetInfos } = await cdp.send('Target.getTargets', {}, { signal: this.signal });
    for (const t of targetInfos) this.track(t);
    if (target.own) {
      // claude-pro's own browser: its tabs are all the agent's
      for (const tab of this.tabs.values()) tab.ours = true;
      const pages = [...this.tabs.values()];
      if (pages.length === 1) await this.select(pages[0]);
    }
    return target;
  }

  close() {
    const cdp = this.cdp;
    this.cdp = null;
    this.browser = null;
    this.reset();
    try { cdp?.close(); } catch { /* already gone */ }
  }

  track(info) {
    if (info.type !== 'page') return null;
    let tab = this.tabs.get(info.targetId);
    if (!tab) {
      const hex = /^[0-9a-f]{8,}$/i.test(info.targetId) ? info.targetId.toLowerCase() : null;
      tab = { id: hex ? null : `t${this.nextTab++}`, hex, targetId: info.targetId, ours: false, sessionId: null, frameId: null, net: new Map(), lastNet: 0, loading: false, navigations: 0, dialog: null, dialogWaiters: new Set(), lines: null };
      this.tabs.set(info.targetId, tab);
      this.relabel();
    }
    tab.title = info.title || '';
    if (info.url) tab.url = info.url;
    return tab;
  }

  // A tab's id is "t" and the start of its own id in the browser (its targetId, which it keeps while it is open),
  // 4 hex digits or as many more as it takes to tell it from the other open tabs. Numbers given in the order of a
  // connection (t1, t2...) started again at every reconnect and restart of claude-pro, so that an id in the
  // conversation (one the user picked with /tabs, say) could then be another tab, the one the agent would click in
  // or close. These ids mean the same tab in every connection and every session (see tab).
  relabel() {
    const hexTabs = [...this.tabs.values()].filter((t) => t.hex);
    for (const tab of hexTabs) {
      let len = 4;
      while (len < tab.hex.length && hexTabs.some((o) => o !== tab && o.hex.startsWith(tab.hex.slice(0, len)))) len++;
      tab.id = `t${tab.hex.slice(0, len)}`;
    }
    this.byId = new Map([...this.tabs.values()].map((t) => [t.id, t]));
  }

  onEvent(method, params, sessionId) {
    if (method === 'Cdp.closed') {
      if (!this.cdp) return; // closed by us
      const label = this.browser?.label || 'the browser';
      this.cdp = null;
      this.browser = null;
      this.reset();
      this.notes.push(`The connection to ${label} was lost (${params.reason}): the next call connects again.`);
      return;
    }
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const fresh = method === 'Target.targetCreated' && !this.tabs.has(params.targetInfo.targetId);
      const tab = this.track(params.targetInfo);
      if (tab && fresh) {
        const opener = params.targetInfo.openerId && this.tabs.get(params.targetInfo.openerId);
        if (opener?.ours || (opener && opener === this.current)) {
          tab.ours = true;
          this.notes.push(`The page opened a new tab ${tab.id} (${safeUrl(tab.url)}): switch to it to work there.`);
        }
      }
      return;
    }
    if (method === 'Target.targetDestroyed') {
      const tab = this.tabs.get(params.targetId);
      if (!tab) return;
      this.tabs.delete(params.targetId);
      this.relabel();
      if (tab.sessionId) this.sessions.delete(tab.sessionId);
      if (this.current === tab) {
        this.current = null;
        this.notes.push(`Tab ${tab.id} was closed.`);
      }
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const tab = this.sessions.get(params.sessionId);
      if (tab) { this.sessions.delete(params.sessionId); tab.sessionId = null; }
      return;
    }
    const tab = sessionId && this.sessions.get(sessionId);
    if (!tab) return;
    const now = Date.now();
    switch (method) {
      case 'Network.requestWillBeSent': tab.net.set(params.requestId, now); tab.lastNet = now; break;
      case 'Network.loadingFinished':
      case 'Network.loadingFailed': tab.net.delete(params.requestId); tab.lastNet = now; break;
      case 'Page.frameStartedLoading': if (params.frameId === tab.frameId) tab.loading = true; break;
      case 'Page.frameStoppedLoading': if (params.frameId === tab.frameId) tab.loading = false; break;
      case 'Page.loadEventFired': tab.loading = false; break;
      case 'Page.frameNavigated':
        if (!params.frame.parentId) { tab.frameId = params.frame.id; tab.url = params.frame.url; tab.navigations++; }
        break;
      case 'Page.navigatedWithinDocument': if (params.frameId === tab.frameId) tab.url = params.url; break;
      case 'Page.javascriptDialogOpening':
        tab.dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt };
        for (const w of [...tab.dialogWaiters]) w();
        break;
      case 'Page.javascriptDialogClosed': tab.dialog = null; break;
      default: break;
    }
  }

  takeNotes() {
    const notes = this.notes;
    this.notes = [];
    return notes;
  }

  send(tab, method, params = {}, { timeoutMs = browserLimits.commandMs } = {}) {
    if (!this.connected) return Promise.reject(new BrowserError('the browser connection is closed'));
    return this.cdp.send(method, params, { sessionId: tab?.sessionId || undefined, signal: this.signal, timeoutMs });
  }

  // A command's reply, or null when the page opens an alert, confirm or prompt first: the page is then stopped in
  // that dialog, and the reply (of the click that opened it, say) only comes once it is answered.
  untilDialog(tab, promise) {
    promise.catch(() => {});
    if (tab.dialog) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const onDialog = () => resolve(null);
      tab.dialogWaiters.add(onDialog);
      promise.then(resolve, reject).finally(() => tab.dialogWaiters.delete(onDialog));
    });
  }

  input(tab, method, params) {
    if (tab.dialog) return Promise.resolve(null);
    return this.untilDialog(tab, this.send(tab, method, params));
  }

  // A tab by its id. One shown earlier may be longer or shorter than the tab's id now (another tab with the same
  // start was opened or closed meanwhile): any start of a tab's own id that only one open tab has is that tab's.
  tab(id) {
    if (id) {
      const want = String(id).trim().toLowerCase();
      const exact = this.byId.get(want);
      if (exact) return exact;
      const start = /^t([0-9a-f]{4,})$/.exec(want)?.[1];
      const hits = start ? [...this.tabs.values()].filter((t) => t.hex?.startsWith(start)) : [];
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new BrowserError(`${id} could be any of ${hits.length} tabs now: ${hits.map((t) => `${t.id} ${String(t.title || '').slice(0, 40)}`).join('; ')}; pass the longer id`);
      throw new BrowserError(`no tab ${id} (it was closed, or the id is from another browser): switch by words of its title or address, or list them with tabs`);
    }
    if (!this.current) throw new BrowserError('no tab is selected: switch (tab: its id, or words of its title or address) to the one the user means, or open (url) a new one');
    return this.current;
  }

  async attach(tab) {
    if (tab.sessionId) return;
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true }, { signal: this.signal, timeoutMs: browserLimits.commandMs });
    tab.sessionId = sessionId;
    this.sessions.set(sessionId, tab);
    await Promise.all([
      this.send(tab, 'Page.enable'),
      this.send(tab, 'Network.enable'),
      // the page behaves as if its window had the focus: the user is typing in the terminal
      this.send(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {}),
    ]);
    try {
      const { frameTree } = await this.send(tab, 'Page.getFrameTree');
      tab.frameId = frameTree.frame.id;
      tab.url = frameTree.frame.url;
    } catch { /* known from the target */ }
  }

  // Make `tab` the one actions go to: attached, in front (a background tab may be asleep or throttled) and awake.
  async select(tab) {
    await this.attach(tab);
    await this.cdp.send('Target.activateTarget', { targetId: tab.targetId }, { signal: this.signal, timeoutMs: 5000 }).catch(() => {});
    await this.send(tab, 'Page.setWebLifecycleState', { state: 'active' }, { timeoutMs: 5000 }).catch(() => {});
    this.current = tab;
    if (tab.dialog) return; // Page.enable reports a dialog that was already open: the page runs nothing until it is answered
    try {
      await this.send(tab, 'Runtime.evaluate', { expression: '1', returnByValue: true }, { timeoutMs: 5000 });
    } catch (e) {
      if (this.signal?.aborted) throw abortError();
      throw new BrowserError(`${tab.id} does not respond (${e.message}): it may be asleep or busy; ask the user to click on it, then try again`);
    }
  }

  async open(url) {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' }, { signal: this.signal });
    const tab = this.tabs.get(targetId) || this.track({ targetId, type: 'page', title: '', url: 'about:blank' });
    tab.ours = true;
    await this.select(tab);
    if (url) await this.navigate(tab, url);
    return tab;
  }

  async navigate(tab, url) {
    let target;
    try { target = new URL(url).href; } catch { target = /^[\w-]+(\.[\w-]+)+/.test(url) ? `https://${url}` : url; }
    const r = await this.send(tab, 'Page.navigate', { url: target }, { timeoutMs: browserLimits.navigationMs });
    if (r.errorText) throw new BrowserError(`cannot open ${target}: ${r.errorText}`);
    tab.loading = Boolean(r.loaderId); // a navigation inside the document has none
  }

  async history(tab, step) {
    const { currentIndex, entries } = await this.send(tab, 'Page.getNavigationHistory');
    const entry = entries[currentIndex + step];
    if (!entry) throw new BrowserError(`there is no page to go ${step < 0 ? 'back' : 'forward'} to`);
    tab.loading = true;
    await this.send(tab, 'Page.navigateToHistoryEntry', { entryId: entry.id });
  }

  async closeTab(tab, force) {
    if (!tab.ours && !force) throw new BrowserError(`${tab.id} is one of the user's tabs, not one you opened: close it only when the user asks for it, with force: true`);
    await this.cdp.send('Target.closeTarget', { targetId: tab.targetId }, { signal: this.signal });
    this.tabs.delete(tab.targetId);
    this.relabel();
    if (tab.sessionId) this.sessions.delete(tab.sessionId);
    if (this.current === tab) this.current = null;
  }

  // Wait until what an action started is done: a navigation's load, else a quiet network (requests running for
  // more than 2 s, a long poll or a stream, do not count).
  async settle(tab) {
    const start = Date.now();
    await sleep(150, this.signal);
    for (;;) {
      if (tab.dialog || !this.connected) return;
      const now = Date.now();
      for (const [id, t] of tab.net) if (now - t > 60_000) tab.net.delete(id);
      const busy = [...tab.net.values()].some((t) => now - t < 2000);
      if (!tab.loading && !busy && now - tab.lastNet >= browserLimits.quietMs) return;
      if (now - start >= (tab.loading ? browserLimits.navigationMs : browserLimits.settleMs)) return;
      await sleep(100, this.signal);
    }
  }

  // The page's accessibility trees, for snapshotLines (see snapshot.js): the main frame's, and those of the iframes
  // that run in the page's process (a cross-site one is 'remote').
  async trees(tab) {
    if (tab.dialog) throw new BrowserError(`a ${tab.dialog.type} dialog is open (${JSON.stringify(tab.dialog.message)}): answer it with dialog (accept, text) first`);
    const { nodes } = await this.send(tab, 'Accessibility.getFullAXTree', {}, { timeoutMs: 20_000 });
    const frames = new Map();
    try {
      const { frameTree } = await this.send(tab, 'Page.getFrameTree');
      const walk = async (ft) => {
        for (const child of ft.childFrames || []) {
          try {
            const { backendNodeId } = await this.send(tab, 'DOM.getFrameOwner', { frameId: child.frame.id });
            try {
              const t = await this.send(tab, 'Accessibility.getFullAXTree', { frameId: child.frame.id }, { timeoutMs: 10_000 });
              frames.set(backendNodeId, t.nodes?.length ? t.nodes : 'remote');
            } catch { frames.set(backendNodeId, 'remote'); }
          } catch { /* a frame without an owner element here */ }
          await walk(child);
        }
      };
      await walk(frameTree);
    } catch { /* the main tree is enough */ }
    return { main: nodes, frames, baseUrl: tab.url };
  }

  async objectId(tab, backendNodeId, ref) {
    try {
      const { object } = await this.send(tab, 'DOM.resolveNode', { backendNodeId, objectGroup: 'claude-pro' });
      return object.objectId;
    } catch (e) {
      throw this.gone(ref || `e${backendNodeId}`, e);
    }
  }

  gone(ref, e) {
    if (e?.name === 'AbortError') return e;
    const m = e?.message || '';
    if (/layout object/i.test(m)) return new BrowserError(`${ref} is not shown on the page (it has no box): use another element, or scroll or open what contains it`);
    return /No node|not found|detached|Could not compute|does not belong|Cannot find/i.test(m)
      ? new BrowserError(`${ref} is no longer on the page (it changed): take a new snapshot`)
      : e;
  }

  async callOn(tab, ref, fn, args = []) {
    const objectId = await this.objectId(tab, refId(ref), ref);
    const r = await this.send(tab, 'Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true, userGesture: true }, { timeoutMs: browserLimits.evalMs });
    if (r.exceptionDetails) throw new BrowserError(`the script threw: ${exceptionText(r.exceptionDetails)}`);
    return r.result?.value;
  }

  // Where to click an element: scrolled into view, the middle of its first box.
  async point(tab, ref) {
    const backendNodeId = refId(ref);
    let quads;
    try {
      await this.send(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
      ({ quads } = await this.send(tab, 'DOM.getContentQuads', { backendNodeId }));
    } catch (e) { throw this.gone(ref, e); }
    const q = quads.find((x) => quadArea(x) > 1);
    if (!q) throw new BrowserError(`${ref} takes no space on the page (hidden or collapsed)`);
    return { backendNodeId, x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  }

  // What is on top at (x, y) when it is not the element (or inside it): a dialog, a banner, a cookie notice.
  async coveredBy(tab, backendNodeId, x, y) {
    let hit;
    try {
      // (x, y) is in the window, getNodeForLocation takes the document's coordinates: the page's scroll added
      const { cssLayoutViewport: vp } = await this.send(tab, 'Page.getLayoutMetrics');
      // (ignorePointerEventsNone would hit-test the see-through layers a click goes through: an editor's placeholder)
      hit = await this.send(tab, 'DOM.getNodeForLocation', { x: Math.round(x + vp.pageX), y: Math.round(y + vp.pageY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
    } catch { return null; } // cannot tell: click
    if (!hit?.backendNodeId || hit.backendNodeId === backendNodeId) return null;
    try {
      const [own, other] = await Promise.all([this.objectId(tab, backendNodeId), this.objectId(tab, hit.backendNodeId)]);
      const r = await this.send(tab, 'Runtime.callFunctionOn', { objectId: own, functionDeclaration: CONTAINS, arguments: [{ objectId: other }], returnByValue: true });
      if (r.result?.value === true) return null;
    } catch { /* in another frame: covered */ }
    try {
      const objectId = await this.objectId(tab, hit.backendNodeId);
      const r = await this.send(tab, 'Runtime.callFunctionOn', { objectId, functionDeclaration: COVER_LABEL, returnByValue: true });
      return r.result?.value || 'another element';
    } catch { return 'another element'; }
  }

  async mouse(tab, x, y, { button = 'left', clickCount = 1 } = {}) {
    const buttons = { left: 1, right: 2, middle: 4 }[button] ?? 1;
    await this.input(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    for (let i = 1; i <= clickCount; i++) {
      await this.input(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: i });
      await this.input(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i });
    }
  }

  async click(tab, { ref, x, y, button, double, force }) {
    if (ref === undefined || ref === null || ref === '') {
      if (typeof x !== 'number' || typeof y !== 'number') throw new BrowserError('click needs a ref, or x and y (CSS pixels in the viewport)');
      await this.mouse(tab, x, y, { button, clickCount: double ? 2 : 1 });
      return;
    }
    let p = await this.point(tab, ref);
    if (!force) {
      let cover = await this.coveredBy(tab, p.backendNodeId, p.x, p.y);
      // Scrolled to the edge of the window, an element may be under a sticky header or footer: try it in the
      // middle, then at the other edges (as Playwright does).
      for (const block of ['center', 'end', 'start']) {
        if (!cover) break;
        await this.callOn(tab, ref, 'function(block) { this.scrollIntoView({ block, inline: "nearest", behavior: "instant" }); }', [block]);
        p = await this.point(tab, ref);
        cover = await this.coveredBy(tab, p.backendNodeId, p.x, p.y);
      }
      if (cover) throw new BrowserError(`${ref} is covered by ${cover}: close what covers it (a dialog, a banner, a menu), or pass force: true to click that point anyway`);
    }
    await this.mouse(tab, p.x, p.y, { button, clickCount: double ? 2 : 1 });
  }

  async hover(tab, ref) {
    const p = await this.point(tab, ref);
    await this.input(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
  }

  async press(tab, combo) {
    const parts = String(combo).split('+');
    const last = parts.pop();
    const name = last === '' && parts.length ? '+' : last; // "Control++"
    let mask = 0;
    const down = [];
    for (const raw of parts.filter(Boolean)) {
      const m = raw.toLowerCase() === 'mod' ? (process.platform === 'darwin' ? MODIFIERS.meta : MODIFIERS.control) : MODIFIERS[raw.toLowerCase()];
      if (!m) throw new BrowserError(`unknown modifier "${raw}" in "${combo}": use Control, Shift, Alt, Meta or Mod`);
      mask |= m[0];
      down.push(m);
      await this.input(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: m[1], code: m[2], windowsVirtualKeyCode: m[3], modifiers: mask });
    }
    const k = keyEvent(name);
    const shifted = mask & 8;
    const text = mask & ~8 ? undefined : k.text && shifted && k.text.length === 1 ? k.text.toUpperCase() : k.text;
    const key = shifted && k.key.length === 1 ? k.key.toUpperCase() : k.key;
    const commands = process.platform === 'darwin' && mask & 4 && MAC_COMMANDS[k.key.toLowerCase()] ? [MAC_COMMANDS[k.key.toLowerCase()]] : undefined;
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: mask };
    await this.input(tab, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands } : {}) });
    await this.input(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    for (const m of down.reverse()) {
      mask &= ~m[0];
      await this.input(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: m[1], code: m[2], windowsVirtualKeyCode: m[3], modifiers: mask });
    }
  }

  // Typing goes in as the browser's own text input (what an input method sends): every script and editor sees it
  // as typed, Chinese included.
  async type(tab, { ref, text = '', clear, submit, force }) {
    if (ref) await this.click(tab, { ref, force });
    if (clear) {
      const field = ref ? await this.callOn(tab, ref, 'function() { if (typeof this.select === "function" && "value" in this) { this.select(); return true; } return false; }') : false;
      if (!field) await this.press(tab, 'Mod+a');
      if (!text) await this.press(tab, 'Backspace');
    }
    if (text && !tab.dialog) await this.input(tab, 'Input.insertText', { text });
    if (submit && !tab.dialog) await this.press(tab, 'Enter');
  }

  async scroll(tab, { ref, dy, dx }) {
    if (ref && dy === undefined && dx === undefined) { await this.point(tab, ref); return; }
    const { cssVisualViewport: vp } = await this.send(tab, 'Page.getLayoutMetrics');
    let x = vp.clientWidth / 2;
    let y = vp.clientHeight / 2;
    if (ref) ({ x, y } = await this.point(tab, ref)); // scroll inside that element (a list, a panel)
    await this.input(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx || 0, deltaY: dy ?? Math.round(vp.clientHeight * 0.8) });
  }

  async selectOption(tab, ref, value) {
    const r = await this.callOn(tab, ref, `function(wanted) {
      if (this.tagName !== 'SELECT') return { error: 'not a <select>: click it and then the option' };
      const options = [...this.options];
      const o = options.find((x) => x.value === wanted) || options.find((x) => x.label.trim() === wanted || x.textContent.trim() === wanted);
      if (!o) return { error: 'no option ' + JSON.stringify(wanted) + '; the options: ' + options.map((x) => x.label.trim()).join(', ') };
      this.value = o.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { label: o.label.trim() };
    }`, [String(value ?? '')]);
    if (r?.error) throw new BrowserError(`${ref}: ${r.error}`);
    return r?.label;
  }

  async upload(tab, ref, files) {
    await this.send(tab, 'DOM.setFileInputFiles', { files, backendNodeId: refId(ref) }).catch((e) => { throw this.gone(ref, e); });
  }

  async evaluate(tab, script, ref) {
    const isFn = /^\s*(async\s+)?(function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(script);
    let r;
    if (ref) {
      const objectId = await this.objectId(tab, refId(ref), ref);
      const fn = isFn ? `function() { return (${script})(this); }` : `function() { return (${script}); }`;
      r = await this.untilDialog(tab, this.send(tab, 'Runtime.callFunctionOn', { objectId, functionDeclaration: fn, returnByValue: true, awaitPromise: true, userGesture: true }, { timeoutMs: browserLimits.evalMs }));
    } else {
      r = await this.untilDialog(tab, this.send(tab, 'Runtime.evaluate', { expression: isFn ? `(${script})()` : script, returnByValue: true, awaitPromise: true, userGesture: true, replMode: !isFn }, { timeoutMs: browserLimits.evalMs }));
    }
    if (!r) return `(no value yet: the script opened ${tab.dialog?.type === 'alert' ? 'an' : 'a'} ${tab.dialog?.type || ''} dialog, ${JSON.stringify(tab.dialog?.message ?? '')}; answer it with dialog)`;
    if (r.exceptionDetails) throw new BrowserError(`the script threw: ${exceptionText(r.exceptionDetails)}`);
    const v = r.result;
    if (v?.value !== undefined) return typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 1);
    return v?.description ?? String(v?.type ?? 'undefined');
  }

  async text(tab, ref) {
    if (ref) return String(await this.callOn(tab, ref, 'function() { return this.innerText ?? this.textContent ?? ""; }') ?? '');
    const r = await this.send(tab, 'Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }, { timeoutMs: browserLimits.evalMs });
    return String(r.result?.value ?? '');
  }

  async waitFor(tab, { text, gone, ms, timeout }) {
    if (!text) {
      await sleep(Math.min(Math.max(Number(ms) || 1000, 0), browserLimits.waitMaxMs), this.signal);
      return `waited ${ms || 1000} ms`;
    }
    const limit = Math.min(Number(timeout) || browserLimits.waitMs, browserLimits.waitMaxMs);
    const until = Date.now() + limit;
    const wanted = String(text).toLowerCase();
    for (;;) {
      const body = (await this.text(tab).catch((e) => { if (e?.name === 'AbortError') throw e; return ''; })).toLowerCase();
      if (body.includes(wanted) !== Boolean(gone)) return `${JSON.stringify(text)} ${gone ? 'is gone' : 'is on the page'}`;
      if (tab.dialog) throw new BrowserError(`a ${tab.dialog.type} dialog opened (${JSON.stringify(tab.dialog.message)})`);
      if (Date.now() >= until) throw new BrowserError(`${JSON.stringify(text)} ${gone ? 'is still on the page' : 'did not appear'} after ${limit / 1000} s`);
      await sleep(300, this.signal);
    }
  }

  async screenshot(tab, { ref, full }) {
    const params = { format: 'jpeg', quality: 80 };
    if (ref) {
      const p = await this.point(tab, ref);
      const { quads } = await this.send(tab, 'DOM.getContentQuads', { backendNodeId: p.backendNodeId });
      const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
      const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
      const { cssVisualViewport: vp } = await this.send(tab, 'Page.getLayoutMetrics');
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      params.clip = { x: left + vp.pageX, y: top + vp.pageY, width: Math.max(1, Math.max(...xs) - left), height: Math.max(1, Math.max(...ys) - top), scale: 1 };
      params.captureBeyondViewport = true;
    } else if (full) {
      const { cssContentSize: size } = await this.send(tab, 'Page.getLayoutMetrics');
      params.clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 10_000), scale: 1 };
      params.captureBeyondViewport = true;
    }
    await this.cdp.send('Target.activateTarget', { targetId: tab.targetId }, { signal: this.signal, timeoutMs: 5000 }).catch(() => {});
    const { data } = await this.send(tab, 'Page.captureScreenshot', params, { timeoutMs: 30_000 });
    return data;
  }

  async dialog(tab, { accept = true, text }) {
    if (!tab.dialog) throw new BrowserError('no dialog is open');
    await this.send(tab, 'Page.handleJavaScriptDialog', { accept: accept !== false, ...(text !== undefined ? { promptText: String(text) } : {}) });
    tab.dialog = null;
  }

  async release(tab) {
    if (tab?.sessionId) await this.send(tab, 'Runtime.releaseObjectGroup', { objectGroup: 'claude-pro' }, { timeoutMs: 3000 }).catch(() => {});
  }
}

export const safeUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' ? `${x.origin}${x.pathname}` : u;
  } catch { return u; }
};

export const browserSession = new BrowserSession();

// For a process that ends by itself (claude-pro -p): an open connection would keep it alive, and so would the
// pipe of WebFetch's headless browser (render.js).
export function closeBrowser() {
  browserSession.close();
  closeRenderer();
}

export { CdpError };
