import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "fs";

// Find session DB
const dataDir = process.env.USERPROFILE + "/.openclaw/.openclaw-data";
try {
  const files = readdirSync(dataDir);
  console.log("Data dir files:", files.filter(f => f.endsWith(".sqlite")));
} catch { console.log("No .openclaw-data dir"); }

// Check sessions DB
try {
  const db = new DatabaseSync(dataDir + "/sessions.sqlite");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log("Tables:", tables.map(t => t.name));
  
  const rows = db.prepare("SELECT key, json_extract(data, '$.modelOverride') as modelOverride FROM sessions WHERE key LIKE '%router-evaluator%' ORDER BY rowid DESC LIMIT 5").all();
  console.log("Evaluator sessions:", rows);
  db.close();
} catch(e) { console.log("Sessions DB error:", e.message); }

// Also check agents DB
try {
  const db2 = new DatabaseSync(dataDir + "/agents.sqlite");
  const tables2 = db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log("\nAgents DB tables:", tables2.map(t => t.name));
  const rows2 = db2.prepare("SELECT * FROM sessions WHERE key LIKE '%router-evaluator%' ORDER BY rowid DESC LIMIT 3").all();
  for (const r of rows2) {
    console.log({ key: r.key, modelOverride: r.modelOverride || r.model_override });
  }
  db2.close();
} catch(e) { console.log("Agents DB:", e.message); }
