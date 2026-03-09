import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

const before = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
console.log(`Before purge: ${before.c} facts`);

// Delete all facts — we'll re-extract with the better prompt
db.prepare('DELETE FROM cortex_hot_memory').run();

const after = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
console.log(`After purge: ${after.c} facts`);

db.close();
console.log('Done. Hot memory purged.');
