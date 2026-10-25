// Read, Write and Edit tools. Edits require that the file was read first and hasn't
// changed on disk since, which prevents the model from clobbering changes it never saw.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolvePath, displayPath } from '../utils/paths.js';
import { diffLines, makeHunks, countChanges, splitLines } from '../utils/diff.js';
import { fitImage } from '../utils/images.js';
import { decodeText, encodeText, encodingName } from '../utils/encoding.js';

const MAX_LINES = 10_000;
const MAX_LINE_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 400_000; // a read without offset/limit bigger than this is refused
const HARD_MAX_CHARS = 400_000; // never return more than this in one read (about 100k tokens), even with an explicit limit
// ... and never more than about this many tokens: 400k characters of Chinese text are some 320k tokens, more than a
// whole context window (Read is not cut down to a preview like other large tool results).
const MAX_OUTPUT_TOKENS = 100_000;

// Tokens of text as the program estimates them (agent.js estimateTokens): 4 ASCII characters or 1.25 others each.
// `limit`: the index where that many tokens are reached (text.length when they are not).
function tokensOf(text) {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 4 + (text.length - ascii) * 0.8);
}
function tokenLimitIndex(text, limit) {
  let t = 0;
  for (let i = 0; i < text.length; i++) {
    t += text.charCodeAt(i) < 128 ? 0.25 : 0.8;
    if (t > limit) return i;
  }
  return text.length;
}
const tooManyTokens = (text) => text.length > MAX_OUTPUT_TOKENS * 1.25 && tokensOf(text) > MAX_OUTPUT_TOKENS;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

// The file as text: {text, crlf, bom, encoding, lossy} (see utils/encoding.js), or null for binary data.
// `crlf` is true when CRLF is the file's main line ending. Editing rewrites every line ending, so a
// mostly-LF file with one stray CRLF must stay LF instead of being converted wholesale.
function readText(file, buf = fs.readFileSync(file)) {
  const decoded = decodeText(buf);
  if (!decoded) return null;
  const crlfCount = (decoded.text.match(/\r\n/g) || []).length;
  const bareLfCount = (decoded.text.match(/\n/g) || []).length - crlfCount;
  return { ...decoded, crlf: crlfCount > 0 && crlfCount >= bareLfCount };
}

const notText = (file) => `${file} appears to be a binary file, not text.`;
const notRewritable = (file, { encoding }) => (encoding === 'gbk'
  ? `${file} is GB18030 text with characters GBK cannot write, so rewriting it here could change bytes you did not edit. Change it with a tool that knows its encoding (Bash: iconv, python).`
  : `${file} is not valid UTF-8 or GBK as a whole (another encoding, or mixed), so rewriting it here would corrupt the bytes that could not be decoded. Change it with a tool that knows its encoding (Bash: iconv, python).`);

// What a Read says about a file that is not plain UTF-8.
function encodingNote(t) {
  if (t.lossy) return t.encoding === 'gbk'
    ? '\n\n(This file is GB18030 with characters GBK cannot write: Edit and Write refuse to rewrite it.)'
    : '\n\n(This file is not valid UTF-8 or GBK as a whole: bytes that could not be decoded show as \ufffd, and Edit and Write refuse to rewrite it.)';
  if (t.encoding !== 'utf8') return `\n\n(This file is ${encodingName(t.encoding)}${t.bom ? ' with a BOM' : ''}; Edit and Write keep that encoding.)`;
  return '';
}

// Why `text` cannot be written into a file in the encoding `meta` says, or null when it can.
function unwritable(file, text, meta) {
  if (!meta?.encoding || meta.encoding === 'utf8') return null;
  const { error } = encodeText(text, meta);
  return error ? `${file} is ${encodingName(meta.encoding)}-encoded (kept so when it is edited), and the new text has ${error}. Use other characters, or convert the file to UTF-8 first if the user wants that.` : null;
}

// Each line as its number, a tab and the line. Not padded as cat -n pads it: the padding cost 2 tokens a line on
// GPT and 1 on Claude (measured 2026-10-26: 12% of a code Read on gpt-6.1-sol, 4% on Opus 5.5), in every Read
// result, which stays in the conversation and is sent again with every later request.
export function numberLines(lines, start, maxLineChars = MAX_LINE_CHARS) {
  return lines.map((l, i) => {
    const line = l.length > maxLineChars ? l.slice(0, maxLineChars) + '… [line truncated]' : l;
    return `${start + i}\t${line}`;
  }).join('\n');
}

