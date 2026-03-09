import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');

// Check for main-agent issuer entries (the new gateway hook)
const mainAgent = db.prepare("SELECT role, substr(content, 1, 150) as preview, timestamp FROM cortex_session WHERE issuer = 'main-agent' ORDER BY rowid DESC LIMIT 10").all();
console.log(`main-agent writes: ${mainAgent.length}`);
mainAgent.forEach(r => console.log(`  [${r.timestamp}] ${r.role}: ${r.preview}`));

// Compare with session-sync (old batch method)
const sessionSync = db.prepare("SELECT COUNT(*) as c FROM cortex_session WHERE issuer = 'session-sync'").all();
console.log(`\nsession-sync (old batch) writes: ${sessionSync[0].c}`);

// Check for writes after rebuild (~10:08)
const recent = db.prepare("SELECT role, issuer, substr(content, 1, 150) as preview, timestamp FROM cortex_session WHERE timestamp > '2026-03-09T08:00:00' ORDER BY rowid DESC LIMIT 10").all();
console.log(`\nAll writes after 10:00 UTC+2 (08:00 UTC):`);
recent.forEach(r => console.log(`  [${r.timestamp}] ${r.issuer}/${r.role}: ${r.preview}`));

db.close();
