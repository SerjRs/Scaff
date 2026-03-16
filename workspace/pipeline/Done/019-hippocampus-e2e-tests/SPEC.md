---
id: "019"
title: "Hippocampus E2E Test Suite — Full Knowledge Graph Lifecycle"
created: "2026-03-15"
author: "scaff"
priority: "high"
status: "cooking"
moved_at: "2026-03-16"
depends_on: ["017a", "017b", "017c", "017d", "017e", "017f", "017g", "017h", "017i", "018"]
---

# 019 — Hippocampus E2E Test Suite

> ## ⚠️ RE-OPENED: LLM Mocking Gap (2026-03-16)
>
> **Problem:** All 61 tests use `mockLLM` / `mockEmbedFn` — no test ever calls a real LLM.
> This means the tests validate data flow and DB operations but miss integration bugs:
> - `getProfileCandidates` was deleted but tests passed (mock bypasses entire auth path)
> - `memory_query` doesn't search `hippocampus_facts_vec` but E4 passed (mock LLM always returns canned response regardless of actual search results)
> - Duplicate tool names (`graph_traverse`) not caught (mock never sends tools to a real API)
>
> **Fix:** Add a subset of integration tests that use **real Sonnet calls** via the reusable LLM client (018).
>
> **How to call the real LLM from tests:**
> ```typescript
> import { complete } from "../../llm/simple-complete.js";
>
> // For fact extraction tests:
> const realExtractLLM: FactExtractorLLM = async (prompt: string) => {
>   return complete(prompt, { model: "claude-sonnet-4-5", maxTokens: 2048 });
> };
>
> // For Cortex loop tests (callLLM):
> // Use createGatewayLLMCaller(params) from llm-caller.ts — the REAL caller
> // that resolves auth profiles, assembles tools, and calls the Anthropic API.
> // This is the path that was completely untested and had 2 bugs.
> ```
>
> **What to do:**
> - Replace all mocked LLM calls with real Sonnet calls via `complete()` or `createGatewayLLMCaller()`
> - Replace `mockEmbedFn` with real Ollama `nomic-embed-text` embeddings
> - Tests must exercise the actual auth path, actual tool assembly, actual API responses
> - If a test was passing with mocks but fails with real LLM, that's a real bug — fix it

## Goal
Comprehensive end-to-end test suite that validates the entire Hippocampus v2 knowledge graph lifecycle — from fact storage to extraction to graph building to system floor injection to eviction to revival. Every test logs its output so you can **see** the data flowing through the system at each stage.

Each test prints a structured output block showing the state of the relevant tables before and after the operation. This is not just pass/fail — it's an observable knowledge graph lifecycle.

## Output Format

Every test MUST log its observable state using a helper:

```typescript
function dumpFacts(db: DatabaseSync, label: string): void {
  const facts = db.prepare(
    `SELECT id, substr(fact_text, 1, 60) as text, fact_type, confidence, status, 
            source_type, source_ref, hit_count, cold_vector_id
     FROM hippocampus_facts ORDER BY created_at`
  ).all();
  console.log(`\n=== ${label} — hippocampus_facts (${facts.length} rows) ===`);
  console.table(facts);
}

function dumpEdges(db: DatabaseSync, label: string): void {
  const edges = db.prepare(
    `SELECT e.id, 
            substr(f1.fact_text, 1, 30) as from_fact, 
            substr(f2.fact_text, 1, 30) as to_fact,
            e.edge_type, e.confidence, e.is_stub, e.stub_topic
     FROM hippocampus_edges e
     JOIN hippocampus_facts f1 ON e.from_fact_id = f1.id
     JOIN hippocampus_facts f2 ON e.to_fact_id = f2.id
     ORDER BY e.created_at`
  ).all();
  console.log(`\n=== ${label} — hippocampus_edges (${edges.length} rows) ===`);
  console.table(edges);
}

function dumpSystemFloor(context: AssembledContext, label: string): void {
  const floor = context.layers.find(l => l.name === "system_floor");
  console.log(`\n=== ${label} — System Floor (${floor?.tokens ?? 0} tokens) ===`);
  // Extract just the Knowledge Graph section
  const match = floor?.content.match(/## Knowledge Graph[\s\S]*?(?=\n## |$)/);
  console.log(match?.[0] ?? "(no Knowledge Graph section)");
}

function dumpCold(db: DatabaseSync, label: string): void {
  const cold = db.prepare(
    `SELECT id, substr(fact_text, 1, 60) as text FROM cortex_cold_memory ORDER BY created_at`
  ).all();
  console.log(`\n=== ${label} — cortex_cold_memory (${cold.length} rows) ===`);
  console.table(cold);
}

function dumpShards(db: DatabaseSync, label: string): void {
  const shards = db.prepare(
    `SELECT id, channel, topic, status, message_count, token_count, facts_extracted
     FROM cortex_shards ORDER BY created_at`
  ).all();
  console.log(`\n=== ${label} — cortex_shards (${shards.length} rows) ===`);
  console.table(shards);
}
```

