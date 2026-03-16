---
id: "019e"
title: "Hippocampus Tests — E. Graph Traversal"
created: "2026-03-16"
author: "scaff"
priority: "high"
status: "cooking"
parent: "019"
---

# 019e — Graph Traversal Tests

## Test File
`src/cortex/__tests__/e2e-hippocampus-full.test.ts` — Category E (6 tests)

## Tests
- E1. Traverse from a fact — depth 1
- E2. Traverse depth 2 — transitive connections
- E3. Traverse respects maxDepth
- E4. Traverse with stub edges
- E5. Traverse handles cycles
- E6. Traverse from non-existent fact

## LLM Usage
None — pure DB + graph traversal operations. No mocks to replace.

## Task
- Remove mock imports if referenced
- These are pure graph operations, should pass as-is once mock imports are cleaned up
