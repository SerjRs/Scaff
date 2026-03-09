import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const dbPath = 'C:\\Users\\Temp User\\.openclaw\\router-jobs.db';

if (!existsSync(dbPath)) {
  console.log(JSON.stringify({ error: 'DB file not found' }));
  process.exit(0);
}

const db = new DatabaseSync(dbPath);

console.log('=== ARCHIVE ANALYSIS ===');

// Check if archive table exists
const archiveExists = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='jobs_archive'`
).get();

if (!archiveExists) {
  console.log('jobs_archive table: NOT FOUND');

  // Try alternate names
  const allTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
  console.log('All tables:', JSON.stringify(allTables.map(t => t.name)));
  process.exit(0);
}

try {
  const total = db.prepare(`SELECT COUNT(*) as count FROM jobs_archive`).get();
  console.log('Total archived jobs:', total.count);

  const byStatus = db.prepare(`SELECT status, COUNT(*) as count FROM jobs_archive GROUP BY status ORDER BY count DESC`).all();
  console.log('By status:', JSON.stringify(byStatus));

  const byTier = db.prepare(`SELECT tier, COUNT(*) as count FROM jobs_archive GROUP BY tier ORDER BY count DESC`).all();
  console.log('By tier:', JSON.stringify(byTier));

  // Average execution time (completed_at - started_at if columns exist)
  const cols = db.prepare(`PRAGMA table_info(jobs_archive)`).all().map(c => c.name);
  console.log('Archive columns:', JSON.stringify(cols));

  if (cols.includes('started_at') && cols.includes('completed_at')) {
    const timing = db.prepare(
      `SELECT AVG(completed_at - started_at) as avg_ms, MIN(completed_at - started_at) as min_ms, MAX(completed_at - started_at) as max_ms
       FROM jobs_archive WHERE status='completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL`
    ).get();
    console.log('Execution timing (ms):', JSON.stringify(timing));
  } else if (cols.includes('duration_ms')) {
    const timing = db.prepare(
      `SELECT AVG(duration_ms) as avg_ms, MIN(duration_ms) as min_ms, MAX(duration_ms) as max_ms
       FROM jobs_archive WHERE status='completed'`
    ).get();
    console.log('Execution timing (ms):', JSON.stringify(timing));
  }

  // Success/failure ratio
  const success = db.prepare(`SELECT COUNT(*) as count FROM jobs_archive WHERE status='completed'`).get();
  const failure = db.prepare(`SELECT COUNT(*) as count FROM jobs_archive WHERE status='failed'`).get();
  const ratio = total.count > 0 ? ((success.count / total.count) * 100).toFixed(1) : 'N/A';
  console.log('Success/Failure:', JSON.stringify({ success: success.count, failure: failure.count, successRatePct: ratio }));

  // Most recent archived jobs
  const recent = db.prepare(`SELECT * FROM jobs_archive ORDER BY rowid DESC LIMIT 5`).all();
  console.log('Recent archived:', JSON.stringify(recent));

} catch (e) {
  console.log('Archive query error:', e.message);
}
