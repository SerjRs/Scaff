#!/usr/bin/env node
/**
 * Nightly code indexer — wrapper for code-index.mjs
 * 
 * Designed to run unattended via cron at 3 AM.
 * Runs incremental index, logs results to memory/nightly-index.log
 */

import { execSync } from 'child_process';
import { writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LOG_PATH = resolve(ROOT, 'workspace', 'memory', 'nightly-index.log');

const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);

try {
  mkdirSync(dirname(LOG_PATH), { recursive: true });

  // Run incremental index
  const out = execSync(`node "${resolve(__dirname, 'code-index.mjs')}"`, {
    cwd: ROOT,
    timeout: 600_000, // 10 min max
    encoding: 'utf-8',
    env: { ...process.env },
  });

  appendFileSync(LOG_PATH, `[${ts}] OK\n${out.trim()}\n\n`);

  // Print summary for cron output
  console.log(`[nightly-code-index] ${ts} — done`);
  console.log(out.trim());
} catch (err) {
  const msg = err.stderr || err.message || String(err);
  appendFileSync(LOG_PATH, `[${ts}] FAIL\n${msg}\n\n`);
  console.error(`[nightly-code-index] ${ts} — failed: ${msg}`);
  process.exit(1);
}
