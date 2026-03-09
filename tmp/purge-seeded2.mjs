import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');

// Keep only Gardener-extracted facts (07:20 and 19:15 runs on Mar 7)
const keep = db.prepare(`
  SELECT COUNT(*) as c FROM cortex_hot_memory 
  WHERE created_at LIKE '2026-03-07T07:20%' OR created_at LIKE '2026-03-07T19:15%'
`).get();
console.log('Keeping:', keep.c, 'Gardener-extracted facts');

const result = db.prepare(`
  DELETE FROM cortex_hot_memory 
  WHERE created_at NOT LIKE '2026-03-07T07:20%' AND created_at NOT LIKE '2026-03-07T19:15%'
`).run();
console.log('Deleted:', result.changes);

const after = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
console.log('Remaining:', after.c);

db.close();