Run tests with `--reporter=verbose` so console output is visible:
```bash
pnpm vitest run src/cortex/__tests__/e2e-hippocampus-full.test.ts --reporter=verbose
```

---

## Test Categories

### A. Schema & Storage Foundation

**A1. Graph tables created on init**
Call `initHotMemoryTable(db)` → dump all tables → verify `hippocampus_facts`, `hippocampus_edges`, `cortex_hot_memory`, `cortex_cold_memory` all exist with correct columns.

Output:
```
=== A1 — Tables after initHotMemoryTable ===
┌─────────────────────┬────────┐
│ name                │ type   │
├─────────────────────┼────────┤
│ cortex_hot_memory   │ table  │
│ cortex_cold_memory  │ table  │
│ hippocampus_facts   │ table  │
│ hippocampus_edges   │ table  │
└─────────────────────┴────────┘
```

**A2. Insert a fact and verify storage**
Insert a single fact via `insertFact()` → dump facts table → verify all fields stored correctly (id, fact_text, fact_type, confidence, status, source_type, source_ref, created_at, last_accessed_at, hit_count=0).

**A3. Insert an edge and verify storage**
Insert two facts + one edge via `insertEdge()` → dump edges table → verify from_fact_id, to_fact_id, edge_type, confidence, is_stub=0, stub_topic=null.

**A4. All fact types stored correctly**
Insert one fact of each type: fact, decision, outcome, correction, source → dump → verify fact_type column matches for each.

**A5. All edge types stored correctly**
Insert facts and create one edge of each type: because, informed_by, resulted_in, contradicts, updated_by, related_to, sourced_from, part_of → dump → verify edge_type column matches for each.

**A6. Migration from legacy hot memory**
Insert facts into `cortex_hot_memory` (legacy table), call `migrateHotMemoryToGraph()` → dump both tables → verify facts moved to `hippocampus_facts` with `source_type='conversation'`, original `cortex_hot_memory` rows still exist.

---

### B. Fact Extraction from Conversations

**B1. Extract facts from simple conversation**
Create a mock transcript:
```
Serj: We decided to use SQLite for the graph storage
Cortex: Got it, SQLite for graph storage instead of Neo4j
Serj: Yes, and we should use recursive CTEs for traversal
```
Call `extractFactsFromTranscript(mockLLM, transcript)` where mockLLM returns structured JSON:
```json
{"facts":[{"id":"f1","text":"Team decided to use SQLite for graph storage","type":"decision","confidence":"high"},{"id":"f2","text":"Neo4j was considered but rejected","type":"fact","confidence":"medium"},{"id":"f3","text":"Recursive CTEs will be used for graph traversal","type":"decision","confidence":"high"}],"edges":[{"from":"f1","to":"f2","type":"contradicts"},{"from":"f3","to":"f1","type":"informed_by"}]}
```

Verify: 3 ExtractedFacts with correct types, 2 ExtractedEdges with correct relationships.

Output: dump the parsed `ExtractionResult` structure.

**B2. Extract facts from real-ish multi-turn conversation**
Longer transcript with 10+ turns covering a debugging session. Mock LLM returns facts including `outcome` and `correction` types. Verify all types present in extraction.

**B3. Malformed LLM output — graceful fallback**
Mock LLM returns garbage text. Verify `extractFactsFromTranscript` returns `{ facts: [], edges: [] }` without throwing.

