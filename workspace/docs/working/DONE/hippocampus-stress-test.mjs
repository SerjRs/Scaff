/**
 * Hippocampus Stress Test
 * 
 * Sends fact-laden messages through webchat Cortex path, waits for Gardener
 * extraction, then tests recall accuracy.
 * 
 * Target: ≥20 facts extracted, 80% recall on 10 queries (Milestone 1)
 */

import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OPENCLAW_ROOT = 'C:\\Users\\Temp User\\.openclaw';
const DB_PATH = path.join(OPENCLAW_ROOT, 'cortex', 'bus.sqlite');
const REPORT_PATH = path.join(OPENCLAW_ROOT, 'workspace', 'docs', 'working', 'hippocampus-stress-test-report.md');

// --- Fact-laden messages (each contains 2-3 extractable facts) ---
const SEED_MESSAGES = [
  "I moved to Berlin in 2019 and I've been living there since. My apartment is in Kreuzberg.",
  "My main programming languages are TypeScript and Python. I avoid Java whenever possible.",
  "I drive a Tesla Model 3, white color, bought it in 2023.",
  "My wife's name is Elena and she works as a UX designer at Figma.",
  "We have two cats: Luna and Pixel. Luna is a tabby and Pixel is a black cat.",
  "I use NeoVim as my main editor but VSCode for debugging. My terminal is WezTerm.",
  "My go-to lunch spot is a Vietnamese place called Pho 36 near Kottbusser Tor.",
  "I run 5K every morning at 6:30 AM. My best time is 22 minutes.",
  "Our team uses PostgreSQL for the main database and Redis for caching. We migrated from MongoDB last year.",
  "I'm allergic to shellfish but I love sushi, especially salmon nigiri.",
  "My phone number is +49-170-555-1234 and I prefer Signal over WhatsApp for work.",
  "The project deadline is April 15th. We have a demo with the board on April 10th.",
  "I read mostly sci-fi. My favorite book is Blindsight by Peter Watts. Currently reading Project Hail Mary.",
  "Our AWS bill is around $8000/month. Most of it is EKS and RDS. We're evaluating Fly.io as alternative.",
  "I take melatonin before bed and drink oat milk in my coffee. No sugar.",
];

// --- Recall queries (each should match facts from above) ---
const RECALL_QUERIES = [
  { query: "Where do I live?", expected: ["Berlin", "Kreuzberg"] },
  { query: "What programming languages do I use?", expected: ["TypeScript", "Python"] },
  { query: "What car do I drive?", expected: ["Tesla", "Model 3"] },
  { query: "Tell me about my wife", expected: ["Elena", "UX", "Figma"] },
  { query: "What are my cats' names?", expected: ["Luna", "Pixel"] },
  { query: "What editor do I use?", expected: ["NeoVim", "VSCode"] },
  { query: "What's my running routine?", expected: ["5K", "6:30", "morning"] },
  { query: "What databases does our team use?", expected: ["PostgreSQL", "Redis"] },
  { query: "What food allergies do I have?", expected: ["shellfish"] },
  { query: "When is the project deadline?", expected: ["April 15"] },
];

// --- Helpers ---
function getHotFactCount() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const count = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get().c;
  db.close();
  return count;
}

function getHotFacts() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const facts = db.prepare('SELECT fact_text, created_at FROM cortex_hot_memory ORDER BY created_at ASC').all();
  db.close();
  return facts;
}

function getSessionMsgCount() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const count = db.prepare('SELECT COUNT(*) as c FROM cortex_session').get().c;
  db.close();
  return count;
}

function getLatestAssistant() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = db.prepare(
    "SELECT content, timestamp FROM cortex_session WHERE role='assistant' ORDER BY id DESC LIMIT 1"
  ).get();
  db.close();
  return row;
}

function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
}

