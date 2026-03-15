---
id: "021"
title: "Hippocampus Full Memory Backfill — Import Scaff's Entire History"
created: "2026-03-15"
author: "scaff"
priority: "high"
status: "cooking"
depends_on: ["017a", "017d", "017e", "017i"]
---

# 021 — Hippocampus Full Memory Backfill

## Goal

Import ALL of Scaff's historical memory sources into the Hippocampus knowledge graph, so Cortex has full access to every decision, lesson, preference, event, and relationship accumulated since Feb 3, 2026.

Currently the graph has **193 facts, all from Library articles**. Zero from conversations, daily logs, or curated memory. This task fills that gap.

## Current Graph State

- **193 facts** (all `source_type: article`, from Library migration)
- **40 edges** (from Library migration)
- **0 facts** from conversations, daily logs, or curated memory

## Processing Approach

Each source type requires a different parsing strategy. The script for each subtask:

1. Reads the source files
2. Parses/chunks the content appropriately
3. Sends chunks to Haiku for fact+edge extraction (structured JSON)
4. Deduplicates against existing graph facts (cosine similarity > 0.85)
5. Inserts new facts + edges into `hippocampus_facts` / `hippocampus_edges`
6. Logs results to a report file

**LLM**: Use Haiku via `src/llm/simple-complete.ts` (NOT Ollama — too slow).
**Embeddings**: Use Ollama `nomic-embed-text` for dedup vectors.
**DB**: `cortex/bus.sqlite` — write directly to `hippocampus_facts` + `hippocampus_edges`.

---

## Subtasks (ordered by priority)

### 021a — Curated Memory Files (P0, ~160KB)

**Source files:**
- `workspace/MEMORY-BCK.md` (19KB) — Old backup of MEMORY.md before it was trimmed. Contains rich curated knowledge: preferences, architecture decisions, project history, lessons learned, people context, tool configurations.
- `workspace/MEMORY.md` (0.5KB) — Current trimmed MEMORY.md. Mostly an index now, but contains some key refs.
- `workspace/memory/long-term/people.md` (0.5KB) — People Scaff interacts with: names, roles, relationships, preferences.
- `workspace/memory/long-term/preferences.md` (1.6KB) — Serj's preferences: dark mode, minimal responses, tools, workflows.
- `workspace/memory/long-term/identity.md` (2.1KB) — Scaff's identity: name, vibe, emoji, personality traits.
- `workspace/memory/long-term/security.md` (1.4KB) — Security policies, boundaries, data handling rules.
- `workspace/memory/long-term/testing.md` (2.3KB) — Testing patterns, lessons from test failures, CI/CD notes.
- `workspace/memory/long-term/infrastructure.md` (7.6KB) — Host setup, Ollama config, gateway, rebuild scripts, scheduled tasks, ports, services.
- `workspace/memory/long-term/architecture-state.md` (9KB) — Current state of Cortex, Router, Library, Hippocampus architectures. What's active, what's deprecated.
- `workspace/memory/long-term/archived-reports-feb2026.md` (4.2KB) — Archived analysis reports from February 2026.
- `workspace/memory/long-term/mortality-review.md` (11.4KB) — Deep review of agent continuity, session lifecycle, memory persistence. Philosophical + technical.
- `workspace/memory/long-term/MEMORY_old_backup.md` (7.3KB) — Another older MEMORY backup with additional historical context.

**Parsing strategy:** Each file is small enough to send as a single chunk to Haiku. Extract facts with `source_type: "curated_memory"` and `source_ref: "memory://<filename>"`.

**What to extract:** Preferences, identity facts, relationship info, security policies, infrastructure details, architecture decisions, lessons learned.

**Expected yield:** ~100-200 facts, ~30-50 edges.

---

### 021b — Daily Memory Logs (P0, ~170KB)

**Source files:**
- `workspace/memory/2026-02-03.md` through `workspace/memory/2026-03-15.md` — **33 daily log files**