**B4. LLM returns facts without edges**
Mock LLM returns `{"facts": [...], "edges": []}`. Verify facts are extracted, empty edges handled cleanly.

**B5. Dedup — exact duplicate rejected**
Insert fact "Serj prefers dark mode". Extract the same fact again via `dedupAndInsertGraphFact()`. Dump facts → verify only 1 row.

**B6. Dedup — near-duplicate with longer text replaces**
Insert "SQLite for graph" (short). Then insert "SQLite chosen for graph storage due to simplicity" (longer, semantically similar). With mock embedFn returning similar vectors, dump facts → verify the longer version replaced the shorter one.

**B7. Dedup — different facts both kept**
Insert "Serj uses dark mode" and "The project uses TypeScript". With mock embedFn returning distant vectors, dump facts → verify 2 distinct rows.

---

### C. Shard-Aware Fact Extraction

**C1. Shard created from conversation messages**
Enable foreground sharding. Send 5 messages via `appendToSession()` + `assignMessageWithBoundaryDetection()`. Dump shards table → verify an active shard exists with correct message_count.

**C2. Closed shard triggers fact extraction**
Create a shard, add messages, close it (force via updating status='closed'). Run `runFactExtractor()` with mock LLM. Dump:
- shards table → verify `facts_extracted=1` (marked as extracted)
- hippocampus_facts → verify extracted facts exist with `source_type='conversation'`
- hippocampus_edges → verify extracted edges exist

**C3. Multiple shards — each extracted independently**
Create 2 shards on different topics. Close both. Run fact extractor. Dump facts → verify facts from both shards, with different topic contexts.

**C4. Already-extracted shard skipped**
Create and close a shard. Run fact extractor (processes it). Run fact extractor again. Dump → verify no duplicate facts, shard not reprocessed.

**C5. Fallback extraction — channel without shards**
Add messages directly to session (no sharding). Run fact extractor. Dump → verify facts extracted from raw session history.

---

### D. System Floor — Knowledge Graph Injection

**D1. Empty graph → no Knowledge Graph section**
Start with empty graph. Call `loadSystemFloor(workspaceDir)` → dump output → verify no "Knowledge Graph" section in system floor.

**D2. Facts without edges → flat list**
Insert 3 facts (no edges). Call `loadSystemFloor(workspaceDir, getTopFactsWithEdges(db, 30, 3))` → dump output → verify "Knowledge Graph (Hot Memory)" section with 3 bullet points, no edge hints.

Expected output:
```
## Knowledge Graph (Hot Memory)
- Serj prefers dark mode
- The project uses TypeScript
- SQLite chosen for graph storage
```

**D3. Facts with edges → edge breadcrumbs shown**
Insert 3 facts + 2 edges (f1→f2 "because", f1→f3 "resulted_in"). Call `loadSystemFloor` with `getTopFactsWithEdges` → dump → verify facts show edge hints:

Expected output:
```
## Knowledge Graph (Hot Memory)
- Team chose SQLite for graph [→ because: Neo4j was too heavy | → resulted_in: Recursive CTEs adopted]
- Neo4j was too heavy
- Recursive CTEs adopted
```

**D4. Evicted fact edge shows stub hint**
Insert 2 facts + edge. Evict one fact (edge becomes stub). Call `getTopFactsWithEdges` → dump → verify the stub edge shows `[evicted: <stub_topic>]`.

**D5. Top-30 ranking — hit_count + recency**
Insert 40 facts. Touch 10 of them (increment hit_count). Call `getTopFactsWithEdges(db, 30)` → dump → verify the 10 touched facts are in the top 30 (higher ranking).

**D6. Full context assembly with graph**
Start Cortex with hippocampus enabled. Insert facts + edges. Enqueue a webchat message. Capture the context passed to `callLLM`. Dump system floor → verify Knowledge Graph section present with facts and edge breadcrumbs.

---

### E. Graph Traversal

**E1. Traverse from a fact — depth 1**
Insert: A→B (because), A→C (resulted_in), D→A (informed_by). Call `traverseGraph(db, A.id, { maxDepth: 1 })`. Dump traversal result → verify A as root, B, C, D as depth-1 neighbors with correct edge types.

