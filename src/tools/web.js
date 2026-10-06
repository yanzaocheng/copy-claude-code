// WebFetch (fetch a page, convert to markdown-ish text, answer a prompt about it with the
// small model) and WebSearch (DuckDuckGo HTML endpoint with a Bing fallback).

import { quickQuery } from '../api.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
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
    .replace(/<(script|style|noscript|svg|iframe|template|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer)[\s\S]*?<\/\1>/gi, '');
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

async function fetchText(url, signal) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < webLimits.cacheMs) return hit;
  const ctrl = new AbortController();
  // A timeout must be reported as one, and must not look like the user's interrupt.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, webLimits.timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort(); else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: ctrl.signal });
    const buf = await readCapped(res, webLimits.maxBodyBytes);
    const type = res.headers.get('content-type') || '';
    const base = { at: Date.now(), status: res.status, statusText: res.statusText, bytes: buf.length, finalUrl: res.url, type };
    // Binary content (a PDF, an image, an archive) is not shown as text.
    if (BINARY_TYPE.test(type) || buf.subarray(0, 8000).includes(0)) return { ...base, text: '', binary: true };
    let text = decodeBody(buf, type);
    if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(text)) text = htmlToMarkdown(text, res.url);
    const r = { ...base, text };
    // Only a successful page is remembered: a 503 or a 404 must not be served for the next 15 minutes
    // after the server has recovered.
    if (res.ok) remember(url, r);
    return r;
  } catch (e) {
    if (timedOut && !signal?.aborted) throw new Error(`timed out after ${Number((webLimits.timeoutMs / 1000).toFixed(1))}s`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function makeWebFetchTool(config) {
  return {
    name: 'WebFetch',
    readOnly: true,
    description: `- Fetches content from a specified URL (any scheme the network allows, including localhost and private addresses), converts HTML to markdown, and answers a prompt about it using a small, fast model
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
        raw: { type: 'boolean', description: 'Return the converted page text itself instead of an answer from the small model' },
      },
      required: ['url'],
    },
    summarize(input) { return input.url; },
    domain(input) { try { return new URL(input.url).hostname; } catch { return null; } },
    async call(input, ctx) {
      let url;
      try { url = new URL(input.url); } catch { return { isError: true, content: `Invalid URL: ${input.url}` }; }
      let page;
      try { page = await fetchText(url.href, ctx.signal); } catch (e) {
        if (ctx.signal?.aborted) throw e;
        return { isError: true, content: `Failed to fetch ${url.href}: ${e.cause?.message || e.message}` };
      }
      const size = page.bytes > 1024 ? `${(page.bytes / 1024).toFixed(1)}KB` : `${page.bytes}B`;
      const display = { summary: `Received ${size} (${page.status} ${page.statusText || ''})`.trim() };
      if (page.status >= 400) return { isError: true, content: `HTTP ${page.status} ${page.statusText} fetching ${url.href}\n\n${page.text.slice(0, 2000)}`, display };
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
          model: config.smallModel,
          system: 'You extract information from web pages. Answer only from the provided content. Be complete and precise: include every relevant detail, exact quotes, numbers and code. Keep code blocks intact.',
          prompt: `Web page content from ${page.finalUrl || url.href}:\n---\n${content}\n---\n\n${input.prompt || 'Summarize this page, keeping all important details, code and numbers.'}\n\nRespond based only on the content above.`,
          maxTokens: 16_000,
          signal: ctx.signal,
          // Nobody is told about a pause that happens inside a tool call, so the summary is skipped
          // instead (the page text below is returned as it is) and the main agent does the waiting.
          waitForRateLimit: false,
        });
        return { content: answer || content.slice(0, 50_000), display };
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        return { content: content.slice(0, 100_000), display };
      }
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
  const html = await res.text();
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && results.length < 10) {
    let href = decodeEntities(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (/duckduckgo\.com\/y\.js/.test(href)) continue; // ads
    results.push({ title: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim(), url: href, snippet: decodeEntities((m[3] || '').replace(/<[^>]+>/g, '')).trim() });
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

export const WebSearchTool = {
  name: 'WebSearch',
  readOnly: true,
  description: `- Allows searching the web and using the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search results (title, URL, snippet) for the query
- Use this tool for accessing information beyond your knowledge cutoff
- Use WebFetch afterwards to read a promising result in full
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
  summarize(input) { return `"${input.query}"`; },
  async call(input, ctx) {
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
    const host = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
    const match = (h, d) => h === d || h.endsWith('.' + d);
    if (input.allowed_domains?.length) results = results.filter((r) => input.allowed_domains.some((d) => match(host(r.url), d)));
    if (input.blocked_domains?.length) results = results.filter((r) => !input.blocked_domains.some((d) => match(host(r.url), d)));
    if (!results.length) {
      return { isError: !!errors.length, content: errors.length ? `Web search failed: ${errors.join('; ')}` : `No results found for "${input.query}"`, display: { summary: 'No results' } };
    }
    const text = results.map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`).join('\n\n');
    return { content: `Web search results for query: "${input.query}"\n\n${text}`, display: { summary: `Found ${results.length} results` } };
  },
};
