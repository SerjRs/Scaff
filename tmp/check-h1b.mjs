import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');

const all = db.prepare('SELECT fact_text, created_at, hit_count FROM cortex_hot_memory ORDER BY created_at').all();
console.log(`Total facts: ${all.length}\n`);
for (let i = 0; i < all.length; i++) {
  console.log(`${i+1}. [${all[i].created_at.substring(0,10)}] ${all[i].fact_text}`);
}

db.close();
