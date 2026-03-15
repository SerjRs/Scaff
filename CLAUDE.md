# Claude Code Instructions — 021 (Memory Backfill)

## Branch
`feat/021-memory-backfill`

## Task
Create a **single reusable ingestion script** at `scripts/backfill-memory.ts` that can import any of the 11 source types into the Hippocampus knowledge graph.

Read the full spec: `workspace/pipeline/InProgress/021-hippocampus-full-memory-backfill/SPEC.md`

## What to Build

A TypeScript script (`scripts/backfill-memory.ts`) that:

1. **Takes a `--source` argument** selecting which source type to process:
   `--source curated_memory|daily_log|agent_facts|pipeline_task|correction|main_session|cortex_archive|executor_session|architecture_doc|workspace_session|executor_doc`

2. **Takes a `--base` argument** for the OpenClaw root path (default: `~/.openclaw`)

3. **For each source type**, knows which files to read (paths from the SPEC)

4. **Parses/chunks** the content per source type:
   - Markdown files: send as single chunk if <8KB, split into ~4KB sections if larger
   - JSONL files: parse lines, extract message content, group into chunks
   - JSON files: parse and extract relevant content

5. **Calls Haiku** for fact+edge extraction using `src/llm/simple-complete.ts`:
   ```typescript
   import { complete } from '../src/llm/simple-complete.js';
   
   const result = await complete(extractionPrompt, {
     model: 'claude-haiku-4-5',
     maxTokens: 4096,
   });
   ```

6. **Deduplicates** against existing facts using `dedupAndInsertGraphFact()` from `src/cortex/gardener.ts`

7. **Inserts** new facts + edges into the graph using functions from `src/cortex/hippocampus.ts`

8. **Logs results** to stdout: facts inserted, edges created, duplicates skipped, errors

9. **Is idempotent**: checks `source_ref` before processing — skips files already imported

## Key Architecture

### LLM Client
```typescript
import { complete } from '../src/llm/simple-complete.js';
```
Read `src/llm/simple-complete.ts` and `src/llm/resolve-auth.ts` to understand how auth works. It reads from `agents/main/agent/auth-profiles.json`.

### Hippocampus Functions
```typescript
import { insertFact, insertEdge, initBus, initGraphTables } from '../src/cortex/hippocampus.js';
import { dedupAndInsertGraphFact } from '../src/cortex/gardener.js';
```
Read `src/cortex/hippocampus.ts` for the full API. Key functions:
- `insertFact(db, { factText, factType, confidence, sourceType, sourceRef })`
- `insertEdge(db, { fromFactId, toFactId, edgeType })`
- `dedupAndInsertGraphFact(db, fact, sourceType, embedFn)` — handles dedup

### Embedding Function
For dedup, use Ollama nomic-embed-text:
```typescript
async function embedFn(text: string): Promise<Float32Array> {
  const resp = await fetch('http://127.0.0.1:11434/api/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
  });
  const data = await resp.json();
  return new Float32Array(data.embedding);
}
```

### Extraction Prompt
The prompt to Haiku should request structured JSON output:
```
Extract facts and relationships from this text. Return JSON:
{
  "facts": [
    { "id": "f1", "text": "...", "type": "fact|decision|outcome|correction", "confidence": "high|medium|low" }
  ],
  "edges": [
    { "from": "f1", "to": "f2", "type": "because|informed_by|resulted_in|contradicts|updated_by|related_to|sourced_from|part_of" }
  ]
}

Focus on: decisions made, preferences stated, lessons learned, architecture choices, 
relationships between concepts, corrections of earlier beliefs.
Skip: routine tool outputs, code blocks, timestamps without context.
```

### DB Path
`<base>/cortex/bus.sqlite` — open with `new DatabaseSync(path)`.

## File Structure

```
scripts/
  backfill-memory.ts    # Main script
```

Single file. All source type handlers in one file with a switch/map on `--source`.

## Usage Examples

```bash
# Import curated memory files
npx tsx scripts/backfill-memory.ts --source curated_memory --base "C:\Users\Temp User\.openclaw"

# Import daily logs
npx tsx scripts/backfill-memory.ts --source daily_log --base "C:\Users\Temp User\.openclaw"

# Dry run (parse + extract but don't write to DB)
npx tsx scripts/backfill-memory.ts --source curated_memory --base "C:\Users\Temp User\.openclaw" --dry-run
```

## Steps

1. Read the SPEC.md for full source file inventory
2. Read `src/llm/simple-complete.ts` and `src/cortex/hippocampus.ts` and `src/cortex/gardener.ts` for APIs
3. Read the existing `scripts/library-to-graph.ts` for the pattern used in the previous migration
4. Create `scripts/backfill-memory.ts`
5. Verify it compiles: `npx tsx --no-warnings scripts/backfill-memory.ts --help`
6. Commit, push, create PR: `gh pr create --title "feat: 021 — hippocampus memory backfill script" --body "..." --base main`
7. Signal: `openclaw system event --text "Done 021 script"`

## Constraints
- Do NOT run the script against the real DB — just verify it compiles and --help works
- Use Haiku (`claude-haiku-4-5`) for extraction, NOT Sonnet
- 200ms delay between Haiku calls
- Error tolerance: log failures, continue
- Idempotent: check source_ref before processing
