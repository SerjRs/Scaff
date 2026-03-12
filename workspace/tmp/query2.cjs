const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('cortex/bus.sqlite', {readOnly: true});

// Look at pending ops from 17:00 onward
const ops = db.prepare("SELECT * FROM cortex_pending_ops WHERE dispatched_at > '2026-03-11T17:00:00' ORDER BY dispatched_at ASC").all();
ops.forEach(op => {
  console.log('=== OP:', op.id);
  console.log('  type:', op.type);
  console.log('  status:', op.status);
  console.log('  dispatched:', op.dispatched_at);
  console.log('  completed:', op.completed_at);
  console.log('  reply_channel:', op.reply_channel);
  console.log('  desc:', (op.description || '').substring(0, 200));
  console.log('  result:', (op.result || '').substring(0, 300));
  console.log('');
});

db.close();