**Full file list:**
- `2026-02-03.md` (1.5KB) — First day alive
- `2026-02-04.md` (2.2KB)
- `2026-02-05.md` (3.1KB)
- `2026-02-06.md` (2.3KB)
- `2026-02-07.md` (1.7KB)
- `2026-02-08.md` (4.2KB)
- `2026-02-09.md` (12.3KB)
- `2026-02-10.md` (2.2KB)
- `2026-02-10-PHASE2-COMPLETE.md` (10.1KB) — Major milestone doc
- `2026-02-11.md` (8.8KB)
- `2026-02-12.md` (30.6KB) — Very large, busy day
- `2026-02-13.md` (7.7KB)
- `2026-02-15.md` (3KB)
- `2026-02-17.md` (1.4KB)
- `2026-02-18.md` (1.1KB)
- `2026-02-19.md` (0.6KB)
- `2026-02-23.md` (1.3KB)
- `2026-02-24.md` (1.5KB)
- `2026-02-25.md` (1.2KB)
- `2026-02-26.md` (4.2KB)
- `2026-02-27.md` (4.7KB)
- `2026-03-02.md` (3.1KB)
- `2026-03-04.md` (4.3KB)
- `2026-03-05.md` (11KB)
- `2026-03-07.md` (4.8KB)
- `2026-03-08.md` (0.8KB)
- `2026-03-09.md` (10.9KB)
- `2026-03-10.md` (8.3KB)
- `2026-03-11.md` (6.6KB)
- `2026-03-12.md` (5.9KB)
- `2026-03-13.md` (1.6KB)
- `2026-03-14.md` (5.7KB)
- `2026-03-15.md` (3KB) — Today

**Parsing strategy:** Each daily file is processed individually. Files under 8KB go as single chunks. Files over 8KB are split into ~4KB sections. Each chunk sent to Haiku for extraction. Use `source_type: "daily_log"` and `source_ref: "daily://2026-02-03"` (date from filename).

**What to extract:** Events that happened, decisions made, bugs found, features built, problems encountered, conversations with Serj, milestones reached.

**Expected yield:** ~200-400 facts, ~50-100 edges.

---

### 021c — Main Agent Fact Files (P0, ~90KB)

**Source files:**
- `agents/main/memory/long-term/facts-2026-02-20.md` (58.6KB) — Large fact dump from Feb 20
- `agents/main/memory/long-term/facts-2026-02-23.md` (23.2KB) — Fact dump from Feb 23
- `agents/main/memory/long-term/facts-2026-02-24.md` (5.6KB) — Fact dump from Feb 24
- `agents/main/memory/long-term/facts-2026-02-25.md` (1.4KB) — Fact dump from Feb 25

**Parsing strategy:** These are already structured as fact lists (one fact per line or bullet). Parse the structure first — if they're already in a structured format, extract directly. If prose, chunk into ~4KB windows and send to Haiku. Use `source_type: "agent_facts"` and `source_ref: "agent-facts://2026-02-20"`.

**What to extract:** These ARE facts already — identity info, preferences, decisions, infrastructure notes. The LLM should normalize format and extract edges between related facts.

**Expected yield:** ~150-300 facts, ~40-80 edges. High overlap with 021a (dedup will handle it).

---

### 021d — Pipeline Done Specs (P1, ~200KB)

**Source files:**
- `workspace/pipeline/Done/*/SPEC.md` — **39 completed task specifications**
- `workspace/pipeline/Done/*/CLAUDE.md` — Agent instructions for each task (contains implementation context)
- `workspace/pipeline/Done/*/STATE.md` — Final state + milestones

**Task directories (39 total):**
```
001-cortex-write-file
002-cortex-pipeline-status
003-cortex-move-file
004-cortex-delete-file
005-coding-executor
006-router-weight-timeout
007-cortex-task-context-ownership
008-dispatch-spread-replycontext
009-cortex-sync-tools-and-pipeline-completion
010a-library-embedding-backfill
010b-library-full-text-storage
010c-library-task-context
010d-library-suggestions-metrics
011-cortex-loop-silence-bugs
012-read-file-pagination
013-cortex-self-awareness
014-cortex-config-tool
015-pipeline-transition-tool
016-executor-spec-passthrough
017a-graph-schema-migration
017b-system-floor-graph-injection
017c-graph-traverse-tool
017d-conversation-fact-edges
017e-article-ingestion-graph
017f-replace-library-breadcrumbs
017g-consolidator
017h-eviction-edge-stubs
017i-library-migration-script
018-reusable-llm-client
019-hippocampus-e2e-tests
020a-cortex-e2e through 020i-cortex-e2e
```

**Parsing strategy:** For each task dir, concatenate SPEC.md + STATE.md (skip CLAUDE.md unless SPEC is missing). Send as one chunk to Haiku. Use `source_type: "pipeline_task"` and `source_ref: "pipeline://001-cortex-write-file"`.

**What to extract:** What was built, why it was built, key architecture decisions, what approach was chosen (and what was rejected), blockers encountered, final outcome.

