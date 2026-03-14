import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite', { open: true, readOnly: true });

// Check schemas
const busCols = db.prepare("PRAGMA table_info('cortex_bus')").all();
console.log('cortex_bus:', busCols.map(c => c.name + ':' + c.type).join(', '));

const sessCols = db.prepare("PRAGMA table_info('cortex_session')").all();
console.log('cortex_session:', sessCols.map(c => c.name + ':' + c.type).join(', '));

const chCols = db.prepare("PRAGMA table_info('cortex_channel_states')").all();
console.log('cortex_channel_states:', chCols.map(c => c.name + ':' + c.type).join(', '));

// Get latest messages from cortex_bus
const busRows = db.prepare("SELECT * FROM cortex_bus ORDER BY rowid DESC LIMIT 30").all();
for (const r of busRows) {
    const keys = Object.keys(r);
    const summary = {};
    for (const k of keys) {
        if (typeof r[k] === 'string' && r[k].length > 200) {
            summary[k] = r[k].substring(0, 200) + '...';
        } else {
            summary[k] = r[k];
        }
    }
    console.log(JSON.stringify(summary));
    console.log('---');
}
