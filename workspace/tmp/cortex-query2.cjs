const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const dbPath = path.join(process.env.USERPROFILE, ".openclaw", "cortex", "bus.sqlite");
const db = new DatabaseSync(dbPath);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", tables.map(t => t.name).join(", "));

// Get recent messages from ~17:51 local (15:51 UTC)
for (const tbl of tables.map(t => t.name)) {
  try {
    const count = db.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get();
    console.log(`\n--- ${tbl}: ${count.c} rows ---`);
    const sample = db.prepare(`SELECT * FROM ${tbl} ORDER BY rowid DESC LIMIT 1`).get();
    if (sample) console.log("Columns:", Object.keys(sample).join(", "));
  } catch (e) {
    console.log(`\n--- ${tbl}: error: ${e.message} ---`);
  }
}

db.close();