**Expected yield:** ~100-200 facts, ~60-100 edges (many cross-task dependencies).

---

### 021e — Learning Corrections (P1, 117KB)

**Source file:**
- `learning/corrections.jsonl` (117KB) — JSONL file with correction entries

**Parsing strategy:** Parse JSONL, extract each correction entry. Group into batches of ~10 corrections per LLM call. Use `source_type: "correction"` and `source_ref: "learning://corrections"`.

**What to extract:** What the mistake was, what the correct behavior is, the lesson learned. These are HIGH VALUE for preventing repeated mistakes — extract as `fact_type: "correction"`.

**Expected yield:** ~50-100 facts (corrections), ~20-40 edges.

---

### 021f — Main Session JSONL (P1, ~4.9MB)

**Source file:**
- `agents/main/sessions/96b13e67-e9a3-43d3-b67b-20a05f87c546.jsonl` (4.9MB) — The complete main session transcript

**Parsing strategy:** This is the biggest and noisiest source. Parse the JSONL, extract only human<>assistant message pairs (skip tool calls, system messages, large code blocks). Chunk into conversation windows of ~20 message pairs (~4KB each). Send each window to Haiku for extraction. Use `source_type: "conversation"` and `source_ref: "session://96b13e67/chunk-001"`.

**Key filtering rules:**
- Skip messages that are pure tool call results (JSON blobs, file contents, command output)
- Skip system messages and compaction summaries (already processed in daily logs)
- Keep: user messages, assistant text responses, key decisions discussed
- Truncate any single message over 2KB to first 2KB

**What to extract:** Discussions with Serj about architecture, decisions made during conversations, preferences expressed, problems debugged together, project direction changes.

**Expected yield:** ~200-400 facts, ~80-150 edges.

---

### 021g — Cortex Session Archive (P1, 1.3MB)

**Source file:**
- `cortex/session-archive-2026-03-09.json` (1.3MB) — Archived Cortex session data from March 9

**Parsing strategy:** Parse JSON, extract message content. Chunk into ~4KB windows. Use `source_type: "cortex_session"` and `source_ref: "cortex-archive://2026-03-09"`.

**What to extract:** Cortex conversations (webchat interactions), decisions made through Cortex, tool usage patterns.

**Expected yield:** ~50-100 facts, ~20-40 edges.

---

### 021h — Router Executor Sessions (P2, ~8.6MB)

**Source files:**
- `agents/router-executor/sessions/*.jsonl` — **33 session files**
- Largest files: `c5352686...jsonl` (2.1MB), `2a49a3b3...jsonl` (700KB), `71ea4a7e...jsonl` (700KB)

**Parsing strategy:** Focus on the largest 10-15 sessions (the others are small/trivial). Parse each JSONL, extract assistant messages only (skip tool calls and code output). Chunk into ~4KB windows. Use `source_type: "executor_session"` and `source_ref: "executor://c5352686/chunk-001"`.

**What to extract:** What coding tasks were performed, implementation decisions, bugs encountered during coding, patterns discovered.

**Expected yield:** ~100-200 facts, ~30-60 edges.

---

### 021i — Workspace Architecture Docs (P2, ~150KB)

**Source files:**
- `workspace/docs/cortex-architecture.md` (19.7KB)
- `workspace/docs/hipocampus-architecture.md` (19.9KB)
- `workspace/docs/hipocampus-implementation.md` (20.6KB)
- `workspace/docs/library-architecture.md` (28KB)
- `workspace/docs/overall-architecture.md` (3.4KB)
- `workspace/docs/foreground-sharding-architecture.md` (17.2KB)
- `workspace/docs/cortex-subsystem-architecture.md` (45.3KB)
- `workspace/docs/executor-architecture-v2.md` (27.5KB)
- `workspace/docs/scaff-origin/whitepaper.md` (49.4KB) — Origin story / vision doc
- `workspace/docs/scaff-origin/dna.json` (33.8KB) — DNA definition
- `workspace/DNA.md` (13.2KB) — Identity DNA
- `workspace/PURPOSE.md` (2.8KB) — Core purpose

**Parsing strategy:** Each doc is chunked into ~4KB sections. Send to Haiku for extraction. Use `source_type: "architecture_doc"` and `source_ref: "docs://cortex-architecture"`.

**What to extract:** Architecture decisions, design rationale, component relationships, evolution history, why things were built the way they were.

**Expected yield:** ~150-300 facts, ~60-120 edges.

