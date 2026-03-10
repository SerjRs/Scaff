/**
 * Router Stress Test (via Cortex webchat)
 * 
 * Sends messages that require tool use through Cortex → Router path.
 * Verifies tasks complete and results come back.
 */

import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OPENCLAW_ROOT = 'C:\\Users\\Temp User\\.openclaw';
const DB_PATH = path.join(OPENCLAW_ROOT, 'cortex', 'bus.sqlite');
const REPORT_PATH = path.join(OPENCLAW_ROOT, 'workspace', 'docs', 'working', 'router-stress-test-report.md');

// Messages that should trigger Router tasks (tool use)
const TOOL_QUERIES = [
  {
    name: "File read",
    message: "Read the first 5 lines of workspace/SOUL.md and tell me what it says",
    expectInResponse: ["Scaff", "calm", "direct"],
    timeoutSec: 60,
  },
  {
    name: "Web search",
    message: "Search the web for 'Bucharest weather today' and tell me the temperature",
    expectInResponse: ["Bucharest", "°"],
    timeoutSec: 90,
  },
  {
    name: "Simple exec",
    message: "Run 'node --version' and tell me which Node.js version is installed",
    expectInResponse: ["v2", "node", "."],
    timeoutSec: 60,
  },
  {
    name: "Memory recall",
    message: "What do you remember about my cats?",
    expectInResponse: ["Luna", "Pixel"],
    timeoutSec: 60,
  },
  {
    name: "Multi-step reasoning",
    message: "How many files are in the workspace/docs/working/ directory? List them.",
    expectInResponse: ["stress", "test", ".md"],
    timeoutSec: 90,
  },
  {
    name: "File write",
    message: "Create a file at workspace/_router_test_output.txt with the content 'Router works!' and confirm it was created",
    expectInResponse: ["created", "Router works", "wrote"],
    timeoutSec: 60,
  },
  {
    name: "Calendar/time",
    message: "What is today's date and day of the week?",
    expectInResponse: ["March", "2026", "Sunday"],
    timeoutSec: 60,
  },
  {
    name: "Combined memory + tool",
    message: "What's my favorite book? Search the web for a summary of it.",
    expectInResponse: ["Blindsight", "Watts"],
    timeoutSec: 90,
  },
];

// --- Helpers ---
function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
}

function getSessionMsgCount() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const c = db.prepare('SELECT COUNT(*) as c FROM cortex_session').get().c;
  db.close();
  return c;
}

function getLatestAssistantAfter(afterId) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  // Get all assistant messages after the given id
  const rows = db.prepare(
    "SELECT id, content, timestamp FROM cortex_session WHERE role='assistant' AND id > ? ORDER BY id DESC"
  ).all(afterId);
  db.close();
  // Return the latest one, concatenating if there are multiple (tool calls + final)
  if (rows.length === 0) return null;
  // The final response is usually the last assistant message
  return { id: rows[0].id, content: String(rows[0].content), timestamp: rows[0].timestamp };
}

function getMaxId() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = db.prepare("SELECT MAX(id) as maxId FROM cortex_session").get();
  db.close();
  return row.maxId || 0;
}

function sendMessage(msg) {
  const escaped = msg.replace(/"/g, '`"').replace(/'/g, "''");
  execSync(
    `powershell -Command "Start-Job { cd '${OPENCLAW_ROOT}'; pnpm openclaw tui --session main:webchat --message \\"${escaped}\\" 2>&1 } | Out-Null; Start-Sleep 20; Get-Job | Stop-Job -PassThru | Remove-Job"`,
    { timeout: 40000, stdio: 'ignore' }
  );
}

function sendAndWaitForResponse(msg, timeoutSec = 60) {
  const beforeId = getMaxId();
  sendMessage(msg);
  
  // Wait for a non-tool-call assistant response
  const start = Date.now();
  while ((Date.now() - start) < timeoutSec * 1000) {
    sleep(3000);
    const latest = getLatestAssistantAfter(beforeId);
    if (latest && latest.content && !latest.content.startsWith('[Tool]')) {
      return latest.content;
    }
  }
  
  // Return whatever we have
  const latest = getLatestAssistantAfter(beforeId);
  return latest?.content || '[no response]';
}

// --- Main ---
const startTime = Date.now();
const log = [];
const results = [];

function logMsg(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] ${msg}`);
  log.push(`[${ts}] ${msg}`);
}

logMsg('=== Router Stress Test (via Cortex) ===');
logMsg(`Session messages: ${getSessionMsgCount()}`);

for (let i = 0; i < TOOL_QUERIES.length; i++) {
  const q = TOOL_QUERIES[i];
  logMsg(`\n--- Test ${i + 1}/${TOOL_QUERIES.length}: ${q.name} ---`);
  logMsg(`Query: "${q.message.substring(0, 80)}"`);
  
  const response = sendAndWaitForResponse(q.message, q.timeoutSec);
  logMsg(`Response: "${response.substring(0, 200)}"`);
  
  // Check expected keywords (at least 1 hit = pass)
  const hits = q.expectInResponse.filter(kw => response.toLowerCase().includes(kw.toLowerCase()));
  const pass = hits.length >= 1;
  
  results.push({
    name: q.name,
    query: q.message,
    response: response.substring(0, 300),
    expected: q.expectInResponse,
    hits,
    pass,
  });
  
  logMsg(`Expected any of: [${q.expectInResponse.join(', ')}] → Hits: [${hits.join(', ')}] → ${pass ? '✅ PASS' : '❌ FAIL'}`);
  
  sleep(5000); // breathing room between tests
}

// Results
const passed = results.filter(r => r.pass).length;
const total = results.length;
const elapsed = Math.round((Date.now() - startTime) / 60000);

logMsg('\n=== Results ===');
logMsg(`Passed: ${passed}/${total} (${Math.round(passed/total*100)}%)`);
logMsg(`Duration: ${elapsed} minutes`);

// Write report
const report = `# Router Stress Test Report (via Cortex)
**Date:** ${new Date().toISOString().substring(0, 10)}
**Duration:** ${elapsed} minutes

## Results
- **Passed:** ${passed}/${total} (${Math.round(passed/total*100)}%)

## Individual Tests
| # | Test | Result | Hits |
|---|------|--------|------|
${results.map((r, i) => `| ${i+1} | ${r.name} | ${r.pass ? '✅' : '❌'} | ${r.hits.join(', ') || 'none'} |`).join('\n')}

## Details
${results.map((r, i) => `### ${i+1}. ${r.name}
**Query:** ${r.query}
**Response:** ${r.response}
**Expected:** ${r.expected.join(', ')}
**Hits:** ${r.hits.join(', ') || 'none'}
**Result:** ${r.pass ? '✅ PASS' : '❌ FAIL'}
`).join('\n')}

## Log
\`\`\`
${log.join('\n')}
\`\`\`
`;

fs.writeFileSync(REPORT_PATH, report);
logMsg(`Report: ${REPORT_PATH}`);
