import { DatabaseSync } from 'node:sqlite';

// Get cortex_bus schema first
const bus = new DatabaseSync('C:\\Users\\Temp User\\.openclaw\\cortex\\bus.sqlite', { readOnly: true });
const schema = bus.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cortex_bus'").get();
console.log('BUS SCHEMA:', schema?.sql);

const stuck = bus.prepare("SELECT * FROM cortex_bus WHERE state != 'completed' ORDER BY rowid DESC").all();
console.log('\n=== STUCK IN CORTEX BUS:', stuck.length, '===');
for (const s of stuck) console.log(JSON.stringify(s));

const recent = bus.prepare("SELECT rowid,* FROM cortex_bus ORDER BY rowid DESC LIMIT 8").all();
console.log('\n=== RECENT BUS ===');
for (const r of recent) console.log(JSON.stringify(r));
bus.close();

const rq = new DatabaseSync('C:\\Users\\Temp User\\.openclaw\\router\\queue.sqlite', { readOnly: true });
const pending = rq.prepare("SELECT id,status,type,weight,tier,created_at FROM jobs ORDER BY created_at DESC LIMIT 10").all();
console.log('\n=== ROUTER JOBS (active):', pending.length, '===');
for (const p of pending) console.log(`id=${p.id} status=${p.status} tier=${p.tier} w=${p.weight} created=${p.created_at}`);

const arch = rq.prepare("SELECT id,status,weight,tier,length(result) as len,substr(result,1,80) as r,created_at FROM jobs_archive ORDER BY created_at DESC LIMIT 10").all();
console.log('\n=== ROUTER ARCHIVE (recent 10) ===');
for (const a of arch) console.log(`status=${a.status} tier=${a.tier} w=${a.weight} len=${a.len} created=${a.created_at} r=${a.r?.substring(0,60)}`);
rq.close();

// Cortex session last entries
const bus2 = new DatabaseSync('C:\\Users\\Temp User\\.openclaw\\cortex\\bus.sqlite', { readOnly: true });
const lastSess = bus2.prepare("SELECT id,role,substr(content,1,120) as c,timestamp FROM cortex_session ORDER BY id DESC LIMIT 10").all();
console.log('\n=== CORTEX SESSION (last 10) ===');
for (const s of lastSess) console.log(`id=${s.id} role=${s.role} ts=${s.timestamp} c=${String(s.c).substring(0,80)}`);
bus2.close();
