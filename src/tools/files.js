// Read, Write and Edit tools. Edits require that the file was read first and hasn't
// changed on disk since, which prevents the model from clobbering changes it never saw.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, displayPath } from '../utils/paths.js';
import { diffLines, makeHunks, countChanges, splitLines } from '../utils/diff.js';

const MAX_LINES = 10_000;
const MAX_LINE_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 400_000; // a read without offset/limit bigger than this is refused
const HARD_MAX_CHARS = 1_000_000; // never return more than this in one read, even with an explicit limit
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function isBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

// `crlf` is true when CRLF is the file's main line ending. Editing rewrites every line ending, so a
// mostly-LF file with one stray CRLF must stay LF instead of being converted wholesale.
function readText(file, buf = fs.readFileSync(file)) {
  const raw = buf.toString('utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const bareLfCount = (text.match(/\n/g) || []).length - crlfCount;
  return { text, bom: text !== raw, crlf: crlfCount > 0 && crlfCount >= bareLfCount };
}

export function numberLines(lines, start) {
  return lines.map((l, i) => {
    const line = l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '… [line truncated]' : l;
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
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Any lines longer than ${MAX_LINE_CHARS} characters will be truncated
- Results are returned using cat -n format, with line numbers starting at 1
- This tool can read images (PNG, JPG, GIF, WEBP) and Jupyter notebooks (.ipynb)
- This tool can only read files, not directories. To list a directory, use ls via the Bash tool.
- You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.
- If you read a file that exists but has empty contents you will receive a warning in place of file contents.`,
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to read' },
      offset: { type: 'number', description: 'The line number to start reading from. Only provide if the file is too large to read at once' },
      limit: { type: 'number', description: 'The number of lines to read. Only provide if the file is too large to read at once.' },
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
      if (stat.size > 5 * 1024 * 1024) return { isError: true, content: `Image too large (${Math.round(stat.size / 1024)}KB, max 5MB).` };
      const data = fs.readFileSync(file).toString('base64');
      ctx.fileState.set(file, { mtimeMs: stat.mtimeMs });
      return {
        content: [{ type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data } }],
        display: { summary: `Read image (${Math.round(stat.size / 1024)}KB)` },
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
    const buf = fs.readFileSync(file);
    if (isBinary(buf)) return { isError: true, content: `This appears to be a binary file (${stat.size} bytes) and cannot be displayed as text.` };

    const { text } = readText(file, buf);
    const lines = splitLines(text);
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
    const limit = Math.max(1, Math.floor(input.limit || MAX_LINES));
    const slice = lines.slice(start - 1, start - 1 + limit);
    let content = numberLines(slice, start);
    if (content.length > MAX_OUTPUT_CHARS && !input.limit) {
      return { isError: true, content: `File content (${Math.round(content.length / 1024)}KB) exceeds the maximum allowed size. Use the offset and limit parameters to read specific portions of the file, or use the Grep tool to search for specific content.` };
    }
    let cut = false;
    if (content.length > HARD_MAX_CHARS) {
      content = `${content.slice(0, HARD_MAX_CHARS)}\n… [output cut at ${HARD_MAX_CHARS} characters; read a smaller range with offset/limit]`;
      cut = true;
    }
    const end = start + slice.length - 1;
    seen(cut || start > 1 || end < lines.length);
    if (end < lines.length) content += `\n\n(File has ${lines.length} lines total; showing lines ${start}-${end}. Use offset/limit to read more.)`;
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

function writeText(file, text, { crlf, bom }) {
  let out = text;
  if (crlf) out = out.replace(/\r?\n/g, '\r\n');
  if (bom) out = String.fromCharCode(0xfeff) + out;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out, 'utf8');
}

function snippet(content, focusLine, count) {
  const lines = splitLines(content);
  const from = Math.max(0, focusLine - 5);
  const to = Math.min(lines.length, focusLine + count + 4);
  return numberLines(lines.slice(from, to), from + 1);
}

export const WriteTool = {
  name: 'Write',
  editsFiles: true,
  description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer editing an existing file when that is the natural place for a change, but create new files whenever the task needs them (code, tests, scripts, configs, data).
- Do not create documentation files (*.md, READMEs) unless the user asks for them or the task clearly calls for one.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`,
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
      return checkFreshness(file, ctx, { full: true });
    }
    return null;
  },
  preview(input, ctx) {
    const file = resolvePath(input.file_path, ctx.cwd);
    const exists = fs.existsSync(file);
    const newLines = splitLines(input.content);
    if (!exists) return { kind: 'create', path: file, lines: newLines };
    const ops = diffLines(splitLines(readText(file).text), newLines);
    return { kind: 'diff', path: file, hunks: makeHunks(ops), ...countChanges(ops) };
  },
  async call(input, ctx) {
    const err = this.validate(input, ctx);
    if (err) return { isError: true, content: err };
    const file = resolvePath(input.file_path, ctx.cwd);
    const exists = fs.existsSync(file);
    const prev = exists ? readText(file) : { text: '', crlf: false, bom: false };
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
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- Prefer editing existing files when that is the natural place for a change; create new files whenever the task needs them.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
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
    const { text, crlf, bom } = readText(file);
    const before = text.replace(/\r\n/g, '\n');
    const r = applyEdit(before, oldStr, newStr, !!input.replace_all);
    if (r.error) return { error: r.error };
    return { file, before, after: r.result, index: r.index, count: r.count, meta: { crlf, bom }, newStr };
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
      ? `The file ${p.file} has been updated. All ${p.count} occurrences were replaced.`
      : `The file ${p.file} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\n${snippet(p.after, line, splitLines(p.newStr).length)}`;
    return { content: text, display: { summary: changeSummary(preview), preview } };
  },
};
