// Read an existing Claude Code subscription login. There is no login flow here and no subprocess: signing
// in is the official application's. Renewing the access token with the refresh token stored beside it is
// done by oauth.js, which is the only code that writes the credentials file; this reads it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CLAUDE_CODE_API_URL = 'https://api.anthropic.com';
export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
export const CLAUDE_CODE_BETAS = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14';
const sessionIds = new WeakMap();
let installedVersion;

function readJson(file, label) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { throw new Error(`Could not read existing Claude Code ${label}: ${file}. Select the existing login with CLAUDE_PRO_CLAUDE_CONFIG_FILE / CLAUDE_PRO_CLAUDE_CREDENTIALS_FILE.`); }
  // JSON.parse errors can contain an excerpt of the token. Never echo them.
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Invalid JSON in Claude Code ${label}: ${file}.`); }
}

function clientVersion(config, metadata) {
  if (config.env.CLAUDE_PRO_CLAUDE_CODE_VERSION) return config.env.CLAUDE_PRO_CLAUDE_CODE_VERSION;
  if (installedVersion) return installedVersion;
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir.replace(/^"|"$/g, ''), 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'), 'utf8'));
      if (/^\d+\.\d+\.\d+$/.test(pkg.version)) return (installedVersion = pkg.version);
    } catch { /* native installs do not have an npm package */ }
  }
  return /^\d+\.\d+\.\d+$/.test(metadata.lastOnboardingVersion || '') ? metadata.lastOnboardingVersion : '2.1.289';
}

export function readClaudeCodeLogin(config) {
  const metadata = readJson(config.claudeCodeConfigFile, 'account configuration');
  const credentials = readJson(config.claudeCodeCredentialsFile, 'credentials');
  const oauth = credentials?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken.trim()) {
    throw new Error(`No existing Claude Code subscription access token in ${config.claudeCodeCredentialsFile}. The .claude.json file contains account metadata; the token is in .claude/.credentials.json.`);
  }
  if (oauth.expiresAt && Number(oauth.expiresAt) <= Date.now()) {
    throw new Error('The existing Claude Code access token has expired and cannot be renewed from here (the credentials file has no refresh token, or CLAUDE_PRO_DISABLE_TOKEN_REFRESH is set). Run `claude` and use /login to sign in again; this project will read the updated file automatically.');
  }
  if (!sessionIds.has(config)) sessionIds.set(config, crypto.randomUUID());
  return {
    accessToken: oauth.accessToken,
    expiresAt: Number(oauth.expiresAt) || null, // ms since epoch; the token lives 8 hours
    userId: JSON.stringify({ device_id: metadata.userID || '', account_uuid: metadata.oauthAccount?.accountUuid || '', session_id: sessionIds.get(config) }),
    version: clientVersion(config, metadata),
  };
}

export function claudeCodeHeaders(login) {
  return {
    'anthropic-beta': CLAUDE_CODE_BETAS,
    'user-agent': `claude-cli/${login.version} (external, cli)`,
    'x-app': 'cli',
  };
}
