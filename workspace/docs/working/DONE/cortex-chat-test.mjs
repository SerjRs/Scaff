/**
 * Send a message through chat.send (Cortex live path) using the built gateway client.
 * 
 * This imports from the compiled dist to get proper auth/handshake handling.
 * 
 * Usage: node cortex-chat-test.mjs "your message here"
 */

import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';

const OPENCLAW_ROOT = path.resolve(import.meta.dirname, '../../..');
const DB_PATH = path.join(OPENCLAW_ROOT, 'cortex', 'bus.sqlite');
const MESSAGE = process.argv[2] || 'Hello from the stress test!';
const SESSION_KEY = 'main:webchat';

function getSessionMsgCount() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const count = db.prepare('SELECT COUNT(*) as c FROM cortex_session').get().c;
  db.close();
  return count;
}

function getHotFactCount() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const count = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get().c;
  db.close();
  return count;
}

function getLatestAssistant() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = db.prepare(
    "SELECT content, timestamp FROM cortex_session WHERE role='assistant' ORDER BY timestamp DESC, id DESC LIMIT 1"
  ).get();
  db.close();
  return row;
}

// Use pnpm openclaw with an internal gateway RPC call
// The "tui" command or direct call through the compiled code
function sendViaCli(message) {
  // Use the gateway call.ts through the compiled entry
  // chat.send needs: sessionKey, message, idempotencyKey
  const idempotencyKey = crypto.randomUUID();
  const paramsJson = JSON.stringify({
    sessionKey: SESSION_KEY,
    message: message,
    idempotencyKey: idempotencyKey,
  });

  // Write a small Node script that uses the compiled gateway client
  const script = `
    const { callGatewayCli } = await import('./dist/call-Ba3LcL7T.js');
    try {
      const result = await callGatewayCli({
        method: 'chat.send',
        params: ${JSON.stringify(JSON.parse(paramsJson))},
        expectFinal: true,
      });
      console.log(JSON.stringify(result));
    } catch (e) {
      console.error('RPC error:', e.message);
    }
  `;
  
  try {
    const result = execSync(`node --input-type=module -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
      cwd: OPENCLAW_ROOT,
      timeout: 120000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (e) {
    return `Error: ${e.stderr?.substring(0, 300) || e.message?.substring(0, 300)}`;
  }
}

// --- Main ---
console.log(`Message: "${MESSAGE.substring(0, 80)}"`);
console.log(`DB: ${DB_PATH}\n`);

const preMsgCount = getSessionMsgCount();
const preHotFacts = getHotFactCount();
const preLatest = getLatestAssistant();
console.log(`Pre-send: ${preMsgCount} session msgs, ${preHotFacts} hot facts`);
console.log(`Latest assistant: "${String(preLatest?.content).substring(0, 80)}"\n`);

console.log('Sending via gateway RPC...');
const result = sendViaCli(MESSAGE);
console.log(`RPC result: ${result}\n`);

// Wait for Cortex to process
console.log('Waiting 15s for Cortex to process...');
execSync('ping -n 16 127.0.0.1 > nul', { stdio: 'ignore' }); // Windows sleep

const postMsgCount = getSessionMsgCount();
const postHotFacts = getHotFactCount();
const postLatest = getLatestAssistant();
console.log(`Post-send: ${postMsgCount} session msgs, ${postHotFacts} hot facts`);
console.log(`New messages: ${postMsgCount - preMsgCount}`);
console.log(`Latest assistant: "${String(postLatest?.content).substring(0, 200)}"`);

if (postMsgCount > preMsgCount) {
  console.log('\n✅ Message went through Cortex — session DB updated!');
} else {
  console.log('\n❌ No new messages in Cortex DB — message did NOT go through Cortex path');
}
