import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

// Top facts by hit count
console.log('=== Top 10 facts by hit count ===');
const top = db.prepare('SELECT id, substr(fact_text,1,120) as preview, hit_count, created_at, last_accessed_at FROM cortex_hot_memory ORDER BY hit_count DESC LIMIT 10').all();
for (const f of top) {
  console.log(`  [hits=${f.hit_count}] ${f.preview}`);
  console.log(`    created: ${f.created_at}, last_accessed: ${f.last_accessed_at}`);
}

// Recent facts
console.log('\n=== 10 most recent facts ===');
const recent = db.prepare('SELECT substr(fact_text,1,120) as preview, created_at FROM cortex_hot_memory ORDER BY created_at DESC LIMIT 10').all();
for (const f of recent) {
  console.log(`  [${f.created_at}] ${f.preview}`);
}

// Stats
const total = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
const withHits = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory WHERE hit_count > 0').get();
console.log(`\nTotal facts: ${total.c}, with hits: ${withHits.c}`);

// Session stats
const sessCount = db.prepare('SELECT COUNT(*) as c FROM cortex_session').get();
const channels = db.prepare('SELECT channel, COUNT(*) as c FROM cortex_session GROUP BY channel').all();
console.log(`\nSession rows: ${sessCount.c}`);
for (const ch of channels) console.log(`  ${ch.channel}: ${ch.c}`);

// Channel states
const states = db.prepare('SELECT * FROM cortex_channel_states').all();
console.log('\nChannel states:');
for (const s of states) console.log(`  ${JSON.stringify(s)}`);

db.close();
