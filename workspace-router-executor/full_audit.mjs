import { DatabaseSync } from 'node:sqlite';

const dbPath = 'C:\\Users\\Temp User\\.openclaw\\router\\queue.sqlite';
const db = new DatabaseSync(dbPath);
const now = Date.now();

// ==================== SCHEMA VALIDATION ====================
console.log('\n===== STEP 1: SCHEMA VALIDATION =====');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
const journalMode = db.prepare('PRAGMA journal_mode').get();
const pageSize = db.prepare('PRAGMA page_size').get();
const pageCount = db.prepare('PRAGMA page_count').get();
const dbSizeBytes = pageSize.page_size * pageCount.page_count;

console.log('Tables found:', tables.map(t => t.name));
console.log('Journal mode:', journalMode.journal_mode);
console.log('DB size:', (dbSizeBytes / 1024).toFixed(1), 'KB');

const expectedTables = ['jobs', 'jobs_archive'];
const missingTables = expectedTables.filter(t => !tables.map(r => r.name).includes(t));
console.log('Schema valid:', missingTables.length === 0 ? '✅' : `❌ Missing: ${missingTables}`);

for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
  const idxs = db.prepare(`PRAGMA index_list(${t.name})`).all();
  console.log(`\n[TABLE: ${t.name}]`);
  console.log('  columns:', cols.map(c => `${c.name}(${c.type})`).join(', '));
  console.log('  indexes:', idxs.map(i => i.name).join(', ') || 'none');
}

// ==================== QUEUE STATE ====================
console.log('\n===== STEP 2: QUEUE STATE =====');
const statuses = db.prepare('SELECT status, COUNT(*) as cnt FROM jobs GROUP BY status ORDER BY cnt DESC').all();
const totalJobs = db.prepare('SELECT COUNT(*) as cnt FROM jobs').get();
console.log('Total active jobs:', totalJobs.cnt);
console.log('Status breakdown:', JSON.stringify(statuses));

// Stuck jobs: in_queue or running for > 10 minutes (using ISO timestamps)
const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
const stuck = db.prepare(
  `SELECT id, status, tier, type, issuer, created_at, started_at, retry_count 
   FROM jobs 
   WHERE status IN ('in_queue','running','pending') AND created_at < ?
   ORDER BY created_at ASC`
).all(tenMinAgo.replace('T', ' ').replace('Z', ''));
console.log('Stuck jobs (>10min old, still active):', stuck.length);
if (stuck.length > 0) {
  stuck.forEach(j => console.log('  STUCK:', JSON.stringify(j)));
}

// Jobs by tier
const byTier = db.prepare('SELECT tier, COUNT(*) as cnt FROM jobs GROUP BY tier ORDER BY cnt DESC').all();
console.log('Jobs by tier:', JSON.stringify(byTier));

// Failed jobs in queue
const failed = db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE status='failed'").get();
console.log('Failed jobs still in queue:', failed.cnt);

// Old completed (unarchived) jobs
const oldCompleted = db.prepare(
  `SELECT id, status, tier, created_at FROM jobs WHERE status='completed' ORDER BY created_at ASC LIMIT 10`
).all();
console.log('Unarchived completed jobs:', oldCompleted.length, JSON.stringify(oldCompleted));

// Recent jobs sample
const recent = db.prepare('SELECT id, type, status, tier, created_at FROM jobs ORDER BY rowid DESC LIMIT 5').all();
console.log('Most recent jobs:', JSON.stringify(recent));

// ==================== ARCHIVE ANALYSIS ====================
console.log('\n===== STEP 3: ARCHIVE ANALYSIS =====');
const archiveTotal = db.prepare('SELECT COUNT(*) as cnt FROM jobs_archive').get();
console.log('Total archived jobs:', archiveTotal.cnt);

const archiveByStatus = db.prepare('SELECT status, COUNT(*) as cnt FROM jobs_archive GROUP BY status ORDER BY cnt DESC').all();
console.log('Archive by status:', JSON.stringify(archiveByStatus));

const archiveByTier = db.prepare('SELECT tier, COUNT(*) as cnt FROM jobs_archive GROUP BY tier ORDER BY cnt DESC').all();
console.log('Archive by tier:', JSON.stringify(archiveByTier));

const archiveByType = db.prepare('SELECT type, COUNT(*) as cnt FROM jobs_archive GROUP BY type ORDER BY cnt DESC').all();
console.log('Archive by type:', JSON.stringify(archiveByType));

// Execution time from started_at and finished_at
const timing = db.prepare(`
  SELECT 
    COUNT(*) as cnt,
    AVG((julianday(finished_at) - julianday(started_at)) * 86400 * 1000) as avg_ms,
    MIN((julianday(finished_at) - julianday(started_at)) * 86400 * 1000) as min_ms,
    MAX((julianday(finished_at) - julianday(started_at)) * 86400 * 1000) as max_ms
  FROM jobs_archive 
  WHERE status='completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL
`).get();
console.log('Completed job timing (ms):', JSON.stringify({
  count: timing.cnt,
  avg_ms: timing.avg_ms ? timing.avg_ms.toFixed(0) : null,
  min_ms: timing.min_ms ? timing.min_ms.toFixed(0) : null,
  max_ms: timing.max_ms ? timing.max_ms.toFixed(0) : null
}));

// Success vs failure ratio
const archSuccess = db.prepare("SELECT COUNT(*) as cnt FROM jobs_archive WHERE status='completed'").get();
const archFailed = db.prepare("SELECT COUNT(*) as cnt FROM jobs_archive WHERE status='failed'").get();
const archRetry = db.prepare("SELECT AVG(retry_count) as avg FROM jobs_archive WHERE status='completed'").get();
const successRate = archiveTotal.cnt > 0 ? ((archSuccess.cnt / archiveTotal.cnt) * 100).toFixed(1) : 'N/A';
console.log('Success/Failure:', JSON.stringify({
  success: archSuccess.cnt,
  failed: archFailed.cnt,
  other: archiveTotal.cnt - archSuccess.cnt - archFailed.cnt,
  successRatePct: successRate,
  avgRetries: archRetry.avg ? archRetry.avg.toFixed(2) : 0
}));

// Archival rate over time (last 24h, 7d)
const oneDayAgo = new Date(now - 24*60*60*1000).toISOString().replace('T', ' ').replace('Z', '');
const sevenDaysAgo = new Date(now - 7*24*60*60*1000).toISOString().replace('T', ' ').replace('Z', '');
const archived24h = db.prepare("SELECT COUNT(*) as cnt FROM jobs_archive WHERE archived_at > ?").get(oneDayAgo);
const archived7d = db.prepare("SELECT COUNT(*) as cnt FROM jobs_archive WHERE archived_at > ?").get(sevenDaysAgo);
console.log('Archived last 24h:', archived24h.cnt);
console.log('Archived last 7 days:', archived7d.cnt);

// Most recent archived
const recentArchive = db.prepare('SELECT id, type, status, tier, retry_count, created_at, finished_at, archived_at FROM jobs_archive ORDER BY rowid DESC LIMIT 5').all();
console.log('Most recent archived:', JSON.stringify(recentArchive));
