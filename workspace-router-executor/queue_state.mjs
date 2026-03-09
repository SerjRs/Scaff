import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const dbPath = 'C:\\Users\\Temp User\\.openclaw\\router-jobs.db';

if (!existsSync(dbPath)) {
  console.log(JSON.stringify({ error: 'DB file not found' }));
  process.exit(0);
}

const db = new DatabaseSync(dbPath);
const now = Date.now();

console.log('=== QUEUE STATE ===');

// Status counts
try {
  const statuses = db.prepare(`SELECT status, COUNT(*) as count FROM jobs GROUP BY status ORDER BY count DESC`).all();
  console.log('Status distribution:', JSON.stringify(statuses));

  const total = db.prepare(`SELECT COUNT(*) as count FROM jobs`).get();
  console.log('Total jobs in queue:', total.count);

  // Stuck jobs (pending/running for > 10 minutes)
  const stuckThreshold = now - 10 * 60 * 1000;
  const stuck = db.prepare(
    `SELECT id, status, tier, created_at, started_at FROM jobs WHERE status IN ('pending','running') AND created_at < ? ORDER BY created_at ASC`
  ).all(stuckThreshold);
  console.log('Stuck jobs (>10min):', JSON.stringify(stuck));

  // Oldest unarchived jobs
  const old = db.prepare(
    `SELECT id, status, tier, created_at FROM jobs WHERE status='completed' ORDER BY created_at ASC LIMIT 5`
  ).all();
  console.log('Old completed (unarchived):', JSON.stringify(old));

  // Recent jobs
  const recent = db.prepare(
    `SELECT id, status, tier, created_at FROM jobs ORDER BY created_at DESC LIMIT 10`
  ).all();
  console.log('Recent jobs:', JSON.stringify(recent));
} catch (e) {
  console.log('Queue query error:', e.message);
}
