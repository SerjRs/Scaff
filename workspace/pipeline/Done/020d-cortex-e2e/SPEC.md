---
id: "020d"
title: "Cortex E2E — Hippocampus Integration"
created: "2026-03-15"
author: "scaff"
priority: "medium"
status: "cooking"
depends_on: ["019"]
---

# 020d — Cortex E2E: Hippocampus Integration via Webchat

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
