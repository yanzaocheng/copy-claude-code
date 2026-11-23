// 开机自动启动: the web console started at log-in (`claude-pro web --no-open`), so that 远程访问 answers from the
// moment the computer is on. Per system, all of it for this user alone:
//   Windows  a shortcut in the Startup folder, its window minimized (the command ends at once; the console goes on)
//   macOS    a LaunchAgent (~/Library/LaunchAgents), run at load
//   Linux    an XDG autostart entry (~/.config/autostart): a desktop session's log-in; a server has none
// The command is this claude-pro (this Node, this install): enabling it again after a move or a Node change renews it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { INSTALL_DIR } from '../config.js';

const NAME = 'claude-pro 控制台';
const LABEL = 'fun.7bit.claude-pro.web';
const ENTRY = path.join(INSTALL_DIR, 'bin', 'claude-pro.js');
const ARGS = ['web', '--no-open'];

function where() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return { kind: 'windows', file: path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${NAME}.lnk`) };
  }
  if (process.platform === 'darwin') return { kind: 'macos', file: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`) };
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return { kind: 'linux', file: path.join(config, 'autostart', 'claude-pro-web.desktop') };
}

// {supported, enabled, kind, file, hint}: on Linux without a desktop session there is no log-in to start it at
export function autostartStatus() {
  const w = where();
  const headless = w.kind === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !fs.existsSync(path.dirname(w.file));
  return {
    supported: !headless,
    enabled: fs.existsSync(w.file),
    kind: w.kind,
    file: w.file,
    // a server: started by cron at boot instead (the user's choice to make: their crontab)
    hint: headless ? `@reboot ${JSON.stringify(process.execPath)} ${JSON.stringify(ENTRY)} ${ARGS.join(' ')}` : null,
  };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const desktopQuote = (s) => `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`;

// A shortcut written by PowerShell (WScript.Shell): the paths through the environment, the script as UTF-16
// (-EncodedCommand), so that a user folder in Chinese survives.
function windowsShortcut(file) {
  const icon = path.join(INSTALL_DIR, 'src', 'web', 'icon.ico');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CP_LNK)',
    '$lnk.TargetPath = $env:CP_NODE',
    '$lnk.Arguments = $env:CP_ARGS',
    '$lnk.WorkingDirectory = $env:USERPROFILE',
    '$lnk.WindowStyle = 7',
    `$lnk.Description = "${NAME}（开机自动启动）"`,
    'if (Test-Path -LiteralPath $env:CP_ICON) { $lnk.IconLocation = "$env:CP_ICON,0" }',
    '$lnk.Save()',
  ].join('\n');
  const env = { ...process.env, CP_LNK: file, CP_NODE: process.execPath, CP_ARGS: [`"${ENTRY}"`, ...ARGS].join(' '), CP_ICON: icon };
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env, windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n')[0])) : resolve()));
  });
}

export async function setAutostart(enabled) {
  const st = autostartStatus();
  if (!st.supported) throw new Error('这台电脑没有图形桌面，没有登录时启动的地方：可以用 crontab 的 @reboot（见下面的说明）');
  if (!enabled) {
    fs.rmSync(st.file, { force: true });
    return autostartStatus();
  }
  fs.mkdirSync(path.dirname(st.file), { recursive: true });
  if (st.kind === 'windows') await windowsShortcut(st.file);
  else if (st.kind === 'macos') {
    fs.writeFileSync(st.file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${[process.execPath, ENTRY, ...ARGS].map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
</dict></plist>
`);
  } else {
    fs.writeFileSync(st.file, `[Desktop Entry]
Type=Application
Name=${NAME}（开机自动启动）
Exec=${[process.execPath, ENTRY, ...ARGS].map(desktopQuote).join(' ')}
Icon=${path.join(INSTALL_DIR, 'src', 'web', 'icon-512.png')}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`);
  }
  return autostartStatus();
}
