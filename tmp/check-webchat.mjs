import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');
const rows = db.prepare("SELECT role, channel, substr(content, 1, 150) as preview FROM cortex_session WHERE channel = 'webchat' ORDER BY rowid").all();
rows.forEach((r, i) => console.log(`${i}: [${r.role}] ${r.preview}`));
db.close();
