import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/Temp User/.openclaw/library/library.sqlite', { open: true, readOnly: true });

const items = db.prepare("SELECT id, title, summary, key_concepts, tags, content_type, source_quality FROM items WHERE status = 'active' ORDER BY id").all();

for (const item of items) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`[${item.id}] ${item.title}`);
  console.log(`Tags: ${item.tags}`);
  console.log(`Quality: ${item.source_quality} | Type: ${item.content_type}`);
  console.log(`\nSummary:\n${item.summary}`);
  console.log(`\nKey Concepts:\n${item.key_concepts}`);
}

db.close();
