// Where a Chrome or Edge is on this machine: the Browser tool's own browser (session.js), the headless renderer of
// WebFetch (render.js) and the web console's app window (web/server.js) start one of these. Apart from both of them,
// which import each other's other parts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
