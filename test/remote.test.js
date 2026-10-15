import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Remote control through the gateway: the real App in a headless terminal connects out to a fake
// gateway, which plays both the relay and the page. A command from the page runs a turn whose text and tool calls
// come back as events, a question the model asks is answered from the page, and a gateway that forgets the session
// gets it registered again with the whole conversation.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-remote-config-'));
let lastAnswer = null;

const frames = (events) => events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
const textReply = (text) => frames([
  { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]);
const toolReply = (id, name, input) => frames([
  { type: 'message_start', message: { model: 'mock', usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]);

const { applyEvent, hydrate } = await import('../src/remote.js');

// The fake gateway: the model API, and the remote control relay with a page that keeps the transcript.
const KEY = 'gw-test-key';
const gw = { sessions: new Map(), registrations: 0, stream: null, pending: new Map(), cid: 0, page: { state: hydrate([]), seq: 0, status: null, snapshots: 0, byes: [] }, others: [], messages: [], acks: [], files: new Map(), deleted: [], uploads: new Map(), puts: [], ranges: [], cutAt: null, cutGet: false, order: [] };
const MB = 1024 * 1024;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const storeFile = (name, data) => {
  const id = `f${gw.files.size + 1}xxxxxxxxxxxxxxx`;
  gw.files.set(id, { id, name, size: data.length, sha256: sha256(data), data });
  return { id, name, size: data.length, sha256: sha256(data) };
};
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b ? JSON.parse(b) : {})); });
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/v1/messages') {
    const body = await readBody(req);
    gw.lastRequest = body;
    const last = body.messages.at(-1);
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    const result = blocks.find((b) => b.type === 'tool_result');
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (result?.tool_use_id === 'toolu_bash') res.end(textReply('All done.'));
    else if (result?.tool_use_id === 'toolu_ask') { lastAnswer = typeof result.content === 'string' ? result.content : JSON.stringify(result.content); res.end(textReply('Got it.')); }
    else if (/ask me/.test(text)) res.end(toolReply('toolu_ask', 'AskUserQuestion', { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] }));
    else res.end(toolReply('toolu_bash', 'Bash', { command: 'echo remote-ok', description: 'Say ok' }));
    return;
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: { message: 'Missing or invalid gateway API key' } });
  if (url.pathname === '/v1/account') return json(res, 200, { account: { email: 'me@example.com', balance_usd: 5 } });
  if (req.method === 'POST' && url.pathname === '/v1/remote/sessions') {
    const body = await readBody(req);
    gw.registrations++;
    gw.sessions.set(body.id, body);
    return json(res, 200, { id: body.id, url: `https://gw.example/#remote/${body.id}` });
  }
  // resumable uploads: the same unfinished upload again for the same file; cutAt cuts the chunk sent at that offset in the middle
  if (req.method === 'POST' && url.pathname === '/v1/remote/uploads') {
    const body = await readBody(req);
    let up = [...gw.uploads.values()].find((u) => u.sha256 === body.sha256 && u.size === body.size && !u.complete);
    if (!up) {
      up = { id: `u${gw.uploads.size + 1}xxxxxxxxxxxxxxx`, name: body.name, size: body.size, sha256: body.sha256, data: Buffer.alloc(0) };
      gw.uploads.set(up.id, up);
    }
    return json(res, 200, { id: up.id, received: up.data.length, chunkSize: MB });
  }
  const upload = /^\/v1\/remote\/uploads\/([\w-]+)$/.exec(url.pathname);
  if (upload) {
    const up = gw.uploads.get(upload[1]);
    if (!up) return json(res, 404, { error: { message: 'no such upload' } });
    if (req.method === 'GET') return json(res, 200, { id: up.id, size: up.size, received: up.data.length, complete: Boolean(up.complete) });
    const offset = Number(req.headers['x-upload-offset']);
    gw.puts.push(offset);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (offset !== up.data.length) return json(res, 409, { error: { message: 'wrong offset' }, received: up.data.length });
    const chunk = Buffer.concat(chunks);
    if (gw.cutAt === offset) { // half of it arrives, then the connection breaks
      gw.cutAt = null;
      up.data = Buffer.concat([up.data, chunk.subarray(0, chunk.length >> 1)]);
      return req.socket.destroy();
    }
    up.data = Buffer.concat([up.data, chunk]);
    if (up.data.length < up.size) return json(res, 200, { received: up.data.length });
    if (sha256(up.data) !== up.sha256) return json(res, 422, { error: { message: 'checksum' } });
    up.complete = true;
    gw.files.set(up.id, { id: up.id, name: up.name, size: up.size, sha256: up.sha256, data: up.data });
    return json(res, 200, { received: up.size, complete: true, file: { id: up.id, name: up.name, size: up.size, sha256: up.sha256 } });
  }
  // downloads with Range; cutGet breaks the next one after the first megabyte
  const file = /^\/v1\/remote\/files\/([\w-]+)$/.exec(url.pathname);
  if (file) {
    const stored = gw.files.get(file[1]);
    if (!stored) return json(res, 404, { error: { message: 'no such file' } });
    if (req.method === 'DELETE') { gw.deleted.push(stored.id); return json(res, 200, { ok: true }); }
    const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range || '')?.[1] || 0);
    gw.ranges.push(req.headers.range || null);
    const body = stored.data.subarray(from);
    res.writeHead(from ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': body.length, 'x-file-sha256': stored.sha256, ...(from ? { 'content-range': `bytes ${from}-${stored.size - 1}/${stored.size}` } : {}) });
    if (gw.cutGet) {
      gw.cutGet = false;
      res.write(body.subarray(0, MB));
      return setTimeout(() => res.socket.destroy(), 50);
    }
    return res.end(body);
  }
  if (req.method === 'GET' && url.pathname === '/v1/remote/sessions') {
    const own = [...gw.sessions.values()].map((p) => ({ id: p.id, name: p.name, machine: p.machine, cwd: p.cwd, peerId: p.peerId, online: true, ended: false }));
    return json(res, 200, { data: [...own, ...gw.others] });
  }
  const m = /^\/v1\/remote\/sessions\/([\w-]+)\/(commands|events|results|messages)$/.exec(url.pathname);
  if (!m) return json(res, 404, { error: 'not found' });
  if (m[2] === 'messages') {
    const body = await readBody(req);
    gw.messages.push({ to: m[1], ...body });
    return json(res, 200, { ok: true, id: `m${gw.messages.length}`, delivered: true });
  }
  if (!gw.sessions.has(m[1])) return json(res, 404, { error: 'no such session' });
  if (m[2] === 'commands') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ type: 'viewers', count: 1 })}\n\n`);
    gw.stream = res;
    req.on('close', () => { gw.order.push('stream closed'); if (gw.stream === res) gw.stream = null; });
    return;
  }
  const body = await readBody(req);
  if (m[2] === 'results') { gw.order.push(`result ${body.cid}`); gw.acks.push(body.cid); gw.pending.get(body.cid)?.(body); gw.pending.delete(body.cid); return json(res, 200, { ok: true }); }
  const page = gw.page;
  for (const msg of body.messages) {
    if (msg.t === 'snapshot') { page.state = hydrate(msg.items); page.seq = msg.seq; page.status = msg.status; page.snapshots++; }
    if (msg.t === 'status') page.status = msg.status;
    if (msg.t === 'bye') page.byes.push(msg);
    if (msg.t === 'batch') for (const ev of msg.events) if (ev.seq > page.seq) { page.seq = ev.seq; applyEvent(page.state, ev); }
  }
  return json(res, 200, { ok: true });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// What the page sends, as the gateway passes it on: resolves with the session's result.
const command = (type, body = {}) => new Promise((resolve, reject) => {
  if (!gw.stream) { reject(new Error('the session is not connected')); return; }
  const cid = `c${++gw.cid}`;
  gw.pending.set(cid, resolve);
  gw.stream.write(`data: ${JSON.stringify({ cid, type, body })}\n\n`);
});

fs.writeFileSync(path.join(configDir, 'gateway.json'), JSON.stringify({ url: base, apiKey: KEY, account: { email: 'me@example.com' } }));
Object.assign(process.env, {
  CLAUDE_PRO_CONFIG_DIR: configDir, CLAUDE_PRO_PROVIDER: 'gateway', CLAUDE_PRO_GATEWAY_URL: base,
  CLAUDE_PRO_GATEWAY_MODEL: 'mock', CLAUDE_PRO_MAX_RETRIES: '1', CLAUDE_PRO_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_PRO_RIPGREP_PATH: 'off', CLAUDE_CODE_EFFORT_LEVEL: 'auto', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '0',
  CLAUDE_PRO_ONLINE: '1', // a session the tests drive goes online (when logged in) only with this
});
const { startTui } = await import('./tui-harness.js');

test.after(() => server.close());

const until = async (what, check, timeout = 20_000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('remote control through the gateway: the page follows a turn it started, answers a question, and survives a forgetful gateway', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-remote-'));
  const tui = await startTui({ cwd, flags: {} });
  t.after(() => tui.close());
  const page = gw.page;
  await until('the snapshot', () => page.snapshots >= 1 && gw.stream);
  const [session] = [...gw.sessions.values()];
  assert.match(session.id, /^[\w-]{8,64}$/);
  assert.equal(session.cwd, cwd.replace(/\\/g, '/'));
  await tui.waitFor('⇄ 1 watching', { timeout: 5000, all: false });

  assert.deepEqual(await command('send', { text: 'run it' }), { cid: 'c1', ok: true, queued: false });
  await until('the reply', () => page.state.items.some((i) => i.k === 'text' && i.text === 'All done.') && page.status && !page.status.busy);
  await tui.waitFor('All done.', { timeout: 5000 });
  assert.match(await tui.snapshot({ all: true }), /> run it/, 'the message shows in the terminal as if typed there');
  assert.deepEqual(page.state.items.map((i) => i.k).filter((k) => k !== 'output'), ['user', 'tool', 'text']);
  const tool = page.state.items.find((i) => i.k === 'tool');
  assert.equal(tool.status, 'done');
  assert.match(tool.head, /Bash/);
  assert.match(tool.lines.join('\n'), /remote-ok/);

  assert.equal((await command('send', { text: 'ask me' })).ok, true);
  await until('the question', () => page.status?.dialog?.options);
  const dialog = page.status.dialog;
  assert.match(dialog.question, /Which color\?/);
  assert.deepEqual(dialog.options.map((o) => o.label), ['Red', 'Blue', 'Other (type your own answer)']);
  assert.match((await command('send', { text: '/help' })).error, /Commands wait/, 'a command waits for the turn');
  assert.equal((await command('dialog', { id: dialog.id + 1, index: 1 })).ok, false, 'only the open question');
  assert.equal((await command('dialog', { id: dialog.id, index: 1 })).ok, true);
  await until('the answer', () => page.state.items.some((i) => i.k === 'text' && i.text === 'Got it.') && !page.status.busy);
  assert.match(lastAnswer, /"Which color\?"="Blue"/);

  // The gateway restarts and forgets everything: the session registers again and sends the whole conversation.
  const kinds = page.state.items.map((i) => i.k).filter((k) => k !== 'output');
  const registrations = gw.registrations;
  gw.sessions.clear();
  gw.page.state = hydrate([]);
  gw.stream?.destroy();
  await until('a new registration and snapshot', () => gw.registrations > registrations && gw.stream && page.state.items.length > 0, 15_000);
  assert.deepEqual(page.state.items.map((i) => i.k).filter((k) => k !== 'output'), kinds);

  // /clear starts the page over too.
  const snapshots = page.snapshots;
  tui.send('/clear\r');
  await until('the reset', () => page.snapshots > snapshots && page.state.items.length === 0);

  // /status: the state, the name, the computer service (no link, no QR code: the web page lists the sessions).
  tui.send('/status\r');
  const status = await tui.waitFor('Computer service', { timeout: 5000 });
  assert.match(status, /Remote control\s+online as me@example\.com · 1 page open now/);
  assert.ok(!status.includes('https://gw.example/#remote/'), 'no link');
  assert.doesNotMatch(status, /Scan with a phone/);
  assert.match(status, /Name\s+&claude-pro-remote-/);

  // /logout: offline at once, with a goodbye; /login: online again at once, without a restart.
  tui.send('/logout\r');
  await until('the bye', () => page.byes.length === 1);
  assert.equal(page.byes[0].restarting, false);
  await tui.waitFor('This session is offline there now.', { timeout: 5000 });
  assert.equal(tui.app.remote, null);
  fs.writeFileSync(path.join(configDir, 'gateway.json'), JSON.stringify({ url: base, apiKey: KEY, account: { email: 'me@example.com' } }));
  const before = gw.registrations;
  tui.send('/login gateway\r');
  await tui.waitFor('This session is online at the gateway: the web page (远程控制) shows it.', { timeout: 10_000 });
  assert.ok(gw.registrations > before && tui.app.remote?.online);

  // logged out in another window: this one follows (the timer does what syncRemote does)
  fs.rmSync(path.join(configDir, 'gateway.json'));
  await tui.app.syncRemote();
  assert.equal(tui.app.remote, null);
  await until('the second bye', () => page.byes.length === 2);
  tui.send('/status\r');
  await tui.waitFor('offline: this computer is not logged in to the gateway', { timeout: 5000 });
  fs.writeFileSync(path.join(configDir, 'gateway.json'), JSON.stringify({ url: base, apiKey: KEY, account: { email: 'me@example.com' } }));
});

test('a session the web page opened (claude-pro host): --remote-id is its id at the gateway, --name its name, online even with CLAUDE_PRO_ONLINE=0', async (t) => {
  gw.sessions.clear();
  process.env.CLAUDE_PRO_ONLINE = '0';
  t.after(() => { process.env.CLAUDE_PRO_ONLINE = '1'; });
  const tui = await startTui({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-remote-')), flags: { remoteId: 'from-the-page-1', name: '前端 web' } });
  t.after(() => tui.close());
  await until('the registration', () => gw.sessions.has('from-the-page-1') && gw.stream);
  assert.equal(tui.app.remote.id, 'from-the-page-1');
  assert.equal(gw.sessions.get('from-the-page-1').name, '前端-web', 'the name, as /rename makes it');
  assert.equal(tui.app.sessionLabel(), '前端-web');
  await tui.waitFor('⇄ &前端-web', { timeout: 5000, all: false });
});

test('sessions on other computers: &computer sends a task through the gateway, the answer comes back, and a task from there is answered there', async (t) => {
  const office = { id: 'office-session-1', name: 'proj', machine: '公司', host: 'OFFICE-PC', cwd: 'D:/work/proj', online: true, ended: false };
  gw.others = [office, { id: 'gone-1', name: 'old', machine: '公司', cwd: 'D:/old', online: false, ended: true }];
  gw.sessions.clear(); // the sessions of the tests before are gone
  t.after(() => { gw.others = []; });
  const tui = await startTui({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-remote-')), flags: {} });
  t.after(() => tui.close());
  await until('the session list', () => tui.app.remotePeers.length === 1 && gw.stream);
  assert.equal(tui.app.remotePeers[0].label, '公司/proj', 'only the online session of the other computer');
  const me = tui.app.remote.id;
  assert.equal(gw.sessions.get(me).machine.length > 0, true, 'the session tells the gateway its computer');

  // typing & lists the sessions; &公司 is the only session on that computer
  tui.send('&');
  await tui.waitFor('&公司/proj', { timeout: 5000, all: false });
  tui.send('\x7f');
  gw.messages.length = 0;
  tui.send('&公司 run the tests\r');
  await until('the task', () => gw.messages.length === 1);
  assert.deepEqual(gw.messages[0], { to: office.id, from: me, kind: 'task', text: 'run the tests' });
  await tui.waitFor('Sent to &公司/proj', { timeout: 5000 });
  const push = (msg) => gw.stream.write(`data: ${JSON.stringify({ type: 'peer', ...msg })}\n\n`);
  const from = { id: office.id, name: 'proj', machine: '公司', cwd: office.cwd };
  push({ cid: 'r1', kind: 'reply', inReplyTo: 'm1', text: 'All 12 tests pass.', from });
  await tui.waitFor('&公司/proj answered:', { timeout: 5000 });
  await until('the acknowledgement', () => gw.acks.includes('r1'));

  // a task from the other computer runs here, and its answer goes back to it through the gateway
  push({ cid: 't1', kind: 'task', text: 'run it', from });
  await until('the answer', () => gw.messages.length === 2, 20_000);
  assert.deepEqual(gw.messages[1], { to: office.id, from: me, kind: 'reply', text: 'All done.', inReplyTo: 't1' });
  assert.match(await tui.snapshot({ all: true }), /task from &公司\/proj: run it/);
  // sent again (say the acknowledgement was lost): acknowledged, not run twice
  push({ cid: 't1', kind: 'task', text: 'run it', from });
  await until('the second acknowledgement', () => gw.acks.filter((c) => c === 't1').length === 2);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(tui.app.busy, false);
  assert.equal(gw.messages.length, 2);

  // /rename: the new name at the gateway (registered again), and as the title
  const registrations = gw.registrations;
  tui.send('/rename web-server\r');
  await tui.waitFor('This session is now &web-server', { timeout: 5000 });
  await until('the new registration', () => gw.registrations > registrations && gw.sessions.get(me).name === 'web-server');
  assert.equal(tui.app.sessionLabel(), 'web-server');
});

test('files: /sendfile uploads them for a session on another computer, and files sent here land in the Downloads folder, never over a file', async (t) => {
  const office = { id: 'office-session-1', name: 'proj', machine: '公司', host: 'OFFICE-PC', cwd: 'D:/work/proj', online: true, ended: false };
  gw.others = [office];
  gw.sessions.clear();
  gw.messages.length = 0;
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-downloads-'));
  process.env.CLAUDE_PRO_DOWNLOAD_DIR = downloads;
  t.after(() => { gw.others = []; delete process.env.CLAUDE_PRO_DOWNLOAD_DIR; });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-remote-'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(cwd, 'photo 2.jpg'), Buffer.from([0xff, 0xd8, 1, 2, 3]));
  const tui = await startTui({ cwd, flags: {} });
  t.after(() => tui.close());
  await until('the session list', () => tui.app.remotePeers.length === 1 && gw.stream);

  // & in the middle of the line lists the sessions too
  tui.send('/sendfile a.txt &公');
  await tui.waitFor('&公司/proj', { timeout: 5000, all: false });
  tui.send('\x7f'.repeat(20));

  // a path with a space, not quoted
  tui.send(`/sendfile &公司 a.txt ${path.join(cwd, 'photo 2.jpg')}\r`);
  await until('the message with the files', () => gw.messages.length === 1);
  const sent = gw.messages[0];
  assert.equal(sent.to, office.id);
  assert.equal(sent.kind, 'task');
  assert.equal(sent.text, '');
  assert.deepEqual(sent.files.map((x) => gw.files.get(x.id).name), ['a.txt', 'photo 2.jpg']);
  assert.equal(gw.files.get(sent.files[0].id).data.toString(), 'hello');
  await tui.waitFor('Sent 2 files', { timeout: 5000 });

  // files from the other computer: saved (next to a file of the same name, not over it), then confirmed
  fs.writeFileSync(path.join(downloads, '报告.txt'), 'old');
  const ref = storeFile('报告.txt', Buffer.from('内容'));
  gw.stream.write(`data: ${JSON.stringify({ type: 'peer', cid: 'x1', kind: 'task', text: '', files: [ref], from: { id: office.id, name: 'proj', machine: '公司', cwd: office.cwd } })}\n\n`);
  await until('the confirmation', () => gw.messages.length === 2);
  const reply = gw.messages[1];
  assert.equal(reply.kind, 'reply');
  assert.equal(reply.inReplyTo, 'x1');
  assert.match(reply.text, /Saved 1 file in the Downloads folder/);
  assert.equal(fs.readFileSync(path.join(downloads, '报告.txt'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(downloads, '报告 (1).txt'), 'utf8'), '内容');
  assert.ok(reply.text.includes(path.join(downloads, '报告 (1).txt')));
  await until('the file is taken off the gateway', () => gw.deleted.includes(ref.id));
  assert.equal(tui.app.busy, false, 'files alone do not start a turn');
});

test('big files: an upload cut off in the middle continues where the gateway stopped, sending again continues an unfinished upload, a download cut off continues with a range', async (t) => {
  const office = { id: 'office-session-1', name: 'proj', machine: '公司', host: 'OFFICE-PC', cwd: 'D:/work/proj', online: true, ended: false };
  gw.others = [office];
  gw.sessions.clear();
  gw.messages.length = 0;
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-downloads-'));
  process.env.CLAUDE_PRO_DOWNLOAD_DIR = downloads;
  t.after(() => { gw.others = []; delete process.env.CLAUDE_PRO_DOWNLOAD_DIR; });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-remote-'));
  const video = crypto.randomBytes(3 * MB + 123);
  fs.writeFileSync(path.join(cwd, 'video.mp4'), video);
  const tui = await startTui({ cwd, flags: {} });
  t.after(() => tui.close());
  await until('the session list', () => tui.app.remotePeers.length === 1 && gw.stream);

  // the second chunk is cut in the middle: after a wait it continues from what the gateway has (a 409 says where)
  gw.puts.length = 0;
  gw.cutAt = MB;
  tui.send('/sendfile &公司 video.mp4\r');
  await tui.waitFor('Sending 1 file (3.0 MB) to &公司/proj in the background', { timeout: 5000 });
  await until('the message with the video', () => gw.messages.length === 1, 20_000);
  assert.deepEqual(gw.puts.slice(0, 3), [0, MB, MB], 'the cut chunk is sent again from where it was, and told where the gateway is');
  assert.ok(gw.puts.includes(MB + MB / 2), 'then it continues from the half that arrived');
  assert.ok(sha256(gw.files.get(gw.messages[0].files[0].id).data) === sha256(video), 'the gateway has the whole video');
  await tui.waitFor('Sent 1 file (3.0 MB) to &公司/proj', { timeout: 5000 });

  // an upload left unfinished (another day, another process): sending the same file continues it
  const other = crypto.randomBytes(2 * MB);
  fs.writeFileSync(path.join(cwd, 'other.bin'), other);
  gw.uploads.set('u-old-xxxxxxxxxxxxxx', { id: 'u-old-xxxxxxxxxxxxxx', name: 'other.bin', size: other.length, sha256: sha256(other), data: other.subarray(0, MB) });
  gw.puts.length = 0;
  tui.send('/sendfile &公司 other.bin\r');
  await until('the second message', () => gw.messages.length === 2, 20_000);
  assert.deepEqual(gw.puts, [MB], 'only the part the gateway did not have');

  // a download cut after the first megabyte continues with a range, and the message is acknowledged once saved
  const ref = storeFile('clip.mp4', video);
  gw.cutGet = true;
  gw.ranges.length = 0;
  gw.stream.write(`data: ${JSON.stringify({ type: 'peer', cid: 'big1', kind: 'task', text: '', files: [ref], from: { id: office.id, name: 'proj', machine: '公司', cwd: office.cwd } })}\n\n`);
  await until('the confirmation', () => gw.messages.length === 3, 20_000);
  assert.deepEqual(gw.ranges, [null, `bytes=${MB}-`]);
  assert.ok(fs.readFileSync(path.join(downloads, 'clip.mp4')).equals(video));
  assert.deepEqual(fs.readdirSync(downloads), ['clip.mp4'], 'no .part file left behind');
  await until('the acknowledgement', () => gw.acks.includes('big1'));
});

test('remote control: a key the gateway refuses is reported once, not retried until the login changes', async (t) => {
  fs.writeFileSync(path.join(configDir, 'gateway.json'), JSON.stringify({ url: base, apiKey: 'revoked', account: {} }));
  t.after(() => fs.writeFileSync(path.join(configDir, 'gateway.json'), JSON.stringify({ url: base, apiKey: KEY, account: {} })));
  const tui = await startTui({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-remote-')) });
  t.after(() => tui.close());
  await tui.waitFor('This session could not go online at the gateway: Missing or invalid gateway API key', { timeout: 10_000 });
  assert.equal(tui.app.remote, null);
  const registrations = gw.registrations;
  assert.equal(await tui.app.syncRemote(), null, 'the same key: not tried again');
  tui.send('/status\r');
  await tui.waitFor('the gateway refused this computer\'s key', { timeout: 5000 });
  // a new login: online
  fs.writeFileSync(path.join(configDir, 'gateway.json'), JSON.stringify({ url: base, apiKey: KEY, account: {} }));
  assert.ok((await tui.app.syncRemote())?.registered);
  assert.equal(gw.registrations, registrations + 1);
  await until('online', () => tui.app.remote?.online);
});

// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('the page asks what the terminal knows (its menus\' options, its input box\'s suggestions, directories), and sends images', async (t) => {
  gw.sessions.clear();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-remote-'));
  fs.mkdirSync(path.join(cwd, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'main.js'), '');
  fs.writeFileSync(path.join(cwd, 'src', 'ui', 'app.js'), '');
  const tui = await startTui({ cwd });
  t.after(() => tui.close());
  await until('online', () => gw.stream && tui.app.remote?.online);

  // options: what /model and /effort offer, plain text, the default first
  const opts = await command('options');
  assert.equal(opts.ok, true, opts.error);
  assert.equal(opts.model, 'mock');
  assert.deepEqual(opts.models[0], { value: 'default', label: 'Default', description: 'mock → mock' });
  assert.ok(opts.models.some((m) => m.value === 'opus' && m.label === 'opus' && m.description.startsWith('→ ')));
  assert.deepEqual(opts.efforts.slice(-2).map((e) => e.value), ['auto', 'default']);
  assert.equal('mode' in opts, false, 'no plan mode to choose any more');
  assert.ok(!JSON.stringify(opts).includes('\\u001b'), 'no colours');

  // suggest: /commands, @files, &sessions, as the input box here would
  const mo = await command('suggest', { text: '/mo', cursor: 3 });
  assert.deepEqual([mo.ok, mo.items[0].value, mo.items[0].label, mo.items[0].submitOnEnter, mo.from, mo.to], [true, '/model', '/model [model]', true, 0, 3]);
  assert.ok(!JSON.stringify(mo).includes('\\u001b'));
  let files = { items: [] };
  for (let i = 0; i < 100 && !files.items.length; i++) { // the file index is built in the background
    files = await command('suggest', { text: 'look at @src/', cursor: 13 });
    if (!files.items.length) await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual(files.items.map((i) => i.value).sort(), ['@src/', '@src/main.js', '@src/ui/', '@src/ui/app.js']);
  assert.deepEqual(files.items, tui.app.suggest('look at @src/', 13).items.map((i) => ({ value: i.value, label: i.label, description: '', submitOnEnter: false, noSpace: Boolean(i.noSpace) })), 'what the input box here suggests');
  assert.deepEqual([files.from, files.to], [8, 13]);
  assert.equal(files.items.find((i) => i.value === '@src/ui/').noSpace, true);
  tui.app.flashMessage = null;
  assert.deepEqual(await command('suggest', { text: '&', cursor: 1 }), { cid: `c${gw.cid}`, ok: true, items: [] });
  assert.equal(tui.app.flashMessage, null, 'nothing shows in the terminal');
  assert.deepEqual((await command('suggest', { text: 'plain words', cursor: 11 })).items, []);

  // list: the computer service's listing, "" being the working directory
  const listed = await command('list', { path: '' });
  assert.equal(listed.path, path.resolve(cwd));
  assert.deepEqual(listed.entries.map((e) => e.name), ['src']);
  assert.match((await command('list', { path: path.join(cwd, 'nope') })).error, /^目录不存在：/);

  // images: alone they go as their placeholders, with the image itself to the model
  const sent = await command('send', { text: '', images: [{ media_type: 'image/png', data: PNG }] });
  assert.equal(sent.ok, true, sent.error);
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  const first = gw.lastRequest.messages.find((m) => m.role === 'user');
  assert.ok(first.content.some((b) => b.type === 'image' && b.source.media_type === 'image/png'), 'the image went to the model');
  assert.ok(first.content.some((b) => b.type === 'text' && b.text === '[Image #1]'));
  const refused = async (images) => (await command('send', { text: 'look', images })).error;
  assert.equal(await refused([{ media_type: 'image/bmp', data: PNG }]), 'The image is image/bmp: only PNG, JPEG, GIF and WebP images can be sent.');
  assert.equal(await refused(Array.from({ length: 7 }, () => ({ media_type: 'image/png', data: PNG }))), 'At most 6 images can be sent at a time (this message has 7).');
  assert.equal(await refused([{ media_type: 'image/png', data: PNG }, { media_type: 'image/png', data: 'not base64!' }]), 'Image 2 is not base64 data.');
  assert.equal(await refused([{ media_type: 'image/png', data: Buffer.alloc(6 * MB, 1).toString('base64') }]), 'The image is 6.0 MB: at most 5 MB.');
  assert.equal(await refused([{ media_type: 'image/jpeg', data: Buffer.from('not a picture at all').toString('base64') }]), 'The image is not a readable JPEG image.');
});

test('/cd: the session goes on in another directory with the same conversation and the same id at the gateway; its name follows the directory unless one was given', async (t) => {
  gw.sessions.clear();
  const { projectDir, SessionStore } = await import('../src/session.js');
  const restartFile = path.join(configDir, 'restart-state.json');
  const saved = { supervised: process.env.CLAUDE_PRO_SUPERVISED, file: process.env.CLAUDE_PRO_RESTART_FILE };
  Object.assign(process.env, { CLAUDE_PRO_SUPERVISED: '1', CLAUDE_PRO_RESTART_FILE: restartFile });
  t.after(() => {
    for (const [k, v] of [['CLAUDE_PRO_SUPERVISED', saved.supervised], ['CLAUDE_PRO_RESTART_FILE', saved.file]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-cd-from-'));
  const to = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-cd-to-')), 'next project');
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(from, 'a-file.txt'), '');
  const tui = await startTui({ cwd: from });
  t.after(() => tui.close());
  await until('online', () => gw.stream && tui.app.remote?.online);
  tui.send('first question\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  const id = tui.app.remote.id;
  const oldFile = tui.app.store.file;
  assert.ok(fs.existsSync(oldFile));

  tui.send('/cd nowhere-at-all\r');
  await tui.waitFor(`No such directory: ${path.join(from, 'nowhere-at-all')}`, { timeout: 5000 });
  tui.send('/cd a-file.txt\r');
  await tui.waitFor('Not a directory:', { timeout: 5000 });
  assert.equal(fs.existsSync(restartFile), false);

  // from the page, as it does: the directory moves, the session restarts there
  gw.order = [];
  assert.equal((await command('send', { text: `/cd ${to}` })).ok, true);
  const cdCid = `c${gw.cid}`;
  await until('the restart', () => tui.app.exiting && fs.existsSync(restartFile));
  const state = JSON.parse(fs.readFileSync(restartFile, 'utf8'));
  fs.rmSync(restartFile);
  assert.deepEqual([state.cwd, state.changedDirectory, state.remote.id, state.peerName], [to, true, id, null]);
  assert.equal(state.sessionFile, path.join(projectDir(to), `${state.sessionId}.jsonl`));
  assert.equal(fs.existsSync(oldFile), false, 'moved, not copied');
  assert.equal(JSON.parse(fs.readFileSync(state.sessionFile, 'utf8').split('\n')[0]).cwd, to);
  await until('the page told it restarts', () => gw.page.byes.at(-1)?.restarting === true);
  await until('its command stream closed', () => gw.order.includes('stream closed'));
  assert.ok(gw.order.indexOf(`result ${cdCid}`) < gw.order.indexOf('stream closed'), `the answer before the stream closes: ${gw.order}`);

  // the next process (main.js starts it in state.cwd)
  const next = await startTui({ cwd: to, flags: { restart: state } });
  t.after(() => next.close());
  await next.waitFor(`Working directory: ${to}`, { timeout: 10_000 });
  await until('registered again', () => gw.sessions.get(id)?.cwd === to.replace(/\\/g, '/') && next.app.remote?.online);
  assert.equal(next.app.remote.id, id, 'the page stays on it');
  assert.equal(gw.sessions.get(id).name, 'next-project', 'the name follows the directory');
  assert.ok(next.app.agent.messages.length >= 3, 'the conversation goes on');
  assert.ok(SessionStore.list(to).some((s) => s.id === state.sessionId), '/resume finds it there');
  await until('the page shows the line', () => gw.page.state.items.some((it) => it.k === 'output' && it.lines.some((l) => l.includes(`Working directory: ${to}`))));

  // a name given with /rename stays; back to the first directory, from the terminal
  next.app.renameSession('keep me');
  next.send(`/cd ${from}\r`);
  await until('the second restart', () => next.app.exiting && fs.existsSync(restartFile));
  const again = JSON.parse(fs.readFileSync(restartFile, 'utf8'));
  fs.rmSync(restartFile);
  assert.deepEqual([again.cwd, again.peerName, again.sessionFile], [from, 'keep-me', path.join(projectDir(from), `${state.sessionId}.jsonl`)]);
  assert.equal(again.restarts.length, 0, 'a /cd does not count as a restart that may be a loop');
});

test('a command that ends the session (a /cd or /exit from the page): its answer goes out before the command stream closes and the bye', async () => {
  const { RemoteControl } = await import('../src/remote.js');
  const order = [];
  const fetchImpl = async (url, init) => {
    order.push(`${init.method} ${new URL(url).pathname.split('/').pop()}`);
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let remote;
  remote = new RemoteControl({
    gateway: { url: 'http://gw.invalid', apiKey: 'k' },
    id: 'ends-itself-1',
    fetchImpl,
    handlers: { send: () => { remote.close({ restarting: true }); return { queued: false }; }, seed: () => [] },
  });
  remote.registered = true;
  remote.streamAbort = new AbortController();
  remote.streamAbort.signal.addEventListener('abort', () => order.push('stream closed'));
  remote.command({ cid: 'c1', type: 'send', body: { text: '/cd x' } });
  await remote.close();
  assert.deepEqual(order, ['POST results', 'stream closed', 'POST events']);
});

test('the status says what the page needs (asking, cost, context, background work, the conversation), and a question to type the answer to is answered from the page', async (t) => {
  gw.sessions.clear();
  const { TextDialog } = await import('../src/ui/dialogs.js');
  const tui = await startTui({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-remote-')) });
  t.after(() => tui.close());
  await until('online', () => gw.stream && tui.app.remote?.online);
  const reg = [...gw.sessions.values()].at(-1);
  assert.deepEqual([reg.kind, reg.conversationId], ['terminal', tui.app.store.id]);
  assert.match(reg.computerId, /^[\w-]{8,64}$/);

  const status = tui.app.remoteStatus();
  assert.deepEqual([status.asking, status.kind, status.conversationId, status.cost], [false, 'terminal', tui.app.store.id, 0]);
  assert.equal(status.context.window, tui.app.config.mainModel.contextWindow);
  assert.ok(status.context.used > 0, 'an estimate before any request');
  assert.deepEqual(status.background, []);

  const answer = tui.app.showDialog(new TextDialog({ title: 'Name it', question: 'What should it be called?', placeholder: 'a name', value: 'draft' }));
  await until('the question on the page', () => gw.page.status?.dialog?.input);
  assert.equal(gw.page.status.asking, true);
  assert.deepEqual(gw.page.status.dialog.input, { placeholder: 'a name', value: 'draft', multiline: false });
  const id = gw.page.status.dialog.id;
  assert.match((await command('dialog', { id, index: 0 })).error, /Type an answer first/);
  assert.equal((await command('dialog', { id, text: 'final name' })).ok, true);
  assert.equal(await answer, 'final name');
  await until('no longer asking', () => gw.page.status?.asking === false);
});

test('an unwatched session sends a change of busy or asking at once, the rest at most every few seconds', async () => {
  const { RemoteControl } = await import('../src/remote.js');
  let status = { busy: false, asking: false, title: 'a', model: 'm', cwd: '/x', name: 'n', tokens: 0 };
  const remote = new RemoteControl({ gateway: { url: 'http://gw.invalid', apiKey: 'k' }, id: 'urgent-test-1', fetchImpl: async () => new Response('{}'), handlers: { status: () => status, seed: () => [] } });
  remote.registered = true;
  remote.viewers = 0;
  remote.needSnapshot = false;
  remote.pump = () => {};
  remote.flush();
  const sent = () => remote.outbox.filter((m) => m.t === 'status').length;
  const first = sent();
  status = { ...status, title: 'b' };
  remote.flush();
  assert.equal(sent(), first, 'a title change waits');
  status = { ...status, busy: true };
  remote.flush();
  assert.equal(sent(), first + 1, 'busy goes at once');
  status = { ...status, asking: true };
  remote.flush();
  assert.equal(sent(), first + 2, 'so does a question');
  clearInterval(remote.statusTimer);
});

test('output: the whole result of a tool call, also one that was saved to a file', async (t) => {
  gw.sessions.clear();
  const tui = await startTui({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-remote-')) });
  t.after(() => tui.close());
  await until('online', () => gw.stream && tui.app.remote?.online);
  tui.send('run something\r');
  await tui.waitFor('All done.', { timeout: 20_000 });
  await tui.waitIdle({ timeout: 20_000 });
  const out = await command('output', { id: 'toolu_bash' });
  assert.equal(out.ok, true, out.error);
  assert.match(out.text, /remote-ok/);
  assert.equal(out.truncated, false);
  assert.match((await command('output', { id: 'toolu_nope' })).error, /no such tool call/);

  // a result that points to the file it was saved to: the file is what comes back
  const { toolResultsDir } = await import('../src/session.js');
  const saved = path.join(toolResultsDir(tui.app.cwd), 'big.txt');
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.writeFileSync(saved, 'x'.repeat(1024 * 1024 + 10));
  tui.app.agent.messages.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_big', name: 'Bash', input: { command: 'big' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: `<persisted-output>\nOutput too large (1024.0KB). Full output saved to: ${saved}\n...` }] },
  );
  const big = await command('output', { id: 'toolu_big' });
  assert.deepEqual([big.text.length, big.truncated], [1024 * 1024, true]);
});

test('a !command of bash mode reads on the page, after a resume, as it was shown when it ran', async () => {
  const { transcriptItems } = await import('../src/remote.js');
  const { stripAnsi } = await import('../src/ui/ansi.js');
  const items = transcriptItems([
    { role: 'user', content: [{ type: 'text', text: '<bash-input>echo hi</bash-input>\n<bash-stdout>hi\nthere</bash-stdout>\n<system-reminder>The user ran this command directly in bash mode.</system-reminder>' }] },
    { role: 'user', content: 'a question' },
  ]);
  assert.deepEqual(items.map((i) => (i.k === 'output' ? { k: 'output', lines: i.lines.map(stripAnsi) } : i)), [
    { k: 'output', lines: ['! echo hi', '  ⎿  hi', '     there', ''] },
    { k: 'user', text: 'a question' },
  ]);
});
