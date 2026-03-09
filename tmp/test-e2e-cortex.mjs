// End-to-end test: send a webchat message through the Cortex feed
// This simulates exactly what the webchat handler does

import { DatabaseSync } from "node:sqlite";
import { execSync } from "child_process";

const busDb = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/cortex/bus.sqlite");
const routerDb = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/router/queue.sqlite");

// Count current state
const busBefore = busDb.prepare("SELECT COUNT(*) as c FROM cortex_bus").get().c;
const routerBefore = routerDb.prepare("SELECT COUNT(*) as c FROM jobs_archive").get().c;
console.log(`Before: bus=${busBefore}, router_archive=${routerBefore}`);

// Use the CLI to send a webchat message through Cortex
// The 'send' command can target webchat channel
const cli = process.env.USERPROFILE + "/.openclaw/openclaw.mjs";

console.log("\nSending test through webchat channel via CLI...");
try {
  const out = execSync(`node "${cli}" send --channel webchat --message "What is the square root of 144? Reply with just the number."`, { 
    timeout: 15000, encoding: "utf-8", cwd: process.env.USERPROFILE + "/.openclaw" 
  });
  console.log("Send result:", out.trim());
} catch(e) {
  console.log("Send error (might be expected):", e.message?.slice(0, 200));
}

// Wait and poll for changes
console.log("\nWaiting for pipeline...");
const start = Date.now();
while (Date.now() - start < 90000) {
  const busNow = busDb.prepare("SELECT COUNT(*) as c FROM cortex_bus").get().c;
  const routerNow = routerDb.prepare("SELECT COUNT(*) as c FROM jobs_archive").get().c;
  const pendingJobs = routerDb.prepare("SELECT COUNT(*) as c FROM jobs WHERE status IN ('pending','in_queue','in_execution')").get().c;
  
  if (busNow > busBefore || routerNow > routerBefore || pendingJobs > 0) {
    console.log(`\nActivity detected! bus=${busNow} (was ${busBefore}), archive=${routerNow} (was ${routerBefore}), pending=${pendingJobs}`);
    
    // Wait for job to complete
    if (pendingJobs > 0) {
      console.log("Job in pipeline, waiting for completion...");
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    
    if (routerNow > routerBefore) {
      const latest = routerDb.prepare("SELECT id, type, status, tier FROM jobs_archive ORDER BY created_at DESC LIMIT 1").get();
      console.log("Latest job:", JSON.stringify(latest));
    }
    break;
  }
  await new Promise(r => setTimeout(r, 2000));
  process.stdout.write(".");
}

// Final token monitor
console.log("\n\n=== TOKEN MONITOR ===");
const tokens = execSync(`node "${cli}" tokens`, { timeout: 10000, encoding: "utf-8", cwd: process.env.USERPROFILE + "/.openclaw" });
console.log(tokens);

busDb.close();
routerDb.close();
