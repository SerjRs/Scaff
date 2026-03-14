import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/Temp User/.openclaw/library/library.sqlite', { open: true, readOnly: true });

const withText = db.prepare("SELECT COUNT(*) as c FROM items WHERE full_text IS NOT NULL AND full_text != ''").get();
const withoutText = db.prepare("SELECT COUNT(*) as c FROM items WHERE full_text IS NULL OR full_text = ''").get();
console.log('With full_text:', withText.c);
console.log('Without full_text:', withoutText.c);

const sample = db.prepare("SELECT id, title, LENGTH(full_text) as textLen, LENGTH(summary) as sumLen FROM items LIMIT 5").all();
for (const s of sample) {
  console.log(`  [${s.id}] ${s.title} | full_text=${s.textLen ?? 'NULL'} | summary=${s.sumLen ?? 'NULL'}`);
}

// Check if vec0 extension is loadable
try {
  db.prepare("SELECT * FROM item_embeddings LIMIT 1").get();
  console.log('vec0 module: working');
} catch (e) {
  console.log('vec0 module error:', e.message);
}

db.close();
