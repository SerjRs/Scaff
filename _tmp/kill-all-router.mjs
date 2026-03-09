import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { homedir } from "node:os";

const dbPath = resolve(homedir(), ".openclaw/router/queue.sqlite");
const db = new DatabaseSync(dbPath);

const r = db.prepare("UPDATE jobs SET status = 'failed' WHERE status NOT IN ('completed', 'failed', 'cancelled')").run();
console.log("Killed", r.changes, "job(s)");

const counts = db.prepare("SELECT status, COUNT(*) as c FROM jobs GROUP BY status").all();
counts.forEach(s => console.log(`  ${s.status}: ${s.c}`));

db.close();
