#!/usr/bin/env node
/**
 * sync-session-to-hippocampus.mjs
 * 
 * Reads the active main agent session JSONL, extracts user + assistant messages,
 * and inserts them into cortex_session so the Gardener can extract facts.
 * 
 * Only runs when shardsEnabled is false (hippocampus mode).
 * Tracks last synced position to avoid duplicates.
 * 
 * Called by HIPPOCAMPUS_REFRESH cron (every 2h) or manually.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const ROOT = process.env.USERPROFILE + '/.openclaw';
const DB_PATH = ROOT + '/cortex/bus.sqlite';
const SESSIONS_DIR = ROOT + '/agents/main/sessions';
const CONFIG_PATH = ROOT + '/workspace/memory/memory-config.json';
const STATE_PATH = ROOT + '/workspace/memory/hippocampus-sync-state.json';

// --- Check config ---
try {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (config.shardsEnabled !== false) {
    console.log('shardsEnabled is not false — skipping sync (markdown mode active)');
    process.exit(0);
  }
} catch (e) {
  console.log('No memory-config.json found — skipping sync');
  process.exit(0);
}

// --- Find active session ---
const sessionFiles = readdirSync(SESSIONS_DIR)
  .filter(f => f.endsWith('.jsonl') && !f.includes('_backup'))
  .map(f => ({ name: f, path: join(SESSIONS_DIR, f), mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (sessionFiles.length === 0) {
  console.log('No session files found');
  process.exit(0);
}

const activeSession = sessionFiles[0];
console.log(`Active session: ${activeSession.name}`);

// --- Load sync state ---
let syncState = { lastSessionId: null, lastLineNumber: 0 };
try {
  syncState = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
} catch (e) {
  // First run
}

// Reset line tracking if session changed
const sessionId = activeSession.name.replace('.jsonl', '');
if (syncState.lastSessionId !== sessionId) {
  console.log(`New session detected (was: ${syncState.lastSessionId})`);
  syncState.lastSessionId = sessionId;
  syncState.lastLineNumber = 0;
}

// --- Read session JSONL ---
const lines = readFileSync(activeSession.path, 'utf8').split('\n').filter(Boolean);
console.log(`Total lines: ${lines.length}, last synced: ${syncState.lastLineNumber}`);

if (lines.length <= syncState.lastLineNumber) {
  console.log('No new lines to sync');
  process.exit(0);
}

// --- Extract user + assistant messages from new lines ---
const newMessages = [];
for (let i = syncState.lastLineNumber; i < lines.length; i++) {
  try {
    const entry = JSON.parse(lines[i]);
    if (entry.type !== 'message') continue;
    
    const role = entry.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    
    // Extract text content
    let text = '';
    const content = entry.message.content;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    }
    
    if (!text || text.length < 5) continue;
    
    // Skip system events, heartbeats, cron triggers
    if (text.startsWith('System:') && (text.includes('HIPPOCAMPUS_REFRESH') || text.includes('gateway'))) continue;
    if (text === 'HEARTBEAT_OK' || text === 'NO_REPLY') continue;
    
    newMessages.push({
      role,
      content: text,
      timestamp: entry.timestamp || new Date().toISOString(),
      lineNumber: i,
    });
  } catch (e) {
    // Skip unparseable lines
  }
}

console.log(`New messages to sync: ${newMessages.length}`);

if (newMessages.length === 0) {
  syncState.lastLineNumber = lines.length;
  writeFileSync(STATE_PATH, JSON.stringify(syncState, null, 2), 'utf8');
  console.log('State updated, nothing to insert');
  process.exit(0);
}

// --- Insert into cortex_session ---
const db = new DatabaseSync(DB_PATH);

const insert = db.prepare(
  `INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

let inserted = 0;
for (const msg of newMessages) {
  const metadata = JSON.stringify({
    source: 'session-sync',
    sessionId,
    lineNumber: msg.lineNumber,
  });
  
  insert.run(
    randomUUID(),
    msg.role,
    'whatsapp',
    msg.role === 'user' ? 'serj' : 'scaff',
    msg.content,
    msg.timestamp,
    metadata,
    'session-sync'
  );
  inserted++;
}

db.close();

// --- Update sync state ---
syncState.lastLineNumber = lines.length;
syncState.lastSyncAt = new Date().toISOString();
syncState.lastInserted = inserted;
writeFileSync(STATE_PATH, JSON.stringify(syncState, null, 2), 'utf8');

console.log(`Inserted ${inserted} messages into cortex_session`);
console.log(`Gardener will extract facts on next run`);