**E2. Traverse depth 2 — transitive connections**
Insert: A→B (because), B→C (resulted_in). Call `traverseGraph(db, A.id, { maxDepth: 2 })`. Dump → verify C appears at depth 2.

**E3. Traverse respects maxDepth**
Same graph as E2. Call with `maxDepth: 1`. Dump → verify C is NOT included.

**E4. Traverse with stub edges**
Insert A→B edge, evict B (edge becomes stub). Traverse from A → dump → verify B appears as stub with topic hint.

**E5. Traverse handles cycles**
Insert A→B, B→C, C→A (circular). Traverse from A → dump → verify no infinite loop, each fact appears once.

**E6. Traverse from non-existent fact**
Call `traverseGraph(db, "nonexistent-id")` → verify returns null or empty result, no crash.

---

### F. Library → Graph Enrichment

**F1. Article ingestion creates source node + facts + edges**
Simulate the gateway-bridge article ingestion flow:
1. Create a parsed article result with title, summary, facts, edges
2. Call `insertFact` for source node (fact_type='source', source_ref='library://item/123')
3. Call `insertFact` for each extracted fact
4. Call `insertEdge` for sourced_from + inter-fact edges

Dump facts → verify source node with fact_type='source', all facts with source_type='article', source_ref set.
Dump edges → verify sourced_from edges from each fact to source node + inter-fact edges.

**F2. Multiple articles create separate subgraphs**
Ingest 2 articles. Dump facts → verify 2 source nodes. Dump edges → verify each fact links only to its own source node.

**F3. Consolidator discovers cross-article connections**
Ingest 2 articles with related content (e.g., both mention "SQLite"). Run `runConsolidation()` with mock LLM that returns a `related_to` edge between facts from different articles. Dump:
- hippocampus_facts → facts from both articles
- hippocampus_edges → verify new `related_to` edge crosses article boundaries (different source_refs)

**F4. Consolidator skips already-connected facts**
Insert 2 facts with an existing edge. Run consolidation. Dump edges → verify no duplicate edge created.

**F5. Consolidator — empty recent facts → no-op**
Run consolidation with `since` far in the future. Verify result: factsScanned=0, edgesDiscovered=0.

**F6. Article source_ref enables idempotent ingestion**
Insert article source node with source_ref='library://item/42'. Try to ingest same article again (check for existing source_ref). Dump → verify only 1 source node for that item.

---

### G. Fact Lifecycle — Promotion & Demotion

**G1. New fact starts at hit_count=0, status=active**
Insert fact → dump → verify hit_count=0, status='active'.

**G2. touchGraphFact increments hit_count + updates last_accessed_at**
Insert fact. Call `touchGraphFact(db, id)` 3 times. Dump → verify hit_count=3, last_accessed_at updated.

**G3. Frequently accessed facts rank higher**
Insert 5 facts. Touch facts 3 and 5 multiple times. Call `getTopFactsWithEdges(db, 3)` → dump → verify facts 3 and 5 appear in top 3.

**G4. Stale facts identified for eviction**
Insert 5 facts. Manually set 2 facts to have old `created_at` (30 days ago) and `hit_count=1`. Call `getStaleGraphFacts(db, 14, 3)` → dump → verify only the 2 old low-hit facts returned.

**G5. Active high-hit facts survive eviction scan**
Insert fact, touch it 10 times. Set old created_at. Call `getStaleGraphFacts` → dump → verify this fact is NOT returned (hit_count > threshold).

**G6. Full eviction flow — fact → cold storage**
Insert fact + embedding. Call `evictFact(db, id, embedding)`. Dump:
- hippocampus_facts → verify status='evicted', cold_vector_id set
- cortex_cold_memory → verify fact text appears in cold storage
- hippocampus_edges → verify connected edges have is_stub=1, stub_topic set

**G7. Evicted fact excluded from system floor**
Insert 3 facts. Evict 1. Call `getTopFactsWithEdges(db, 30)` → dump → verify only 2 active facts returned.

**G8. Revival — cold fact comes back**
Evict a fact. Call `reviveFact(db, id)`. Dump:
- hippocampus_facts → verify status='active', hit_count=1, cold_vector_id=NULL
- hippocampus_edges → verify edges with active endpoints have is_stub=0 restored