function renderNotebook(json) {
  const cells = json.cells || [];
  return cells.map((cell, i) => {
    const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
    let out = `<cell id="${cell.id || i}" type="${cell.cell_type}">\n${src}\n</cell>`;
    for (const o of cell.outputs || []) {
      const text = o.text ? [].concat(o.text).join('') : o.data?.['text/plain'] ? [].concat(o.data['text/plain']).join('') : '';
      if (text) out += `\n<output>\n${text.slice(0, 5000)}\n</output>`;
    }
    return out;
  }).join('\n\n');
}

export const ReadTool = {
  name: 'Read',
  readOnly: true,
  description: `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the user provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter should be an absolute path
- By default, it reads up to ${MAX_LINES} lines starting from the beginning of the file
- Read a file whole when you need to understand it; when only a part of a long file matters, give offset and limit (find the place with Grep first if needed)
- Any lines longer than ${MAX_LINE_CHARS} characters will be truncated
- A file whose numbered text is longer than ${MAX_OUTPUT_CHARS} characters or about ${MAX_OUTPUT_TOKENS / 1000}k tokens (Chinese text gets there sooner) is refused (or cut there with offset/limit). When you need a large file whole, in one call, pass allow_large: true: then there is no line, character or line length limit, only the room left in the context, and a read that does not fit is refused.
- Results are returned as each line's number, a tab, then the line (numbers start at 1)
- This tool can read images (PNG, JPG, GIF, WEBP) and Jupyter notebooks (.ipynb)
- This tool can only read files, not directories. To list a directory, use ls via the Bash tool.
- Do not read a file again just to check an edit you made to it: Edit, MultiEdit and Write report an error when they fail.
- If you read a file that exists but has empty contents you will receive a warning in place of file contents.`,
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to read' },
      offset: { type: 'number', description: 'The line number to start reading from. Only provide if the file is too large to read at once' },
      limit: { type: 'number', description: 'The number of lines to read. Only provide if the file is too large to read at once.' },
      allow_large: { type: 'boolean', description: 'Read past the usual size limits in one call (the whole file, or the whole offset/limit range, with long lines kept whole), when you need all of it and the context has room. Refused if it would not fit in the context left.' },
    },
    required: ['file_path'],
  },
  summarize(input, ctx) {
    const p = displayPath(resolvePath(input.file_path, ctx.cwd), ctx.cwd);
    return input.offset || input.limit ? `${p}, lines ${input.offset || 1}-${(input.offset || 1) + (input.limit || MAX_LINES) - 1}` : p;
  },
  filePath(input, ctx) { return resolvePath(input.file_path, ctx.cwd); },
  async call(input, ctx) {
    const file = resolvePath(input.file_path, ctx.cwd);
    let stat;
    try { stat = fs.statSync(file); } catch {
      return { isError: true, content: `File does not exist: ${file}` };
    }
    if (stat.isDirectory()) return { isError: true, content: `EISDIR: ${file} is a directory. Use the Bash tool with ls to list directories.` };
    const ext = path.extname(file).toLowerCase();

    if (IMAGE_TYPES[ext]) {
      if (stat.size > 30 * 1024 * 1024) return { isError: true, content: `Image too large (${Math.round(stat.size / 1024)}KB, max 30MB).` };
      // Scaled to what the API takes (see utils/images.js): a full-page screenshot would otherwise make every
      // later request of the session fail once it has many images.
      const fit = await fitImage({ data: fs.readFileSync(file).toString('base64'), media_type: IMAGE_TYPES[ext] });
      if (fit.error) return { isError: true, content: `Cannot show ${file}: ${fit.error}. Crop it or take a smaller screenshot.` };
      ctx.fileState.set(file, { mtimeMs: stat.mtimeMs });
      const dims = fit.width ? `${fit.width}×${fit.height}, ` : '';
      const kb = Math.round((fit.data.length * 3) / 4 / 1024);
      return {
        content: [
          { type: 'image', source: { type: 'base64', media_type: fit.media_type, data: fit.data } },
          ...(fit.from ? [{ type: 'text', text: `[Scaled from ${fit.from.width}×${fit.from.height} to ${fit.width}×${fit.height} px to fit the API's image size limit. For detail, crop the area or take a smaller screenshot.]` }] : []),
        ],
        display: { summary: fit.from ? `Read image (${fit.from.width}×${fit.from.height}, scaled to ${fit.width}×${fit.height}, ${kb}KB)` : `Read image (${dims}${kb}KB)` },
      };
    }
    if (ext === '.ipynb') {
      try {
        const raw = fs.readFileSync(file);
        const nb = JSON.parse(raw.toString('utf8'));
        const rendered = renderNotebook(nb);
        if (rendered.length > MAX_OUTPUT_CHARS || tooManyTokens(rendered)) {
          return { isError: true, content: `Notebook content (${Math.round(rendered.length / 1024)}KB, about ${tokensOf(rendered).toLocaleString('en-US')} tokens) exceeds the maximum allowed size. Look at parts of it with the Bash tool (python or jq on its JSON), or use Grep to search it.` };
        }
        ctx.fileState.set(file, { mtimeMs: stat.mtimeMs, hash: hashOf(raw) });
        return { content: rendered, display: { summary: `Read ${(nb.cells || []).length} cells` } };
      } catch (e) {
        return { isError: true, content: `Could not parse notebook: ${e.message}` };
      }
    }
    const buf = fs.readFileSync(file);
    const decoded = readText(file, buf);
    if (!decoded) return { isError: true, content: `This appears to be a binary file (${stat.size} bytes) and cannot be displayed as text.` };
    const note = encodingNote(decoded);
    const lines = splitLines(decoded.text);
    // `partial` records that part of the file was not shown, so Write can refuse to overwrite it; `hash` tells a
    // later change of its time without a change of its bytes from a real one (see fileStanding).
    const seen = (partial) => ctx.fileState.set(file, { mtimeMs: stat.mtimeMs, partial, hash: hashOf(buf) });
    if (lines.length === 0) {
      seen(false);
      return { content: '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>', display: { summary: 'Read 0 lines (empty file)' } };
    }
    const start = Math.max(1, Math.floor(input.offset || 1));
    if (start > lines.length) {
      seen(true);
      return { content: `<system-reminder>Warning: the file exists but is shorter than the provided offset (${start}). The file has ${lines.length} lines.</system-reminder>`, display: { summary: 'Read 0 lines' } };
    }
    // allow_large: no line, character or line length limit, only the room left in the context (see Agent.takeContext).
    const large = input.allow_large === true;
    const limit = Math.max(1, Math.floor(input.limit || (large ? Infinity : MAX_LINES)));
    const slice = lines.slice(start - 1, start - 1 + limit);
    let content = numberLines(slice, start, large ? Infinity : MAX_LINE_CHARS);
    if (large) {
      const fit = ctx.agent?.takeContext?.(content);
      if (fit && !fit.ok) {
        const n = (t) => t.toLocaleString('en-US');
        return { isError: true, content: `File content (about ${n(fit.tokens)} tokens) does not fit in the context left (about ${n(Math.max(0, fit.room))} tokens before auto-compaction). Read the parts you need with offset and limit, or use the Grep tool to search for specific content.` };
      }
    } else if (!input.limit && (content.length > MAX_OUTPUT_CHARS || tooManyTokens(content))) {
      return { isError: true, content: `File content (${Math.round(content.length / 1024)}KB, about ${tokensOf(content).toLocaleString('en-US')} tokens) exceeds the maximum allowed size. Use the offset and limit parameters to read specific portions of the file, or use the Grep tool to search for specific content. If you need the whole file at once, pass allow_large: true.` };
    }
    let cut = false;
    let end = start + slice.length - 1;
    const cutAt = large ? content.length : Math.min(HARD_MAX_CHARS, tokenLimitIndex(content, MAX_OUTPUT_TOKENS));
    if (cutAt < content.length) {
      const kept = content.slice(0, cutAt);
      const whole = kept.endsWith('\n'); // the cut fell between two lines
      end = start + (kept.match(/\n/g) || []).length - (whole ? 1 : 0); // the last line shown
      const why = cutAt === HARD_MAX_CHARS ? `${HARD_MAX_CHARS} characters` : `about ${MAX_OUTPUT_TOKENS / 1000}k tokens`;
      content = `${kept}${whole ? '' : '\n'}… [output cut at ${why}: line ${end} is the last one shown${whole ? '' : ', and only in part'}; read on from there with offset/limit, or pass allow_large: true to read it all at once]`;
      cut = true;
    }
    seen(cut || start > 1 || end < lines.length);
    if (end < lines.length) content += `\n\n(File has ${lines.length} lines total; showing lines ${start}-${end}. Use offset/limit to read more.)`;
    content += note;
    return { content, display: { summary: `Read ${slice.length} line${slice.length === 1 ? '' : 's'}` } };
  },
};

const hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// How a file stands against what the model has seen of it: null (read or written by it, unchanged since),
// 'unread', or 'modified' (changed on disk since). A time that moved while the bytes stayed the same (git, a
// formatter that changed nothing, an antivirus scan or a cloud sync on Windows) is no change: the content is
// compared as well, as Claude Code does.
export function fileStanding(file, ctx) {
  const state = ctx.fileState.get(file);
  if (!state) return 'unread';
  const now = mtime(file);
  if (now === null || state.mtimeMs === undefined || Math.abs(now - state.mtimeMs) <= 1) return null;
  let same = false;
  try { same = Boolean(state.hash) && hashOf(fs.readFileSync(file)) === state.hash; } catch { /* gone: changed */ }
  if (!same) return 'modified';
  state.mtimeMs = now;
  return null;
}

// Validate that a file may be written: it must have been read and be unchanged since. With
// `full`, which Write needs because it replaces the whole file, the read must also have covered
// all of it. (Edit has its own rule, see EditTool.plan.)
export function checkFreshness(file, ctx, { full = false } = {}) {
  const standing = fileStanding(file, ctx);
  if (standing === 'unread') return 'File has not been read yet. Read it first before writing to it.';
  if (full && ctx.fileState.get(file).partial) {
    return 'Only part of this file has been seen (a Read with offset/limit, or edits without a whole Read), so Write would overwrite content you have not seen. Read the whole file first, or use Edit for targeted changes.';
  }
  if (standing === 'modified') {
    return 'File has been modified since it was last read, either by the user or by a linter. Read it again before attempting to write it.';
  }
  return null;
}

