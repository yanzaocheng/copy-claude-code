// WebFetch (fetch a page, convert to markdown-ish text, answer a prompt about it with the currently selected model)
// and WebSearch (the models' own search through the gateway, see searchWithModel; scraping DuckDuckGo or Bing only
// as the last resort).

import { quickQuery, streamMessage } from '../api.js';
import { localDate } from '../context.js';
import { renderPage, CHECK_TITLE } from '../browser/render.js';
import { safeUrl } from '../browser/session.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.8',
  // the languages a browser says it reads: without them a site may pick one by the address (ai.google.dev sent its
  // Portuguese page)
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
};
const MAX_REDIRECTS = 20; // as browsers
const cache = new Map(); // url -> {at, text, status, bytes}; only successful responses

// Limits, in one object so tests can shrink them.
export const webLimits = {
  timeoutMs: 30_000, // for a whole page, headers and body
  searchTimeoutMs: 20_000,
  maxBodyBytes: 10 * 1024 * 1024, // the rest of a bigger response is never downloaded
  cacheMs: 15 * 60_000,
  cacheEntries: 40,
  cacheBytes: 60 * 1024 * 1024,
};

// Content that is not text: a page read as text would be a wall of garbage for the model.
const BINARY_TYPE = /^(?:image\/(?!svg)|audio\/|video\/|font\/)|^application\/(?:pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|octet-stream|msword|wasm|vnd\.ms-|vnd\.openxmlformats-)/i;

// Decode a response body using the charset from the Content-Type header, a byte order mark or a
// <meta> tag, in that order of preference (pages in GBK, Big5 or Shift_JIS are common enough).
export function decodeBody(buf, contentType = '') {
  let label = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (buf[0] === 0xFF && buf[1] === 0xFE) label = 'utf-16le';
  else if (buf[0] === 0xFE && buf[1] === 0xFF) label = 'utf-16be';
  else if (!label) label = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1];
  try {
    return new TextDecoder(label || 'utf-8').decode(buf); // an unknown label throws
  } catch {
    return buf.toString('utf8');
  }
}

// Read at most `max` bytes of a response body and stop downloading after that.
async function readCapped(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const chunks = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  try { await reader.cancel(); } catch { /* already finished */ }
  return Buffer.concat(chunks).subarray(0, max);
}

function remember(url, entry) {
  const now = Date.now();
  for (const [key, old] of cache) if (now - old.at >= webLimits.cacheMs) cache.delete(key);
  cache.set(url, entry);
  let bytes = 0;
  for (const e of cache.values()) bytes += e.text.length;
  // Oldest first (Map keeps insertion order); the page just fetched always stays.
  for (const key of cache.keys()) {
    if (cache.size <= 1 || (cache.size <= webLimits.cacheEntries && bytes <= webLimits.cacheBytes)) break;
    bytes -= cache.get(key).text.length;
    cache.delete(key);
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToMarkdown(html, baseUrl) {
  let s = html;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1];
  s = s.replace(/<!--[\s\S]*?-->/g, '')
    // the name ends where the tag's does: <header>, <navbar-menu>, <style-guide> are other elements (taken for <head>,
    // <nav>, <style>, they ran on to a later closing tag and took the page's text with them)
    .replace(/<(script|style|noscript|svg|iframe|template|head)(?=[\s>/])[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(nav|footer)(?=[\s>/])[\s\S]*?<\/\1\s*>/gi, '');
  const abs = (href) => { try { return new URL(decodeEntities(href), baseUrl).href; } catch { return href; } };
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, code) => `\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, ''))}\n\`\`\`\n`)
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, t) => `\n\n${'#'.repeat(+n)} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => {
      const text = t.replace(/<[^>]+>/g, '').trim();
      return text ? `[${text}](${abs(href)})` : '';
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote|h\d)>/gi, '\n\n')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return (title ? `# ${decodeEntities(title.trim())}\n\n` : '') + s;
}

// The cookies of one fetch, kept across its redirects as a browser keeps them (for their host or domain, path,
// https only when secure, until they expire). Redirects followed without them can go round for good: ai.google.dev
// sends a visitor to a sign-in check that sets a cookie and sends it back, and without the cookie it starts again
// ("redirect count exceeded").
export class CookieJar {
  constructor() { this.cookies = []; }

