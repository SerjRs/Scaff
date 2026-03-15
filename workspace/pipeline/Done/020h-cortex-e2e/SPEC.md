---
id: "020h"
title: "Cortex E2E — Library Integration"
created: "2026-03-15"
author: "scaff"
priority: "medium"
status: "cooking"
depends_on: []
---

# 020h — Cortex E2E: Library Integration via Webchat

## Goal
Test library ingestion flow through webchat: LLM triggers `library_ingest`, executor processes the article, results flow back into hippocampus graph.

## Category: I (Library Integration)

## Test File
`src/cortex/__tests__/e2e-webchat-library.test.ts`

## Tests (~2)

### I. Library Integration

**I1. library_ingest tool triggers executor**
Mock LLM calls `library_ingest(url)` → verify the task meta is stored and onSpawn is called with the Librarian executor details.

**I2. Article ingestion writes to graph**
Simulate complete library ingestion: executor returns JSON with title, summary, facts, and edges → verify:
- Library item created in library.sqlite
- hippocampus_facts populated with source node + extracted facts
- hippocampus_edges populated with sourced_from edges linking facts to source

## Notes
- library_ingest is async (spawns Librarian executor)
- The gateway-bridge handles executor result → library + graph writes
- Test I2 needs to simulate the full round-trip or directly call gateway-bridge internals

## Test Results
`workspace/pipeline/Cooking/020h-cortex-e2e/TEST-RESULTS.md`