// In the encoding, BOM and line endings the file had (`meta`, from readText); checked with unwritable() first.
// Returns the hash of what was written, for the file state.
function writeText(file, text, { crlf, bom, encoding = 'utf8' }) {
  const { buffer, error } = encodeText(crlf ? text.replace(/\r?\n/g, '\r\n') : text, { encoding, bom });
  if (error) throw new Error(`${file}: ${error}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return hashOf(buffer);
}

// Where the new text of an edit is, for its result: "lines 12-18", "line 12", or "text removed at line 12".
// The result used to show a snippet of the file around the change; it repeated new_string, which the model has
// just written, and stayed in the conversation to be re-read by every later request. The line numbers are what
// it still needs (for a Read with offset/limit); Claude Code's Edit also answers with a short confirmation.
function changedLines(line, newStr) {
  if (!newStr) return `text removed at line ${line}`;
  const count = newStr.split('\n').length - (newStr.endsWith('\n') ? 1 : 0);
  return count > 1 ? `lines ${line}-${line + count - 1}` : `line ${line}`;
}

export const WriteTool = {
  name: 'Write',
  editsFiles: true,
  description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- An existing file must have been read with the Read tool first (a Grep result does not count); otherwise this tool fails.
- Missing parent directories are created.`,
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to write (must be absolute, not relative)' },
      content: { type: 'string', description: 'The content to write to the file' },
    },
    required: ['file_path', 'content'],
  },
  summarize(input, ctx) { return displayPath(resolvePath(input.file_path, ctx.cwd), ctx.cwd); },
  filePath(input, ctx) { return resolvePath(input.file_path, ctx.cwd); },
  validate(input, ctx) {
    if (typeof input.content !== 'string') return 'content must be a string';
    const file = resolvePath(input.file_path, ctx.cwd);
    if (fs.existsSync(file)) {
      if (fs.statSync(file).isDirectory()) return `${file} is a directory`;
      const fresh = checkFreshness(file, ctx, { full: true });
      if (fresh) return fresh;
      const prev = readText(file);
      if (prev?.lossy) return notRewritable(file, prev);
      return unwritable(file, input.content, prev);
    }
    return null;
  },
  preview(input, ctx) {
    const file = resolvePath(input.file_path, ctx.cwd);
    const exists = fs.existsSync(file);
    const newLines = splitLines(input.content);
    if (!exists) return { kind: 'create', path: file, lines: newLines };
    const ops = diffLines(splitLines(readText(file)?.text ?? ''), newLines);
    return { kind: 'diff', path: file, hunks: makeHunks(ops), ...countChanges(ops) };
  },
  async call(input, ctx) {
    const err = this.validate(input, ctx);
    if (err) return { isError: true, content: err };
    const file = resolvePath(input.file_path, ctx.cwd);
    const exists = fs.existsSync(file);
    // The encoding, BOM and line endings of what was there stay (a binary file it replaces: plain UTF-8).
    const prev = (exists && readText(file)) || { text: '', crlf: false, bom: false, encoding: 'utf8' };
    const preview = this.preview(input, ctx);
    const hash = writeText(file, input.content, prev);
    ctx.fileState.set(file, { mtimeMs: mtime(file), hash });
    const n = splitLines(input.content).length;
    if (!exists) {
      return {
        content: `File created successfully at: ${file}`,
        display: { summary: `Wrote ${n} line${n === 1 ? '' : 's'} to ${displayPath(file, ctx.cwd)}`, preview },
      };
    }
    return {
      content: `The file ${file} has been updated successfully.`,
      display: { summary: changeSummary(preview), preview },
    };
  },
};

