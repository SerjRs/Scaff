import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// Remove facts that are clearly noise
const noise = db.prepare(`
  DELETE FROM cortex_hot_memory 
  WHERE fact_text LIKE 'Task dispatched with TASK_ID%'
  OR fact_text LIKE 'Task % (Difficulty %): %'
  OR fact_text LIKE '%httpbin.org%'
  OR fact_text LIKE '%UUID%from httpbin%'
  OR fact_text LIKE '2^16%'
  OR fact_text LIKE '%Prime numbers%'
  OR fact_text LIKE '%Hexadecimal 0x%'
  OR fact_text LIKE 'A task with ID %'
  OR fact_text LIKE '%User-Agent string%'
  OR fact_text LIKE '%origin IP address%'
`).run();
console.log(`Deleted ${noise.changes} noise facts`);

const remaining = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
console.log(`Remaining: ${remaining.c} facts`);

// Show what's left
const facts = db.prepare('SELECT fact_text FROM cortex_hot_memory ORDER BY created_at').all();
for (const f of facts) console.log(`  • ${f.fact_text}`);

db.close();
