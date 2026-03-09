import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { homedir } from "node:os";

const dbPath = resolve(homedir(), ".openclaw/router/queue.sqlite");
const db = new DatabaseSync(dbPath);

// Get all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", tables.map(t => t.name).join(", "));

// Check each status
const statuses = db.prepare("SELECT status, COUNT(*) as c FROM jobs GROUP BY status ORDER BY status").all();
console.log("\nJob counts by status:");
statuses.forEach(s => console.log(`  ${s.status}: ${s.c}`));

// Any non-terminal jobs
const active = db.prepare("SELECT id, status, created_at, substr(payload, 1, 150) as preview FROM jobs WHERE status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at DESC LIMIT 10").all();
if (active.length === 0) {
  console.log("\nNo in-flight jobs. All clear.");
} else {
  console.log(`\n${active.length} in-flight job(s):`);
  active.forEach(j => console.log(`  ${j.id} [${j.status}] ${j.created_at}\n    ${j.preview}`));
}

// Check cortex bus too
const busPath = resolve(homedir(), ".openclaw/cortex/bus.sqlite");
const busDb = new DatabaseSync(busPath);
const pending = busDb.prepare("SELECT COUNT(*) as c FROM cortex_bus WHERE status = 'pending'").get();
const processing = busDb.prepare("SELECT COUNT(*) as c FROM cortex_bus WHERE status = 'processing'").get();
console.log(`\nCortex bus: ${pending.c} pending, ${processing.c} processing`);
busDb.close();

db.close();
