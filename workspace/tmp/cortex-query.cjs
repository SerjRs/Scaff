const { DatabaseSync } = require("node:sqlite");
const path = require("path");

// Find the cortex DB
const busPath = path.join(process.env.USERPROFILE, ".openclaw", "bus.sqlite");
const db = new DatabaseSync(busPath);

// List tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", tables.map(t => t.name).join(", "));

// Find cortex session table
const cortexTables = tables.filter(t => t.name.includes("cortex"));
if (cortexTables.length > 0) {
  console.log("\nCortex tables:", cortexTables.map(t => t.name).join(", "));
}

// Try different possible table names
for (const tbl of ["cortex_session", "cortex_messages", "messages", "session"]) {
  try {
    const count = db.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get();
    console.log(`\n${tbl}: ${count.c} rows`);
    const recent = db.prepare(`SELECT * FROM ${tbl} ORDER BY rowid DESC LIMIT 1`).get();
    console.log("Columns:", Object.keys(recent).join(", "));
  } catch {}
}

db.close();
