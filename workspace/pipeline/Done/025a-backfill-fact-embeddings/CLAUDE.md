# CLAUDE.md — 025a: Backfill embeddings for hippocampus facts

> **DO NOT ASK FOR CONFIRMATION. Execute all steps immediately.**

## Task

Create and run a script that generates Ollama `nomic-embed-text` embeddings for all ~6,655 hippocampus facts that are missing vec entries, and inserts them into `hippocampus_facts_vec`.

## Steps

### 1. Create `scripts/backfill-embeddings.ts`

```typescript
import { DatabaseSync } from "node:sqlite";

// 1. Open DB
const db = new DatabaseSync("cortex/bus.sqlite");

// 2. Load sqlite-vec extension (REQUIRED for hippocampus_facts_vec)
const sqliteVec = await import("sqlite-vec");
sqliteVec.load(db);

// 3. Find facts missing vec entries
const missing = db.prepare(`
  SELECT f.rowid, f.id, f.fact_text
  FROM hippocampus_facts f
  LEFT JOIN hippocampus_facts_vec_rowids v ON v.rowid = f.rowid
  WHERE v.rowid IS NULL AND f.status = 'active'
  ORDER BY f.rowid ASC
`).all();

console.log(`Found ${missing.length} facts without embeddings`);

// 4. Embed each fact via Ollama
let success = 0;
let failed = 0;

for (let i = 0; i < missing.length; i++) {
  const fact = missing[i];
  
  // Retry up to 3 times
  let embedding = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", prompt: fact.fact_text }),
      });
      const json = await res.json();
      embedding = new Float32Array(json.embedding);
      break;
    } catch (err) {
      const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      console.log(`  Retry ${attempt + 1}/3 for rowid ${fact.rowid}: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  
  if (embedding && embedding.length === 768) {
    db.prepare(`
      INSERT INTO hippocampus_facts_vec (rowid, embedding) 
      VALUES (CAST(? AS INTEGER), ?)
    `).run(Number(fact.rowid), new Uint8Array(embedding.buffer));
    success++;
  } else {
    console.log(`  FAILED rowid ${fact.rowid}: ${fact.fact_text.slice(0, 60)}`);
    failed++;
  }
  
  // Progress every 100
  if ((i + 1) % 100 === 0) {
    console.log(`Progress: ${i + 1}/${missing.length} (${success} ok, ${failed} failed)`);
  }
}

// 5. Summary
console.log(`\nDone. Success: ${success}, Failed: ${failed}, Total: ${missing.length}`);

// 6. Verify
const vecCount = db.prepare("SELECT count(*) as n FROM hippocampus_facts_vec_rowids").get();
const activeCount = db.prepare("SELECT count(*) as n FROM hippocampus_facts WHERE status = 'active'").get();
console.log(`Vec entries: ${vecCount.n} / Active facts: ${activeCount.n}`);
```

**Important notes for the script:**
- The file must use `.ts` extension and be run with `npx tsx`
- `sqlite-vec` is already installed as an npm dependency
- `db.enableLoadExtension(true)` may be needed before `sqliteVec.load(db)` — check if `load()` handles it
- The `CAST(? AS INTEGER)` is required because node:sqlite binds JS numbers as REAL, but sqlite-vec requires INTEGER rowids
- `new Uint8Array(embedding.buffer)` is required — sqlite-vec expects raw bytes, not Float32Array directly

### 2. Run the script

```bash
npx tsx scripts/backfill-embeddings.ts
```

This will take ~5-10 minutes (6,655 facts × ~50ms per Ollama call).

### 3. Verify

After the script completes, run a quick check:

```typescript
// Add this at the end of the script or run separately
const testEmbed = await fetch("http://127.0.0.1:11434/api/embeddings", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "nomic-embed-text", prompt: "Scaff birthday creation date" }),
});
const testJson = await testEmbed.json();
const queryVec = new Float32Array(testJson.embedding);

const results = db.prepare(`
  SELECT v.distance, f.fact_text, f.source_type
  FROM hippocampus_facts_vec v
  JOIN hippocampus_facts f ON f.rowid = v.rowid
  WHERE v.embedding MATCH ? AND k = 5
  ORDER BY v.distance
`).all(new Uint8Array(queryVec.buffer));

console.log("\nTest query: 'Scaff birthday creation date'");
for (const r of results) {
  console.log(`  [${r.distance.toFixed(3)}] [${r.source_type}] ${r.fact_text.slice(0, 100)}`);
}
```

The results should contain facts about Scaff's birthday/creation — NOT "Task 011 addresses 4 root causes".

### 4. Write results

Create `workspace/pipeline/InProgress/025a-backfill-fact-embeddings/TEST-RESULTS.md` with:
- Total facts processed, success count, failed count
- Vec count before and after
- Test query results (top 5 for "Scaff birthday")
- Pass/fail verdict

### 5. Commit

```bash
git add scripts/backfill-embeddings.ts workspace/pipeline/InProgress/025a-backfill-fact-embeddings/
git commit -m "feat(025a): backfill embeddings for 6,655 hippocampus facts"
```

## Environment
- Working dir: `C:\Users\Temp User\.openclaw`
- DB: `cortex/bus.sqlite`
- Ollama: `127.0.0.1:11434` with `nomic-embed-text` model (768 dimensions)
- Node v24.13.0, Windows
- Branch: `feat/025a-backfill-embeddings`
- `sqlite-vec` npm package is installed

## Constraints
- Do NOT modify any source code in `src/`
- Do NOT delete existing vec entries (the 10 from today's Gardener run)
- Only INSERT new vec entries for facts that don't have one (the LEFT JOIN handles this)
- Script must be idempotent (safe to run again)
- If Ollama is slow or returns errors, retry with backoff — don't crash
