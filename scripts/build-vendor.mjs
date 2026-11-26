// Builds what the console's page loads from src/web/vendor/: the code editor (CodeMirror 6, its languages each a
// chunk loaded when a file of that language opens) and the terminal (xterm.js). The page has no build step: these are
// built here once, when a version of them is taken up, and committed; the packages are devDependencies only.
//
//   node scripts/build-vendor.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'web', 'vendor');
const ENTRIES = path.join(ROOT, 'scripts', 'vendor');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const common = { bundle: true, format: 'esm', minify: true, target: 'es2022', legalComments: 'none', logLevel: 'warning', absWorkingDir: ROOT };
await build({ ...common, entryPoints: { codemirror: path.join(ENTRIES, 'codemirror.js') }, outdir: OUT, splitting: true, chunkNames: 'cm-[hash]' });
await build({ ...common, entryPoints: { xterm: path.join(ENTRIES, 'xterm.js') }, outdir: OUT });
fs.copyFileSync(path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), path.join(OUT, 'xterm.css'));

const files = fs.readdirSync(OUT);
const size = files.reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`${files.length} files, ${(size / 1024).toFixed(0)} KB in ${path.relative(ROOT, OUT)}`);
