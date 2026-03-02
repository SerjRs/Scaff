/**
 * Hippocampus Integration Test
 * 
 * Sends messages to Cortex via gateway RPC, then queries the SQLite DB
 * to verify fact extraction and hot memory population.
 * 
 * Usage: node hippocampus-test.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { createConnection } from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GATEWAY_PORT = 18789;
const DB_PATH = path.resolve(import.meta.dirname, '../../../cortex/bus.sqlite');

// ---------------------------------------------------------------------------
// Gateway RPC
// ---------------------------------------------------------------------------

function callGateway(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    
    const socket = createConnection({ port: GATEWAY_PORT, host: '127.0.0.1' }, () => {
      const httpReq = [
        `POST /rpc HTTP/1.1`,
        `Host: 127.0.0.1:${GATEWAY_PORT}`,
        `Content-Type: application/json`,
        `Content-Length: ${Buffer.byteLength(payload)}`,
        `Connection: close`,
        '',
        payload,
      ].join('\r\n');
      socket.write(httpReq);
    });

    let data = '';
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => {
      try {
        const bodyStart = data.indexOf('\r\n\r\n');
        const body = bodyStart >= 0 ? data.slice(bodyStart + 4) : data;
        const parsed = JSON.parse(body);
        if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
        else resolve(parsed.result);
      } catch (e) {
        reject(new Error(`Failed to parse response: ${e.message}\nRaw: ${data.substring(0, 500)}`));
      }
    });
    socket.on('error', reject);
    socket.setTimeout(30000, () => { socket.destroy(); reject(new Error('timeout')); });
  });
}

async function sendMessage(message) {
  const result = await callGateway('agent', {
    message,
    idempotencyKey: crypto.randomUUID(),
  });
  return result;
}

// ---------------------------------------------------------------------------
// DB Queries
// ---------------------------------------------------------------------------

function getHotMemoryFacts(db) {
  try {
    return db.prepare('SELECT * FROM cortex_hot_memory ORDER BY hit_count DESC, last_accessed_at DESC').all();
  } catch (e) {
    return [];
  }
}

function getSessionMessageCount(db) {
  return db.prepare('SELECT COUNT(*) as c FROM cortex_session').get().c;
}

function getRecentMessages(db, limit = 5) {
  return db.prepare('SELECT role, channel, content, timestamp FROM cortex_session ORDER BY timestamp DESC, id DESC LIMIT ?').all(limit);
}

function getChannelStates(db) {
  return db.prepare('SELECT * FROM cortex_channel_states').all();
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

function printSection(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

function printDbState(db) {
  const msgCount = getSessionMessageCount(db);
  const facts = getHotMemoryFacts(db);
  const channels = getChannelStates(db);
  const recent = getRecentMessages(db, 3);

  console.log(`\n📊 DB State:`);
  console.log(`   Session messages: ${msgCount}`);
  console.log(`   Hot memory facts: ${facts.length}`);
  console.log(`   Channel states: ${channels.length}`);
  
  if (facts.length > 0) {
    console.log(`\n🧠 Hot Memory:`);
    for (const f of facts.slice(0, 10)) {
      console.log(`   [hits=${f.hit_count}] ${String(f.fact_text).substring(0, 80)}`);
    }
  }
  
  console.log(`\n💬 Recent messages:`);
  for (const m of recent.reverse()) {
    const text = String(m.content).substring(0, 80);
    console.log(`   [${m.role}@${m.channel}] ${text}`);
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  printSection('INITIAL STATE');
  printDbState(db);

  // Phase 1: Send conversation with memorable facts
  printSection('PHASE 1: Seeding Facts');

  const factMessages = [
    "Hey, I want to tell you something important: my favorite programming language is Rust and I started learning it in January 2026.",
    "Also, our production server runs on a machine called DianaE, it's a Windows box with 32GB RAM.",
    "One more thing: we use Anthropic Claude as our main LLM provider, and our monthly budget for API calls is around $200.",
  ];

  for (const msg of factMessages) {
    console.log(`\n→ Sending: "${msg.substring(0, 60)}..."`);
    try {
      const result = await sendMessage(msg);
      console.log(`← Status: ${result?.status ?? 'unknown'}`);
    } catch (e) {
      console.log(`← Error: ${e.message}`);
    }
    await sleep(3000); // Give Cortex time to process
  }

  printSection('STATE AFTER SEEDING');
  printDbState(db);

  // Phase 2: Wait for Gardener (if it runs on a schedule)
  printSection('PHASE 2: Checking Gardener');
  console.log('Waiting 10s for any gardener activity...');
  await sleep(10000);
  printDbState(db);

  // Phase 3: Test recall
  printSection('PHASE 3: Testing Recall');

  const recallQueries = [
    "What's my favorite programming language?",
    "What's the name of our production server?",
    "How much is our monthly LLM budget?",
  ];

  for (const q of recallQueries) {
    console.log(`\n→ Asking: "${q}"`);
    try {
      const result = await sendMessage(q);
      console.log(`← Status: ${result?.status ?? 'unknown'}`);
    } catch (e) {
      console.log(`← Error: ${e.message}`);
    }
    await sleep(5000);
  }

  printSection('FINAL STATE');
  printDbState(db);

  // Summary
  printSection('SUMMARY');
  const finalFacts = getHotMemoryFacts(db);
  const finalMsgCount = getSessionMessageCount(db);
  console.log(`Messages in session: ${finalMsgCount}`);
  console.log(`Facts in hot memory: ${finalFacts.length}`);
  console.log(`\nMilestone 1 checklist:`);
  console.log(`  [${finalFacts.length > 0 ? '✅' : '❌'}] Gardener extracted facts`);
  console.log(`  [${finalFacts.length >= 20 ? '✅' : '❌'}] ≥20 facts in hot memory (got ${finalFacts.length})`);
  console.log(`  [ ] memory_query returns relevant results (manual check needed)`);
  console.log(`  [ ] Cold storage round-trip (needs vector eviction cycle)`);

  db.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
