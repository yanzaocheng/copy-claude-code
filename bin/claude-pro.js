#!/usr/bin/env node
import { main } from '../src/main.js';

const major = parseInt(process.versions.node, 10);
if (major < 22) {
  process.stderr.write(`claude-pro requires Node.js 22 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0; },
  (err) => {
    process.stderr.write(`Fatal: ${err?.stack || err}\n`);
    process.exit(1);
  },
);