function changeSummary({ added, removed }) {
  const parts = [];
  if (added) parts.push(`${added} addition${added === 1 ? '' : 's'}`);
  if (removed) parts.push(`${removed} removal${removed === 1 ? '' : 's'}`);
  return parts.length ? `Updated with ${parts.join(' and ')}` : 'No changes';
}

// Apply old->new replacement to text. Returns {result, count, index} or {error, notFound}. The errors do not repeat
// old_string (the model has it in its own call): a miss shows where the most similar text is instead (see missed).
export function applyEdit(text, oldStr, newStr, replaceAll) {
  if (oldStr === newStr) return { error: 'No changes to make: old_string and new_string are exactly the same.' };
  if (oldStr === '') {
    if (text.length) return { error: 'Cannot use an empty old_string on a non-empty file. Use Write to replace the whole file.' };
    return { result: newStr, count: 1, index: 0 };
  }
  let actualOld = oldStr;
  let count = text.split(actualOld).length - 1;
  if (count === 0) {
    // Tolerate trailing whitespace differences at line ends.
    const norm = (s) => s.replace(/[ \t]+\n/g, '\n');
    if (norm(text).includes(norm(oldStr)) && norm(text) !== text) {
      return { error: 'String to replace not found exactly (whitespace differs at line ends): copy the text exactly, including the whitespace at the ends of its lines.', notFound: true };
    }
    // Curly quote normalisation.
    const straight = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    // Curly quotes are single UTF-16 units, so indices line up between the two forms.
    const idx = straight(text).indexOf(straight(oldStr));
    if (idx >= 0) {
      actualOld = text.slice(idx, idx + oldStr.length);
      count = text.split(actualOld).length - 1;
    }
  }
  if (count === 0) return { error: 'String to replace not found in file.', notFound: true };
  if (count > 1 && !replaceAll) {
    return { error: `Found ${count} matches of the string to replace (${matchLines(text, actualOld)}), but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one, add the lines around it to old_string so that it matches that one only.` };
  }
  const index = text.indexOf(actualOld);
  const result = replaceAll ? text.split(actualOld).join(newStr) : text.slice(0, index) + newStr + text.slice(index + actualOld.length);
  return { result, count, index };
}

// "at lines 12, 40 and 77": where `needle` starts in `text` (the first 10).
function matchLines(text, needle) {
  const lines = [];
  for (let i = text.indexOf(needle); i >= 0 && lines.length < 11; i = text.indexOf(needle, i + needle.length)) {
    lines.push(text.slice(0, i).split('\n').length);
  }
  const shown = lines.slice(0, 10);
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : String(shown[0]);
  return `at line${shown.length > 1 ? 's' : ''} ${list}${lines.length > 10 ? ' and more' : ''}`;
}

// Character bigrams of a string, for a similarity of two lines (Dice coefficient).
function bigrams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
function dice(a, b) {
  let n = 0, total = 0;
  for (const [g, c] of a) { total += c; n += Math.min(c, b.get(g) || 0); }
  for (const c of b.values()) total += c;
  return total ? (2 * n) / total : 0;
}

// The part of `text` most like `oldStr`, for an edit that missed: {from, to, text} (1-based lines, numbered as Read
// numbers them) or null when nothing is alike. Lines of old_string found whole (whitespace aside) vote for where
// it would start; without any, its longest line is looked for by similarity. Most misses are an old_string from
// memory or with other indentation: the right text in the error saves a Read and gets the retry right.
function similarRegion(text, oldStr, maxLines = 14) {
  const lines = text.split('\n');
  const want = oldStr.replace(/\n+$/, '').split('\n');
  if (lines.length > 50_000 || lines.length * want.length > 5_000_000) return null;
  const key = (s) => s.trim();
  const at = new Map();
  lines.forEach((l, i) => { const k = key(l); if (k.length >= 3) { const list = at.get(k); if (list) list.push(i); else at.set(k, [i]); } });
  const votes = new Map();
  want.forEach((l, k) => {
    const hits = at.get(key(l));
    if (hits && hits.length <= 20) for (const i of hits) votes.set(i - k, (votes.get(i - k) || 0) + 1);
  });
  let start = null;
  let best = 0;
  for (const [s, v] of votes) if (v > best || (v === best && s < start)) { best = v; start = s; }
  const meaningful = want.filter((l) => key(l).length >= 3).length;
  if (start === null || best < Math.max(1, Math.ceil(meaningful * 0.3))) {
    const probe = want.map(key).reduce((a, b) => (b.length > a.length ? b : a), '');
    if (probe.length < 6) return null;
    const k = want.findIndex((l) => key(l) === probe);
    const pb = bigrams(probe);
    let score = 0;
    start = null;
    lines.forEach((l, i) => {
      const t = key(l);
      if (!t || t.length > probe.length * 3 || probe.length > t.length * 3) return;
      const s = dice(pb, bigrams(t));
      if (s > score) { score = s; start = i - k; }
    });
    if (start === null || score < 0.5) return null;
  }
  const from = Math.max(0, start - 1);
  const to = Math.min(lines.length - 1, Math.max(from, start + want.length), from + maxLines - 1);
  return { from: from + 1, to: to + 1, text: numberLines(lines.slice(from, to + 1), from + 1, 300) };
}