---

### 021j — Workspace Sessions (P2, ~5MB)

**Source files:**
- `workspace/sessions/*.jsonl` and `*_backup.jsonl` — **~30 files**
- Largest: `ec5d4d37..._backup.jsonl` (2MB), `32c68f81..._backup.jsonl` (2.4MB), `ad879ac6..._backup.jsonl` (808KB)

**Parsing strategy:** Same as 021f — parse JSONL, extract human<>assistant pairs, skip tool calls and large code blocks. Chunk into ~4KB windows. Use `source_type: "workspace_session"` and `source_ref: "workspace-session://<id>/chunk-001"`.

**What to extract:** Additional conversation context not captured in the main session. May overlap heavily with daily logs (dedup handles it).

**Expected yield:** ~100-200 facts, ~30-60 edges.

---

### 021k — Router Executor Workspace Docs (P2, ~200KB)

**Source files:**
- `workspace-router-executor/MEMORY.md` (1.7KB) — Executor agent's own memory
- `workspace-router-executor/immune-system-design.md` (33KB) — Security system design
- `workspace-router-executor/circuit-breaker-dlq-design.md` (44.9KB) — Resilience patterns
- `workspace-router-executor/zero-trust-analysis.md` (53.9KB) — Security analysis
- `workspace-router-executor/flight-recorder-design.md` (78.4KB) — Observability design
- `workspace-router-executor/code-quality-report.md` (9.7KB) — Code quality findings
- `workspace-router-executor/security-exposure-report.md` (8.7KB) — Security exposure
- `workspace-router-executor/memory/long-term/infrastructure.md` (2.7KB) — Executor infra notes

**Parsing strategy:** Chunk large docs into ~4KB sections. Use `source_type: "executor_doc"` and `source_ref: "executor-docs://immune-system-design"`.

**What to extract:** Security architecture decisions, resilience patterns, code quality insights. These were produced by the executor agent as analysis tasks.

**Expected yield:** ~100-200 facts, ~40-80 edges.

---

## Post-Import: Consolidation Pass (021-final)

After all subtasks complete, run the Hippocampus consolidator to discover cross-source edges:
- Entity overlap detection (same concepts mentioned in different sources)
- Embedding similarity for related but differently-worded facts
- Timeline edges (facts from same date linked by `related_to`)

This uses the existing `gardener.ts` consolidator logic.

---

## Estimated Totals

| Subtask | Source | Est. Facts | Est. Edges |
|---------|--------|-----------|-----------|
| 021a | Curated memory | 100-200 | 30-50 |
| 021b | Daily logs | 200-400 | 50-100 |
| 021c | Agent fact files | 150-300 | 40-80 |
| 021d | Pipeline specs | 100-200 | 60-100 |
| 021e | Corrections | 50-100 | 20-40 |
| 021f | Main session | 200-400 | 80-150 |
| 021g | Cortex archive | 50-100 | 20-40 |
| 021h | Executor sessions | 100-200 | 30-60 |
| 021i | Architecture docs | 150-300 | 60-120 |
| 021j | Workspace sessions | 100-200 | 30-60 |
| 021k | Executor docs | 100-200 | 40-80 |
| **Total** | | **~1300-2600** | **~460-880** |

After dedup, expect **~800-1500 unique facts** and **~300-600 edges**.

## Script Pattern

Each subtask follows the same script pattern (TypeScript, using `src/llm/simple-complete.ts`):

```typescript
import { complete } from '../src/llm/simple-complete.js';
import { DatabaseSync } from 'node:sqlite';
// ... hippocampus imports for insertFact, insertEdge, dedupAndInsertGraphFact

// 1. Read source files
// 2. Parse/chunk
// 3. For each chunk:
//    a. Call Haiku for extraction → { facts: [...], edges: [...] }
//    b. For each fact: dedupAndInsertGraphFact(db, fact, sourceType, embedFn)
//    c. For each edge: insertEdge(db, { fromFactId, toFactId, edgeType })
// 4. Log results
```

## Constraints

- **Haiku for extraction** (not Ollama — too slow, not Sonnet — too expensive for this volume)
- **Dedup against existing** — all 193 existing article facts must be checked
- **Idempotent** — re-running a subtask skips already-imported source_refs
- **Rate limiting** — add 200ms delay between Haiku calls to avoid rate limits
- **Error tolerance** — log failures, continue with next chunk
- **No data deletion** — additive only, never remove existing facts/edges
