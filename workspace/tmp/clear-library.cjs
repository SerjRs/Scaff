const {DatabaseSync} = require('node:sqlite');

const db = new DatabaseSync('library/library.sqlite');

// Show what we're deleting
const items = db.prepare('SELECT id, url, title FROM items').all();
console.log('Items to delete:');
items.forEach(i => console.log(' ', i.id, i.title || i.url));

// Clear all Library data
db.exec('DELETE FROM items');
db.exec('DELETE FROM sqlite_sequence'); // reset autoincrement

// Clear embedding tables (drop data but keep schema)
try {
  // sqlite-vec virtual table — need to delete via rowid
  const rowids = db.prepare('SELECT rowid FROM item_embeddings_rowids').all();
  console.log('\nEmbedding rowids to clear:', rowids.length);
  db.exec('DELETE FROM item_embeddings_rowids');
  db.exec('DELETE FROM item_embeddings_chunks');
  db.exec('DELETE FROM item_embeddings_vector_chunks00');
} catch(e) {
  console.log('Embeddings clear (best-effort):', e.message);
}

// Verify
const remaining = db.prepare('SELECT COUNT(*) as c FROM items').get();
console.log('\nItems remaining:', remaining.c);

// Also clear any pending library task metadata from cortex bus
const busDb = new DatabaseSync('cortex/bus.sqlite');
try {
  const pendingMeta = busDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='library_task_meta'").get();
  if (pendingMeta) {
    const cnt = busDb.prepare('SELECT COUNT(*) as c FROM library_task_meta').get();
    console.log('Pending library tasks in bus:', cnt.c);
    busDb.exec('DELETE FROM library_task_meta');
    console.log('Cleared library_task_meta');
  } else {
    console.log('No library_task_meta table in bus DB');
  }
} catch(e) { console.log('Bus check:', e.message); }
busDb.close();

db.close();
console.log('\nLibrary wiped — ready for fresh test.');