**G9. Revival reconnects edges to active neighbors**
Insert A, B, C with edges A→B, A→C. Evict A (both edges become stubs). Revive A. Dump edges → verify both edges restored (is_stub=0) since B and C are still active.

**G10. Partial revival — one neighbor still evicted**
Insert A, B with edge A→B. Evict both A and B. Revive only A. Dump edges → verify A→B edge stays as stub (B still evicted).

**G11. Stub pruning — old bilateral stubs deleted**
Insert A, B with edge. Evict both. Manually set edge created_at to 120 days ago. Call `pruneOldStubs(db, 90)` → dump → verify edge deleted.

**G12. Stub pruning — keeps recent stubs**
Same as G11 but edge created_at is 30 days ago. Call `pruneOldStubs(db, 90)` → dump → verify edge still exists.

**G13. Stub pruning — keeps stubs with one active endpoint**
Insert A, B with edge. Evict only B. Edge is old (120 days). Call `pruneOldStubs` → dump → verify edge NOT deleted (A is still active).

---

### H. Full Vector Evictor Integration

**H1. runVectorEvictor processes stale graph facts**
Insert 3 facts: 1 fresh (today), 2 old (30 days ago, low hit_count). Run `runVectorEvictor` with mock embedFn. Dump:
- hippocampus_facts → 1 active, 2 evicted
- cortex_cold_memory → 2 rows

**H2. runVectorEvictor also processes legacy hot memory**
Insert facts in both `cortex_hot_memory` (legacy) and `hippocampus_facts`. Run evictor. Dump → verify both legacy and graph facts evicted.

**H3. runVectorEvictor calls pruneOldStubs**
Create old bilateral stubs. Run evictor. Dump edges → verify old stubs pruned.

---

### I. Memory Query Integration

**I1. memory_query finds hot graph facts**
Insert facts into hippocampus_facts. Call `executeMemoryQuery(db, { query: "...", embedFn })`. Dump → verify matching facts returned.

**I2. memory_query finds cold facts**
Insert fact, evict it to cold storage with embedding. Call `executeMemoryQuery` with similar query embedding. Dump → verify cold fact found.

**I3. memory_query triggers revival on cold hit**
Insert graph fact, evict it. Query cold storage and find it. Dump hippocampus_facts → verify the graph fact was revived (status='active').

**I4. memory_query touches accessed graph facts**
Insert graph fact with hit_count=0. Call `executeMemoryQuery` that finds it. Dump → verify hit_count incremented.

---

### J. End-to-End Lifecycle Scenarios

**J1. Full conversation → extraction → graph → system floor**
1. Start Cortex with hippocampus + sharding enabled
2. Send 5 webchat messages (a discussion about architecture decisions)
3. Force-close the shard
4. Run fact extractor (mock LLM returns typed facts + edges)
5. Dump hippocampus_facts + hippocampus_edges
6. Send another webchat message
7. Capture context passed to callLLM
8. Dump system floor → verify Knowledge Graph section contains the extracted facts with edge breadcrumbs

**J2. Article ingest → consolidation → unified graph**
1. Insert conversation facts (from J1-style flow)
2. Ingest an article (simulate gateway-bridge flow) about a related topic
3. Run consolidation (mock LLM finds cross-source connections)
4. Dump full graph: facts from both sources, edges including cross-source, sourced_from
5. Call `getTopFactsWithEdges` → verify unified view shows conversation + article facts interleaved

**J3. Fact lifecycle: birth → promotion → eviction → revival**
1. Extract fact from conversation → dump (status=active, hit_count=0)
2. Simulate the fact being useful: touchGraphFact 5 times → dump (hit_count=5)
3. Time passes: set created_at to 30 days ago, hit_count stays high → verify NOT evicted
4. Simulate disuse: reset hit_count to 1 → run evictor → dump (status=evicted, in cold storage, edges are stubs)
5. Later: memory_query hits the cold fact → dump (revived, status=active, hit_count=1, edges reconnected)

