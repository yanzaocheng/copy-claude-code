import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Config } from '../src/config.js';
import { makeWebFetchTool, decodeBody, webLimits } from '../src/tools/web.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GBK = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3, 0xCA, 0xC0, 0xBD, 0xE7]); // 你好世界

async function pageServer(t, handler) {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) || 0) + 1);
    handler(req, res, hits);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return { hits, base: `http://127.0.0.1:${server.address().port}` };
}

const raw = (tool, url) => tool.call({ url, raw: true }, {});
const config = (env = {}) => new Config({ CLAUDE_PRO_GATEWAY_MODEL: 'mock', ...env }, {}, { hooks: {}, mcpServers: {} }, process.cwd());

// Limits are shared by the whole module: every test that changes them puts them back.
function limits(t, changes) {
  const original = { ...webLimits };
  Object.assign(webLimits, changes);
  t.after(() => Object.assign(webLimits, original));
}

test('decodeBody: charset from the header, a byte order mark or a <meta> tag; unknown labels fall back to UTF-8', () => {
  assert.equal(decodeBody(GBK, 'text/html; charset=gbk'), '你好世界');
  assert.equal(decodeBody(GBK, 'text/html; charset="GB2312"'), '你好世界');
  assert.equal(decodeBody(Buffer.concat([Buffer.from('<meta charset="gb2312">'), GBK])), '<meta charset="gb2312">你好世界');
  assert.equal(decodeBody(Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=gbk">'), GBK])).endsWith('你好世界'), true);
  assert.equal(decodeBody(Buffer.from('你好', 'utf8'), 'text/html; charset=utf-8'), '你好');
  assert.equal(decodeBody(Buffer.from('plain ascii'), ''), 'plain ascii');
  assert.equal(decodeBody(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('hi', 'utf16le')])), 'hi', 'UTF-16 byte order mark');
  assert.equal(decodeBody(Buffer.from('你好', 'utf8'), 'text/html; charset=no-such-charset'), '你好', 'an unknown label does not throw');
  assert.equal(decodeBody(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('bom', 'utf8')])), 'bom', 'the UTF-8 byte order mark is dropped');
});

test('WebFetch decodes GBK pages, whether the charset is in the header or in a <meta> tag', async (t) => {
  const { base } = await pageServer(t, (req, res) => {
    if (req.url === '/header') {
      res.writeHead(200, { 'content-type': 'text/html; charset=gbk' });
      res.end(Buffer.concat([Buffer.from('<html><body><p>'), GBK, Buffer.from('</p></body></html>')]));
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(Buffer.concat([Buffer.from('<html><head><meta charset="gb2312"></head><body><p>'), GBK, Buffer.from('</p></body></html>')]));
    }
  });
  const tool = makeWebFetchTool(config());
  assert.match((await raw(tool, `${base}/header`)).content, /你好世界/);
  assert.match((await raw(tool, `${base}/meta`)).content, /你好世界/);
});

test('WebFetch caches a successful page but not an error, so a recovered server is used again', async (t) => {
  const { base, hits } = await pageServer(t, (req, res, counts) => {
    if (req.url === '/flaky' && counts.get('/flaky') === 1) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('down'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`page ${req.url}`);
  });
  const tool = makeWebFetchTool(config());
  const first = await raw(tool, `${base}/flaky`);
  assert.equal(first.isError, true);
  assert.match(first.content, /HTTP 503/);
  const second = await raw(tool, `${base}/flaky`);
  assert.equal(second.isError, undefined);
  assert.equal(second.content, 'page /flaky');
  await raw(tool, `${base}/flaky`);
  await raw(tool, `${base}/flaky`);
  assert.equal(hits.get('/flaky'), 2, 'the good page is served from the cache from then on');
});

test('WebFetch keeps only a limited number of pages in its cache', async (t) => {
  limits(t, { cacheEntries: 3 });
  const { base, hits } = await pageServer(t, (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`page ${req.url}`); });
  const tool = makeWebFetchTool(config());
  for (const name of ['a', 'b', 'c', 'd', 'e']) await raw(tool, `${base}/${name}-evict`);
  await raw(tool, `${base}/e-evict`);
  assert.equal(hits.get('/e-evict'), 1, 'the newest page is still cached');
  await raw(tool, `${base}/a-evict`);
  assert.equal(hits.get('/a-evict'), 2, 'the oldest was evicted and had to be fetched again');
});

