// Inject a test message into cortex_bus to test LLM call path
const {DatabaseSync} = require('node:sqlite');
const crypto = require('node:crypto');

const db = new DatabaseSync('cortex/bus.sqlite');

const id = crypto.randomUUID();
const envelope = {
  id,
  channel: 'whatsapp',
  sender: { id: '+40751845717', name: 'Serj', relationship: 'partner' },
  content: 'test ping',
  priority: 'normal',
  timestamp: new Date().toISOString(),
  replyContext: { channel: 'whatsapp', threadId: '+40751845717' },
};

// Insert into cortex_bus as pending
db.prepare(`INSERT INTO cortex_bus (id, state, priority, enqueued_at, envelope) 
            VALUES (?, 'pending', 1, ?, ?)`)
  .run(id, new Date().toISOString(), JSON.stringify(envelope));

console.log('Injected test message:', id);
console.log('Now check if loop picks it up...');
db.close();
