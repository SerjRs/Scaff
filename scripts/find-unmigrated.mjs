import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

const root = join(homedir(), ".openclaw");
const busDb = new DatabaseSync(join(root, "cortex", "bus.sqlite"), { readOnly: true });
const libDb = new DatabaseSync(join(root, "library", "library.sqlite"), { readOnly: true });

// Get already-migrated source_refs
const migrated = busDb.prepare("SELECT source_ref FROM hippocampus_facts WHERE fact_type = 'source' AND source_ref LIKE 'library://item/%'").all();
console.log("Already migrated:");
migrated.forEach(r => console.log("  ", r.source_ref));

// Get all library items
const items = libDb.prepare("SELECT id, title, summary, key_concepts, tags, content_type FROM items WHERE status != 'failed' ORDER BY created_at ASC").all();
console.log("\nAll library items (" + items.length + "):");
items.forEach(i => console.log("  id=" + i.id + " | " + i.title));

const migratedSet = new Set(migrated.map(r => r.source_ref));
const unmigrated = items.filter(i => !migratedSet.has("library://item/" + i.id));
console.log("\nUnmigrated (" + unmigrated.length + "):");
unmigrated.forEach(i => {
  console.log("\n--- id=" + i.id + " ---");
  console.log("Title: " + i.title);
  console.log("Summary: " + i.summary);
  console.log("Key Concepts: " + i.key_concepts);
  console.log("Tags: " + i.tags);
});

busDb.close();
libDb.close();
