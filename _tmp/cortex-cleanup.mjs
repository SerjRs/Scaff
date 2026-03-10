import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('cortex/bus.sqlite');

const before = db.prepare(`SELECT COUNT(*) as cnt FROM cortex_session`).get();
console.log(`Before: ${before.cnt} rows`);

// Delete from corruption point (id >= 4258) onward
const result = db.prepare(`DELETE FROM cortex_session WHERE id >= 4258`).run();
console.log(`Deleted: ${result.changes} rows`);

// Reset active shards that might reference deleted messages
const shardResult = db.prepare(`UPDATE shards SET status = 'closed' WHERE status = 'active'`).run();
console.log(`Closed active shards: ${shardResult.changes}`);

const after = db.prepare(`SELECT COUNT(*) as cnt FROM cortex_session`).get();
console.log(`After: ${after.cnt} rows`);

db.close();
