# Claude Code Instructions — 019

## Branch
`feat/019-hippocampus-e2e-tests`

## Context
The Hippocampus v2 knowledge graph was built across tasks 017a–017i + 018. This task creates a comprehensive E2E test suite that validates the entire lifecycle: storage → extraction → graph building → system floor injection → promotion → eviction → revival. Every test writes its expected/actual results to TEST-RESULTS.md for human review.

## What to Build

### 1. Test Reporter — `src/cortex/__tests__/helpers/hippo-test-utils.ts`

Create a shared helper file with:

**TestReporter class:**
```typescript
interface TestResult {
  id: string;          // "A1", "B2"
  name: string;
  category: string;
  passed: boolean;
  expected: string;
  actual: string;
  data?: string;       // table dumps, etc.
  error?: string;
  durationMs?: number;
}

class TestReporter {
  private results: TestResult[] = [];
  private startTime = Date.now();

  record(result: TestResult): void {
    this.results.push(result);
  }

  writeReport(outputPath: string): void {
    const totalMs = Date.now() - this.startTime;
    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;

    let md = `# Hippocampus E2E Test Results\n`;
    md += `Generated: ${new Date().toISOString()}\n\n`;
    md += `## Summary\n`;
    md += `- Total: ${this.results.length}\n`;
    md += `- Passed: ${passed}\n`;
    md += `- Failed: ${failed}\n`;
    md += `- Duration: ${(totalMs / 1000).toFixed(1)}s\n\n`;

    // Group by category
    const categories = new Map<string, TestResult[]>();
    for (const r of this.results) {
      const cat = categories.get(r.category) ?? [];
      cat.push(r);
      categories.set(r.category, cat);
    }

    for (const [category, tests] of categories) {
      md += `## ${category}\n\n`;
      for (const t of tests) {
        const icon = t.passed ? '✅' : '❌';
        md += `### ${t.id}. ${t.name} ${icon}\n`;
        md += `**Expected:** ${t.expected}\n`;
        md += `**Result:** ${t.actual}\n`;
        if (t.data) {
          md += `**Data:**\n\`\`\`\n${t.data}\n\`\`\`\n`;
        }
        if (t.error) {
          md += `**Error:**\n\`\`\`\n${t.error}\n\`\`\`\n`;
        }
        md += `\n`;
      }
    }

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, md, 'utf-8');
    console.log(`\nTest report written to: ${outputPath}`);
  }
}
```

**Dump helpers** (return strings, don't just console.log):
```typescript
function dumpFacts(db: DatabaseSync, label: string): string {
  const facts = db.prepare(
    `SELECT id, substr(fact_text, 1, 60) as text, fact_type, confidence, status,
            source_type, source_ref, hit_count, cold_vector_id
     FROM hippocampus_facts ORDER BY created_at`
  ).all();
  let out = `${label} — hippocampus_facts (${facts.length} rows)\n`;
  for (const f of facts) {
    out += `  ${(f as any).text} | type=${(f as any).fact_type} status=${(f as any).status} hits=${(f as any).hit_count}\n`;
  }
  return out;
}

function dumpEdges(db: DatabaseSync, label: string): string {
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
  let out = `${label} — hippocampus_edges (${edges.length} rows)\n`;
  for (const e of edges) {
    const stub = (e as any).is_stub ? ` [STUB: ${(e as any).stub_topic}]` : '';
    out += `  ${(e as any).from_fact} → ${(e as any).to_fact} (${(e as any).edge_type})${stub}\n`;
  }
  return out;
}

function dumpCold(db: DatabaseSync, label: string): string { ... }
function dumpShards(db: DatabaseSync, label: string): string { ... }
```

**Mock helpers:**
```typescript
/** Deterministic 768-dim mock embedding seeded from text */
function mockEmbedding(seed: number): Float32Array {
  const emb = new Float32Array(768);
  for (let i = 0; i < 768; i++) emb[i] = Math.sin(seed * (i + 1));
  return emb;
}

const mockEmbedFn = async (text: string): Promise<Float32Array> => {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) | 0;
  return mockEmbedding(seed);
};
```

Export everything: `TestReporter`, dump helpers, mock helpers.

### 2. Main test file — `src/cortex/__tests__/e2e-hippocampus-full.test.ts`

Read SPEC.md for the full list of 55 tests across categories A–J. Implement ALL of them.

**Key structure:**
```typescript
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { TestReporter, dumpFacts, dumpEdges, ... } from "./helpers/hippo-test-utils.js";

const reporter = new TestReporter();
const REPORT_PATH = path.resolve(__dirname, "../../../../workspace/pipeline/Cooking/019-hippocampus-e2e-tests/TEST-RESULTS.md");

// ... setup/teardown ...

afterAll(() => {
  reporter.writeReport(REPORT_PATH);
});

