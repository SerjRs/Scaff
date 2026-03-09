import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { homedir } from "node:os";

const dbPath = resolve(homedir(), ".openclaw/cortex/bus.sqlite");
const db = new DatabaseSync(dbPath);

// Count before
const total = db.prepare("SELECT COUNT(*) as c FROM cortex_session").get();
const toolCallRows = db.prepare("SELECT COUNT(*) as c FROM cortex_session WHERE content LIKE '%\"toolCall\"%' OR content LIKE '%\"tool_use\"%'").get();
const toolResultRows = db.prepare("SELECT COUNT(*) as c FROM cortex_session WHERE content LIKE '%\"tool_result\"%' AND channel = 'internal'").get();
const silenceRows = db.prepare("SELECT COUNT(*) as c FROM cortex_session WHERE content = '[silence]'").get();

console.log("=== BEFORE PURGE ===");
console.log("Total rows:", total.c);
console.log("Tool call rows:", toolCallRows.c);
console.log("Tool result rows:", toolResultRows.c);
console.log("Silence rows:", silenceRows.c);
console.log("Clean rows:", total.c - toolCallRows.c - toolResultRows.c - silenceRows.c);

// Delete tool call rows (assistant messages with toolCall/tool_use content)
const del1 = db.prepare("DELETE FROM cortex_session WHERE content LIKE '%\"toolCall\"%' OR content LIKE '%\"tool_use\"%'");
const r1 = del1.run();
console.log("\nDeleted tool call rows:", r1.changes);

// Delete tool result rows (internal channel, user role)
const del2 = db.prepare("DELETE FROM cortex_session WHERE content LIKE '%\"tool_result\"%' AND channel = 'internal'");
const r2 = del2.run();
console.log("Deleted tool result rows:", r2.changes);

// Delete [silence] rows
const del3 = db.prepare("DELETE FROM cortex_session WHERE content = '[silence]'");
const r3 = del3.run();
console.log("Deleted silence rows:", r3.changes);

// Count after
const after = db.prepare("SELECT COUNT(*) as c FROM cortex_session").get();
console.log("\n=== AFTER PURGE ===");
console.log("Remaining rows:", after.c);

// Show last 10 remaining
const remaining = db.prepare("SELECT id, channel, role, sender_id, timestamp, substr(content, 1, 100) as preview FROM cortex_session ORDER BY id DESC LIMIT 10").all();
remaining.reverse().forEach(r => {
  console.log(`[${r.id}] ${r.timestamp} ${r.channel}/${r.role}: ${r.preview}`);
});

db.close();