  store(url, setCookies) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, hostOnly: true, path: null, secure: false, expires: null };
      for (const attr of attrs) {
        const i = attr.indexOf('=');
        const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
        const val = i < 0 ? '' : attr.slice(i + 1).trim();
        if (key === 'domain' && val) { cookie.domain = val.replace(/^\./, '').toLowerCase(); cookie.hostOnly = false; }
        else if (key === 'path' && val.startsWith('/')) cookie.path = val;
        else if (key === 'secure') cookie.secure = true;
        else if (key === 'max-age' && /^-?\d+$/.test(val)) cookie.expires = Date.now() + Number(val) * 1000;
        else if (key === 'expires' && cookie.expires === null && !Number.isNaN(Date.parse(val))) cookie.expires = Date.parse(val);
      }
      // not for another site, nor for a whole top-level domain (Domain=com)
      if (!cookie.hostOnly && (!cookie.domain.includes('.') || (host !== cookie.domain && !host.endsWith(`.${cookie.domain}`)))) continue;
      cookie.path ??= u.pathname.lastIndexOf('/') > 0 ? u.pathname.slice(0, u.pathname.lastIndexOf('/')) : '/';
      this.cookies = this.cookies.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
      if (cookie.expires === null || cookie.expires > Date.now()) this.cookies.push(cookie);
    }
  }

  header(url) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const now = Date.now();
    return this.cookies
      .filter((c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`))
        && (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`))
        && (!c.secure || u.protocol === 'https:')
        && (c.expires === null || c.expires > now))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
}

// The text of a page without its title line and blanks: how much it shows.
const shownChars = (text) => text.replace(/^# .*\n?/, '').replace(/\s+/g, '').length;
// A page that its scripts fill in: an empty element they mount the app into, or a note asking for JavaScript.
const APP_SHELL = /<(div|main|section)\b[^>]*\bid\s*=\s*["']?(?:root|app|__next|__nuxt|svelte|q-app)["']?[^>]*>\s*<\/\1>|<app-root\b[^>]*>\s*<\/app-root>|<noscript[^>]*>[\s\S]{0,500}?(?:enable|requires?|needs?|turn on)\b[\s\S]{0,60}?javascript|<noscript[^>]*>[\s\S]{0,300}?(?:启用|开启|需要)\s*javascript/i;

// A plain request, its redirects followed with their cookies: {status, statusText, text, html, scripts, check,
// binary, bytes, finalUrl, type}. `check`: a browser check page (Cloudflare's "Just a moment...").
async function fetchPlain(url, signal) {
  const ctrl = new AbortController();
  // A timeout must be reported as one, and must not look like the user's interrupt.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, webLimits.timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort(); else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const jar = new CookieJar();
    let current = url;
    for (let hops = 0; ; hops++) {
      const cookie = jar.header(current);
      const res = await fetch(current, { headers: cookie ? { ...HEADERS, Cookie: cookie } : HEADERS, redirect: 'manual', signal: ctrl.signal });
      jar.store(current, res.headers.getSetCookie?.() ?? []);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (location) {
        try { await res.body?.cancel(); } catch { /* done */ }
        const next = new URL(location, current).href;
        if (hops >= MAX_REDIRECTS) throw Object.assign(new Error(`too many redirects (more than ${MAX_REDIRECTS}; they go round between ${safeUrl(current)} and ${safeUrl(next)})`), { code: 'TOO_MANY_REDIRECTS' });
        current = next;
        continue;
      }
      const buf = await readCapped(res, webLimits.maxBodyBytes);
      const type = res.headers.get('content-type') || '';
      const base = { at: Date.now(), status: res.status, statusText: res.statusText, bytes: buf.length, finalUrl: current, type };
      // Binary content (a PDF, an image, an archive) is not shown as text.
      if (BINARY_TYPE.test(type) || buf.subarray(0, 8000).includes(0)) return { ...base, text: '', binary: true };
      const body = decodeBody(buf, type);
      const html = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body);
      const title = html ? decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() || '') : '';
      return {
        ...base, html, title,
        text: html ? htmlToMarkdown(body, current) : body,
        scripts: html && /<script\b/i.test(body),
        shell: html && APP_SHELL.test(body),
        check: res.headers.get('cf-mitigated') === 'challenge' || (html && CHECK_TITLE.test(title)),
      };
    }
  } catch (e) {
    if (timedOut && !signal?.aborted) throw Object.assign(new Error(`timed out after ${Number((webLimits.timeoutMs / 1000).toFixed(1))}s`), { code: 'TIMEOUT' });
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Why a page that a plain request got is opened in a headless browser too, or null: a browser check page, a server
// that refuses what is not a browser (403 "Access Denied", 429, 503), or a page whose text its scripts write (an
// app's empty shell, or next to no text at all with scripts; not a small page that has a script, as example.com).
function browserReason(page) {
  if (page.binary) return null;
  if (page.check) return 'check';
  if ([403, 429, 503].includes(page.status)) return 'refused';
  if (page.html && page.status < 300 && page.scripts) {
    const shown = shownChars(page.text);
    if (shown < 50 || (page.shell && shown < 1000)) return 'script';
  }
  return null;
}

// Whether a request that failed may work in a browser: redirects that go round, a connection reset or refused at
// its TLS handshake (servers that tell a browser by it), a name or route the browser's proxy settings reach. Not
// when nothing listens there, nor after the request took its whole time already.
const browserMayOpen = (err) => !['ECONNREFUSED', 'TIMEOUT'].includes(err?.code || err?.cause?.code);

// A page for WebFetch: a plain request first (fast and cheap), and the headless browser (browser/render.js) when
// that does not get the page (see browserReason). `rendered`: the browser's page; `blocked`: a page the browser did
// not get past either (a check that wants a person, or next to nothing shown after a refusal).
async function fetchPage(url, signal) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < webLimits.cacheMs) return hit;
  let plain = null;
  let failure = null;
  try { plain = await fetchPlain(url, signal); } catch (e) {
    if (signal?.aborted) throw e;
    failure = e;
  }
  const web = /^https?:$/.test(new URL(url).protocol);
  const why = !web ? null : plain ? browserReason(plain) : browserMayOpen(failure) ? 'failed' : null;
  let page = plain;
  if (why) {
    let rendered = null;
    try { rendered = await renderPage(url, { signal }); } catch (e) {
      if (signal?.aborted) throw e;
      if (!plain) throw Object.assign(new Error(`${failure.cause?.message || failure.message}; a headless browser could not open it either (${e.message})`), { code: failure.code });
    }
    if (rendered) {
      const text = htmlToMarkdown(rendered.html, rendered.finalUrl);
      const r = {
        at: Date.now(), status: rendered.status, statusText: rendered.statusText, bytes: Buffer.byteLength(rendered.html),
        finalUrl: rendered.finalUrl, type: 'text/html', html: true, title: rendered.title, text, rendered: true,
        refusedStatus: plain && why !== 'script' ? plain.status : null,
      };
      if (rendered.challenge) page = { ...r, blocked: 'check' };
      else if ((why === 'check' || why === 'refused') && r.status < 400 && shownChars(text) < 200) page = { ...r, blocked: 'empty' };
      else if (why !== 'script' || shownChars(text) > shownChars(plain.text)) page = r;
    }
  }
  if (!page) throw failure; // nothing listens there, or it took the whole time already
  // Only a successful page is remembered: a 503 or a 404 must not be served for the next 15 minutes after the
  // server has recovered.
  if (page.status >= 200 && page.status < 300 && !page.binary && !page.blocked) remember(url, page);
  return page;
}