test('WebFetch does not show binary content as text', async (t) => {
  const { base } = await pageServer(t, (req, res) => {
    if (req.url === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(Buffer.from('%PDF-1.7\n' + 'x'.repeat(3000))); return; }
    if (req.url === '/nul') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(Buffer.concat([Buffer.from('start'), Buffer.alloc(100, 0)])); return; }
    if (req.url === '/svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg><text>vector</text></svg>'); return; }
    if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/vnd.api+json' }); res.end('{"data":[]}'); return; }
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 1]));
  });
  const tool = makeWebFetchTool(config());
  const pdf = await raw(tool, `${base}/pdf`);
  assert.equal(pdf.isError, true);
  assert.match(pdf.content, /is not text \(application\/pdf, 2\.9KB\).*curl/);
  assert.equal((await raw(tool, `${base}/nul`)).isError, true);
  assert.equal((await raw(tool, `${base}/png`)).isError, true);
  assert.equal((await raw(tool, `${base}/svg`)).isError, undefined, 'SVG is text');
  assert.equal((await raw(tool, `${base}/json`)).content, '{"data":[]}', 'a vnd.*+json type is text');
});

test('WebFetch stops downloading at the size limit', async (t) => {
  limits(t, { maxBodyBytes: 512 * 1024 });
  let written = 0;
  let finished = false;
  const { base } = await pageServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const chunk = Buffer.alloc(64 * 1024, 'a');
    const pump = () => {
      while (written < 200 * 1024 * 1024) {
        if (res.destroyed) return;
        const ok = res.write(chunk);
        written += chunk.length;
        if (!ok) { res.once('drain', pump); return; }
      }
      finished = true;
      res.end();
    };
    pump();
  });
  const tool = makeWebFetchTool(config());
  const r = await raw(tool, `${base}/endless`);
  assert.ok(!r.isError, String(r.content).slice(0, 500)); // it fails now and then under the full suite: say why
  assert.equal(r.content.length, 512 * 1024);
  assert.match(r.display.summary, /^Received 512\.0KB/);
  await sleep(300);
  assert.equal(finished, false, 'the server was cut off, not drained');
  assert.ok(written < 100 * 1024 * 1024, `the server wrote ${written} bytes`);
});

test('WebFetch reports a timeout as a timeout, and a user abort as an abort', async (t) => {
  limits(t, { timeoutMs: 400 });
  const { base } = await pageServer(t, () => { /* never answers */ });
  const tool = makeWebFetchTool(config());
  const started = Date.now();
  const r = await raw(tool, `${base}/hang`);
  assert.equal(r.isError, true);
  assert.match(r.content, /Failed to fetch .*\/hang: timed out after 0\.4s/);
  assert.ok(Date.now() - started < 3000);

  const ctrl = new AbortController();
  const pending = tool.call({ url: `${base}/hang2`, raw: true }, { signal: ctrl.signal });
  await sleep(100);
  ctrl.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
});

test('WebFetch: when the summary request is rate limited it returns the page at once instead of waiting for the reset', async (t) => {
  const { base } = await pageServer(t, (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('the page text'); });
  let apiRequests = 0;
  const api = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      apiRequests++;
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(Math.floor((Date.now() + 3 * 3_600_000) / 1000)),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }));
    });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(() => { api.closeAllConnections?.(); api.close(); });
  const cfg = config({ CLAUDE_PRO_GATEWAY_URL: `http://127.0.0.1:${api.address().port}`, CLAUDE_PRO_GATEWAY_API_KEY: 'test', CLAUDE_PRO_MAX_RETRIES: '3', CLAUDE_PRO_PROVIDER: 'gateway' });
  const tool = makeWebFetchTool(cfg);
  const started = Date.now();
  const r = await tool.call({ url: `${base}/summarise-me`, prompt: 'what does it say?' }, {});
  assert.equal(r.content, 'the page text');
  assert.ok(!r.isError);
  assert.ok(Date.now() - started < 3000, 'no pause inside the tool call');
  assert.equal(apiRequests, 1);
});
