import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { homedir } from "node:os";
const db = new DatabaseSync(resolve(homedir(), ".openclaw/router/queue.sqlite"));
// Check both active and archived
const active = db.prepare("SELECT id, status, payload, created_at, finished_at FROM jobs ORDER BY created_at DESC LIMIT 5").all();
const archived = db.prepare("SELECT id, status, payload, created_at, finished_at FROM jobs_archive ORDER BY created_at DESC LIMIT 5").all();
console.log("=== ACTIVE JOBS ===");
active.forEach(r => console.log(`${r.id.slice(0,8)} | ${r.status} | ${r.created_at}\n${r.payload}\n`));
if (!active.length) console.log("None");
console.log("\n=== ARCHIVED JOBS ===");
archived.forEach(r => console.log(`${r.id.slice(0,8)} | ${r.status} | ${r.created_at}\n${r.payload}\n`));
if (!archived.length) console.log("None");
db.close();
