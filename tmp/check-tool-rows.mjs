import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.openclaw/cortex/bus.sqlite');

const rows = db.prepare("SELECT rowid, role, channel, substr(content, 1, 300) as preview FROM cortex_session WHERE content LIKE '%toolCall%' OR content LIKE '%tool_result%' OR content LIKE '%tool_use%'").all();
console.log('Rows with tool content:', rows.length);
rows.forEach(r => console.log(`  ${r.rowid} [${r.role}/${r.channel}]: ${r.preview}`));

// Also check: how many rows total in the foreground window?
const total = db.prepare("SELECT COUNT(*) as c FROM cortex_session").get();
console.log('\nTotal session rows:', total.c);

db.close();
