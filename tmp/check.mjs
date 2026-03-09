import { DatabaseSync } from "node:sqlite";

// Router queue
const rdb = new DatabaseSync("router/queue.sqlite");
const jobs = rdb.prepare("SELECT id,type,status,tier,created_at FROM jobs ORDER BY created_at DESC LIMIT 10").all();
console.log("Active jobs:", JSON.stringify(jobs, null, 2));
const arch = rdb.prepare("SELECT id,type,status,tier,created_at FROM jobs_archive ORDER BY created_at DESC LIMIT 10").all();
console.log("Archive:", JSON.stringify(arch, null, 2));
rdb.close();

// Cortex bus
const cdb = new DatabaseSync("cortex/bus.sqlite");
const cols = cdb.prepare("PRAGMA table_info(cortex_bus)").all();
console.log("Bus columns:", cols.map(c => c.name).join(", "));
const recent = cdb.prepare("SELECT * FROM cortex_bus ORDER BY rowid DESC LIMIT 5").all();
console.log("Recent bus:", JSON.stringify(recent, null, 2));
cdb.close();