export function makeWebFetchTool(config) {
  return {
    name: 'WebFetch',
    readOnly: true,
    description: `- Fetches content from a specified URL (any scheme the network allows, including localhost and private addresses), converts HTML to markdown, and answers a prompt about it using the model currently selected for this session
- Takes a URL and a prompt as input
- Set raw: true to get the converted page text itself instead of an answer: use it when you need the exact content, code, tables or the whole document (very long pages are saved to a file and previewed; read the file for the rest)
- Use this tool when you need to retrieve and analyze web content

Usage notes:
- The URL must be a fully-formed valid URL, used exactly as given
- The prompt should describe what information you want to extract from the page; it is optional with raw: true
- This tool is read-only and does not modify any files
- Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL`,
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'The URL to fetch content from' },
        prompt: { type: 'string', description: 'The prompt to run on the fetched content' },
        raw: { type: 'boolean', description: 'Return the converted page text itself instead of an answer from the selected model' },
      },
      required: ['url'],
    },
    summarize(input) { return input.url; },
    domain(input) { try { return new URL(input.url).hostname; } catch { return null; } },
    async call(input, ctx) {
      let url;
      try { url = new URL(input.url); } catch { return { isError: true, content: `Invalid URL: ${input.url}` }; }
      let page;
      try { page = await fetchPage(url.href, ctx.signal); } catch (e) {
        if (ctx.signal?.aborted) throw e;
        return { isError: true, content: `Failed to fetch ${url.href}: ${e.cause?.message || e.message}` };
      }
      const size = page.bytes > 1024 ? `${(page.bytes / 1024).toFixed(1)}KB` : `${page.bytes}B`;
      const display = { summary: `Received ${size} (${`${page.status} ${page.statusText || ''}`.trim()}${page.rendered ? ', in a headless browser' : ''})` };
      const useBrowser = 'Open it with the Browser tool: in the user\'s browser, which may be logged in or past the check already, or with browser: "own", where the user can pass the check if it asks.';
      if (page.blocked === 'check') {
        return { isError: true, content: `${url.href} shows a browser check ("${page.title || 'Just a moment...'}") that a headless browser does not get past: it wants a person. ${useBrowser}`, display };
      }
      if (page.blocked === 'empty') {
        const ended = page.finalUrl && page.finalUrl !== url.href ? ` (it ended at ${safeUrl(page.finalUrl)})` : '';
        return { isError: true, content: `${url.href} turned a plain request away (HTTP ${page.refusedStatus}) and showed next to nothing in a headless browser either${ended}: it may want a login or a check by a person. ${useBrowser}\n\n${page.text.slice(0, 1000)}`, display };
      }
      if (page.status >= 400) {
        const hint = [401, 403, 429, 503].includes(page.status) ? `\n\n(${page.rendered ? 'A headless browser got this too. ' : ''}If the page opens in a browser for the user, with a login or a check, use the Browser tool.)` : '';
        return { isError: true, content: `HTTP ${page.status} ${page.statusText} fetching ${url.href}${hint}\n\n${page.text.slice(0, 2000)}`, display };
      }
      if (page.binary) {
        return { isError: true, content: `${page.finalUrl || url.href} is not text (${page.type || 'binary data'}, ${size}), so WebFetch cannot read it. If you need the file, download it with curl in Bash.`, display };
      }
      if (input.raw) {
        const text = page.text.length > 1_000_000 ? `${page.text.slice(0, 1_000_000)}\n\n[content truncated at 1,000,000 characters]` : page.text;
        return { content: text || '(the page has no text content)', display };
      }
      const content = page.text.length > 400_000 ? page.text.slice(0, 400_000) + '\n\n[content truncated]' : page.text;
      try {
        const answer = await quickQuery(config, {
          model: config.model,
          system: 'You extract information from web pages. Answer only from the provided content. Be complete and precise: include every relevant detail, exact quotes, numbers and code. Keep code blocks intact.',
            prompt: `Web page content from ${page.finalUrl || url.href}:\n---\n${content}\n---\n\n${input.prompt || 'Summarize this page, keeping all important details, code and numbers.'}\n\nRespond based only on the content above.`,
            maxTokens: 16_000,
            signal: ctx.signal,
            // Nobody is told about a pause that happens inside a tool call, so the summary is skipped
            // instead (the page text below is returned as it is) and the main agent does the waiting.
            waitForRateLimit: false,
          });
        if (answer) return { content: answer, display };
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
      }
      return { content: content.slice(0, 100_000), display };
    },
  };
}

