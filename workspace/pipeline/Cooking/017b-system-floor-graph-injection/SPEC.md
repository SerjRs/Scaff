---
id: "017b"
title: "System Floor injection with edge breadcrumbs"
created: "2026-03-14"
author: "scaff"
priority: "critical"
status: "cooking"
moved_at: "2026-03-14"
depends_on: ["017a"]
parent: "017"
---

# 017b — System Floor Graph Injection

## Depends on
017a (graph schema + CRUD)

## Touches
- `src/cortex/context.ts`

## What to Change

**`loadSystemFloor()`** — currently injects flat facts:
```typescript
// CURRENT:
const factsText = hotFacts.map((f) => `- ${f.factText}`).join("\n");
sections.push(`## Known Facts\n${factsText}`);
```

Replace with graph-aware injection:
```typescript
// NEW:
const lines = graphFacts.map((f) => {
  const edgeHints = f.edges
    .map((e) => `→ ${e.edgeType}: ${e.targetHint}`)
    .join(" | ");
  return edgeHints ? `- ${f.factText} [${edgeHints}]` : `- ${f.factText}`;
});
sections.push(`## Knowledge Graph (Hot Memory)\n${lines.join("\n")}`);
```

**`assembleContext()`** — currently calls `getTopHotFacts(db, 50)`. Replace with `getTopFactsWithEdges(db, 30, 3)` from 017a.

## What to Delete
- `hotFacts` parameter from `loadSystemFloor()` signature
- Flat fact injection code
- `HotFact` import (replace with new graph type from hippocampus.ts)

## What NOT to Change
- Library breadcrumb injection (removed in 017f, not here)
- `memory_query` tool

## Tests
- Graph facts with edges produce `[→ type: hint]` format
- Token budget stays under 15-20% of max context
- Empty graph produces no "Knowledge Graph" section
- Facts without edges render without brackets

## Files
| File | Change |
|------|--------|
| `src/cortex/context.ts` | Replace flat injection with graph breadcrumbs |
