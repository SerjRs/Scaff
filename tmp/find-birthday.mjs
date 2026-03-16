import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

// Search for birthday-related facts
const queries = ['%February 3%', '%Feb 3%', '%2026-02-03%', '%birthday%', '%born%', '%creation date%'];
for (const q of queries) {
  const rows = db.prepare(`SELECT fact_text, source_type FROM hippocampus_facts WHERE fact_text LIKE ?`).all(q);
  if (rows.length > 0) {
    console.log(`\n=== "${q}" (${rows.length} results) ===`);
    for (const r of rows) {
      console.log(`  [${r.source_type}] ${r.fact_text.slice(0, 150)}`);
    }
  } else {
    console.log(`"${q}" — no results`);
  }
}
