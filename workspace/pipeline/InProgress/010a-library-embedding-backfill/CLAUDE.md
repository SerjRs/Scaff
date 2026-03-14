# Claude Code Instructions — 010a

## Branch
`feat/010a-library-embedding-backfill`

## What to Build
1. **Backfill script** (`scripts/library-backfill-embeddings.mjs`):
   - Open `library/library.sqlite` with sqlite-vec loaded
   - Find items with no embedding: `SELECT id, title, summary, key_concepts FROM items WHERE id NOT IN (SELECT item_id FROM item_embeddings)`
   - For each: build text `${title}. ${summary} ${key_concepts joined}`, call Ollama `nomic-embed-text` at `http://127.0.0.1:11434/api/embeddings`, insert into `item_embeddings`
   - Use 30s timeout per embedding call
   - Log each item: success or failure
   - Exit with count of backfilled items

2. **Fix embeddings.ts** (`src/library/embeddings.ts`):
   - Accept optional `timeoutMs` parameter (default 15000 instead of 5000)

3. **Fix gateway-bridge.ts** (`src/cortex/gateway-bridge.ts`):
   - In the fire-and-forget embedding generation (~line 356): increase timeout to 15s
   - Add 1 retry with 2s delay on failure before logging warning

## Constraints
- Do NOT modify any files outside the scope above
- Do NOT change the embedding model or dimensions (nomic-embed-text, 768)
- The backfill script should be idempotent (safe to run multiple times)
- Update STATE.md after each milestone

## Test
- Run the backfill script and verify it completes
- Check: `SELECT COUNT(*) FROM item_embeddings` should match active item count