function sendMessage(msg) {
  const escaped = msg.replace(/"/g, '`"');
  execSync(
    `powershell -Command "Start-Job { cd '${OPENCLAW_ROOT}'; pnpm openclaw tui --session main:webchat --message \\"${escaped}\\" 2>&1 } | Out-Null; Start-Sleep 20; Get-Job | Stop-Job -PassThru | Remove-Job"`,
    { timeout: 40000, stdio: 'ignore' }
  );
}

function sendAndWaitForResponse(msg) {
  const preMsgCount = getSessionMsgCount();
  sendMessage(msg);
  // Wait up to 30s for response
  for (let i = 0; i < 15; i++) {
    sleep(2000);
    const postCount = getSessionMsgCount();
    if (postCount >= preMsgCount + 2) { // user + assistant
      return getLatestAssistant();
    }
  }
  return getLatestAssistant();
}

// --- Main ---
const startTime = Date.now();
const log = [];

function logMsg(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] ${msg}`);
  log.push(`[${ts}] ${msg}`);
}

logMsg('=== Hippocampus Stress Test ===');
logMsg(`Pre-test: ${getHotFactCount()} hot facts, ${getSessionMsgCount()} session messages`);

// Phase 1: Seed facts
logMsg('\n--- Phase 1: Seeding facts ---');
for (let i = 0; i < SEED_MESSAGES.length; i++) {
  logMsg(`Sending ${i + 1}/${SEED_MESSAGES.length}: "${SEED_MESSAGES[i].substring(0, 50)}..."`);
  try {
    sendMessage(SEED_MESSAGES[i]);
    logMsg(`  ✓ Sent`);
  } catch (e) {
    logMsg(`  ✗ Error: ${e.message?.substring(0, 100)}`);
  }
  // Small gap between messages
  sleep(3000);
}

const postSeedFacts = getHotFactCount();
const postSeedMsgs = getSessionMsgCount();
logMsg(`\nPost-seed: ${postSeedFacts} hot facts, ${postSeedMsgs} session messages`);

// Phase 2: Wait for Gardener extraction (up to 12 min, checking every 60s)
logMsg('\n--- Phase 2: Waiting for Gardener extraction ---');
const preWaitFacts = getHotFactCount();
let extractedFacts = preWaitFacts;
const maxWaitMin = 12;
for (let i = 0; i < maxWaitMin; i++) {
  sleep(60000);
  extractedFacts = getHotFactCount();
  logMsg(`  ${i + 1}min: ${extractedFacts} hot facts`);
  if (extractedFacts >= preWaitFacts + 15) {
    logMsg('  Target reached early!');
    break;
  }
}

logMsg(`\nPost-extraction: ${extractedFacts} hot facts`);
const allFacts = getHotFacts();
logMsg('All facts:');
for (const f of allFacts) {
  logMsg(`  • ${f.fact_text}`);
}

// Phase 3: Recall queries
logMsg('\n--- Phase 3: Recall queries ---');
const results = [];
for (let i = 0; i < RECALL_QUERIES.length; i++) {
  const q = RECALL_QUERIES[i];
  logMsg(`\nQuery ${i + 1}/${RECALL_QUERIES.length}: "${q.query}"`);
  
  const response = sendAndWaitForResponse(q.query);
  const responseText = String(response?.content || '');
  logMsg(`  Response: "${responseText.substring(0, 150)}"`);
  
  // Check if expected keywords are in the response
  const hits = q.expected.filter(kw => responseText.toLowerCase().includes(kw.toLowerCase()));
  const pass = hits.length >= Math.ceil(q.expected.length / 2); // at least half the keywords
  results.push({ query: q.query, expected: q.expected, hits, pass, response: responseText.substring(0, 200) });
  logMsg(`  Expected: [${q.expected.join(', ')}] → Hits: [${hits.join(', ')}] → ${pass ? '✅ PASS' : '❌ FAIL'}`);
  
  sleep(3000);
}

// Phase 4: Report
const passed = results.filter(r => r.pass).length;
const recallRate = Math.round((passed / results.length) * 100);
const elapsed = Math.round((Date.now() - startTime) / 60000);
const finalFacts = getHotFactCount();

logMsg('\n--- Results ---');
logMsg(`Total hot facts: ${finalFacts}`);
logMsg(`Recall: ${passed}/${results.length} (${recallRate}%)`);
logMsg(`Duration: ${elapsed} minutes`);
logMsg(`Target: ≥20 facts, ≥80% recall`);
logMsg(`Verdict: ${finalFacts >= 20 && recallRate >= 80 ? '✅ MILESTONE 1 PASSED' : '❌ MILESTONE 1 NOT MET'}`);

// Write report
const report = `# Hippocampus Stress Test Report
**Date:** ${new Date().toISOString().substring(0, 10)}
**Duration:** ${elapsed} minutes

## Results
- **Hot facts extracted:** ${finalFacts} (target: ≥20)
- **Recall accuracy:** ${passed}/${results.length} = ${recallRate}% (target: ≥80%)
- **Verdict:** ${finalFacts >= 20 && recallRate >= 80 ? '✅ MILESTONE 1 PASSED' : '❌ MILESTONE 1 NOT MET'}

## Facts Extracted
${allFacts.map(f => `- ${f.fact_text}`).join('\n')}

## Recall Queries
| # | Query | Expected | Hits | Result |
|---|-------|----------|------|--------|
${results.map((r, i) => `| ${i + 1} | ${r.query} | ${r.expected.join(', ')} | ${r.hits.join(', ') || 'none'} | ${r.pass ? '✅' : '❌'} |`).join('\n')}

## Log
\`\`\`
${log.join('\n')}
\`\`\`
`;

fs.writeFileSync(REPORT_PATH, report);
logMsg(`\nReport written to ${REPORT_PATH}`);
