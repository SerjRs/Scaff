/**
 * Cortex Tool Stress Test v2
 * 10 tasks of varying difficulty, sent via TUI (webchat channel) → Cortex → Router
 * Monitors cortex_session DB for results
 */
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';

const DB_PATH = 'C:\\Users\\Temp User\\.openclaw\\cortex\\bus.sqlite';
const CWD = 'C:\\Users\\Temp User\\.openclaw';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getMaxId() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const r = db.prepare('SELECT MAX(id) as m FROM cortex_session').get();
  db.close();
  return r.m || 0;
}

function getNewEntries(afterId) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare('SELECT id, role, channel, content FROM cortex_session WHERE id > ? ORDER BY id ASC').all(afterId);
  db.close();
  return rows;
}

function send(msg) {
  try {
    execSync(`pnpm openclaw tui --session "main:webchat" --message "${msg.replace(/"/g, '\\"')}"`, {
      cwd: CWD, timeout: 60000, stdio: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' }
    });
  } catch {}
}

async function waitForResult(afterId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(5000);
    const entries = getNewEntries(afterId);
    const assistants = entries.filter(e => e.role === 'assistant' && e.channel === 'webchat' && e.content && e.content.length > 30);
    // Skip spawn acks — look for relay of actual results
    for (const a of assistants) {
      const c = a.content;
      if (c.startsWith('[Tool] sessions_spawn') && c.length < 300 && !c.includes('\n\n')) continue;
      if (c === '[silence]') continue;
      return { ok: true, content: c, elapsed: Date.now() - start };
    }
    // After 80s accept any non-trivial assistant response
    if (Date.now() - start > 80000 && assistants.length > 0) {
      const last = assistants[assistants.length - 1];
      return { ok: true, content: last.content, elapsed: Date.now() - start, late: true };
    }
  }
  const entries = getNewEntries(afterId);
  return { ok: false, entries, elapsed: Date.now() - start };
}

const tests = [
  // Easy - pure knowledge (no tool needed)
  { name: '1. Knowledge (easy)', msg: 'What is the capital of Romania?', expect: ['Bucharest'], needsTool: false },
  // Easy - file read
  { name: '2. File read (easy)', msg: 'Read workspace/SOUL.md and tell me the first 3 lines.', expect: ['SOUL', 'Scaff', 'calm'], needsTool: true },
  // Easy - shell exec
  { name: '3. Shell exec (easy)', msg: 'Run: echo STRESS_TEST_OK and return the output.', expect: ['STRESS_TEST_OK'], needsTool: true },
  // Medium - web search
  { name: '4. Web search (medium)', msg: 'Search the web for Bucharest weather today and tell me the temperature.', expect: ['Bucharest', 'weather', '°', 'temp'], needsTool: true },
  // Medium - file write + verify
  { name: '5. Write + verify (medium)', msg: 'Write "STRESS_V2_PASS" to workspace/_stress_v2.txt, then read it back and confirm the content matches.', expect: ['STRESS_V2_PASS', 'confirm', 'match'], needsTool: true },
  // Medium - exec with output parsing
  { name: '6. Exec + parse (medium)', msg: 'Run: node -e "console.log(JSON.stringify({test:true,time:Date.now()}))" and parse the JSON output. Tell me the value of the test field.', expect: ['true'], needsTool: true },
  // Medium - directory listing
  { name: '7. Dir listing (medium)', msg: 'List all files in workspace/docs/working/ directory and tell me how many there are.', expect: ['cortex', 'stress', 'goal'], needsTool: true },
  // Hard - multi-step: read + reason
  { name: '8. Read + reason (hard)', msg: 'Read workspace/SOUL.md and workspace/USER.md, then tell me what personality the AI has and what the user does for work.', expect: ['Scaff', 'calm', 'architect', 'Software'], needsTool: true },
  // Hard - exec chain
  { name: '9. Exec chain (hard)', msg: 'Run "hostname" and "node --version", then combine the results into one sentence.', expect: ['DIANAE', 'Diana', 'v2', 'node'], needsTool: true },
  // Hard - web search + synthesis
  { name: '10. Search + synthesize (hard)', msg: 'Search the web for "Claude 4 Anthropic 2026" and summarize what you find in 2-3 sentences.', expect: ['Claude', 'Anthropic', 'model', 'AI'], needsTool: true },
];

