const {DatabaseSync} = require('node:sqlite');
const fs = require('node:fs');

const runtimePath = '.openclaw/library/library.sqlite';
const workspacePath = 'library/library.sqlite';

[runtimePath, workspacePath].forEach(dbPath => {
  if (!fs.existsSync(dbPath)) { console.log('Not found:', dbPath); return; }
  console.log('\n=== ' + dbPath + ' ===');
  const db = new DatabaseSync(dbPath);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables:', tables.map(t => t.name).join(', '));
  tables.forEach(t => {
    try {
      const cnt = db.prepare('SELECT COUNT(*) as c FROM ' + t.name).get();
      console.log(' ', t.name + ':', cnt.c, 'rows');
    } catch(e) { console.log(' ', t.name + ': error -', e.message); }
  });
  db.close();
});
