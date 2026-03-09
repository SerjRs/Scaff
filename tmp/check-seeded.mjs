import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');

const seeded = db.prepare("SELECT COUNT(*) as c FROM cortex_session WHERE issuer = 'memory-seed'").get();
console.log('Seeded rows (from markdown import):', seeded.c);

const organic = db.prepare("SELECT COUNT(*) as c FROM cortex_session WHERE issuer IS NULL OR issuer = ''").get();
console.log('Organic rows (live messages):', organic.c);

// Breakdown by channel
const channels = db.prepare("SELECT channel, issuer, COUNT(*) as c FROM cortex_session GROUP BY channel, issuer ORDER BY channel, issuer").all();
console.log('\nBreakdown:');
channels.forEach(r => console.log(`  ${r.channel} / ${r.issuer || '(organic)'}: ${r.c}`));

// Check: were session JSONL files imported?
const jsonl = db.prepare("SELECT COUNT(*) as c FROM cortex_session WHERE metadata LIKE '%session%' OR metadata LIKE '%jsonl%'").get();
console.log('\nRows mentioning session/jsonl in metadata:', jsonl.c);

// Check what files were seeded
const sources = db.prepare("SELECT DISTINCT json_extract(metadata, '$.source') as src FROM cortex_session WHERE issuer = 'memory-seed'").all();
console.log('\nSeeded source files:');
sources.forEach(r => console.log('  ' + r.src));

// Hot memory count
const hot = db.prepare("SELECT COUNT(*) as c FROM cortex_hot_memory").get();
console.log('\nHot memory facts:', hot.c);

// Cold memory count
const cold = db.prepare("SELECT COUNT(*) as c FROM cortex_cold_memory").get();
console.log('Cold memory facts:', cold.c);

// Total facts
console.log('Total facts (hot+cold):', hot.c + cold.c);

db.close();