describe("A. Schema & Storage Foundation", () => {
  it("A1. Graph tables created on init", () => {
    // ... test logic ...
    reporter.record({
      id: "A1",
      name: "Graph tables created on init",
      category: "A. Schema & Storage Foundation",
      passed: true, // or false
      expected: "hippocampus_facts, hippocampus_edges, cortex_hot_memory, cortex_cold_memory exist",
      actual: `Found tables: ${tableNames.join(", ")}`,
      data: dumpFacts(db, "After init"),
    });
    expect(tableNames).toContain("hippocampus_facts");
    // ...
  });
});
```

**IMPORTANT:** Each test MUST:
1. Call `reporter.record(...)` with expected, actual, and data (table dumps)
2. ALSO use `expect()` assertions so vitest reports pass/fail
3. If the test fails unexpectedly (throws), catch the error and record it:
```typescript
try {
  // test logic
  reporter.record({ ..., passed: true, actual: "..." });
  expect(...).toBe(...);
} catch (err) {
  reporter.record({ ..., passed: false, actual: "THREW", error: err.message });
  throw err; // re-throw so vitest sees the failure
}
```

### 3. Test setup pattern

Each test category gets its own `describe` block. Use `beforeEach` to create fresh temp dir + DB:

```typescript
let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hippo-e2e-"));
  db = new DatabaseSync(path.join(tmpDir, "bus.sqlite"));
  // Init all tables
  initHotMemoryTable(db);
  initGraphTables(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

For tests that need vec tables (dedup, cold storage, eviction):
```typescript
beforeEach(async () => {
  // ... base setup ...
  await initGraphVecTable(db);
  await initColdStorage(db);
  await initHotMemoryVecTable(db);
});
```

**Note:** Vec table init is async. If you can't use async beforeEach, call these at the start of each test that needs them.

### 4. Specific test implementation notes

**Category B (Fact Extraction):** Import `extractFactsFromTranscript` from `gardener.ts`. This function is not currently exported — you may need to check if it's exported. If not, test via `runFactExtractor` which calls it internally.

Actually, check the gardener.ts exports first:
```bash
grep "export.*extractFactsFromTranscript" src/cortex/gardener.ts
```
If it's not exported, either:
- Export it (preferred — add `export` keyword)
- Or test extraction indirectly through `runFactExtractor` with a mock LLM

**Category C (Shards):** Import shard functions from `shards.ts`:
- `assignMessageWithBoundaryDetection`, `getActiveShard`, `getShardMessages`
- To close a shard: `db.prepare("UPDATE cortex_shards SET status = 'closed' WHERE id = ?").run(shardId)`
- The `facts_extracted` column is set by `markShardExtracted(db, shardId)` — import from gardener.ts internals or check shards.ts

**Category D (System Floor):** Import `loadSystemFloor` from `context.ts` and `getTopFactsWithEdges` from `hippocampus.ts`. Create a temp workspace dir with a SOUL.md file.

**Category E (Graph Traversal):** Import `traverseGraph` from `hippocampus.ts`. It returns `TraversalNode[]` with depth, edges, etc.

**Category F (Library):** Don't actually import from library — just simulate the insertion pattern from gateway-bridge.ts: insert source node + facts + sourced_from edges manually.

**Category G (Promotion/Demotion):** For setting old timestamps:
```typescript
db.prepare("UPDATE hippocampus_facts SET created_at = ?, last_accessed_at = ? WHERE id = ?")
  .run(oldDate, oldDate, factId);
```

**Category J (Full Lifecycle):** These are integration tests that combine multiple categories. Use `startCortex` from `../index.js` for J1 and J6, or build up the state manually for others.

### 5. Report path

The TEST-RESULTS.md file MUST be written to:
```
workspace/pipeline/Cooking/019-hippocampus-e2e-tests/TEST-RESULTS.md
```

Use this path relative to the project root:
```typescript
const REPORT_PATH = path.resolve(
  process.cwd(),
  "workspace/pipeline/Cooking/019-hippocampus-e2e-tests/TEST-RESULTS.md"
);
```

Or if running from worktree, resolve relative to `__dirname`:
```typescript
const REPORT_PATH = path.resolve(
  __dirname, "../../../../workspace/pipeline/Cooking/019-hippocampus-e2e-tests/TEST-RESULTS.md"
);
```

Check which approach works — the key is that the file ends up in the right place.

## Files to Create
| File | Description |
|------|-------------|
| `src/cortex/__tests__/helpers/hippo-test-utils.ts` | TestReporter, dump helpers, mock helpers |
| `src/cortex/__tests__/e2e-hippocampus-full.test.ts` | All 55 tests across categories A–J |

## After Implementation

1. Run the tests:
```bash
cd /path/to/worktree && pnpm vitest run src/cortex/__tests__/e2e-hippocampus-full.test.ts --reporter=verbose 2>&1
```

2. Check TEST-RESULTS.md exists and has content

3. Commit everything (including TEST-RESULTS.md from the first run)

4. Push branch, create PR

5. Run: `openclaw system event --text "Done 019 hippocampus e2e tests"`

## Constraints
- Do NOT modify any source files — this is a test-only task
- Exception: you MAY add `export` to `extractFactsFromTranscript` in gardener.ts if it's not already exported
- All tests must be deterministic (no real LLM calls, no network)
- TEST-RESULTS.md must be generated by the test run, not hand-written
- Use `console.log` for verbose output during test runs AND write to TEST-RESULTS.md
