#!/usr/bin/env node
/**
 * refresh-hippocampus-context.mjs
 * 
 * 1. Syncs current session messages to cortex_session (if shardsEnabled=false)
 * 2. Reads all facts from cortex_hot_memory and writes them to MEMORY.md
 * 
 * Run periodically (cron) or after Gardener extraction.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const ROOT = process.env.USERPROFILE + '/.openclaw';
const DB_PATH = ROOT + '/cortex/bus.sqlite';
const MEMORY_MD = ROOT + '/workspace/MEMORY.md';
const MARKER_START = '## Hippocampus Facts';
const MARKER_END = '<!-- END HIPPOCAMPUS -->';

// Check if hippocampus refresh is enabled
const CONFIG_PATH = ROOT + '/workspace/memory/memory-config.json';
try {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (config.hippocampusRefreshCron === false) {
    console.log('Hippocampus refresh disabled in memory-config.json');
    process.exit(0);
  }
  // If hippocampus mode (shardsEnabled=false), sync session first
  if (config.shardsEnabled === false) {
    console.log('--- Session sync (hippocampus mode) ---');
    try {
      const out = execSync(`node "${ROOT}/scripts/sync-session-to-hippocampus.mjs"`, { encoding: 'utf8', timeout: 30000 });
      console.log(out);
    } catch (e) {
      console.error('Session sync failed:', e.message);
    }
    console.log('--- End session sync ---\n');
  }
} catch (e) {
  // Config missing = default enabled
}

const db = new DatabaseSync(DB_PATH);

// Limit to 200 most relevant facts (recent + high hit count)
const facts = db.prepare(`
  SELECT fact_text, created_at, hit_count 
  FROM cortex_hot_memory 
  ORDER BY hit_count DESC, created_at DESC
  LIMIT 200
`).all();

if (facts.length === 0) {
  console.log('No facts in hot memory.');
  db.close();
  process.exit(0);
}

// Build the facts section
let factsSection = `${MARKER_START}\n`;
factsSection += `*Auto-generated from cortex_hot_memory. ${facts.length} facts. Do not edit manually.*\n\n`;

for (const f of facts) {
  factsSection += `- ${f.fact_text}\n`;
}
factsSection += `\n${MARKER_END}`;

// Read existing MEMORY.md
let memoryContent = readFileSync(MEMORY_MD, 'utf8');

// Replace existing hippocampus section or append
const startIdx = memoryContent.indexOf(MARKER_START);
const endIdx = memoryContent.indexOf(MARKER_END);

if (startIdx !== -1 && endIdx !== -1) {
  // Replace existing section
  memoryContent = memoryContent.substring(0, startIdx) + factsSection + memoryContent.substring(endIdx + MARKER_END.length);
} else {
  // Append
  memoryContent = memoryContent.trimEnd() + '\n\n' + factsSection + '\n';
}

writeFileSync(MEMORY_MD, memoryContent, 'utf8');
console.log(`Written ${facts.length} facts to MEMORY.md (Hippocampus section)`);
db.close();
