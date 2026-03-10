import Database from 'better-sqlite3';
const db = new Database('router/queue.sqlite');
const rows = db.prepare(`SELECT id, status, model, substr(task,1,100) as task, created_at FROM tasks WHERE status IN ('pending','running') ORDER BY created_at DESC LIMIT 10`).all();
console.log(JSON.stringify(rows, null, 2));
db.close();