**J4. Graph growth with 50 facts across 3 sources**
1. Insert 20 conversation facts with 10 edges
2. Ingest 2 articles (15 facts each, 5 edges each)
3. Run consolidation → adds cross-source edges
4. Run evictor → evicts stale facts
5. Call `getTopFactsWithEdges(db, 30, 3)` → dump the full top-30 view
6. Traverse from a high-connectivity fact → dump the subgraph
7. Print summary: total facts (active/evicted), total edges (live/stub), by source_type

**J5. Contradiction handling**
1. Insert fact A: "The system uses PostgreSQL" (from early conversation)
2. Later insert fact B: "We migrated to SQLite" (from later conversation)  
3. Create edge A→B type "contradicts"
4. Run evictor (A is old, low-hit) → A evicted
5. Dump: verify B is active, A is evicted, contradiction edge is a stub but still visible
6. System floor shows B with `[→ contradicts: [evicted: The system uses PostgreSQL]]`

---

## Files
| File | Description |
|------|-------------|
| `src/cortex/__tests__/e2e-hippocampus-full.test.ts` | Main test file — all categories A through J |
| `src/cortex/__tests__/helpers/hippo-test-utils.ts` | Shared helpers: dumpFacts, dumpEdges, dumpSystemFloor, dumpCold, dumpShards, mockEmbedFn, mockExtractLLM |

## Estimated Test Count
~55 tests across 10 categories.

## Test Results File

Every test writes its results to a structured markdown file at:
```
workspace/pipeline/Cooking/019-hippocampus-e2e-tests/TEST-RESULTS.md
```

The file is generated automatically by the test suite. Format:

```markdown
# Hippocampus E2E Test Results
Generated: 2026-03-15T14:00:00Z

## Summary
- Total: 55
- Passed: 52
- Failed: 3
- Duration: 12.4s

## A. Schema & Storage Foundation

### A1. Graph tables created on init ✅
**Expected:** hippocampus_facts, hippocampus_edges, cortex_hot_memory, cortex_cold_memory tables exist
**Result:** All 4 tables created successfully
**Tables found:** cortex_hot_memory, cortex_cold_memory, hippocampus_facts, hippocampus_edges

### A2. Insert a fact and verify storage ✅
**Expected:** Fact stored with all fields populated, hit_count=0, status=active
**Result:** Fact inserted, all fields match
**Data:**
| id | text | fact_type | confidence | status | hit_count |
|----|------|-----------|------------|--------|-----------|
| abc-123 | Serj prefers dark mode | fact | high | active | 0 |

### D3. Facts with edges → edge breadcrumbs shown ❌
**Expected:** System floor shows edge hints like [→ because: ...]
**Result:** Edge hints missing — getTopFactsWithEdges returned empty edges array
**Data:**
System Floor content:
## Knowledge Graph (Hot Memory)
- Team chose SQLite for graph
- Neo4j was too heavy
```

### Implementation

The test suite uses a `TestReporter` class that collects results and writes the file:

```typescript
class TestReporter {
  private results: TestResult[] = [];
  
  record(test: {
    id: string;          // "A1", "B2", etc.
    name: string;
    category: string;
    passed: boolean;
    expected: string;
    actual: string;
    data?: string;       // table dumps, system floor content, etc.
    error?: string;       // stack trace if failed
  }): void;
  
  writeReport(outputPath: string): void;  // writes TEST-RESULTS.md
}
```

Each test calls `reporter.record(...)` with expected vs actual. In `afterAll()`, the reporter writes the markdown file.

## Run Command
```bash
pnpm vitest run src/cortex/__tests__/e2e-hippocampus-full.test.ts --reporter=verbose 2>&1 | tee hippocampus-e2e.log
```

After the run, review: `workspace/pipeline/Cooking/019-hippocampus-e2e-tests/TEST-RESULTS.md`

## Notes
- All tests use temp dirs + temp DBs — fully isolated
- Mock LLMs return deterministic JSON — no API calls
- Mock embedFn uses seeded sin-wave vectors (deterministic, works for dedup threshold testing)
- Tests are ordered by lifecycle stage — read top to bottom to see a fact's journey from birth to death to revival
- The dump functions use `console.table` for readable output — run with `--reporter=verbose` to see them
- For vec table tests, call `initGraphVecTable(db)` + `initColdStorage(db)` in setup
- TEST-RESULTS.md is the primary review artifact — shows expected vs actual for every test
