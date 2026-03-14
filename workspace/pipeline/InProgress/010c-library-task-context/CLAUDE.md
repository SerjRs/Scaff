# Claude Code Instructions — 010c

## Branch
`feat/010c-library-task-context`

## What to Build
In `src/cortex/loop.ts`, in the sessions_spawn async handler, AFTER the existing SPEC auto-attach block (search for "Auto-attach SPEC.md for pipeline tasks (016)"):

Add Library context injection:

```typescript
// Auto-attach Library domain context for task enrichment (010c)
try {
  const { openLibraryDbReadonly, searchItems } = require("../library/retrieval.js");
  const libraryDb = openLibraryDbReadonly();
  if (libraryDb) {
    try {
      const taskEmbedding = await embedFn(task.substring(0, 500));
      const matches = searchItems(libraryDb, taskEmbedding, 3);
      if (matches.length > 0) {
        const context = matches.map((m: any) => `[${m.title}]\n${m.summary}`).join("\n---\n");
        if (context.length <= 4096) {
          resolvedResources.push({ name: "Library domain context", content: context });
        }
      }
    } finally {
      libraryDb.close();
    }
  }
} catch { /* best-effort — don't block spawn */ }
```

## Constraints
- Place AFTER the SPEC auto-attach block, BEFORE the `onSpawn()` call
- Wrap in try/catch — Library failure must never block task dispatch
- Cap at 3 items, 4KB total
- Use the existing `embedFn` from the loop context (already available)
- Do NOT modify any other files
- Update STATE.md after each milestone

## Test
- Verify the code compiles (`npx tsc --noEmit` — ignore pre-existing errors in other files)
- Verify the injection is in the right position (after SPEC attach, before onSpawn)