// The error of an edit whose old_string was not used: where the most similar text is, when it missed, and what to
// do about a file it had not read or that changed since. `step`: "Edit 2 of 3: " in MultiEdit.
function missed(r, text, oldStr, unseen, step = '') {
  let msg = step + r.error;
  if (r.notFound) {
    const near = similarRegion(text, oldStr);
    if (near) {
      msg += ` The most similar text${step && !step.startsWith('Edit 1 ') ? ', in the file as the edits before this one left it,' : ''} is at lines ${near.from}-${near.to}:\n${near.text}\nIf that is the place, copy old_string from these lines exactly (without the line numbers); if not, Read the file.`;
      if (unseen === 'modified') msg += ' (The file has changed since you last read it.)';
      return msg;
    }
    return `${msg} ${unseen ? UNSEEN_HINT[unseen] : 'Read the file to get its exact text.'}`;
  }
  return unseen ? `${msg} ${UNSEEN_HINT[unseen]}` : msg;
}

// The lines an edit left changed in the new text, for its result: "lines 12-18, 40 and 77-80" (from the diff).
function changedRanges(ops, max = 8) {
  const ranges = [];
  let line = 0;
  let removedAt = null;
  for (const op of ops) {
    if (op.op === '-') { removedAt ??= line + 1; continue; }
    line++;
    if (op.op === '+') {
      const last = ranges.at(-1);
      if (last && !last.removed && last.to === line - 1) last.to = line;
      else ranges.push({ from: line, to: line });
      removedAt = null;
    } else if (removedAt !== null) {
      ranges.push({ from: removedAt, to: removedAt, removed: true });
      removedAt = null;
    }
  }
  if (removedAt !== null) ranges.push({ from: removedAt, to: removedAt, removed: true });
  const text = ranges.slice(0, max).map((r) => (r.removed ? `text removed at line ${r.from}` : r.from === r.to ? `line ${r.from}` : `lines ${r.from}-${r.to}`));
  if (ranges.length > max) text.push(`${ranges.length - max} more places`);
  return text.length > 1 ? `${text.slice(0, -1).join(', ')} and ${text.at(-1)}` : text[0] || 'no lines changed';
}