// A search engine that never answers must not hold the tool call for minutes.
const withTimeout = (signal) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(webLimits.searchTimeoutMs)]);

async function searchDuckDuckGo(query, signal) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query }).toString(),
    signal: withTimeout(signal),
  });
  return parseDuckDuckGo(await res.text());
}

// The results of DuckDuckGo's HTML page, one block per result link. (One regex with an optional snippet group after
// a lazy gap never took the snippet: the gap matched nothing, and every snippet came back empty.)
export function parseDuckDuckGo(html) {
  const results = [];
  const starts = [...html.matchAll(/<a[^>]+class="result__a"/g)].map((m) => m.index);
  for (let i = 0; i < starts.length && results.length < 10; i++) {
    const block = html.slice(starts[i], starts[i + 1] ?? html.length);
    const a = /^<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    let href = decodeEntities(a[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (/duckduckgo\.com\/y\.js/.test(href)) continue; // ads
    const s = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block);
    results.push({ title: decodeEntities(a[2].replace(/<[^>]+>/g, '')).trim(), url: href, snippet: s ? decodeEntities(s[1].replace(/<[^>]+>/g, '')).trim() : '' });
  }
  return results;
}

async function searchBing(query, signal) {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, { headers: { 'User-Agent': UA }, signal: withTimeout(signal) });
  const html = await res.text();
  const results = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    results.push({ title: decodeEntities(a[2].replace(/<[^>]+>/g, '')).trim(), url: decodeEntities(a[1]), snippet: p ? decodeEntities(p[1].replace(/<[^>]+>/g, '')).trim() : '' });
    if (results.length >= 10) break;
  }
  return results;
}

