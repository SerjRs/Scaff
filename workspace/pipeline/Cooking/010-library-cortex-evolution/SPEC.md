---
id: "010"
title: "Library-Driven Cortex Evolution — Roadmap"
created: "2026-03-14"
author: "scaff"
priority: "high"
status: "cooking"
moved_at: "2026-03-14"
---

# 010 — Library-Driven Cortex Evolution (Roadmap)

> This is the umbrella spec. Implementation is split into subtasks (010a–010d).

## Current State (verified 2026-03-14)

| Aspect | Status | Detail |
|--------|--------|--------|
| Items | 21 active | All ingested via `library_ingest` → Librarian executor |
| Embeddings | **4/21** | 17 silently failed (Ollama 5s timeout in fire-and-forget) |
| full_text | **0/21** | Column exists, ingestion pipeline doesn't write to it |
| Breadcrumbs | Partially working | Only 4 items visible to semantic retrieval |
| library_search | Partially working | Same — only 4 items have embeddings |
| library_get | ✅ Working | Retrieves by ID regardless of embeddings |
| sqlite-vec | ✅ Working | Extension loads fine in both read/write modes |
| Shard pollution fix | ✅ Working | Compressed references stored |
| Re-ingestion/versioning | ✅ Working | Code exists in insertItem — version++ on duplicate URL |
| Ingestion pipeline | ✅ Working | Librarian executor → JSON → gateway writes DB |

## Subtasks

| Task | Title | Priority | What |
|------|-------|----------|------|
| 010a | Backfill embeddings + fix generation | Critical | Fix the 17 missing embeddings, make generation reliable |
| 010b | Store full_text on ingestion | High | Pass raw content through ingestion pipeline |
| 010c | Library-informed task context | Medium | Auto-attach Library items to coding executor spawns |
| 010d | Proactive Library suggestions + metrics | Low | System prompt guidance + library_stats enhancements |

## Architecture Fit

The library-architecture.md v2.3 is solid. All Phase A/B features align with the architecture.
No structural changes needed — just filling implementation gaps.

## Future (deferred)

- Night Scholar (autonomous reading)
- Echo chamber mitigations
- Feedback loops (user rates items)
- Domain-specific Librarian prompts
- Re-processing pipeline (needs full_text first — see 010b)
- Tag clustering / domain map (needs >50 items)
- SOUL.md evolution from Library signals (needs >50 items)
