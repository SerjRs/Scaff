import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

const busDb = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/cortex/bus.sqlite");

// Inject a test message into the cortex bus  
const id = crypto.randomUUID();
const envelope = JSON.stringify({
  id,
  channel: "webchat",
  sender: { id: "test-user", name: "Test", relationship: "partner" },
  timestamp: new Date().toISOString(),
  replyContext: { channel: "webchat", messageId: id },
  content: "Research what SQLite WAL mode is and explain in 2 sentences",
  priority: "normal"
});

busDb.prepare("INSERT INTO cortex_bus (id, envelope, state, priority, enqueued_at, attempts) VALUES (?, ?, 'pending', 1, ?, 0)")
  .run(id, envelope, new Date().toISOString());

console.log(`Injected message ${id} into cortex bus`);

// Poll for processing
const start = Date.now();
while (Date.now() - start < 90000) {
  const row = busDb.prepare("SELECT state, processed_at, error FROM cortex_bus WHERE id = ?").get(id);
  if (row && row.state !== "pending") {
    console.log(`State: ${row.state}, processed: ${row.processed_at}, error: ${row.error || 'none'}`);
    break;
  }
  await new Promise(r => setTimeout(r, 2000));
  process.stdout.write(".");
}

// Check token monitor
const { execSync } = await import("child_process");
const cli = process.env.USERPROFILE + "/.openclaw/openclaw.mjs";
console.log("\n\n=== TOKEN MONITOR ===");
const tokens = execSync(`node "${cli}" tokens`, { timeout: 10000, encoding: "utf-8", cwd: process.env.USERPROFILE + "/.openclaw" });
console.log(tokens);

// Check router queue
const routerDb = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/router/queue.sqlite");
const recentJobs = routerDb.prepare("SELECT id, type, status, tier FROM jobs UNION ALL SELECT id, type, status, tier FROM jobs_archive WHERE created_at > datetime('now', '-2 minutes') ORDER BY 1 DESC LIMIT 5").all();
console.log("=== Recent router jobs ===");
console.log(JSON.stringify(recentJobs, null, 2));

busDb.close();
routerDb.close();