export const EditTool = {
  name: 'Edit',
  editsFiles: true,
  description: `Performs exact string replacements in files.

Usage:
- old_string must be the file's exact current text, so Read the file first unless that text is already in this conversation (a Read, Bash or Grep output, an edit of yours). An edit whose old_string occurs exactly once is made even when the file was not read or has changed since (the result says so); replace_all needs a Read of the file as it is now.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`. When it is not found, the error shows the most similar lines of the file.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- More than one change to a file: make them all in one MultiEdit call, not one Edit per response. Changes to several files: put their Edit or MultiEdit calls in the same response (they are made in the order given). Every response is a round trip that sends the whole conversation again and takes tens of seconds.
- To create a new file, pass an empty old_string with the full content as new_string (the file must not exist).`,
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to modify' },
      old_string: { type: 'string', description: 'The text to replace' },
      new_string: { type: 'string', description: 'The text to replace it with (must be different from old_string)' },
      replace_all: { type: 'boolean', default: false, description: 'Replace all occurrences of old_string (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  summarize(input, ctx) { return displayPath(resolvePath(input.file_path, ctx.cwd), ctx.cwd); },
  filePath(input, ctx) { return resolvePath(input.file_path, ctx.cwd); },
  // Compute the edit without writing. Returns {error} or {file, before, after, ...}.
  plan(input, ctx) {
    const file = resolvePath(input.file_path, ctx.cwd);
    const oldStr = String(input.old_string ?? '').replace(/\r\n/g, '\n');
    const newStr = String(input.new_string ?? '').replace(/\r\n/g, '\n');
    if (!fs.existsSync(file)) {
      if (oldStr !== '') return { error: `File does not exist: ${file}` };
      return { file, created: true, before: '', after: newStr, meta: { crlf: false, bom: false } };
    }
    if (fs.statSync(file).isDirectory()) return { error: `${file} is a directory` };
    // A Read is what shows the model the text it replaces, but an old_string that occurs exactly once in the file
    // as it is now shows it too: text from a Bash or Grep output, its own earlier edit, a Read whose result was
    // cleared, a file one of its commands changed. Such an edit is made, with a note; refusing it cost a Read and a
    // retry (in 70 sessions to 2026-10-26, 117 of 2,781 edits). replace_all has no such proof: it needs the read.
    const unseen = fileStanding(file, ctx);
    if (unseen && input.replace_all) {
      return { error: unseen === 'unread'
        ? 'File has not been read yet. Read it first before replacing every occurrence in it.'
        : 'File has been modified since it was last read, either by the user or by a command. Read it again before replacing every occurrence in it.' };
    }
    const current = readText(file);
    if (!current) return { error: notText(file) };
    if (current.lossy) return { error: notRewritable(file, current) };
    const { text, crlf, bom, encoding } = current;
    const before = text.replace(/\r\n/g, '\n');
    const r = applyEdit(before, oldStr, newStr, !!input.replace_all);
    if (r.error) return { error: missed(r, before, oldStr, unseen) };
    const meta = { crlf, bom, encoding };
    const cannot = unwritable(file, r.result, meta);
    if (cannot) return { error: cannot };
    return { file, before, after: r.result, index: r.index, count: r.count, meta, newStr, unseen };
  },
  validate(input, ctx) { return this.plan(input, ctx).error || null; },
  // `p` is an already computed plan, so call() does not read the file and redo the edit a second time.
  preview(input, ctx, p = this.plan(input, ctx)) {
    if (p.error) return null;
    if (p.created) return { kind: 'create', path: p.file, lines: splitLines(p.after) };
    const ops = diffLines(splitLines(p.before), splitLines(p.after));
    return { kind: 'diff', path: p.file, hunks: makeHunks(ops), ...countChanges(ops) };
  },
  async call(input, ctx) {
    const p = this.plan(input, ctx);
    if (p.error) return { isError: true, content: p.error };
    const preview = this.preview(input, ctx, p);
    const prior = ctx.fileState.get(p.file);
    const hash = writeText(p.file, p.after, p.meta);
    // An edit does not show the rest of the file, so a partial read stays partial (a created file is all ours), and
    // a file edited unread, or changed since it was read, counts as partly seen: Write wants a whole Read of it.
    ctx.fileState.set(p.file, { mtimeMs: mtime(p.file), partial: !p.created && (!prior || Boolean(prior.partial) || p.unseen === 'modified'), hash });
    if (p.created) {
      return { content: `File created successfully at: ${p.file}`, display: { summary: `Created ${displayPath(p.file, ctx.cwd)}`, preview } };
    }
    const line = p.before.slice(0, p.index).split('\n').length;
    const text = input.replace_all
      ? `The file ${p.file} has been updated successfully. All ${p.count} occurrences were replaced.`
      : `The file ${p.file} has been updated successfully (${changedLines(line, p.newStr)}).`;
    return { content: p.unseen ? `${text} ${UNSEEN_NOTE[p.unseen]}` : text, display: { summary: changeSummary(preview), preview } };
  },
};

// Several replacements in one file in one call. GPT models make one Edit per response even when they know several
// changes (2026-10-12..26: 2% of gpt-6.1-sol's responses with an edit had more than one, against 54% of Opus 5.5's;
// 561 times an edit response was followed by another one on the same file), and every response is a round trip of
// some 18 s on GPT that sends the whole conversation again. With all the changes in one call they are one response.
// The edits are applied in order to the text as the previous one left it, and all or none are made.
export const MultiEditTool = {
  name: 'MultiEdit',
  editsFiles: true,
  description: `Makes several exact string replacements in one file in one call. The edits are applied in the order given, each to the text as the previous one left it, and either all of them are made or none (the error says which one failed and why).

Usage:
- Use it whenever you know more than one change to a file, instead of an Edit per change: every response is a round trip that sends the whole conversation again and takes tens of seconds.
- Each edit has old_string, new_string and optionally replace_all, with the rules of Edit: old_string is the exact text to replace (as the edits before it leave the file) and must occur once unless replace_all is set; never include the line number prefix of Read output.
- Order the edits so that an earlier one does not change the text a later one looks for.
- To create a file, use Write (or a first edit with an empty old_string, for a file that does not exist).
- Changes to several files: one MultiEdit or Edit call per file, all in the same response.`,
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to modify' },
      edits: {
        type: 'array',
        minItems: 1,
        description: 'The replacements, made in this order',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'The text to replace' },
            new_string: { type: 'string', description: 'The text to replace it with' },
            replace_all: { type: 'boolean', default: false, description: 'Replace all occurrences of old_string (default false)' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['file_path', 'edits'],
  },
  summarize(input, ctx) {
    const n = Array.isArray(input.edits) ? input.edits.length : 0;
    return `${displayPath(resolvePath(input.file_path, ctx.cwd), ctx.cwd)}${n ? `, ${n} edit${n === 1 ? '' : 's'}` : ''}`;
  },
  filePath(input, ctx) { return resolvePath(input.file_path, ctx.cwd); },
  plan(input, ctx) {
    const file = resolvePath(input.file_path, ctx.cwd);
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (!edits.length) return { error: 'edits must be a non-empty list of {old_string, new_string}.' };
    const steps = edits.map((e) => ({
      oldStr: String(e?.old_string ?? '').replace(/\r\n/g, '\n'),
      newStr: String(e?.new_string ?? '').replace(/\r\n/g, '\n'),
      all: Boolean(e?.replace_all),
    }));
    const exists = fs.existsSync(file);
    let unseen = null;
    let meta = { crlf: false, bom: false, encoding: 'utf8' };
    let before = '';
    if (exists) {
      if (fs.statSync(file).isDirectory()) return { error: `${file} is a directory` };
      unseen = fileStanding(file, ctx); // as in Edit: a unique old_string shows the model has the text it replaces
      if (unseen && steps.some((s) => s.all)) {
        return { error: unseen === 'unread'
          ? 'File has not been read yet. Read it first before replacing every occurrence in it (replace_all).'
          : 'File has been modified since it was last read, either by the user or by a command. Read it again before replacing every occurrence in it (replace_all).' };
      }
      const current = readText(file);
      if (!current) return { error: notText(file) };
      if (current.lossy) return { error: notRewritable(file, current) };
      meta = { crlf: current.crlf, bom: current.bom, encoding: current.encoding };
      before = current.text.replace(/\r\n/g, '\n');
    } else if (steps[0].oldStr !== '') {
      return { error: `File does not exist: ${file}. Create it with Write, or with a first edit whose old_string is empty.` };
    }
    let text = before;
    for (let i = 0; i < steps.length; i++) {
      const { oldStr, newStr, all } = steps[i];
      const r = applyEdit(text, oldStr, newStr, all);
      const step = steps.length > 1 ? `Edit ${i + 1} of ${steps.length}: ` : '';
      if (r.error) return { error: `${missed(r, text, oldStr, unseen, step)}${steps.length > 1 ? ' No edit was made.' : ''}` };
      text = r.result;
    }
    const cannot = unwritable(file, text, meta);
    if (cannot) return { error: cannot };
    return { file, before, after: text, meta, count: steps.length, unseen, created: !exists };
  },
  validate(input, ctx) { return this.plan(input, ctx).error || null; },
  preview(input, ctx, p = this.plan(input, ctx)) { return EditTool.preview(input, ctx, p); },
  async call(input, ctx) {
    const p = this.plan(input, ctx);
    if (p.error) return { isError: true, content: p.error };
    const ops = p.created ? null : diffLines(splitLines(p.before), splitLines(p.after));
    const preview = p.created ? { kind: 'create', path: p.file, lines: splitLines(p.after) } : { kind: 'diff', path: p.file, hunks: makeHunks(ops), ...countChanges(ops) };
    const prior = ctx.fileState.get(p.file);
    const hash = writeText(p.file, p.after, p.meta);
    ctx.fileState.set(p.file, { mtimeMs: mtime(p.file), partial: !p.created && (!prior || Boolean(prior.partial) || p.unseen === 'modified'), hash });
    if (p.created) return { content: `File created successfully at: ${p.file}`, display: { summary: `Created ${displayPath(p.file, ctx.cwd)}`, preview } };
    const text = `The file ${p.file} has been updated successfully: ${p.count} edit${p.count === 1 ? '' : 's'} (${changedRanges(ops)}).`;
    return { content: p.unseen ? `${text} ${UNSEEN_NOTE[p.unseen]}` : text, display: { summary: changeSummary(preview), preview } };
  },
};

// What an edit of a file the model had not read, or that changed since it read it, adds to its result or error.
const UNSEEN_NOTE = {
  unread: '(The file had not been read in this conversation; old_string matched its current text once.)',
  modified: '(The file had changed since you last read it, by a command or someone else; the edit was made on its current text. Read it again if those changes matter.)',
};
const UNSEEN_HINT = {
  unread: 'The file has not been read in this conversation: Read it to get its exact text.',
  modified: 'The file has changed since you last read it: Read it again.',
};
