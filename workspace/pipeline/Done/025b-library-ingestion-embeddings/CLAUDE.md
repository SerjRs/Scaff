# CLAUDE.md — 025b: Fix Library ingestion + backfill script embeddings

> **DO NOT ASK FOR CONFIRMATION. Execute all steps immediately.**

## Task

Three code changes to ensure all fact insertion paths generate embeddings:

### 1. Extend `dedupAndInsertGraphFact` to accept `sourceRef`

**File**: `src/cortex/gardener.ts`

Find `dedupAndInsertGraphFact` (around line 470). Add optional `sourceRef` parameter:

```typescript
export async function dedupAndInsertGraphFact(
  db: DatabaseSync,
  fact: ExtractedFact,
  sourceType: string,
  embedFn?: EmbedFunction,
  sourceRef?: string,    // ← ADD THIS
): Promise<{ factId: string; inserted: boolean }>
```

Then find ALL `insertFact()` calls inside this function (there are 4) and add `sourceRef` to each:

```typescript
const id = insertFact(db, {
  factText: fact.text,
  factType: fact.type,
  confidence: fact.confidence,
  sourceType,
  sourceRef,    // ← ADD THIS to all 4 insertFact calls
  // ... keep existing embedding if present
});
```

### 2. Fix Library ingestion in gateway-bridge.ts

**File**: `src/cortex/gateway-bridge.ts`

Find the Library task handler (around line 390-441 where `const hippo = require("./hippocampus.js")`).

a) Add an embed function at the top of the Library handler block:

```typescript
const { dedupAndInsertGraphFact } = require("./gardener.js");

async function embedForLibrary(text: string): Promise<Float32Array> {
  const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  const json = await res.json() as { embedding: number[] };
  return new Float32Array(json.embedding);
}
```

b) For the source article node, add embedding:

```typescript
// Get embedding for article source node
let sourceEmbedding: Float32Array | undefined;
try {
  sourceEmbedding = await embedForLibrary(`Article: ${parsed.title}`);
} catch { /* graceful — insert without embedding */ }

const sourceFactId = hippo.insertFact(instance.db, {
  factText: `Article: ${parsed.title}`,
  factType: "source",
  confidence: "high",
  sourceType: "article",
  sourceRef: `library://item/${itemId}`,
  embedding: sourceEmbedding,
});
```

c) For content facts, replace `hippo.insertFact()` with `dedupAndInsertGraphFact()`:

```typescript
for (const f of parsedFacts) {
  if (!f.text?.trim()) continue;
  const { factId } = await dedupAndInsertGraphFact(
    instance.db,
    { id: f.id, text: f.text.trim(), type: f.type ?? "fact", confidence: f.confidence ?? "medium" },
    "article",
    embedForLibrary,
    `library://item/${itemId}`,
  );
  idMap.set(f.id, factId);
  // Keep existing edge creation code (sourced_from edge etc.)
}
```

d) If the enclosing block is synchronous, wrap the async calls properly. Check if the Library handler is in a `.then()` or callback — it may need to become async.

### 3. Fix backfill script

**File**: `scripts/library-to-graph.ts`

a) Delete the local `insertFact()` function (around line 75) and local `insertEdge()` function.

b) Import from the real modules:
```typescript
import { insertFact, insertEdge } from "../src/cortex/hippocampus.js";
import { dedupAndInsertGraphFact } from "../src/cortex/gardener.js";
```

c) Add an embed function:
```typescript
async function embedFn(text: string): Promise<Float32Array> {
  const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  const json = await res.json() as { embedding: number[] };
  return new Float32Array(json.embedding);
}
```

d) Replace `insertFact()` calls at lines ~205 and ~217 with `dedupAndInsertGraphFact()` calls that pass `embedFn`.

e) The script must load `sqlite-vec`. Add near the top after opening the DB:
```typescript
const db = new DatabaseSync(DB_PATH, { allowExtension: true });
const sqliteVec = await import("sqlite-vec");
sqliteVec.load(db);
```

### 4. Run existing tests

```bash
npx vitest run src/cortex/__tests__/e2e-hippocampus-full.test.ts --reporter=verbose
npx vitest run src/cortex/__tests__/e2e-webchat-hippo.test.ts --reporter=verbose
```

All existing tests must still pass. The `sourceRef` parameter is optional so it's backward compatible.

### 5. Commit

```bash
git add src/cortex/gardener.ts src/cortex/gateway-bridge.ts scripts/library-to-graph.ts
git commit -m "fix(025b): Library ingestion + backfill script now generate embeddings"
```

## Environment
- Working dir: `C:\Users\Temp User\.openclaw`
- Branch: `feat/025b-library-embeddings`
- Node v24.13.0, Windows
- Ollama at 127.0.0.1:11434 with nomic-embed-text

## Constraints
- Do NOT break existing tests
- The `sourceRef` param must be optional (backward compatible)
- Embedding failures should be graceful (insert fact without embedding, don't crash)
- Keep the existing edge creation logic in gateway-bridge.ts unchanged
