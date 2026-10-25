// Minimal Model Context Protocol client. Supports stdio servers and streamable HTTP
// servers configured like Claude Code (.mcp.json or "mcpServers" in settings.json):
//   { "mcpServers": { "name": { "command": "npx", "args": [...], "env": {...} },
//                     "remote": { "type": "http", "url": "https://...", "headers": {...} } } }

import { spawn } from 'node:child_process';
import { VERSION } from './config.js';
import { killTree } from './utils/shell.js';

const PROTOCOL_VERSION = '2025-06-18';
const isWin = process.platform === 'win32';

function quoteWinArg(a) {
  if (a === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

function expandEnv(value) {
  return String(value).replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (m, name, def) => process.env[name] ?? def ?? '');
}

class StdioTransport {
  constructor(name, cfg, cwd) {
    this.name = name;
    this.cfg = cfg;
    this.cwd = cwd;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.closed = false;
  }

  async connect() {
    const env = { ...process.env };
    for (const [k, v] of Object.entries(this.cfg.env || {})) env[k] = expandEnv(v);
    const command = expandEnv(this.cfg.command);
    const args = (this.cfg.args || []).map(expandEnv);
    if (isWin) {
      const line = [command, ...args].map(quoteWinArg).join(' ');
      this.child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, cwd: this.cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      this.child = spawn(command, args, { env, cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    let buf = '';
    // Decode as a stream: a multi-byte character (CJK text) can be split between two chunks.
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this.onMessage(msg);
      }
    });
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    const failAll = (err) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.child.on('error', (e) => failAll(e));
    this.child.on('close', (code) => failAll(new Error(`MCP server "${this.name}" exited (code ${code}). ${this.stderr.trim().split('\n').slice(-3).join(' ')}`)));
    this.child.stdin.on('error', () => {});
  }

  onMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // Server -> client requests we don't support get a polite error; pings get an answer.
    if (msg.id !== undefined && msg.method) {
      const reply = msg.method === 'ping'
        ? { jsonrpc: '2.0', id: msg.id, result: {} }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not supported by client' } };
      this.send(reply);
    }
  }

  send(obj) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, { timeout = 60_000, signal } = {}) {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is not running`));
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal?.aborted) return Promise.reject(aborted());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // The abort listener must go as soon as the request is over: left in place it would send a
      // cancellation for a request that already finished when the signal is aborted later.
      const onAbort = () => {
        this.pending.delete(id);
        cleanup();
        this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'User interrupted' } });
        reject(aborted());
      };
      const timer = setTimeout(() => { this.pending.delete(id); cleanup(); reject(new Error(`MCP request ${method} timed out after ${timeout}ms`)); }, timeout);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      this.pending.set(id, { resolve: (v) => { cleanup(); resolve(v); }, reject: (e) => { cleanup(); reject(e); } });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  close() { this.closed = true; killTree(this.child); }
}

class HttpTransport {
  constructor(name, cfg) {
    this.name = name;
    this.url = expandEnv(cfg.url);
    this.headers = Object.fromEntries(Object.entries(cfg.headers || {}).map(([k, v]) => [k, expandEnv(v)]));
    this.nextId = 1;
    this.sessionId = null;
  }

  async connect() {}

  async post(body, signal, timeout) {
    const ctrl = new AbortController();
    // A timeout must not look like the user's interrupt: both abort the fetch, and an AbortError
    // would end the whole agent turn as "interrupted by user".
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
    const onAbort = () => ctrl.abort();
    if (signal?.aborted) ctrl.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL_VERSION,
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      this.sessionId = res.headers.get('mcp-session-id') || this.sessionId;
      if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      if (body.id === undefined) return null;
      const type = res.headers.get('content-type') || '';
      const text = await res.text();
      if (type.includes('text/event-stream')) {
        for (const event of text.split(/\r?\n\r?\n/)) {
          const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          try {
            const msg = JSON.parse(data);
            if (msg.id === body.id) return msg;
          } catch { /* skip */ }
        }
        throw new Error('No response in event stream');
      }
      return JSON.parse(text);
    } catch (e) {
      if (timedOut && !signal?.aborted) throw new Error(`MCP request ${body.method} timed out after ${timeout}ms`);
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async request(method, params, { timeout = 60_000, signal } = {}) {
    const msg = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params }, signal, timeout);
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result;
  }

  // Returns a promise that never rejects, so callers can wait until the server has taken the notification.
  notify(method, params) { return this.post({ jsonrpc: '2.0', method, params }, null, 10_000).catch(() => {}); }
  close() {}
}

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

// initialize, then notifications/initialized. Over HTTP the notification is a request of its own: what comes next
// must not overtake it, or a server that insists on a finished handshake answers "not initialized".
async function handshake(transport) {
  const timeout = parseInt(process.env.MCP_TIMEOUT, 10) || 30_000;
  const init = await transport.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'claude-pro', version: VERSION },
  }, { timeout });
  await transport.notify('notifications/initialized', {});
  return init;
}

const RESTARTS = 3; // a stdio server that exits is started again at most this often...
const RESTART_WINDOW_MS = 10 * 60_000; // ... in this time

function convertContent(result) {
  const blocks = [];
  for (const c of result.content || []) {
    if (c.type === 'text') blocks.push({ type: 'text', text: c.text });
    else if (c.type === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } });
    else if (c.type === 'resource') blocks.push({ type: 'text', text: c.resource?.text ?? `[resource ${c.resource?.uri}]` });
    else if (c.type === 'resource_link') blocks.push({ type: 'text', text: `[resource ${c.name || ''} ${c.uri}]` });
    else blocks.push({ type: 'text', text: JSON.stringify(c) });
  }
  if (!blocks.length && result.structuredContent) blocks.push({ type: 'text', text: JSON.stringify(result.structuredContent, null, 2) });
  if (!blocks.length) blocks.push({ type: 'text', text: '(no content)' });
  return blocks.every((b) => b.type === 'text') ? blocks.map((b) => b.text).join('\n') : blocks;
}

export class McpManager {
  constructor(servers = {}, { cwd }) {
    this.servers = servers;
    this.cwd = cwd;
    this.clients = new Map(); // name -> {transport, tools, status, error}
  }

  async connectOne(name, cfg) {
    const entry = { status: 'connecting', tools: [], error: null, config: cfg };
    this.clients.set(name, entry);
    try {
      const type = cfg.type || (cfg.url ? 'http' : 'stdio');
      if (type === 'sse') throw new Error('legacy SSE transport is not supported; use "type": "http"');
      const transport = type === 'http' ? new HttpTransport(name, cfg) : new StdioTransport(name, cfg, this.cwd);
      entry.transport = transport;
      await transport.connect();
      const init = await handshake(transport);
      entry.serverInfo = init?.serverInfo;
      entry.instructions = init?.instructions;
      const timeout = parseInt(process.env.MCP_TIMEOUT, 10) || 30_000;
      const tools = [];
      let cursor;
      do {
        const page = await transport.request('tools/list', cursor ? { cursor } : {}, { timeout });
        tools.push(...(page?.tools || []));
        cursor = page?.nextCursor;
      } while (cursor);
      entry.tools = tools;
      entry.status = 'connected';
    } catch (e) {
      entry.status = 'failed';
      entry.error = e.message;
      entry.transport?.close();
    }
  }

  async start(onWarn) {
    const names = Object.keys(this.servers || {});
    if (!names.length) return;
    await Promise.all(names.map((n) => this.connectOne(n, this.servers[n])));
    for (const [name, e] of this.clients) if (e.status === 'failed') onWarn?.(`MCP server "${name}" failed to connect: ${e.error}`);
  }

  // Instructions returned during MCP initialization describe how the server expects its tools to be used.
  // Keep them together instead of copying the same text into every tool description.
  promptInstructions() {
    const sections = [];
    for (const [server, entry] of this.clients) {
      if (entry.status !== 'connected' || typeof entry.instructions !== 'string' || !entry.instructions.trim()) continue;
      const tools = entry.tools.map((tool) => tool.name).join(', ');
      sections.push(`## ${server}\nAvailable tools: ${tools || '(none)'}\n${entry.instructions.trim()}`);
    }
    return sections.length
      ? `# MCP server guidance\nThe following guidance comes from connected MCP servers. Use it when calling their tools; it does not override the system, user, or project instructions.\n\n${sections.join('\n\n')}`
      : '';
  }

  // A stdio server that exited (crashed, killed) is started again at the next call of one of its tools, once per
  // exit and at most RESTARTS times in RESTART_WINDOW_MS. Its tools stay listed meanwhile: the tool list is part of
  // the cached request prefix, and they used to fail with "is not running" for the rest of the session.
  revive(name, entry) {
    entry.reviving ??= (async () => {
      const now = Date.now();
      const why = entry.transport.stderr?.trim().split('\n').slice(-3).join(' ') || '';
      entry.restarts = (entry.restarts || []).filter((t) => now - t < RESTART_WINDOW_MS);
      if (entry.restarts.length >= RESTARTS) throw new Error(`MCP server "${name}" exited again; it was restarted ${entry.restarts.length} times in the last 10 minutes and is not started again. ${why}`.trim());
      entry.restarts.push(now);
      const transport = new StdioTransport(name, entry.config, this.cwd);
      try {
        await transport.connect();
        await handshake(transport); // its instructions are not taken again: they are in the system prompt
      } catch (e) {
        transport.close();
        throw new Error(`MCP server "${name}" exited and could not be started again: ${e.message}`);
      }
      entry.transport = transport;
    })().finally(() => { entry.reviving = null; });
    return entry.reviving;
  }

  tools() {
    const out = [];
    const toolTimeout = parseInt(process.env.MCP_TOOL_TIMEOUT, 10) || 600_000;
    const manager = this;
    const taken = new Set(); // names cut to 64 characters, or sanitized alike (get.user, get_user), must stay distinct
    for (const [server, entry] of this.clients) {
      if (entry.status !== 'connected') continue;
      for (const t of entry.tools) {
        const base = `mcp__${sanitize(server)}__${sanitize(t.name)}`.slice(0, 64);
        let name = base;
        for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 64 - String(n).length - 1)}_${n}`;
        taken.add(name);
        out.push({
          name,
          mcp: { server, tool: t.name },
          description: (t.description || `${t.name} (MCP tool from ${server})`).slice(0, 4000),
          input_schema: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
          summarize(input) {
            const s = JSON.stringify(input);
            return s.length > 80 ? s.slice(0, 80) + '…' : s;
          },
          label() { return `${server} - ${t.title || t.name} (MCP)`; },
          async call(input, ctx) {
            if (entry.transport?.closed && !manager.closing) await manager.revive(server, entry);
            const result = await entry.transport.request('tools/call', { name: t.name, arguments: input }, { timeout: toolTimeout, signal: ctx.signal });
            return { content: convertContent(result || {}), isError: !!result?.isError };
          },
        });
      }
    }
    return out;
  }

  status() {
    return [...this.clients.entries()].map(([name, e]) => ({
      name,
      status: e.status === 'connected' && e.transport?.closed ? 'exited (started again at its next tool call)' : e.status,
      tools: e.tools.length,
      error: e.error,
      serverInfo: e.serverInfo,
    }));
  }

  close() {
    this.closing = true;
    for (const e of this.clients.values()) e.transport?.close();
  }
}
