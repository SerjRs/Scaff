import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// Remove stress test results, ephemeral observations, one-off data
const noise = db.prepare(`
  DELETE FROM cortex_hot_memory 
  WHERE fact_text LIKE 'Task %:%'
  OR fact_text LIKE 'Task % difficulty:%'
  OR fact_text LIKE 'Week %:%'
  OR fact_text LIKE 'Opus Task%'
  OR fact_text LIKE '%Peter Steinberger%'
  OR fact_text LIKE '%Vignesh Natarajan%'
  OR fact_text LIKE '%Shadow has%commits%'
  OR fact_text LIKE '%Top 10 contributors%'
  OR fact_text LIKE '%~450 contributors%'
  OR fact_text LIKE '%delivery pipeline score%'
  OR fact_text LIKE '%llm-caller.ts%'
  OR fact_text LIKE '%User inbound WhatsApp message at%'
  OR fact_text LIKE '%Cortex outbound WhatsApp reply%'
  OR fact_text LIKE '%User is currently writing%'
  OR fact_text LIKE '%User testing message%'
  OR fact_text LIKE '%WhatsApp channel was initially empty%'
  OR fact_text LIKE '%After restart, WhatsApp inbound%'
  OR fact_text LIKE '%date and time output%'
  OR fact_text LIKE '%Memory directory has not been%'
  OR fact_text LIKE '%User asked Cortex to read%'
  OR fact_text LIKE '%User instructed Cortex to write%'
  OR fact_text LIKE '%Critical finding:%'
  OR fact_text LIKE '%14 reliability findings%'
  OR fact_text LIKE '%fix:feat ratio%'
  OR fact_text LIKE '%Security hardening%'
`).run();
console.log(`Deleted ${noise.changes} noise facts`);

const remaining = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
console.log(`Remaining: ${remaining.c} facts`);

const facts = db.prepare('SELECT fact_text FROM cortex_hot_memory ORDER BY created_at').all();
for (const f of facts) console.log(`  • ${f.fact_text}`);

db.close();
