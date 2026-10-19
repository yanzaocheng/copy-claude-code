// Persistent system-prompt profiles saved in the user's claude-pro configuration.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, updateSettingsFile } from './config.js';

export const PROMPTS_DIR = path.join(CONFIG_DIR, 'prompts');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

const isPromptName = (name) => {
  const value = String(name ?? '').trim();
  return Boolean(value) && value !== '.' && value !== '..' && !/[\\/\0]/.test(value);
};

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function profileFile(name) {
  if (!isPromptName(name)) throw new Error(`Invalid prompt name: ${name}`);
  return path.join(PROMPTS_DIR, name);
}

export function activePromptName() {
  const prompts = readSettings()?.prompts;
  const name = prompts && typeof prompts === 'object' && !Array.isArray(prompts) ? prompts.active : null;
  return isPromptName(name) ? String(name).trim() : null;
}

export function loadPrompt(name) {
  const file = profileFile(name);
  const text = fs.readFileSync(file, 'utf8');
  return { name: String(name), file, text };
}

// Returns null for the built-in prompt, or a descriptor with an error when the selected file disappeared.
export function loadActivePrompt() {
  const name = activePromptName();
  if (!name) return null;
  const file = profileFile(name);
  try {
    return { name, file, text: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return { name, file, text: null, error };
  }
}

export function listPromptProfiles() {
  let entries;
  try { entries = fs.readdirSync(PROMPTS_DIR, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isFile() && isPromptName(entry.name))
    .map((entry) => {
      const file = path.join(PROMPTS_DIR, entry.name);
      let size = 0;
      let preview = '';
      try {
        size = fs.statSync(file).size;
        preview = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ').trim().slice(0, 140);
      } catch { /* a file can disappear between readdir and stat/read */ }
      return { name: entry.name, file, size, preview };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function setActivePrompt(name) {
  const active = name == null || String(name).trim() === '' ? null : String(name).trim();
  if (active !== null) {
    const file = profileFile(active);
    if (!fs.statSync(file).isFile()) throw new Error(`Prompt profile is not a file: ${active}`);
  }
  updateSettingsFile(SETTINGS_FILE, (json) => {
    const current = json.prompts && typeof json.prompts === 'object' && !Array.isArray(json.prompts) ? { ...json.prompts } : {};
    if (active) current.active = active;
    else delete current.active;
    if (Object.keys(current).length) json.prompts = current;
    else delete json.prompts;
  });
  return active;
}

export function promptNameForText(text) {
  const firstLine = String(text).split(/\r?\n/, 1)[0].trim();
  let slug = firstLine
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');
  if (!slug || slug === '.' || slug === '..') slug = `prompt-${Date.now()}`;
  let name = `${slug}.txt`;
  let n = 2;
  while (fs.existsSync(profileFile(name))) name = `${slug}-${n++}.txt`;
  return name;
}

export function savePrompt(name, text, { activate = true } = {}) {
  const profile = String(name ?? '').trim();
  const content = String(text ?? '');
  if (!isPromptName(profile)) throw new Error('A prompt profile needs a file name.');
  if (!content.trim()) throw new Error('The system prompt cannot be empty.');
  const file = profileFile(profile);
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  fs.writeFileSync(file, content);
  if (activate) setActivePrompt(profile);
  return { name: profile, file, text: content };
}

export function promptDirectory() {
  return PROMPTS_DIR;
}