async function main() {
  const startTime = new Date();
  console.log('=== Cortex Tool Stress Test v2 ===');
  console.log(`Started: ${startTime.toLocaleString('en-GB', { timeZone: 'Europe/Bucharest' })}`);
  console.log(`Tests: ${tests.length}\n`);

  const results = [];

  for (const t of tests) {
    console.log(`--- ${t.name} ---`);
    console.log(`  Q: "${t.msg.substring(0, 90)}${t.msg.length > 90 ? '...' : ''}"`);

    const beforeId = getMaxId();
    send(t.msg);
    console.log(`  Sent. Waiting...`);

    const result = await waitForResult(beforeId);

    if (!result.ok) {
      console.log(`  ✗ TIMEOUT (${Math.round(result.elapsed / 1000)}s)`);
      // Show what we got
      for (const e of (result.entries || []).slice(0, 5)) {
        console.log(`    [${e.role}/${e.channel}] ${(e.content || '').substring(0, 120)}`);
      }
      results.push({ ...t, pass: false, reason: 'timeout', elapsed: result.elapsed });
    } else {
      const hits = t.expect.filter(kw => result.content.toLowerCase().includes(kw.toLowerCase()));
      const pass = hits.length > 0;
      console.log(`  ${pass ? '✓' : '✗'} (${Math.round(result.elapsed / 1000)}s) hits=[${hits.join(',')}]${result.late ? ' (late)' : ''}`);
      console.log(`  A: "${result.content.substring(0, 180)}${result.content.length > 180 ? '...' : ''}"`);
      results.push({ ...t, pass, hits, elapsed: result.elapsed, response: result.content });
    }
    console.log();
    await sleep(3000);
  }

  // Summary
  const endTime = new Date();
  const duration = Math.round((endTime - startTime) / 60000);
  const passed = results.filter(r => r.pass).length;
  const toolTests = results.filter(r => r.needsTool);
  const toolPassed = toolTests.filter(r => r.pass).length;

  console.log('=== SUMMARY ===');
  console.log(`Total: ${passed}/${results.length} passed (${Math.round(passed/results.length*100)}%)`);
  console.log(`Tool tasks: ${toolPassed}/${toolTests.length} passed`);
  console.log(`Duration: ${duration} minutes`);
  console.log();
  for (const r of results) {
    const time = Math.round(r.elapsed / 1000);
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name} (${time}s)${r.reason ? ` — ${r.reason}` : ''}`);
  }
  console.log(`\nFinished: ${endTime.toLocaleString('en-GB', { timeZone: 'Europe/Bucharest' })}`);

  // Write report
  let report = `# Cortex Tool Stress Test v2 Report\n`;
  report += `**Date:** ${startTime.toISOString().split('T')[0]}\n`;
  report += `**Duration:** ${duration} minutes\n`;
  report += `**Passed:** ${passed}/${results.length} (${Math.round(passed/results.length*100)}%)\n`;
  report += `**Tool tasks:** ${toolPassed}/${toolTests.length}\n\n`;
  report += `## Results\n`;
  report += `| # | Test | Tool? | Time | Result |\n|---|------|-------|------|--------|\n`;
  for (const r of results) {
    report += `| ${r.name.split('.')[0]} | ${r.name.split('. ')[1]} | ${r.needsTool ? 'yes' : 'no'} | ${Math.round(r.elapsed/1000)}s | ${r.pass ? '✅' : '❌'} |\n`;
  }
  report += `\n## Details\n`;
  for (const r of results) {
    report += `### ${r.name}\n`;
    report += `**Query:** ${r.msg}\n`;
    report += `**Result:** ${r.pass ? '✅ PASS' : '❌ FAIL'}${r.reason ? ` (${r.reason})` : ''}\n`;
    report += `**Time:** ${Math.round(r.elapsed/1000)}s\n`;
    if (r.response) report += `**Response:** ${r.response.substring(0, 300)}\n`;
    if (r.hits) report += `**Hits:** ${r.hits.join(', ')}\n`;
    report += `\n`;
  }

  const fs = await import('node:fs');
  fs.writeFileSync('C:\\Users\\Temp User\\.openclaw\\workspace\\docs\\working\\cortex-tool-stress-v2-report.md', report);
  console.log('\nReport written to docs/working/cortex-tool-stress-v2-report.md');
}

main().catch(console.error);
