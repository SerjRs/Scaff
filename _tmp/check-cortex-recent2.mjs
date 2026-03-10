import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { homedir } from "node:os";
const db = new DatabaseSync(resolve(homedir(), ".openclaw/cortex/bus.sqlite"));
const rows = db.prepare(
  "SELECT id, channel, role, timestamp, substr(content, 1, 400) as preview FROM cortex_session WHERE id > 3230 ORDER BY id"
).all();
rows.forEach(r => console.log(`[${r.id}] ${r.timestamp} ${r.channel}/${r.role}: ${r.preview}\n`));
db.close();
