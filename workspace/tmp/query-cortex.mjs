import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:\\Users\\Temp User\\.openclaw\\cortex\\bus.sqlite', { open: true, readOnly: true });

// Find today's messages (March 14, 2026)
// timestamps in cortex_session could be TEXT or INTEGER - check both
const today = new Date('2026-03-14T00:00:00+02:00').getTime();
const tomorrow = new Date('2026-03-15T00:00:00+02:00').getTime();
const todayISO = '2026-03-14';

// Check cortex_session for today's messages (try numeric timestamp)
try {
  let msgs = db.prepare(`SELECT id, envelope_id, role, channel, sender_id, sender_name, substr(content,1,400) as content, timestamp, shard_id, issuer FROM cortex_session WHERE CAST(timestamp AS INTEGER) >= ? AND CAST(timestamp AS INTEGER) < ? ORDER BY timestamp ASC`).all(today, tomorrow);
  if (msgs.length === 0) {
    // Try string match
    msgs = db.prepare(`SELECT id, envelope_id, role, channel, sender_id, sender_name, substr(content,1,400) as content, timestamp, shard_id, issuer FROM cortex_session WHERE timestamp LIKE '${todayISO}%' ORDER BY timestamp ASC`).all();
  }
  if (msgs.length === 0) {
    // Try last 50 messages to see timestamp format
    const recent = db.prepare(`SELECT id, role, substr(content,1,100) as content, timestamp FROM cortex_session ORDER BY id DESC LIMIT 5`).all();
    console.log('No messages found for today. Last 5 messages:');
    for (const m of recent) {
      console.log(`  id=${m.id} role=${m.role} ts=${m.timestamp} | ${m.content}`);
    }
  } else {
    console.log(`Today's cortex_session messages: ${msgs.length}`);
    for (const m of msgs) {
      console.log(`\n--- [id=${m.id}] role=${m.role} channel=${m.channel} sender=${m.sender_name||m.sender_id} shard=${m.shard_id||'null'} issuer=${m.issuer||'null'} ts=${m.timestamp}`);
      console.log(m.content);
    }
  }
} catch(e) {
  console.log('cortex_session query failed:', e.message);
}

// Check cortex_bus for today's entries
try {
  let tasks = db.prepare(`SELECT id, state, substr(envelope,1,500) as envelope, enqueued_at, processed_at, attempts, error FROM cortex_bus WHERE enqueued_at LIKE '${todayISO}%' ORDER BY enqueued_at ASC`).all();
  if (tasks.length === 0) {
    tasks = db.prepare(`SELECT id, state, substr(envelope,1,500) as envelope, enqueued_at, processed_at, attempts, error FROM cortex_bus ORDER BY ROWID DESC LIMIT 5`).all();
    console.log('\nNo cortex_bus entries for today. Last 5:');
    for (const t of tasks) {
      console.log(`  id=${t.id} state=${t.state} enqueued=${t.enqueued_at} processed=${t.processed_at} attempts=${t.attempts} error=${t.error}`);
    }
  } else {
    console.log(`\nToday's cortex_bus entries: ${tasks.length}`);
    for (const t of tasks) {
      console.log(`  id=${t.id} state=${t.state} enqueued=${t.enqueued_at} attempts=${t.attempts} error=${t.error||'none'}`);
    }
  }
} catch(e) {
  console.log('cortex_bus query failed:', e.message);
}

// Check pending ops
try {
  const ops = db.prepare(`SELECT * FROM cortex_pending_ops WHERE dispatched_at LIKE '${todayISO}%' OR completed_at LIKE '${todayISO}%' ORDER BY dispatched_at ASC`).all();
  console.log(`\nToday's pending_ops: ${ops.length}`);
  for (const o of ops) {
    console.log(`  id=${o.id} type=${o.type} status=${o.status} desc=${o.description?.substring(0,200)}`);
  }
} catch(e) {
  console.log('pending_ops query failed:', e.message);
}

db.close();
