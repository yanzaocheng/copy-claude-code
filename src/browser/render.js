// Pages for WebFetch that a plain request does not get: a page that needs JavaScript to show its text, or a server
// that refuses what is not a browser (Akamai's "Access Denied"). They are opened in a headless Chrome (or Edge), one
// per claude-pro process, started with the first such page and closed after a minute without one. It talks over a
// pipe (--remote-debugging-pipe), not a port: no other program can drive it, and it exits by itself when this
// process ends, however that happens (two seconds after a hard kill, measured). Its profile is a fresh one in the
// temp directory: no cookies or logins of the user's.
// A check that wants a person (Cloudflare's "Just a moment...", a CAPTCHA) is not got past: such a page comes back
// with `challenge` set, for the caller to send the model to the Browser tool, where the user can pass it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Cdp, abortError } from './cdp.js';
import { browserExecutables } from './executables.js';
import { killTree, killTreeSync, processAlive } from '../utils/shell.js';

export const renderLimits = {
  startMs: 20_000,
  navigationMs: 25_000, // until the server answers
  loadMs: 15_000, // then until the load event, at most (some pages never stop loading)
  challengeMs: 15_000, // a browser check that runs by itself (a script that sets a cookie and reloads)
  settleMs: 5_000, // then until the network is quiet, for a page that builds itself with scripts
  idleMs: 60_000, // the browser closes after this long without a page
};

const PROFILE_PREFIX = 'claude-pro-render-';
// The title of a check page: one that goes on to the page by itself, or that wants a person.
export const CHECK_TITLE = /^\s*(?:just a moment|attention required|checking (?:your|if the site connection is secure)|please wait|one more step|ddos-guard)/i;
// What the page shows, and whether it is a check page (Cloudflare's, or one with the same title).
const PAGE_STATE = `JSON.stringify({
  title: document.title,
  check: ${CHECK_TITLE}.test(document.title)
    || !!document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, script[src*="/cdn-cgi/challenge-platform/"], iframe[src*="challenges.cloudflare.com"]'),
})`;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(abortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

// Until `done()` or `ms` have passed (not an error: what the page shows then is taken).
async function until(done, ms, signal) {
  for (const end = Date.now() + ms; !done() && Date.now() < end;) await sleep(100, signal);
}

// The DevTools protocol over the browser's pipe, as the WebSocket Cdp expects: messages separated by NUL bytes,
// fd 3 to the browser and fd 4 from it.
class PipeSocket {
  constructor(input, output) {
    this.input = input;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    let buf = '';
    output.setEncoding('utf8');
    output.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\0'); i >= 0; i = buf.indexOf('\0')) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.onmessage?.({ data: msg });
      }
    });
    const closed = () => { if (this.closed) return; this.closed = true; this.onclose?.({}); };
    output.on('close', closed);
    output.on('error', closed);
    input.on('error', closed);
  }

  send(text) { this.input.write(`${text}\0`); }
  close() { try { this.input.end(); } catch { /* gone */ } }
}

// A profile removed; while a file of it is still held (a browser whose end Windows holds up, below), tried again
// every 15 s for two minutes, then left to the next browser's sweep.
function removeDir(dir, tries = 8) {
  fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }, (err) => {
    if (err && tries > 1) setTimeout(() => removeDir(dir, tries - 1), 15_000).unref();
  });
}

// Profiles left behind: those of processes that are gone (one killed outright, or one that exited before its
// browser had let go of the files), and this process's own earlier ones (its browser is not running now).
function sweepProfiles() {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch { return; }
  for (const name of names) {
    const pid = Number(new RegExp(`^${PROFILE_PREFIX}(\\d+)-`).exec(name)?.[1]);
    if (!pid || (pid !== process.pid && processAlive(pid))) continue;
    removeDir(path.join(os.tmpdir(), name));
  }
}

let browser = null; // {child, cdp, dir, ua, meta, busy, idleTimer}
let starting = null;
let exitHook = false;

