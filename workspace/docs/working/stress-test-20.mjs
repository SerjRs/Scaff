#!/usr/bin/env node
// Stress test: 20 tasks, 5 phases, varying delays
// Uses `openclaw agent` to dispatch through the gateway/Router
// Each task runs in a separate child process for parallel execution

import { spawn } from "child_process";
import { writeFileSync, mkdirSync } from "fs";

const OPENCLAW = `${process.env.USERPROFILE}\\.openclaw\\openclaw.mjs`;
const RESULTS_DIR = `${process.env.USERPROFILE}\\.openclaw\\workspace\\docs\\working\\stress-results`;

const tasks = [
  // Phase 1: Warm-up (easy-medium, no-tool heavy)
  { phase: 1, id: "T01", msg: "What is the capital of Romania?" },
  { phase: 1, id: "T02", msg: "List the files in the workspace root directory" },
  { phase: 1, id: "T03", msg: "What are the three laws of thermodynamics? Explain each in one sentence." },
  { phase: 1, id: "T04", msg: "Read the file workspace/SOUL.md and summarize who Scaff is" },

  // Phase 2: Medium load (+12s)
  { phase: 2, id: "T05", msg: "Explain the CAP theorem and give a real-world example for each tradeoff" },
  { phase: 2, id: "T06", msg: "Run git log --oneline -10 in this repo and summarize what the last 10 commits were about" },
  { phase: 2, id: "T07", msg: "What is 17 to the power of 4 plus 23 cubed minus 891? Show your work step by step." },
  { phase: 2, id: "T08", msg: "Read workspace/MEMORY.md and list all open items that are not yet completed" },
  { phase: 2, id: "T09", msg: "Write a haiku about distributed systems then explain why each line fits" },

  // Phase 3: Heavy (+25s)
  { phase: 3, id: "T10", msg: "Read src/cortex/loop.ts and explain the ops-trigger flow when a Router task completes. Be detailed." },
  { phase: 3, id: "T11", msg: "Compare event sourcing vs CQRS: when would you use one without the other? Give text architecture diagrams." },
  { phase: 3, id: "T12", msg: "Run git diff HEAD~5 --stat and analyze which areas of the codebase changed most. Identify patterns." },
  { phase: 3, id: "T13", msg: "Explain the Byzantine Generals Problem and its relationship to blockchain consensus. Be thorough." },

  // Phase 4: Burst (+8s, rapid fire mixed)
  { phase: 4, id: "T14", msg: "What time is it in Tokyo right now?" },
  { phase: 4, id: "T15", msg: "Read src/router/gateway-integration.ts and explain how the executor extracts the final result from payloads." },
  { phase: 4, id: "T16", msg: "List all test files under src/cortex/__tests__/ and briefly describe what each tests based on filename" },
  { phase: 4, id: "T17", msg: "Write a short TypeScript function that debounces async calls with a sliding window. Include types." },

  // Phase 5: Final wave (+18s)
  { phase: 5, id: "T18", msg: "Read workspace/docs/working/ACTIVE-ISSUES.md and give a status report: how many fixed, open, next priority?" },
  { phase: 5, id: "T19", msg: "Analyze tradeoffs between SQLite WAL mode vs journal mode for concurrent read-heavy write-light workloads." },
  { phase: 5, id: "T20", msg: "Run Get-Process node and analyze resource usage of node processes on this machine" },
];

const phaseDelays = { 1: 0, 2: 12, 3: 25, 4: 8, 5: 18 };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dispatchTask(task) {
  return new Promise((resolve) => {
    const start = Date.now();
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] 🚀 ${task.id} dispatching...`);

    const child = spawn("node", [
      OPENCLAW, "agent",
      "-m", task.msg,
      "--session-id", `stress-${task.id.toLowerCase()}`,
      "--json",
      "--timeout", "120"
    ], {
      cwd: `${process.env.USERPROFILE}\\.openclaw`,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);

    child.on("close", (code) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const ts2 = new Date().toISOString().slice(11, 19);
      let resultLen = 0;
      let weight = "?";
      try {
        const parsed = JSON.parse(stdout);
        resultLen = (parsed.text ?? parsed.result ?? stdout).length;
        weight = parsed.weight ?? "?";
      } catch {
        resultLen = stdout.length;
      }

      const status = code === 0 ? "✅" : "❌";
      console.log(`[${ts2}] ${status} ${task.id} done in ${elapsed}s (${resultLen} chars, exit=${code})`);

      // Save individual result
      try {
        writeFileSync(`${RESULTS_DIR}/${task.id}.json`, JSON.stringify({
          id: task.id, phase: task.phase, msg: task.msg,
          exitCode: code, elapsed: parseFloat(elapsed), resultLen,
          stdout: stdout.slice(0, 5000), stderr: stderr.slice(0, 1000),
        }, null, 2));
      } catch {}

      resolve({ id: task.id, phase: task.phase, code, elapsed: parseFloat(elapsed), resultLen });
    });

    // Safety timeout
    setTimeout(() => { try { child.kill(); } catch {} }, 130000);
  });
}

async function main() {
  try { mkdirSync(RESULTS_DIR, { recursive: true }); } catch {}
  console.log("=== Stress Test: 20 Tasks, 5 Phases ===\n");
  const startTime = Date.now();
  const allPromises = [];

  for (let phase = 1; phase <= 5; phase++) {
    const delay = phaseDelays[phase];
    if (delay > 0) {
      console.log(`\n⏳ Waiting ${delay}s before Phase ${phase}...`);
      await sleep(delay * 1000);
    }

    const phaseTasks = tasks.filter(t => t.phase === phase);
    console.log(`\n=== Phase ${phase}: ${phaseTasks.length} tasks ===`);

    // Launch all tasks in this phase in parallel with small jitter
    for (const task of phaseTasks) {
      const jitter = Math.floor(Math.random() * 1500);
      await sleep(jitter);
      allPromises.push(dispatchTask(task));
    }
  }

  console.log("\n⏳ Waiting for all tasks to complete...\n");
  const results = await Promise.all(allPromises);

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const succeeded = results.filter(r => r.code === 0);
  const failed = results.filter(r => r.code !== 0);
  const truncated = succeeded.filter(r => r.resultLen < 100);

  console.log("\n========================================");
  console.log("=== FINAL REPORT ===");
  console.log("========================================");
  console.log(`Total time:  ${totalElapsed}s`);
  console.log(`Succeeded:   ${succeeded.length}/20`);
  console.log(`Failed:      ${failed.length}/20`);
  console.log(`Truncated:   ${truncated.length}/20 (< 100 chars)`);
  console.log(`\nPer-task breakdown:`);

  for (const r of results.sort((a, b) => a.id.localeCompare(b.id))) {
    const icon = r.code === 0 ? "✅" : "❌";
    const warn = r.resultLen < 100 ? " ⚠️ SHORT" : "";
    console.log(`  ${icon} ${r.id} (phase ${r.phase}): ${r.elapsed}s, ${r.resultLen} chars${warn}`);
  }

  // Save summary
  writeFileSync(`${RESULTS_DIR}/SUMMARY.json`, JSON.stringify({ totalElapsed, results }, null, 2));
  console.log(`\nDetailed results saved to: ${RESULTS_DIR}/`);
}

main().catch(console.error);
