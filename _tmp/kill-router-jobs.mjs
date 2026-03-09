import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { homedir } from "node:os";

const dbPath = resolve(homedir(), ".openclaw/router/queue.sqlite");
const db = new DatabaseSync(dbPath);

// Find active jobs
const active = db.prepare("SELECT id, status, created_at, substr(payload, 1, 120) as preview FROM jobs WHERE status IN ('pending', 'in_execution') ORDER BY id DESC").all();

if (active.length === 0) {
  console.log("No active router jobs.");
} else {
  console.log(`Found ${active.length} active job(s):`);
  active.forEach(j => console.log(`  ${j.id} [${j.status}] ${j.created_at} ${j.preview}`));

  // Kill them by setting status to failed
  const kill = db.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('pending', 'in_execution')");
  const result = kill.run();
  console.log(`\nKilled ${result.changes} job(s).`);
}

db.close();
