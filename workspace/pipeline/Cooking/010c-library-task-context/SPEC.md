---
id: "010c"
title: "Library-informed task context for coding executors"
created: "2026-03-14"
author: "scaff"
priority: "medium"
status: "cooking"
moved_at: "2026-03-14"
---

# 010c — Library-Informed Task Context

## Problem

When Cortex spawns coding/research tasks via Router, the executor gets:
- The user's task prompt
- Code search results (if Cortex included them)
- SPEC.md (auto-attached by 016)

It does NOT get relevant Library knowledge. Example: if the Library has an article on "event-driven architecture patterns" and the task is about refactoring the event bus, the executor has no access to that domain knowledge.

## Fix

In `src/cortex/loop.ts`, in the sessions_spawn handler (near the existing auto-attach SPEC logic from 016):

1. Extract key terms from the task description
2. Run a Library breadcrumb query (same as used for system prompt injection)
3. If matches found, append top-3 as a resource: `{ name: "Library context", content: "..." }`
4. Content format: compact — title + summary only (no full_text), capped at 4KB total

### Implementation Detail

The breadcrumb query uses `searchItems()` from `src/library/retrieval.ts` which requires an embedding. We already have `embedViaOllama` in the loop context.

```typescript
// After SPEC auto-attach (016), before onSpawn call:
try {
  const { openLibraryDbReadonly, searchItems } = require("../library/retrieval.js");
  const libraryDb = openLibraryDbReadonly();
  if (libraryDb) {
    const taskEmbedding = await embedFn(task.substring(0, 500));
    const matches = searchItems(libraryDb, taskEmbedding, 3);
    libraryDb.close();
    if (matches.length > 0) {
      const context = matches.map(m => `[${m.title}]\n${m.summary}`).join("\n---\n");
      if (context.length <= 4096) {
        resolvedResources.push({ name: "Library domain context", content: context });
      }
    }
  }
} catch { /* best-effort — don't block spawn */ }
```

### Dependency

Requires 010a (embedding backfill) to be useful — without embeddings, searchItems returns nothing.

## Files

| File | Change |
|------|--------|
| `src/cortex/loop.ts` | Add Library context injection in sessions_spawn handler |

## Verification

- Spawn a task related to a Library topic → check executor logs for "Library domain context" resource
- Spawn a task unrelated to Library → no Library resource attached
