import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

const db = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/router/queue.sqlite");

// Enqueue a simple test job
const id = crypto.randomUUID();
const payload = JSON.stringify({ message: "Test task: what is 2+2?", context: "{}" });
db.prepare(`INSERT INTO jobs (id, type, status, payload, issuer, created_at, updated_at, retry_count)
  VALUES (?, 'agent_run', 'pending', ?, 'test-scaff', datetime('now'), datetime('now'), 0)`)
  .run(id, payload);

console.log(`Enqueued job ${id}`);

// Poll for completion
const start = Date.now();
while (Date.now() - start < 60000) {
  const job = db.prepare("SELECT id, status, tier, weight FROM jobs WHERE id = ?").get(id);
  if (!job) {
    const archived = db.prepare("SELECT id, status, tier FROM jobs_archive WHERE id = ?").get(id);
    if (archived) {
      console.log(`Archived: status=${archived.status} tier=${archived.tier}`);
      break;
    }
  } else {
    if (job.status === "completed" || job.status === "failed") {
      console.log(`Done: status=${job.status} tier=${job.tier} weight=${job.weight}`);
      break;
    }
  }
  await new Promise(r => setTimeout(r, 1000));
}

// Check token monitor for evaluator
console.log("\nChecking for router-evaluator activity...");
const evalJobs = db.prepare("SELECT id, tier, status FROM jobs_archive WHERE created_at > datetime('now', '-2 minutes') ORDER BY created_at DESC LIMIT 5").all();
console.log("Recent archived:", JSON.stringify(evalJobs, null, 2));

db.close();