async function launch(signal) {
  const exe = browserExecutables().find((p) => p && fs.existsSync(p));
  if (!exe) throw new Error('no Chrome or Edge is installed to open it in');
  sweepProfiles();
  if (!exitHook) {
    // A process that exits on purpose (a restart, the end of a -p run) ends it at once, crash reporter included
    // (see closeRenderer). Its profile goes with the next browser's sweep.
    exitHook = true;
    process.once('exit', () => { if (browser) killTreeSync(browser.child); });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${PROFILE_PREFIX}${process.pid}-`));
  const child = spawn(exe, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled', '--disable-extensions', '--mute-audio', '--hide-scrollbars',
    // nothing of its own in the background (component and safe-browsing downloads, sync, translation): a throwaway
    // browser for pages, which then also has less to finish when it is closed
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-features=OptimizationHints,Translate,MediaRouter', '--metrics-recording-only',
    '--window-size=1366,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
  const failed = new Promise((_, reject) => child.once('error', (e) => reject(new Error(`could not start ${path.basename(exe)}: ${e.message}`))));
  failed.catch(() => {});
  const cdp = new Cdp(new PipeSocket(child.stdio[3], child.stdio[4]));
  try {
    const version = await Promise.race([failed, cdp.send('Browser.getVersion', {}, { timeoutMs: renderLimits.startMs, signal })]);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }, { timeoutMs: 5000 }).catch(() => {});
    // As the browser it is: without "Headless" in its name, which servers turn away (in the client hints too).
    const ua = version.userAgent.replace(/Headless(?=Chrome|Edg)/g, '');
    const full = /\/([\d.]+)/.exec(version.product)?.[1] || '0';
    const major = full.split('.')[0];
    const brand = /msedge/i.test(exe) ? 'Microsoft Edge' : /chrome/i.test(exe) ? 'Google Chrome' : null;
    const brands = (v) => [{ brand: 'Chromium', version: v }, ...(brand ? [{ brand, version: v }] : []), { brand: 'Not_A Brand', version: v === major ? '24' : '24.0.0.0' }];
    const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    const meta = { brands: brands(major), fullVersionList: brands(full), platform, platformVersion: '', architecture: process.arch === 'arm64' ? 'arm' : 'x86', bitness: '64', model: '', mobile: false };
    return { child, cdp, dir, ua, meta, busy: 0, idleTimer: null };
  } catch (e) {
    cdp.close();
    killTree(child).finally(() => removeDir(dir));
    throw e;
  }
}

async function ensureBrowser(signal) {
  if (browser && !browser.cdp.closed) return browser;
  browser = null;
  starting ??= launch(signal).then((b) => {
    browser = b;
    // its pipe broke (the browser crashed, or it stopped answering): whatever is left of it goes, the next page
    // starts another
    b.cdp.on((method) => {
      if (method !== 'Cdp.closed' || browser !== b) return;
      browser = null;
      killTree(b.child).finally(() => removeDir(b.dir));
    });
    return b;
  }).finally(() => { starting = null; });
  return starting;
}

function scheduleClose(b) {
  clearTimeout(b.idleTimer);
  if (b.busy) return;
  b.idleTimer = setTimeout(() => { if (browser === b && !b.busy) closeRenderer(); }, renderLimits.idleMs);
  b.idleTimer.unref?.();
}

// The headless browser, closed now: after a minute without a page, or when the program ends (a -p run would wait
// for its pipe).
export function closeRenderer() {
  const b = browser;
  browser = null;
  if (!b) return;
  clearTimeout(b.idleTimer);
  b.cdp.close();
  // Its whole process tree at once: a throwaway browser has nothing to save, and its crash reporter (started on
  // Windows whatever the switches) otherwise stayed, at times, for many seconds after the browser, holding a file of
  // the profile. Even killed, a browser may take Windows 20 to 60 s to end (seen in about one run in five: its
  // termination waits for file I/O, likely the virus scanner on the new profile's files); the profile is removed
  // once it has (removeDir).
  killTree(b.child).finally(() => removeDir(b.dir));
}

// `url` opened in the headless browser: {html, finalUrl, title, status, statusText, challenge}. `status` is the
// main document's (a check page's 403 that went on to the page by itself is the page's 200 by then); `challenge`:
// the page is still a check page, one that wants a person. Throws when the page cannot be opened at all (a network
// error the browser reports, no browser installed).
export async function renderPage(url, { signal } = {}) {
  const b = await ensureBrowser(signal);
  b.busy++;
  clearTimeout(b.idleTimer);
  let targetId = null;
  let off = null;
  try {
    ({ targetId } = await b.cdp.send('Target.createTarget', { url: 'about:blank' }, { signal, timeoutMs: 10_000 }));
    const { sessionId } = await b.cdp.send('Target.attachToTarget', { targetId, flatten: true }, { signal, timeoutMs: 10_000 });
    const send = (method, params = {}, timeoutMs = 15_000) => b.cdp.send(method, params, { sessionId, signal, timeoutMs });
    let status = null;
    let statusText = '';
    let loaded = false;
    let quiet = false;
    off = b.cdp.on((method, params, sid) => {
      if (sid !== sessionId) return;
      if (method === 'Network.responseReceived' && params.type === 'Document' && params.frameId === targetId) {
        status = params.response?.status ?? status;
        statusText = params.response?.statusText || '';
      } else if (method === 'Page.loadEventFired') loaded = true;
      else if (method === 'Page.lifecycleEvent' && params.frameId === targetId) {
        if (params.name === 'init') quiet = false; // a new document (a check page that reloads to the page)
        else if (params.name === 'networkIdle') quiet = true;
      }
    });
    await send('Network.enable');
    await send('Network.setUserAgentOverride', { userAgent: b.ua, acceptLanguage: 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7', userAgentMetadata: b.meta });
    await send('Page.enable');
    await send('Page.setLifecycleEventsEnabled', { enabled: true });
    const nav = await send('Page.navigate', { url }, renderLimits.navigationMs);
    if (nav.errorText) throw new Error(`the browser could not open it: ${nav.errorText}`);
    await until(() => loaded, renderLimits.loadMs, signal);
    // null between two documents (a check page reloading to the page): the state is not known then
    const state = async () => {
      try { return JSON.parse((await send('Runtime.evaluate', { expression: PAGE_STATE, returnByValue: true })).result.value); } catch (e) {
        if (signal?.aborted) throw e;
        return null;
      }
    };
    let page = (await state()) || { title: '', check: false };
    for (const end = Date.now() + renderLimits.challengeMs; page.check && Date.now() < end;) {
      await sleep(500, signal);
      page = (await state()) || page;
    }
    await until(() => quiet, renderLimits.settleMs, signal);
    const { result } = await send('Runtime.evaluate', { expression: `JSON.stringify({ html: document.documentElement ? document.documentElement.outerHTML : '', url: location.href, state: ${PAGE_STATE} })`, returnByValue: true }, 30_000);
    const out = JSON.parse(result.value);
    const last = JSON.parse(out.state);
    return { html: out.html, finalUrl: out.url, title: last.title, status: status ?? 200, statusText, challenge: last.check };
  } finally {
    off?.();
    if (targetId) b.cdp.send('Target.closeTarget', { targetId }, { timeoutMs: 5000 }).catch(() => {});
    b.busy--;
    scheduleClose(b);
  }
}