// ---- WebSearch through the gateway
//
// The search runs where the selected model runs: a request with the server-side search tool (Anthropic's web_search;
// the gateway gives GPT models Codex's), which searches, reads the results and reports what they say, each statement
// marked with its source. Scraping search engines' pages from here, which this tool used to do, gets their bot pages
// (DuckDuckGo: 202), or Bing's results for the first word of the query only (2026-10-27: "run iOS simulator on
// Windows 2026 without Mac" gave ten dictionary entries for "run"): that is the last resort now.

export const searchLimits = { timeoutMs: 90_000, maxUses: 5, maxTextChars: 8000, maxResults: 40 };

const searchSystem = (today) => `You run web searches for another AI agent and report what they found. Search for the query (search again with other words when the first results miss it), then write what the results say that answers it: facts, versions, numbers, dates and names exactly as the pages give them. Do not answer from your own knowledge; when the results do not answer the query, say so plainly. Be brief: at most about 300 words, no preamble. Today's date is ${today}.`;

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const domainMatch = (host, d) => host === d || host.endsWith(`.${String(d).replace(/^\.+/, '')}`);

// Whether a result's URL passes the call's allowed_domains / blocked_domains.
function domainFilter(input) {
  const allowed = (input.allowed_domains || []).map((d) => String(d).toLowerCase());
  const blocked = (input.blocked_domains || []).map((d) => String(d).toLowerCase());
  return (url) => {
    const host = hostOf(url).toLowerCase();
    if (!host) return false;
    if (allowed.length && !allowed.some((d) => domainMatch(host, d))) return false;
    return !blocked.some((d) => domainMatch(host, d));
  };
}

