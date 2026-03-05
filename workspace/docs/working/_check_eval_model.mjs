import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/router/queue.sqlite");

// Check schema
const cols = db.prepare("PRAGMA table_info(jobs_archive)").all();
console.log("Columns:", cols.map(c => c.name).join(", "));

// Get recent jobs
const rows = db.prepare("SELECT * FROM jobs_archive ORDER BY rowid DESC LIMIT 5").all();
for (const r of rows) {
  console.log("\n---");
  for (const [k, v] of Object.entries(r)) {
    if (k === 'result' && v) {
      try {
        const parsed = JSON.parse(v);
        console.log("  result.evaluation:", JSON.stringify(parsed.evaluation, null, 2));
      } catch { console.log(`  ${k}: [parse error]`); }
    } else if (typeof v === 'string' && v.length > 100) {
      console.log(`  ${k}: ${v.slice(0, 100)}...`);
    } else {
      console.log(`  ${k}: ${v}`);
    }
  }
}
db.close();
