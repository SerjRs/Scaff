import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/Temp User/.openclaw/library/library.sqlite', { open: true, readOnly: true });

const total = db.prepare('SELECT COUNT(*) as c FROM items').get();
console.log('Total items:', total.c);

let embedded = 0;
try { embedded = db.prepare('SELECT COUNT(*) as c FROM item_embeddings').get().c; } catch(e) { console.log('No item_embeddings table:', e.message); }
console.log('With embeddings:', embedded);

const cols = db.prepare("PRAGMA table_info('items')").all();
console.log('Columns:', cols.map(c => c.name).join(', '));

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

// Check if full_text column exists
const hasFullText = cols.some(c => c.name === 'full_text');
console.log('Has full_text column:', hasFullText);

// Sample items - check embedding coverage
const items = db.prepare('SELECT id, title, status FROM items ORDER BY id').all();
for (const item of items) {
  let hasEmbed = false;
  try { hasEmbed = !!db.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ?').get(item.id); } catch {}
  console.log(`  [${item.id}] ${item.title} | status=${item.status} | embedded=${hasEmbed}`);
}

db.close();
