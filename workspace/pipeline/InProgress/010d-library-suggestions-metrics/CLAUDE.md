# Claude Code Instructions — 010d

## Branch
`feat/010d-library-suggestions-metrics`

## What to Build

### 1. Proactive suggestions — system prompt (`src/cortex/llm-caller.ts`)

Find the `## Library` section in the tool guidance (search for "When the user shares a URL"). Add after the existing Library guidance:

```
When you detect a knowledge gap — the user asks about something you can't answer well \
and Library search returns no results — suggest they share relevant links: \
"I don't have deep context on [topic]. If you have docs or articles, drop a link and I'll learn it."
```

### 2. library_stats enhancements (`src/cortex/tools.ts`)

In `executeLibraryStats()`, add:

1. **Embedding health line**: Query `item_embeddings` count vs total items. If <80% have embeddings, append ⚠️ warning.
   - Note: `item_embeddings` uses sqlite-vec (vec0). Open with `allowExtension: true`, load sqlite-vec, then query.
   - If vec0 fails to load, show "Embedding health: unavailable (sqlite-vec not loaded)"

2. **Weekly trend**: Group items by ISO week from `ingested_at`. Show last 3 weeks.

3. **Domain coverage**: Group by top-level tag categories. Show item counts per cluster.

## Constraints
- Do NOT modify any other files
- The library_stats function must not crash if sqlite-vec is unavailable
- Keep the output human-readable (it goes to WhatsApp)
- Update STATE.md after each milestone

## Test
- Verify compilation (`npx tsc --noEmit` — ignore pre-existing errors)
- The stats function should return enhanced output when called
