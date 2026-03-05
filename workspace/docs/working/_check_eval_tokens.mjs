import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.USERPROFILE + "/.openclaw/memory/router-evaluator.sqlite");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", tables.map(t => t.name));

for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
  console.log(`\n${t.name} columns:`, cols.map(c => c.name).join(", "));
  const rows = db.prepare(`SELECT * FROM ${t.name} ORDER BY rowid DESC LIMIT 5`).all();
  for (const r of rows) console.log(r);
}
db.close();
