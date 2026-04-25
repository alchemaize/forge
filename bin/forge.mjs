#!/usr/bin/env node

/**
 * Forge CLI launcher.
 * Runs the TypeScript source directly via tsx — no build step required.
 */

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '..', 'src', 'cli.ts');
const tsxPath = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');

try {
  execFileSync(tsxPath, [cliPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
} catch (err) {
  // tsx already printed the error — just exit with the right code
  process.exit(err.status ?? 1);
}
