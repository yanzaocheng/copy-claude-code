#!/usr/bin/env node
// Entry point for the claude-pro command; see src/launcher.js.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from '../src/launcher.js';

if (parseInt(process.versions.node, 10) < 18) {
  process.stderr.write(`claude-pro requires Node.js 18 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}

main(process.argv.slice(2), { self: fs.realpathSync(fileURLToPath(import.meta.url)) });
