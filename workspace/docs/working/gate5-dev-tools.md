# Gate 5 — Dev Tools

*Ref: `ROADMAP.md`, `scaff-dev-tools.md`*
*Started: 2026-03-07*

---

## Tool Priority
1. Import & Dependency Graph (highest impact)
2. **Build + Test Runner — structured output** ← starting here (quickest win)
3. Semantic Code Search
4. Architecture State Tracker

---

## Tool 2: Structured Build + Test Runner

### Step 1: Build the wrapper script
**Plan (2026-03-07 10:00):** Create a script that wraps `pnpm build` (tsc) and `npx vitest run` with `--reporter json`, parses output into structured JSON with file/line/message for errors and test failures. Expose as a callable script at `scripts/build-test.mjs`.

**Result (2026-03-07 10:05):** Created `scripts/build-test.mjs`. Supports `--build`, `--test`, `--scope` flags. Commit `cdac7df3c`. ✅

---

### Step 2: Test with real build + test run
**Plan:** Run the script against the actual codebase, verify structured output captures real errors and test results correctly.

**Result (2026-03-07 10:05):**
- Build only: `{"build": {"success": true, "errors": []}}` ✅
- Scoped test (gardener): `{"tests": {"success": true, "passed": 14, "failed": 0, "total": 14, "duration": "0.9s"}}` ✅
- Router tests (with known failures): `{"tests": {"success": false, "passed": 189, "failed": 13, "total": 202, "failures": [...]}}` ✅
- Failure details include file, test name, and error message with line numbers ✅

---

### Step 3: Integration — make it available as a tool or alias
**Plan:** Wire into the workflow so Scaff/Claude Code can call it and get structured feedback. Consider making it a Cortex tool or a simple CLI alias.

**Result (2026-03-07 10:05):** Available as `node scripts/build-test.mjs`. No tool integration needed — Scaff can call it via `exec`. ✅

---

## Tool 1: Import & Dependency Graph

### Step 1: Build the graph analyzer
**Plan (2026-03-07 10:10):** Create a script using TypeScript Compiler API that answers: what files import this module? What does this module import? Where are startup hooks? Outputs JSON. Check if `.serena/` already provides this before building from scratch.

**Result (2026-03-07 10:15):**
- No Serena available (`.serena/` doesn't exist)
- Built `scripts/import-graph.mjs` using TypeScript Compiler API
- Indexes 4,563 source files, 14,727 import edges
- Queries: `--importers`, `--imports`, `--impact` (transitive), `--startup` (wiring chain)
- Tested: `hippocampus.ts` imported by 9 files, `gardener.ts` impacts 20 files transitively
- Commit `bd10a164d` ✅

**Note:** Graph build takes ~15s (full TS program creation). Could cache the graph to SQLite for faster repeated queries. Deferred — 15s is acceptable for now.

---

## Tool 3: Semantic Code Search

### Step 1: Build the indexer
**Plan (2026-03-07 11:10):** Create `scripts/code-index.mjs` that:
1. Walks all `.ts` source files in `src/` (skip `node_modules`, `dist`, test files)
2. Chunks each file by function/class/block boundaries (using regex, not full AST — faster, good enough)
3. Embeds each chunk via Ollama `nomic-embed-text` at `127.0.0.1:11434`
4. Stores chunks + embeddings in `scaff-tools/code-index.sqlite` using sqlite-vec
5. Tracks file modification times — re-indexes only changed files on subsequent runs

**Result:** *(pending)*

---

### Step 2: Build the query script
**Plan:** Create `scripts/code-search.mjs` that:
1. Takes a natural language query
2. Embeds the query via Ollama
3. Runs vector similarity search against the index
4. Returns top-K results with file path, line range, code snippet, similarity score

**Result:** *(pending)*

---

### Step 3: Test with real queries
**Plan:** Run 5 real queries against the indexed codebase:
1. "where is the router startup sequence"
2. "how are WhatsApp messages dispatched"
3. "where is the Cortex session stored"
4. "how does the evaluator call Ollama"
5. "where are tools registered at startup"
Verify relevant results come back with high similarity scores.

**Result:** *(pending)*
