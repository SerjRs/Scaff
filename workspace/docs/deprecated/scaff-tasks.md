# Scaff Architecture — Task Plan

> **How to use:** Execute one group at a time in Claude Code, then restart the session before moving to the next group. Groups are ordered by priority and dependency.

---

## Group 1: Long Memory — Vector Search + Deduplication + Pruning

**Why first:** Long Memory extraction (Haiku) and its separate cron job are already implemented and working. However, **search is naive keyword matching** — a query for "database choice" won't find "decided to use PostgreSQL." Hot Memory (24h) has vector search but Long Memory (permanent) does not. This is the biggest reliability gap. Additionally, there is no deduplication or pruning, so shard files grow unboundedly with duplicate facts.

### Task 1.1 — Vector-index Long Memory facts

- **File:** `src/memory/long-memory-extractor.ts`
- **Current behavior:** `searchLongMemory()` (around line 272) scans markdown shard files line-by-line, splits the query into words, and counts keyword matches. The code itself notes: _"Simple keyword matching — for full vector search, use MemoryIndexManager."_
- **Target behavior:** Long Memory search uses vector/semantic search via the same vector DB infrastructure that Hot Memory already uses (`MemoryIndexManager`).
- **Requirements:**
  - When `persistFacts()` appends a fact to the daily markdown shard, also upsert it into the vector store. Use a **separate collection/namespace** from Hot Memory (e.g. `long-memory-{agentId}`). Long Memory entries must have **no TTL** (unlike Hot Memory's 24h expiry).
  - Replace `searchLongMemory()` keyword matching with a vector similarity search against this collection.
  - Keep the markdown shard files as-is — they serve as a human-readable backup/audit trail. But **search must go through the vector index**, not file scanning.
  - Return results in the same `ExtractedFact` format so all consumers (`hot-memory-inject.ts` fallback, `long_memory_search` tool) continue working.

### Task 1.2 — Deduplicate facts on write

- **File:** `src/memory/long-memory-extractor.ts`
- **Current behavior:** If the same fact is extracted across multiple gardener cycles, it gets appended again. No dedup.
- **Target behavior:** Before persisting a new fact, check if a near-duplicate already exists.
- **Requirements:**
  - Before upserting a new fact, run a vector similarity search against the Long Memory collection with a high threshold (cosine similarity > 0.92).
  - If a near-duplicate is found, skip both the vector upsert and the markdown append for that fact.
  - Log skipped duplicates at debug level for observability.

### Task 1.3 — Add periodic pruning / consolidation

- **File:** `src/memory/long-memory-extractor.ts` or new file `src/memory/long-memory-pruner.ts`
- **Current behavior:** Shard files and vector entries grow indefinitely. No cleanup.
- **Target behavior:** Periodic consolidation removes outdated or superseded facts.
- **Requirements:**
  - Add a pruning function that can be called on a cron schedule (e.g. daily).
  - Pruning strategy: send older facts (>30 days) to Haiku in batches, ask it to identify facts that are outdated, superseded, or no longer relevant. Remove flagged facts from the vector index.
  - Do NOT delete from markdown shards (keep as permanent audit trail). Only prune the vector index.
  - Register this as a separate Router job type (e.g. `"long_memory_pruning"`) with its own cron schedule.

### Task 1.3 — Ensure every Router-spawned agent has a dedicated prompt template

- **Files:** `src/router/worker.ts`, `src/router/types.ts`, and wherever prompt templates are stored/registered
- **Current behavior:** Verify how the Router currently feeds prompts to spawned agents. Check if each agent type (`memory_cleanup`, `long_memory_extraction`, any subagent types) has its own prompt template or if they share a generic one.
- **Requirements:**
  - Every agent type the Router can spawn MUST have a dedicated prompt template registered in the Router.
  - The worker (`src/router/worker.ts`) must select and inject the correct template based on the job type when invoking an agent.
  - If any agent types are currently running without a specific template (using a generic/shared one), create dedicated templates for them.
  - Templates should be stored in a consistent location (e.g. `src/router/templates/`) and indexed by job type.

---

## Group 2: Long Memory Tool & Fallback — Wire to Vector Search

**Why second:** The `long_memory_search` tool and the automatic fallback in `hot-memory-inject.ts` already exist, but they both call `searchLongMemory()` which uses keyword matching. After Group 1 replaces search with vector, verify these access paths work correctly.

### Task 2.1 — Verify `long_memory_search` tool works with vector search

- **File:** `src/agents/tools/long-memory-search-tool.ts`
- **Action:** After Group 1 is complete, test that the tool returns semantically relevant results (not just keyword matches). Verify it calls the updated `searchLongMemory()` and returns `ExtractedFact` objects correctly.
- **If broken:** Fix the wiring so the tool uses the vector-backed search path.

### Task 2.2 — Verify automatic fallback in `hot-memory-inject.ts`

- **File:** `src/memory/hot-memory-inject.ts` (lines 49-70)
- **Action:** Confirm the fallback path (triggered when Hot Memory returns <3 results) now goes through vector search. Ensure no stale references to the old keyword-matching function remain..

---

## Group 3: Gardener Smart Truncation Audit & Hardening

**Why third:** Bad truncation silently corrupts context. The gardener claims topic-awareness but this needs verification and potential hardening.

### Task 3.1 — Audit `smart-truncation.ts` for topic boundary detection

- **File:** `src/memory/smart-truncation.ts`
- **Action:** Review the current truncation algorithm and document (as code comments at the top of the file) exactly what heuristic it uses:
  - Does it detect topic boundaries, or does it just keep complete turn pairs?
  - Does it respect the `KEEP_TAIL_MESSAGES = 20` from `src/agents/gardener.ts:15` as a soft or hard limit?
  - What happens when a single topic spans 30+ messages?
- **Output:** Add a `@description` JSDoc block at the top of the file summarizing the algorithm's actual behavior, edge cases, and known limitations.

### Task 3.2 — Make truncation AI-driven (smart truncator)

- **File:** `src/memory/smart-truncation.ts`
- **Requirements:**
  - The truncator MUST use an AI call (Haiku tier) to determine where to cut. It should send the message batch to Haiku and ask it to identify the optimal truncation point that preserves topic coherence.
  - Do NOT rely on time-gap heuristics or simple turn-pair logic — the AI must decide where topics begin and end.
  - Allow the tail to exceed 20 messages if cutting at 20 would land mid-topic. Cap at a hard maximum of 35 messages to prevent unbounded growth.
  - Fallback: if the Haiku call fails, fall back to keeping the last 20 messages as a simple tail-keep (current behavior). Log the failure.
  - Add unit tests for: normal truncation, truncation where topic spans >20 messages, Haiku call failure fallback.

---

## Group 4: Health Monitoring Foundation

**Why fourth:** No health monitoring exists. Start with lightweight diagnostics before building a full system.

### Task 4.1 — Create a health status module

- **New file:** `src/health/status.ts`
- **Requirements:**
  - Define a `HealthStatus` type with fields: `overallStatus: "green" | "yellow" | "red"`, `checks: HealthCheck[]` where each check has `name`, `status`, `lastRun`, `message`.
  - Implement checks for:
    - **Gardener freshness:** Is the last `memory_cleanup` job completion within the expected cron interval? (Query the Router queue for the latest completed `memory_cleanup` job.)
    - **Hot Memory staleness:** Is the Hot Memory watermark (`src/memory/hot-store.ts`) within the last 2× the expected ingestion interval?
    - **Context budget:** What percentage of the model's context window is currently used by the session file + hot memory injection + system prompt? Flag yellow at 80%, red at 95%.
  - Export a `getHealthStatus()` function that runs all checks and returns the aggregate status.

### Task 4.2 — Expose health to Cortex via system prompt

- **File:** `src/agents/system-prompt.ts`
- **Requirements:**
  - At system prompt assembly time, call `getHealthStatus()`.
  - If status is not "green", append a brief health advisory to the system prompt (e.g. `"[SYSTEM HEALTH: YELLOW] Gardener has not run in 2 hours. Memory may be stale."`).
  - If status is "green", don't add anything — avoid wasting tokens on "everything is fine" messages.

---

## Group 5: Spec Alignment — Update `overall-architecture.md`

**Why last:** After all code changes are done, align the spec with reality.

### Task 5.1 — Update the architecture document

- **File:** `overall-architecture.md` (project root or docs folder — find the actual location)
- **Changes:**
  - **Section 1 (Cortex):** Remove the claim that Cortex "never executes tasks by itself." Replace with: Cortex handles user conversation directly via `agentCommand()`. It delegates background tasks and subagent work to the Router via `sessions_spawn`.
  - **Section 1 (Cortex):** Remove the cross-channel linking claim, or move it to a "Future / Not Implemented" section.
  - **Section 1 (Cortex):** Update the health monitoring description to reflect the new `src/health/status.ts` implementation from Group 4.
  - **Section 3.3 (Long Memory):** Update to reflect the AI-based extraction (Haiku call) implemented in Group 1, and note it now runs as a separate Router job.
  - **Section 3.4 (Gardener):** Clarify that the gardener only handles truncation, not long memory extraction.
  - **Section 4.3/4.4 (Context layers):** Document that Long Memory is both auto-queried as a fallback (when Hot Memory returns <3 results) AND available as an explicit `long_memory_search` tool.
  - Add a version/date header so future reviews can track when the spec was last aligned.

---

## Execution Summary

| Group | Focus | Key files | Risk |
|-------|-------|-----------|------|
| **1** | Long Memory vector search + dedup + pruning + prompt templates | `long-memory-extractor.ts`, `router/worker.ts`, `router/types.ts` | Medium — replacing search backend, adding write-time dedup |
| **2** | Verify existing tool & fallback work with vector search | `long-memory-search-tool.ts`, `hot-memory-inject.ts` | Low — verification & wiring fixes |
| **3** | AI-driven smart truncation | `smart-truncation.ts` | Medium — replacing truncation logic with AI call |
| **4** | Health monitoring | New `src/health/status.ts`, `system-prompt.ts` | Low — fully additive |
| **5** | Spec alignment | `overall-architecture.md` | None — documentation only |
