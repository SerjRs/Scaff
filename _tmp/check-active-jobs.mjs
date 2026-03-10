import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { homedir } from "node:os";
const db = new DatabaseSync(resolve(homedir(), ".openclaw/router/queue.sqlite"));
const rows = db.prepare("SELECT id, status, substr(payload,1,400) as p, created_at FROM jobs WHERE status IN ('in_execution','pending','in_queue') ORDER BY created_at DESC LIMIT 5").all();
rows.forEach(r => console.log(`${r.id.slice(0,8)} | ${r.status} | ${r.created_at}\n${r.p}\n`));
if (!rows.length) console.log("No active jobs");
db.close();
