const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('C:\\Users\\Temp User\\.openclaw\\cortex\\bus.sqlite');

const rows = db.prepare(
  "SELECT id, role, sender_id, timestamp, substr(content, 1, 200) as preview FROM cortex_session WHERE channel='whatsapp' ORDER BY timestamp"
).all();

console.log('Total rows:', rows.length);
rows.forEach(r => {
  console.log(`[${r.id}] ${r.role} | ${r.sender_id} | ${r.timestamp}`);
  console.log('  ', r.preview);
  console.log();
});
