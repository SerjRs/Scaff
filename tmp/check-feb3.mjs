import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// Facts from Feb 3 daily log
const facts = db.prepare(
  `SELECT id, fact_text, source_type, source_ref FROM hippocampus_facts WHERE source_ref LIKE '%2026-02-03%' ORDER BY id`
).all();
console.log(`Facts with source_ref mentioning Feb 3: ${facts.length}`);
facts.forEach(f => console.log(`  [${f.source_type}] ${f.fact_text}`));

// Search for "first day" or "birthday" or "created" or "Feb 3" in fact_text
console.log('\n--- Facts mentioning "first day", "birthday", "born", "Feb 3", "February 3", "2026-02-03" ---');
const search = db.prepare(
  `SELECT id, fact_text, source_type, source_ref FROM hippocampus_facts WHERE fact_text LIKE '%first day%' OR fact_text LIKE '%birthday%' OR fact_text LIKE '%born%' OR fact_text LIKE '%Feb 3%' OR fact_text LIKE '%February 3%' OR fact_text LIKE '%2026-02-03%'`
).all();
console.log(`Found: ${search.length}`);
search.forEach(f => console.log(`  [${f.source_type}|${f.source_ref}] ${f.fact_text}`));

// Check total facts from daily_log source_type for early Feb
console.log('\n--- All daily_log facts with source_ref containing "02-0" (early Feb) ---');
const earlyFeb = db.prepare(
  `SELECT id, fact_text, source_ref FROM hippocampus_facts WHERE source_type = 'daily_log' AND source_ref LIKE '%2026-02-0%' ORDER BY source_ref, id`
).all();
console.log(`Found: ${earlyFeb.length}`);
earlyFeb.forEach(f => console.log(`  [${f.source_ref}] ${f.fact_text}`));
