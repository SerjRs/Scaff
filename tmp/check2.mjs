import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("cortex/bus.sqlite");
const pending = db.prepare("SELECT id,state,enqueued_at FROM cortex_bus WHERE state != 'completed' ORDER BY enqueued_at DESC LIMIT 10").all();
console.log("Pending:", JSON.stringify(pending, null, 2));
const recent = db.prepare("SELECT id,state,enqueued_at,processed_at FROM cortex_bus ORDER BY rowid DESC LIMIT 3").all();
console.log("Most recent:", JSON.stringify(recent, null, 2));
db.close();
