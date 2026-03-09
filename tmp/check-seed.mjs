import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');
const seeded = db.prepare("SELECT COUNT(*) as c FROM cortex_session WHERE issuer='memory-seed'").get();
const total = db.prepare('SELECT COUNT(*) as c FROM cortex_session').get();
console.log('Seeded rows:', seeded.c);
console.log('Total sessions:', total.c);
db.close();
