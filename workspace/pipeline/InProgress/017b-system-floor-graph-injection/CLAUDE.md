# Claude Code Instructions — 017b

## Branch
`feat/017b-system-floor-graph-injection`

## What to Change

In `src/cortex/context.ts`:

### 1. Update imports

Replace:
```typescript
import type { HotFact } from "./hippocampus.js";
```
With:
```typescript
import type { GraphFactWithEdges } from "./hippocampus.js";
```

### 2. Update `loadSystemFloor()`

Change the signature from `hotFacts?: HotFact[]` to `graphFacts?: GraphFactWithEdges[]`.

Replace the flat fact injection block:
```typescript
if (hotFacts && hotFacts.length > 0) {
  const factsText = hotFacts
    .map((f) => `- ${f.factText}`)
    .join("\n");
  sections.push(`## Known Facts\n${factsText}`);
}
```

With graph-aware injection:
```typescript
if (graphFacts && graphFacts.length > 0) {
  const lines = graphFacts.map((f) => {
    if (f.edges.length === 0) return `- ${f.factText}`;
    const edgeHints = f.edges
      .map((e) => `→ ${e.edgeType}: ${e.isStub ? `[evicted: ${e.targetHint}]` : e.targetHint}`)
      .join(" | ");
    return `- ${f.factText} [${edgeHints}]`;
  });
  sections.push(`## Knowledge Graph (Hot Memory)\n${lines.join("\n")}`);
}
```

### 3. Update `assembleContext()`

Find where `getTopHotFacts` is called (around line 400):
```typescript
const { getTopHotFacts } = await import("./hippocampus.js");
hotFacts = getTopHotFacts(db, 50);
```

Replace with:
```typescript
const { getTopFactsWithEdges } = await import("./hippocampus.js");
const graphFacts = getTopFactsWithEdges(db, 30, 3);
```

Update the call to `loadSystemFloor` to pass `graphFacts` instead of `hotFacts`.

Also update the variable declarations to match — replace `let hotFacts: HotFact[] | undefined` with `let graphFacts: GraphFactWithEdges[] | undefined`.

### 4. Keep backward compatibility

If `getTopFactsWithEdges` throws (e.g., new tables don't exist yet), fall back to the old `getTopHotFacts` approach. Wrap in try/catch:

```typescript
let graphFacts: GraphFactWithEdges[] | undefined;
try {
  const { getTopFactsWithEdges } = await import("./hippocampus.js");
  graphFacts = getTopFactsWithEdges(db, 30, 3);
} catch {
  // Fallback to old hot facts if graph tables don't exist
  const { getTopHotFacts } = await import("./hippocampus.js");
  const hotFacts = getTopHotFacts(db, 50);
  graphFacts = hotFacts.map(f => ({
    ...f, factType: 'fact', confidence: 'medium', status: 'active',
    sourceType: null, sourceRef: null,
    edges: []
  }));
}
```

## Constraints
- Do NOT change any other files
- Do NOT remove the Library breadcrumb injection (that's 017f)
- The `loadSystemFloor` function must still work if graphFacts is empty or undefined
- Update STATE.md after completion

## Tests
No new test file needed — the existing context assembly tests should still pass. Verify with:
```bash
npx vitest run src/cortex/__tests__/ 2>&1 | tail -20
```

When done, commit and run: `openclaw system event --text 'Done: 017b — System Floor graph injection' --mode now`
