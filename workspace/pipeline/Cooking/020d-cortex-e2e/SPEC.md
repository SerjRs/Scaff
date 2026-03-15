---
id: "020d"
title: "Cortex E2E — Hippocampus Integration"
created: "2026-03-15"
author: "scaff"
priority: "medium"
status: "cooking"
moved_at: "2026-03-16"
depends_on: ["019", "023"]
---

# 020d — Cortex E2E: Hippocampus Integration via Webchat

> ## ⚠️ RE-OPENED: LLM Mocking Gap (2026-03-16)
>
> **Problem:** All 6 tests use fully mocked `callLLM` (line 13: "All LLMs are mocked. All tests are deterministic.").
> The mock `callLLM` bypasses `createGatewayLLMCaller` entirely — the function that:
> 1. Resolves auth profiles via `getProfileCandidates` (was broken — function deleted)
> 2. Assembles the tools array (had duplicate `graph_traverse`)
> 3. Calls the real Anthropic API
>
> Test E4 ("memory_query searches both hot and cold") is particularly misleading:
> it inserts a graph fact + cold fact, triggers memory_query, but only checks that
> the mock LLM responded — never inspects whether the memory_query results actually
> contained the graph fact (they didn't — `executeMemoryQuery` skips `hippocampus_facts_vec`).
>
> **Fix:** Add integration tests using the real LLM caller:
> ```typescript
> import { createGatewayLLMCaller } from "../llm-caller.js";
> import { complete } from "../../llm/simple-complete.js";
>
> // Real callLLM — exercises auth, tool assembly, API call:
> const realCallLLM = createGatewayLLMCaller({
>   provider: "anthropic",
>   modelId: "claude-sonnet-4-5",
>   agentDir: path.join(os.homedir(), ".openclaw/agents/main/agent"),
>   config: { /* load from cortex/config.json */ },
>   maxResponseTokens: 1024,
>   onError: (err) => console.error(err),
> });
>
> // For embeddings — use real Ollama nomic-embed-text:
> import { embedViaOllama } from "../tools.js"; // or the embed function from hippocampus
> ```
>
> **What to add:**
> - E4-integration: insert graph fact, call `executeMemoryQuery` with real embeddings, assert graph fact appears in results (depends on 023)
> - E7-integration: send a webchat message through `createGatewayLLMCaller` → verify no tool duplicate error, auth works, response is non-empty
> - Guard with `describe.skipIf(!process.env.RUN_INTEGRATION)`

## Goal
Test hippocampus knowledge graph integration through the full Cortex loop: hot memory in system floor, graph facts with edges, fact extraction via Gardener, cold search, eviction stubs, and revival — all exercised through webchat messages.

## Category: E (Hippocampus Integration)

## Test File
`src/cortex/__tests__/e2e-webchat-hippo.test.ts`

## Tests (~6)

### E. Hippocampus Integration

**E1. Hot memory in system floor**
Insert facts into hippocampus_facts, start Cortex with hippocampusEnabled=true → send webchat message → capture context passed to LLM → verify system floor contains "Knowledge Graph" section with those facts.

**E2. Graph facts with edges in system floor**
Insert facts + edges → verify system floor shows facts with edge breadcrumbs (e.g. `[→ because: other fact]`).

**E3. Fact extraction after conversation (Gardener)**
Send several messages via webchat, trigger fact extraction via Gardener → verify new facts appear in hippocampus_facts with source_type='conversation'.

**E4. Memory query searches both hot and cold**
Insert hot graph facts and cold facts (via eviction), mock LLM calls `memory_query` → verify results include facts from both stores.

**E5. Eviction preserves edge stubs**
Insert fact + edges, evict fact → verify edges have `is_stub=1` and `stub_topic` set. Verify system floor shows stub hints.

**E6. Revival on cold search hit**
Evict a graph fact, trigger `memory_query` that hits cold storage → verify fact is revived (status='active', edges reconnected).

## Notes
- Requires `hippocampusEnabled: true` and mock `embedFn` + `gardenerExtractLLM` in startCortex config
- Overlaps with 019 (hippocampus unit tests) but tests through the full Cortex loop, not just isolated functions

## Test Results
`workspace/pipeline/Cooking/020d-cortex-e2e/TEST-RESULTS.md`
