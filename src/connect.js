// `claude-pro connect <code> [--url U]`: a new computer joins the user's gateway account with the pairing code the
// web page shows (添加电脑). No login in a browser: the code stands for it. The gateway answers with an API key of
// this computer's own, which is saved as /login saves one (gateway.json); then the computer service is set up to
// start at logon and started, so that the page can use this computer at once and after every restart.
//
//   POST {url}/v1/remote/pair {code, id, machine, host, platform, version, home} (no authentication)
//   200 {apiKey, computerId, url, account: {name, email}} · 400 配对码无效或已过期 · 429 too many tries

import os from 'node:os';
import { VERSION, GATEWAY_DEFAULT_URL, loadConfig, settingsFiles, updateSettingsFile } from './config.js';
import { saveGatewayLogin, normalizeGatewayUrl } from './gateway.js';
import { machineName } from './peers.js';
import { computerId, setComputerId, hostEnabled, ensureAutostart, startHostInBackground, hostRunning, readHostState, updateHostState } from './host.js';

// The code as typed: 8 letters and digits (I, O, 0 and 1 are not used), maybe with a dash or spaces, in any case.
export function normalizePairingCode(input) {
  const code = String(input ?? '').toUpperCase().replace(/[\s-]+/g, '');
  return /^[A-Z2-9]{8}$/.test(code) ? code : null;
}

const USAGE = `Usage: claude-pro connect <code> [--url <gateway>]

Connects this computer to your gateway account with the pairing code the web page shows (远程控制 → 添加电脑),
then starts the computer service and sets it to start at logon, so that the page can use this computer.
--url: the gateway's address (default ${GATEWAY_DEFAULT_URL}, or CLAUDE_PRO_GATEWAY_URL).
`;

export async function connectCommand(args = [], { fetchImpl = globalThis.fetch, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), startService = true } = {}) {
  let url = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') url = args[++i];
    else if (args[i].startsWith('--url=')) url = args[i].slice(6);
    else if (args[i] === '-h' || args[i] === '--help') { out(USAGE); return 0; }
    else rest.push(args[i]);
  }
  const code = normalizePairingCode(rest.join(''));
  if (!code) { err(`配对码应是 8 位字母和数字（例如 K7QF-M2XD），不是 "${rest.join(' ')}"\n\n${USAGE}`); return 2; }
  const home = os.homedir();
  const cfg = loadConfig({ cwd: home });
  const base = normalizeGatewayUrl(url || cfg.gatewayUrl);
  let res;
  let data = {};
  try {
    res = await fetchImpl(`${base}/v1/remote/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, id: computerId(), machine: machineName(cfg.env), host: os.hostname(), platform: process.platform, version: VERSION, home }),
      signal: AbortSignal.timeout(20_000),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    err(`连不上网关 ${base}：${e.message}`);
    return 1;
  }
  if (!res.ok || !data.apiKey) {
    const said = data?.error?.message || (typeof data?.error === 'string' ? data.error : '');
    err(res.status === 429 ? `请求太频繁，请稍后再试${said ? `（${said}）` : ''}` : said || `配对失败（HTTP ${res.status}）`);
    return 1;
  }
  const gateway = normalizeGatewayUrl(data.url || base);
  saveGatewayLogin({ url: gateway, apiKey: data.apiKey, account: data.account || {} });
  // another gateway than the one configured: the sessions and the service use this one from now on
  if (gateway !== normalizeGatewayUrl(cfg.gatewayUrl)) {
    updateSettingsFile(settingsFiles(home).user, (json) => { json.env = { ...(json.env || {}), CLAUDE_PRO_GATEWAY_URL: gateway }; });
  }
  if (data.computerId && data.computerId !== computerId()) setComputerId(data.computerId);
  const who = data.account?.name || data.account?.email || '你的账户';
  if (!hostEnabled(cfg.env)) {
    out(`已连接到 ${who}。CLAUDE_PRO_HOST=0：电脑服务不会自己启动，用 claude-pro host start 启动它，网页才能使用这台电脑。`);
    return 0;
  }
  updateHostState({ disabled: undefined, autostartDeclined: undefined });
  const auto = ensureAutostart({ force: true, env: cfg.env });
  if (startService && !hostRunning(readHostState())) startHostInBackground();
  // (one that runs already picks the new login up within seconds)
  out(`已连接到 ${who}，可以在网页上使用这台电脑了。${auto?.file ? `\n登录后自动启动：${auto.file}` : ''}`);
  return 0;
}
