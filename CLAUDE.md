# Claude Code Instructions — 022b

## Branch
`feat/022b-backfill-cortex-archive`

## Task
Fix `scripts/backfill-memory.ts` so the `cortex_archive` source (188 chunks from a 1.3MB JSON) can complete without crashing. Read the full spec at:
`workspace/pipeline/InProgress/022b-backfill-cortex-archive-crash/SPEC.md`

## Context
The script already has retry + try/catch from 022a (just merged). But cortex_archive still crashed silently after 17 minutes on 188 chunks. This spec adds fixes specific to large sources.

## Changes Required (all in `scripts/backfill-memory.ts`)

1. **Per-call timeout (30s)** — Add an AbortController with 30s timeout to each `complete()` call so a hanging API request doesn't block forever. Check if `complete()` from `src/llm/simple-complete.ts` supports a `signal` option. If not, wrap with `Promise.race([complete(...), timeout])`.

2. **Checkpoint file for large sources** — For any source with >50 chunks, write a checkpoint JSON to `<base>/tmp/backfill-checkpoint-<sourceType>.json` after each successful chunk. On re-run, skip chunks already in the checkpoint. Format:
   ```json
   { "completedRefs": ["cortex-archive://2026-03-09/chunk-001", ...] }
   ```

3. **Streaming chunk processing** — Don't accumulate all chunks in an array first. Process and discard each chunk as it's generated. For `cortex_archive`, the JSON file is parsed into messages, then chunked. Process chunks one at a time instead of building the full array.

4. **Print partial summary on interrupt** — Add a `process.on('SIGINT')` and `process.on('SIGTERM')` handler that prints the current stats before exiting, so we know how far it got.

## Steps

1. Read SPEC.md and current `scripts/backfill-memory.ts`
2. Read `src/llm/simple-complete.ts` to check if it supports abort signal
3. Apply all 4 changes
4. Verify compilation: `npx tsx scripts/backfill-memory.ts --help`
5. Commit, push
6. Create PR: `"C:\Program Files\GitHub CLI\gh.exe" pr create --title "fix: 022b — backfill cortex archive resilience" --base main`

## Constraints
- Only modify `scripts/backfill-memory.ts`
- Do NOT run the script against real data
- Changes should benefit all large sources, not just cortex_archive