// What a search request brought back: {results: [{url, title, age}], text, errors, queries}. Anthropic's search
// gives its results as web_search_tool_result blocks (their text is encrypted: what the pages say comes through the
// answer, whose statements carry citations, here marked [n] after the result they come from); Codex's, through the
// gateway, as links in the answer. `keep(url)`: whether a result may be shown.
export function readSearchReply(blocks, keep = () => true) {
  const results = [];
  const index = new Map();
  const add = (url, title, age) => {
    if (!/^https?:\/\//i.test(url || '') || !keep(url)) return -1;
    if (!index.has(url)) {
      results.push({ url, title: String(title || '').replace(/\s+/g, ' ').trim(), age: age || '' });
      index.set(url, results.length - 1);
    }
    return index.get(url);
  };
  const errors = [];
  const queries = [];
  let text = '';
  for (const b of blocks) {
    if (b.type === 'server_tool_use' && b.input?.query) queries.push(String(b.input.query));
    else if (b.type === 'web_search_tool_result') {
      if (Array.isArray(b.content)) for (const r of b.content) add(r.url, r.title, r.page_age);
      else if (b.content?.error_code) errors.push(b.content.error_code);
    } else if (b.type === 'text') {
      const cited = [...new Set((b.citations || []).map((c) => add(c.url, c.title)).filter((i) => i >= 0))];
      text += b.text + cited.map((i) => `[${i + 1}]`).join('');
    }
  }
  if (!blocks.some((b) => b.type === 'web_search_tool_result')) {
    for (const m of text.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)) add(m[2], m[1]);
    for (const m of text.matchAll(/https?:\/\/[^\s)\]>"'`]+/g)) add(m[0].replace(/[.,;:]+$/, ''), '');
  }
  return { results, text: text.trim(), errors, queries };
}

// One search request with `model`; throws when it fails (an error status, a timeout).
async function searchWithModel(config, model, input, signal) {
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: searchLimits.maxUses };
  // Anthropic's search takes one of the two lists; the gateway passes neither to GPT. So the prompt says them as
  // well, and the results are filtered here (readSearchReply).
  if (input.allowed_domains?.length) tool.allowed_domains = input.allowed_domains;
  else if (input.blocked_domains?.length) tool.blocked_domains = input.blocked_domains;
  const scope = [
    input.allowed_domains?.length ? `Only use results from: ${input.allowed_domains.join(', ')}.` : '',
    input.blocked_domains?.length ? `Leave out results from: ${input.blocked_domains.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  const res = await streamMessage(config, {
    model,
    system: searchSystem(localDate()),
    messages: [{ role: 'user', content: `Query: ${input.query}${scope ? `\n\n${scope}` : ''}` }],
    tools: [tool],
    maxTokens: 4000,
    effort: /^gpt-/i.test(model.id) ? 'low' : null, // GPT's default effort thinks for long: a search does not need it
    cacheBucket: 'other',
    cacheMessages: false,
  }, { signal, waitForRateLimit: false });
  return readSearchReply(res.message.content, domainFilter(input));
}

function formatSearch(query, found, model) {
  const { results, text, queries } = found;
  const shown = results.slice(0, searchLimits.maxResults);
  const list = shown.map((r, i) => `${i + 1}. [${(r.title || hostOf(r.url)).replace(/[[\]]/g, '')}](${r.url})${r.age ? ` · ${r.age}` : ''}`).join('\n');
  const ran = queries.length > 1 || (queries.length === 1 && queries[0] !== query) ? ` (searched: ${queries.map((q) => `"${q}"`).join(', ')})` : '';
  const said = text.length > searchLimits.maxTextChars ? `${text.slice(0, searchLimits.maxTextChars)}…` : text;
  const parts = [`Web search results for query: "${query}"${ran}`];
  if (list) parts.push(list);
  if (said) parts.push(`What the results say (summarized by ${model.id}${list ? '; [n] is result n above' : ''}):\n${said}`);
  return parts.join('\n\n');
}

export const WebSearchTool = {
  name: 'WebSearch',
  readOnly: true,
  description: `- Searches the web and returns the results (title, URL, age) with a summary of what they say, each statement marked with the result it comes from
- Use it for current information, documentation, releases, error messages and anything beyond your knowledge cutoff
- Use WebFetch afterwards to read a result in full (it also reads a single post on X from its x.com URL)
- allowed_domains limits the search to some sites: ["x.com"] for posts on X (Twitter), ["github.com"] for repositories and issues (gh in Bash gives exact GitHub data when it is installed); blocked_domains leaves sites out
- After answering from search results, include a "Sources:" section listing the relevant URLs as markdown links`,
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, description: 'The search query to use' },
      allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include results from these domains' },
      blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never include results from these domains' },
    },
    required: ['query'],
  },
  summarize(input) { return `"${input.query}"${input.allowed_domains?.length ? ` on ${input.allowed_domains.join(', ')}` : ''}`; },
  async call(input, ctx) {
    const failures = [];
    if (ctx.config) {
      const model = ctx.config.model;
      const timeout = AbortSignal.timeout(searchLimits.timeoutMs);
      try {
        const found = await searchWithModel(ctx.config, model, input, AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), timeout]));
        if (found.results.length || (found.text && !found.errors.length)) {
          return { content: formatSearch(input.query, found, model), display: { summary: `Found ${found.results.length} results` } };
        }
        if (!found.errors.length) {
          // a search that worked and found nothing: so it is (another engine would not do better)
          return { content: `No results found for "${input.query}"${input.allowed_domains?.length ? ` on ${input.allowed_domains.join(', ')}` : ''}.`, display: { summary: 'No results' } };
        }
        failures.push(`${model.id}: ${found.errors.join(', ')}`);
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        failures.push(`${model.id}: ${timeout.aborted ? `timed out after ${searchLimits.timeoutMs / 1000}s` : (e.message || String(e)).slice(0, 200)}`);
      }
    }
    // The last resort: a search engine's page, scraped.
    const note = failures.length ? `(The search through the gateway failed: ${failures.join('; ')}. These results are scraped from a search engine's page instead and may be off-topic.)\n\n` : '';
    let results = [];
    const errors = [];
    for (const engine of [searchDuckDuckGo, searchBing]) {
      try {
        results = await engine(input.query, ctx.signal);
        if (results.length) break;
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        errors.push(e.cause?.message || e.message);
      }
    }
    const keep = domainFilter(input);
    results = results.filter((r) => keep(r.url));
    if (!results.length) {
      return { isError: Boolean(errors.length || failures.length), content: errors.length || failures.length ? `Web search failed: ${[...failures, ...errors].join('; ')}` : `No results found for "${input.query}"`, display: { summary: 'No results' } };
    }
    const text = results.map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`).join('\n\n');
    return { content: `${note}Web search results for query: "${input.query}"\n\n${text}`, display: { summary: `Found ${results.length} results` } };
  },
};
