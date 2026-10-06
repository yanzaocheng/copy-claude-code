#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { shouldSupervise, supervise } from '../src/supervisor.js';

const major = parseInt(process.versions.node, 10);
if (major < 22) {
  process.stderr.write(`claude-pro requires Node.js 22 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);

if (shouldSupervise(argv)) {
  // An interactive session runs as a child of the supervisor, which starts it again when it asks to be
  // restarted (to load changes to its own code). See src/supervisor.js.
  supervise(argv, { entry: fileURLToPath(import.meta.url) }).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`Fatal: ${err?.stack || err}\n`);
      process.exit(1);
    },
  );
} else {
  const { main } = await import('../src/main.js');
  main(argv).then(
    (code) => { process.exitCode = code ?? 0; },
    (err) => {
      process.stderr.write(`Fatal: ${err?.stack || err}\n`);
      process.exit(1);
    },
  );
}
