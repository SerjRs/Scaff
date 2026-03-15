# Claude Code Instructions — 017e

## Branch
`feat/017e-article-ingestion-graph`

## Context
When a URL is ingested via the Librarian executor, the result is parsed in `gateway-bridge.ts` and stored in the Library DB (`library.sqlite`). This task extends that pipeline to ALSO extract facts+edges from articles and store them in the knowledge graph (`hippocampus_facts` + `hippocampus_edges` in `bus.sqlite`).

## What to Build

### 1. Extend Librarian prompt — `src/library/librarian-prompt.ts`

Add facts and edges to the JSON output schema. After the existing `"full_text"` field in the schema example, add:

```
  "facts": [
    {"id": "f1", "text": "...", "type": "fact|decision|outcome|correction", "confidence": "high|medium|low"},
    ...
  ],
  "edges": [
    {"from": "f1", "to": "f2", "type": "because|informed_by|resulted_in|contradicts|updated_by|related_to"},
    ...
  ]
```

Add these rules to the Rules section:
```
- facts: Extract 3-10 key facts from the article. Each should be a standalone statement of knowledge. Types: fact (claims, data points), decision (recommendations, conclusions), outcome (results, findings), correction (debunking, errata).
- edges: Identify relationships between extracted facts. Only include edges where the relationship is clearly stated in the article. If no clear relationships exist, use an empty array.
```

### 2. Parse facts/edges in gateway-bridge.ts — after Library DB write

In `src/cortex/gateway-bridge.ts`, find the Library task handler (around line 325-410). After the existing `insertItem()` call and embedding generation, add graph ingestion.

**Location:** Inside the `if (libraryUrl)` + `if (job.status === "completed")` block, after the `job.result = ...` lines (around line 384-385), but still inside the `try` block before the `finally { libraryDb.close(); }`.

**Add this code:**

```typescript
// --- Graph ingestion (017e): extract facts+edges into hippocampus ---
try {
  const hippo = require("./hippocampus.js");
  const parsedFacts = parsed.facts as Array<{ id: string; text: string; type?: string; confidence?: string }> | undefined;
  const parsedEdges = parsed.edges as Array<{ from: string; to: string; type: string }> | undefined;

  if (parsedFacts && parsedFacts.length > 0) {
    // Create article source node
    const sourceFactId = hippo.insertFact(instance.db, {
      factText: `Article: ${parsed.title}`,
      factType: "source",
      confidence: "high",
      sourceType: "article",
      sourceRef: `library://item/${itemId}`,
    });

    // Map local IDs (f1, f2...) to real UUIDs
    const idMap = new Map<string, string>();

    for (const f of parsedFacts) {
      if (!f.text?.trim()) continue;
      const factId = hippo.insertFact(instance.db, {
        factText: f.text.trim(),
        factType: f.type ?? "fact",
        confidence: f.confidence ?? "medium",
        sourceType: "article",
        sourceRef: `library://item/${itemId}`,
      });
      idMap.set(f.id, factId);

      // Link fact to article source
      hippo.insertEdge(instance.db, {
        fromFactId: factId,
        toFactId: sourceFactId,
        edgeType: "sourced_from",
      });
    }

    // Insert edges between facts
    if (parsedEdges) {
      for (const e of parsedEdges) {
        const fromId = idMap.get(e.from);
        const toId = idMap.get(e.to);
        if (fromId && toId && fromId !== toId) {
          hippo.insertEdge(instance.db, {
            fromFactId: fromId,
            toFactId: toId,
            edgeType: e.type,
          });
        }
      }
    }

    params.log.info?.(`[library] Graph: ${parsedFacts.length} facts + ${parsedEdges?.length ?? 0} edges from "${parsed.title}"`);
  }
} catch (graphErr) {
  // Graph ingestion is best-effort — don't fail the Library write
  params.log.warn?.(`[library] Graph ingestion failed: ${graphErr instanceof Error ? graphErr.message : String(graphErr)}`);
}
```

**Important:** Also update the `parsed` type annotation (around line 347) to include the new fields:

Change:
```typescript
const parsed = JSON.parse(jsonStr) as {
  title: string; summary: string; key_concepts: string[];
  tags: string[]; content_type: string; source_quality: string;
  full_text?: string;
};
```
To:
```typescript
const parsed = JSON.parse(jsonStr) as {
  title: string; summary: string; key_concepts: string[];
  tags: string[]; content_type: string; source_quality: string;
  full_text?: string;
  facts?: Array<{ id: string; text: string; type?: string; confidence?: string }>;
  edges?: Array<{ from: string; to: string; type: string }>;
};
```

### 3. Ensure `initGraphTables` is called at startup

Check that `initHotMemoryTable(db)` is called during Cortex startup (it should already be — it was added in 017a). This ensures `hippocampus_facts` and `hippocampus_edges` tables exist when gateway-bridge tries to write to them. No changes needed if it's already called.

## Files to Modify
| File | Change |
|------|--------|
| `src/library/librarian-prompt.ts` | Add facts + edges to output schema and rules |
| `src/cortex/gateway-bridge.ts` | Parse facts/edges from executor result, write to graph |

## Tests

Write tests in `src/cortex/__tests__/article-ingestion-graph.test.ts`:

1. **Librarian prompt includes facts/edges schema** — import `buildLibrarianPrompt`, verify output contains "facts" and "edges" fields
2. **Graph ingestion creates source node + facts + edges** — simulate the gateway-bridge graph ingestion logic directly:
   - Set up bus.sqlite with `initBus()` + `initHotMemoryTable()`
   - Call `insertFact` and `insertEdge` in the same pattern as gateway-bridge
   - Verify article source node exists with `fact_type='source'`
   - Verify extracted facts have `source_type='article'` and `source_ref` set
   - Verify `sourced_from` edges connect facts to source node
   - Verify inter-fact edges exist
3. **Graceful skip when no facts in output** — parsed object without `facts` field, verify no graph writes happen and no errors
4. **Edge insertion skips invalid references** — edge with `from: "f99"` (nonexistent), verify silently skipped

Use `initBus()` + `initSessionTables()` + `initHotMemoryTable()` for DB setup.
Import `insertFact`, `insertEdge`, `getFactWithEdges` from hippocampus.ts for assertions.

## Constraints
- Do NOT modify `insertItem()` or any Library DB functions
- Graph ingestion must be best-effort — wrapped in try/catch, Library storage works even if graph fails
- Use `require()` for hippocampus import in gateway-bridge (existing pattern in that file — it uses require for library/db.js too)
- When done, commit, push branch, create PR, then run: `openclaw system event --text "Done 017e article ingestion graph"`
