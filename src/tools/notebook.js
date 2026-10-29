// NotebookEdit: replace, insert or delete a cell of a Jupyter notebook. Like Edit, the
// notebook must have been read first and unchanged on disk since.

import fs from 'node:fs';
import { resolvePath, displayPath } from '../utils/paths.js';
import { checkFreshness, mtime, hashOf } from './files.js';

// Jupyter stores cell source as an array of lines, each keeping its trailing newline.
function toSource(text) {
  const lines = text.split('\n');
  return lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l)).filter((l, i, a) => !(i === a.length - 1 && l === ''));
}

function findCell(nb, id) {
  const cells = nb.cells || [];
  const byId = cells.findIndex((c) => c.id === id);
  if (byId >= 0) return byId;
  const m = /^cell-(\d+)$/.exec(String(id)) || /^(\d+)$/.exec(String(id));
  if (m && +m[1] < cells.length) return +m[1];
  return -1;
}

export const NotebookEditTool = {
  name: 'NotebookEdit',
  editsFiles: true,
  description: `Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing.
- notebook_path must be an absolute path, and the notebook must have been read with Read first.
- cell_id is the id of the cell (or its 0-based index, as in "cell-3"). When inserting, the new cell goes after the cell with this id; omit it to insert at the beginning.
- edit_mode is "replace" (default), "insert" or "delete". cell_type ("code" or "markdown") is required for insert.`,
  input_schema: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'The absolute path to the Jupyter notebook file to edit' },
      cell_id: { type: 'string', description: 'The ID (or "cell-N" index) of the cell to edit' },
      new_source: { type: 'string', description: 'The new source for the cell' },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'The type of the cell (required for insert)' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'The type of edit to make (default: replace)' },
    },
    required: ['notebook_path', 'new_source'],
  },
  summarize(input, ctx) { return displayPath(resolvePath(input.notebook_path, ctx.cwd), ctx.cwd); },
  filePath(input, ctx) { return resolvePath(input.notebook_path, ctx.cwd); },
  validate(input, ctx) {
    const file = resolvePath(input.notebook_path, ctx.cwd);
    if (!file.endsWith('.ipynb')) return 'File must be a Jupyter notebook (.ipynb file). For other file types, use the Edit tool.';
    if (!fs.existsSync(file)) return `Notebook does not exist: ${file}`;
    if ((input.edit_mode || 'replace') === 'insert' && !input.cell_type) return 'cell_type is required when edit_mode is insert.';
    return checkFreshness(file, ctx);
  },
  async call(input, ctx) {
    const err = this.validate(input, ctx);
    if (err) return { isError: true, content: err };
    const file = resolvePath(input.notebook_path, ctx.cwd);
    let nb;
    let bom = false; // a BOM in front made the notebook unreadable here; it is kept when the notebook is written
    try {
      const text = fs.readFileSync(file, 'utf8');
      bom = text.startsWith('\uFEFF');
      nb = JSON.parse(bom ? text.slice(1) : text);
    } catch (e) { return { isError: true, content: `Could not parse notebook: ${e.message}` }; }
    nb.cells ||= [];
    const mode = input.edit_mode || 'replace';
    let summary;
    if (mode === 'insert') {
      let at = 0;
      if (input.cell_id !== undefined && input.cell_id !== '') {
        const i = findCell(nb, input.cell_id);
        if (i < 0) return { isError: true, content: `Cell not found: ${input.cell_id}` };
        at = i + 1;
      }
      const cell = { cell_type: input.cell_type, id: Math.random().toString(36).slice(2, 10), metadata: {}, source: toSource(input.new_source) };
      if (input.cell_type === 'code') { cell.execution_count = null; cell.outputs = []; }
      nb.cells.splice(at, 0, cell);
      summary = `Inserted cell ${cell.id} at position ${at}`;
    } else {
      const i = findCell(nb, input.cell_id);
      if (i < 0) return { isError: true, content: `Cell not found: ${input.cell_id ?? '(no cell_id given)'}` };
      if (mode === 'delete') {
        nb.cells.splice(i, 1);
        summary = `Deleted cell ${input.cell_id}`;
      } else {
        const cell = nb.cells[i];
        cell.source = toSource(input.new_source);
        if (input.cell_type && input.cell_type !== cell.cell_type) {
          cell.cell_type = input.cell_type;
          if (input.cell_type === 'code') { cell.execution_count = null; cell.outputs = []; } else { delete cell.execution_count; delete cell.outputs; }
        }
        if (cell.cell_type === 'code') { cell.execution_count = null; cell.outputs = []; }
        summary = `Updated cell ${input.cell_id}`;
      }
    }
    const out = Buffer.from(`${bom ? '\uFEFF' : ''}${JSON.stringify(nb, null, 1)}\n`, 'utf8');
    fs.writeFileSync(file, out);
    // with its hash, as after a Read: a later change of its time alone (a sync, a scan) is not taken for an edit
    ctx.fileState.set(file, { mtimeMs: mtime(file), hash: hashOf(out) });
    return { content: summary, display: { summary } };
  },
};
