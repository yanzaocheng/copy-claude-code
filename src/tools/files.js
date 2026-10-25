// Read, Write and Edit tools. Edits require that the file was read first and hasn't
// changed on disk since, which prevents the model from clobbering changes it never saw.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, displayPath } from '../utils/paths.js';
import { diffLines, makeHunks, countChanges, splitLines } from '../utils/diff.js';
import { fitImage } from '../utils/images.js';
import { decodeText, encodeText, encodingName } from '../utils/encoding.js';

const MAX_LINES = 10_000;
const MAX_LINE_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 400_000; // a read without offset/limit bigger than this is refused
const HARD_MAX_CHARS = 400_000; // never return more than this in one read (about 100k tokens), even with an explicit limit
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

export function numberLines(lines, start, maxLineChars = MAX_LINE_CHARS) {
  return lines.map((l, i) => {
    const line = l.length > maxLineChars ? l.slice(0, maxLineChars) + '… [line truncated]' : l;
    return `${String(start + i).padStart(6)}\t${line}`;
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
- A file whose numbered text is longer than ${MAX_OUTPUT_CHARS} characters is refused (or cut there with offset/limit). When you need a large file whole, in one call, pass allow_large: true: then there is no line, character or line length limit, only the room left in the context, and a read that does not fit is refused.
- Results are returned using cat -n format, with line numbers starting at 1
- This tool can read images (PNG, JPG, GIF, WEBP) and Jupyter notebooks (.ipynb)
- This tool can only read files, not directories. To list a directory, use ls via the Bash tool.
- Do not read a file again just to check an edit you made to it: Edit and Write report an error when they fail.
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
        const nb = JSON.parse(fs.readFileSync(file, 'utf8'));
        ctx.fileState.set(file, { mtimeMs: stat.mtimeMs });
        return { content: renderNotebook(nb), display: { summary: `Read ${(nb.cells || []).length} cells` } };
      } catch (e) {
        return { isError: true, content: `Could not parse notebook: ${e.message}` };
      }
    }
    const decoded = readText(file, fs.readFileSync(file));
    if (!decoded) return { isError: true, content: `This appears to be a binary file (${stat.size} bytes) and cannot be displayed as text.` };
    const note = encodingNote(decoded);
    const lines = splitLines(decoded.text);
    // `partial` records that part of the file was not shown, so Write can refuse to overwrite it.
    const seen = (partial) => ctx.fileState.set(file, { mtimeMs: stat.mtimeMs, partial });
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
    } else if (content.length > MAX_OUTPUT_CHARS && !input.limit) {
      return { isError: true, content: `File content (${Math.round(content.length / 1024)}KB) exceeds the maximum allowed size. Use the offset and limit parameters to read specific portions of the file, or use the Grep tool to search for specific content. If you need the whole file at once, pass allow_large: true.` };
    }
    let cut = false;
    let end = start + slice.length - 1;
    if (!large && content.length > HARD_MAX_CHARS) {
      const kept = content.slice(0, HARD_MAX_CHARS);
      const whole = kept.endsWith('\n'); // the cut fell between two lines
      end = start + (kept.match(/\n/g) || []).length - (whole ? 1 : 0); // the last line shown
      content = `${kept}${whole ? '' : '\n'}… [output cut at ${HARD_MAX_CHARS} characters: line ${end} is the last one shown${whole ? '' : ', and only in part'}; read on from there with offset/limit, or pass allow_large: true to read it all at once]`;
      cut = true;
    }
    seen(cut || start > 1 || end < lines.length);
    if (end < lines.length) content += `\n\n(File has ${lines.length} lines total; showing lines ${start}-${end}. Use offset/limit to read more.)`;
    content += note;
    return { content, display: { summary: `Read ${slice.length} line${slice.length === 1 ? '' : 's'}` } };
  },
};

// Validate that a file may be written: it must have been read and be unchanged since. With
// `full`, which Write needs because it replaces the whole file, the read must also have covered
// all of it; Edit only replaces text it matched exactly, so a partial read is enough there.
export function checkFreshness(file, ctx, { full = false } = {}) {
  const state = ctx.fileState.get(file);
  if (!state) return 'File has not been read yet. Read it first before writing to it.';
  if (full && state.partial) {
    return 'File was only partly read (offset/limit), so Write would overwrite content you have not seen. Read the whole file first, or use Edit for targeted changes.';
  }
  const now = mtime(file);
  if (now !== null && state.mtimeMs !== undefined && Math.abs(now - state.mtimeMs) > 1) {
    return 'File has been modified since it was last read, either by the user or by a linter. Read it again before attempting to write it.';
  }
  return null;
}

// In the encoding, BOM and line endings the file had (`meta`, from readText); checked with unwritable() first.
function writeText(file, text, { crlf, bom, encoding = 'utf8' }) {
  const { buffer, error } = encodeText(crlf ? text.replace(/\r?\n/g, '\r\n') : text, { encoding, bom });
  if (error) throw new Error(`${file}: ${error}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
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
    writeText(file, input.content, prev);
    ctx.fileState.set(file, { mtimeMs: mtime(file) });
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

// Apply old->new replacement to text. Returns {result, count, index} or {error}.
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
      return { error: 'String to replace not found exactly (whitespace differs at line ends). Read the file again and copy the text exactly, including whitespace.' };
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
  if (count === 0) return { error: `String to replace not found in file.\nString: ${oldStr}` };
  if (count > 1 && !replaceAll) {
    return { error: `Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldStr}` };
  }
  const index = text.indexOf(actualOld);
  const result = replaceAll ? text.split(actualOld).join(newStr) : text.slice(0, index) + newStr + text.slice(index + actualOld.length);
  return { result, count, index };
}

export const EditTool = {
  name: 'Edit',
  editsFiles: true,
  description: `Performs exact string replacements in files.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing (a Grep result does not count). This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
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
    const fresh = checkFreshness(file, ctx);
    if (fresh) return { error: fresh };
    const current = readText(file);
    if (!current) return { error: notText(file) };
    if (current.lossy) return { error: notRewritable(file, current) };
    const { text, crlf, bom, encoding } = current;
    const before = text.replace(/\r\n/g, '\n');
    const r = applyEdit(before, oldStr, newStr, !!input.replace_all);
    if (r.error) return { error: r.error };
    const meta = { crlf, bom, encoding };
    const cannot = unwritable(file, r.result, meta);
    if (cannot) return { error: cannot };
    return { file, before, after: r.result, index: r.index, count: r.count, meta, newStr };
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
    writeText(p.file, p.after, p.meta);
    // An edit does not show the rest of the file, so a partial read stays partial (a created file is all ours).
    ctx.fileState.set(p.file, { mtimeMs: mtime(p.file), partial: !p.created && !!prior?.partial });
    if (p.created) {
      return { content: `File created successfully at: ${p.file}`, display: { summary: `Created ${displayPath(p.file, ctx.cwd)}`, preview } };
    }
    const line = p.before.slice(0, p.index).split('\n').length;
    const text = input.replace_all
      ? `The file ${p.file} has been updated successfully. All ${p.count} occurrences were replaced.`
      : `The file ${p.file} has been updated successfully (${changedLines(line, p.newStr)}).`;
    return { content: text, display: { summary: changeSummary(preview), preview } };
  },
};
