import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');

const before = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
console.log('Before:', before.c);

// The 24 Gardener-extracted facts are from 2026-03-07T07:20 (extraction run)
// The 926 seeded facts have various timestamps but were inserted later
// Safest: delete everything except the original Gardener-extracted ones
// Those have created_at = '2026-03-07T07:20:14.*' or from the 2026-03-07T09:10 run

// Actually let's check the timestamps
const groups = db.prepare(`
  SELECT substr(created_at, 1, 16) as ts, COUNT(*) as c 
  FROM cortex_hot_memory 
  GROUP BY ts 
  ORDER BY ts
`).all();
console.log('\nTimestamp groups:');
for (const g of groups) {
  console.log(`  ${g.ts}: ${g.c} facts`);
}

db.close();
