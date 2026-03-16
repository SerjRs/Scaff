---
id: "019g"
title: "Hippocampus Tests — G. Fact Lifecycle — Promotion & Demotion"
created: "2026-03-16"
author: "scaff"
priority: "high"
status: "cooking"
parent: "019"
---

# 019g — Fact Lifecycle: Promotion & Demotion Tests

## Test File
`src/cortex/__tests__/e2e-hippocampus-full.test.ts` — Category G (13 tests)

## Tests
- G1. New fact starts at hit_count=0, status=active
- G2. touchGraphFact increments hit_count
- G3. Frequently accessed facts rank higher
- G4. Stale facts identified for eviction
- G5. High-hit facts survive eviction scan
- G6. Full eviction flow — fact → cold storage
- G7. Evicted fact excluded from system floor
- G8. Revival — cold fact comes back
- G9. Revival reconnects edges to active neighbors
- G10. Partial revival — one neighbor still evicted
- G11. Stub pruning — old bilateral stubs deleted
- G12. Stub pruning — keeps recent stubs
- G13. Stub pruning — keeps stubs with one active endpoint

## LLM Usage
Uses `mockEmbedFn` for eviction/revival operations (G6, G8–G13). No LLM calls.

## Task
- Replace `mockEmbedFn` with real Ollama `nomic-embed-text`
- This is the largest category (13 tests) — all about eviction, revival, stub management
- Increase timeouts for embedding calls
