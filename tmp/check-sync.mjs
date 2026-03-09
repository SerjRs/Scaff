import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');

const synced = db.prepare("SELECT role, COUNT(*) as c FROM cortex_session WHERE issuer = 'session-sync' GROUP BY role").all();
console.log('Session-synced rows:', JSON.stringify(synced));

const sample = db.prepare("SELECT role, substr(content, 1, 150) as preview FROM cortex_session WHERE issuer = 'session-sync' ORDER BY rowid DESC LIMIT 6").all();
console.log('\nLatest synced:');
sample.forEach(r => console.log('  ' + r.role + ': ' + r.preview));

db.close();
