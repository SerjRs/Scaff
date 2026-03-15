# Claude Code Instructions — 017i

## Branch
`feat/017i-library-migration-script`

## Context
There are 21 existing Library items in `library.sqlite` that were ingested before the knowledge graph existed. This script migrates them into the graph by extracting facts+edges from each item and inserting them into `hippocampus_facts` + `hippocampus_edges` in `bus.sqlite`.

## What to Build

### 1. New script: `scripts/library-to-graph.mjs`

A standalone Node.js script (ESM) that:

1. Opens `library.sqlite` (read-only) and `bus.sqlite` (read-write)
2. Ensures graph tables exist by calling `initHotMemoryTable(db)` on bus.sqlite
3. For each active item in library.sqlite:

   a. **Idempotency check:** Query `hippocampus_facts` for existing fact with `source_ref = 'library://item/${itemId}'` and `fact_type = 'source'`. If found, skip this item and log "Already migrated: {title}".

   b. **Build extraction input** from the Library item:
   ```
   Title: ${title}
   Summary: ${summary}
   Key Concepts: ${key_concepts.join(', ')}
   Tags: ${tags.join(', ')}
   ```
   If `full_text` is available, append it (capped at 10KB to keep prompt reasonable).

   c. **Call LLM** with the extraction prompt (same format as 017e's Librarian prompt facts/edges section):
   ```
   From this article, extract facts and relationships between them.

   CATEGORIES:
   - fact: specific claims, data points, findings
   - decision: recommendations, conclusions
   - outcome: results, findings
   - correction: debunking, errata

   RELATIONSHIPS (only when clearly stated):
   - because, informed_by, resulted_in, contradicts, updated_by, related_to

   RULES:
   - ONLY extract what is directly stated. Do NOT infer.
   - Each fact must be a standalone statement.
   - Assign confidence: high (explicitly stated), medium (clearly implied), low (loosely implied).
   - If no facts found, return {"facts": [], "edges": []}

   Return ONLY valid JSON:
   {"facts": [{"id": "f1", "text": "...", "type": "fact", "confidence": "high"}], "edges": [{"from": "f1", "to": "f2", "type": "because"}]}

   Article:
   ${articleText}
   ```

   d. **Parse response** — try JSON.parse, fallback to regex extraction of `{...}`, fallback to empty result.

   e. **Insert into graph:**
   - Create article source node: `insertFact(busDb, { factText: 'Article: ${title}', factType: 'source', confidence: 'high', sourceType: 'article', sourceRef: 'library://item/${itemId}' })`
   - For each extracted fact: `insertFact(busDb, { factText, factType, confidence, sourceType: 'article', sourceRef: 'library://item/${itemId}' })`
   - For each fact: `insertEdge(busDb, { fromFactId: factId, toFactId: sourceFactId, edgeType: 'sourced_from' })`
   - For each extracted edge: `insertEdge(busDb, { fromFactId: idMap.get(from), toFactId: idMap.get(to), edgeType: type })`

4. After all items processed, log summary.

### 2. LLM call implementation

Use the OpenClaw Router or direct Ollama call. Since this is a one-time script, use Ollama directly for simplicity:

```javascript
async function callLLM(prompt) {
  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3.2:3b',
      prompt: prompt,
      stream: false,
      options: { temperature: 0.1 }
    })
  });
  const data = await response.json();
  return data.response;
}
```

### 3. Database paths

Use the standard OpenClaw paths:
```javascript
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// bus.sqlite location: check _state dir first, then project root
const stateDir = resolve(projectRoot, '_state');
const busDbPath = existsSync(resolve(stateDir, 'cortex', 'bus.sqlite'))
  ? resolve(stateDir, 'cortex', 'bus.sqlite')
  : resolve(projectRoot, 'bus.sqlite');

// Library DB
const libraryDbPath = resolve(projectRoot, 'library', 'library.sqlite');
```

Actually, look at how other scripts in `scripts/` find these paths. Check `scripts/nightly-code-index.mjs` or similar for the pattern. Use the same approach.

### 4. Library DB queries

```sql
-- Get all active items
SELECT id, url, title, summary, key_concepts, tags, content_type, full_text
FROM items
WHERE status != 'failed'
ORDER BY created_at ASC
```

Note: `key_concepts` and `tags` are stored as JSON arrays in SQLite TEXT columns.

### 5. Import graph functions

The script needs to import from the built output. Use:
```javascript
import { initHotMemoryTable, insertFact, insertEdge } from '../src/cortex/hippocampus.js';
```

If that doesn't work because of TypeScript, use the compiled output path — check `tsconfig.json` for `outDir`. Common patterns:
- `../dist/cortex/hippocampus.js`
- `../build/cortex/hippocampus.js`

Or use `node:sqlite` directly with raw SQL (simpler, no import issues):
```javascript
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

function insertFact(db, opts) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hippocampus_facts (id, fact_text, fact_type, confidence, status, source_type, source_ref, created_at, last_accessed_at, hit_count)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, 0)
  `).run(id, opts.factText, opts.factType ?? 'fact', opts.confidence ?? 'medium', opts.sourceType ?? null, opts.sourceRef ?? null, now, now);
  return id;
}

function insertEdge(db, opts) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hippocampus_edges (id, from_fact_id, to_fact_id, edge_type, confidence, created_at)
    VALUES (?, ?, ?, ?, 'medium', ?)
  `).run(id, opts.fromFactId, opts.toFactId, opts.edgeType, now);
  return id;
}
```

**Use the raw SQL approach** — it's a standalone script, keep it self-contained.

## Tests

Since this is a one-time migration script, don't write unit tests. Instead, add a `--dry-run` flag:
- When `--dry-run` is passed, log what WOULD be inserted but don't actually write to the DB
- Log: item title, number of facts extracted, number of edges extracted
- This lets us verify the extraction quality before committing

Also add `--limit N` flag to process only the first N items (useful for testing).

## Constraints
- Process items sequentially (one at a time, don't overload Ollama)
- 30-second timeout per LLM call
- If LLM call fails for an item, log the error and continue to next item
- Idempotent: safe to run multiple times
- When done, commit, push branch, create PR, then run: `openclaw system event --text "Done 017i migration script"`
