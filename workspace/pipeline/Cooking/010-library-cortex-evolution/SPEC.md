# 010 — Library-Driven Cortex Evolution

> **Status:** Cooking  
> **Priority:** High  
> **Author:** Scaff  
> **Date:** 2026-03-14  
> **Related:** docs/library-architecture.md (v2.3)

---

## Problem

The Library is live — 21 items ingested, ingestion pipeline works, breadcrumbs + on-demand pull model is functional. But there are gaps between the architecture doc and reality, and no spec for the next evolution steps.

### Current State (what works)
- `library_ingest(url)` → Librarian executor → stores summary, concepts, tags
- `library_get(id)` → full item retrieval (sync tool)
- `library_search(query)` → semantic search (sync tool)
- Breadcrumbs injected into system prompt every turn (~4 relevant items shown)
- Shard pollution fix: compressed references stored, not full content
- 21 items ingested, all active status

### Known Gaps
1. **Embedding coverage: 4/21 items have embeddings.** 17 items are invisible to semantic retrieval. Breadcrumbs and `library_search` rely on embeddings — items without them are dead weight.
2. **No `full_text` storage.** Architecture doc specifies `full_text TEXT` column for raw content (enables re-processing, re-summarizing with better prompts later). Current implementation likely drops raw content after summarization.
3. **No re-ingestion/versioning flow.** Doc specifies duplicate URLs increment version + update summary. Not verified if implemented.

---

## Evolution Path

### Phase A: Fix Foundation (immediate)

**A1 — Backfill missing embeddings**
- 17/21 items lack embeddings → they don't appear in breadcrumbs or search
- Script or one-time task: read each item's summary, generate embedding via Ollama nomic-embed-text, INSERT into item_embeddings
- Verify: after backfill, `library_search` returns results from all 21 items

**A2 — Store full_text on ingestion**
- Librarian executor already fetches URL content → pass raw text alongside JSON result
- Gateway handler stores in `full_text` column
- Enables future re-processing without re-fetching (links die, paywalls change)

**A3 — Embedding generation in ingestion pipeline**
- Ensure every new ingestion generates an embedding (not just some)
- Root-cause why 17 items are missing embeddings — is it a race condition, Ollama timeout, or missing code path?

### Phase B: Cortex Gets Smarter (short-term)

**B1 — Cross-reference Library + Hippocampus**
- Currently both are independent context sources
- Evolution: when Cortex pulls a Library item, it should cross-reference with Hippocampus facts
- Example: Library has "O-RAN TCO analysis", Hippocampus has "budget is 2.4M" → Cortex connects them automatically
- **Implementation:** This already happens naturally via LLM reasoning. No code change needed — it's an emergent behavior from having both in context. The key is ensuring both sources have good coverage (fix embeddings, keep Hippocampus healthy).

**B2 — Proactive Library suggestions**
- When Cortex detects a knowledge gap during conversation, suggest the user feed relevant links
- Example: User asks about a framework Cortex doesn't know → "I don't have deep knowledge on X. If you have docs or articles, drop them and I'll learn."
- **Implementation:** System prompt guidance, no code change. Add to SOUL.md or tool guidance.

**B3 — Library-informed task context**
- When spawning coding/research tasks via Router, include relevant Library items as context
- Currently: tasks get only the user's prompt + code_search results
- Evolution: auto-attach top-3 Library breadcrumbs relevant to the task description
- **Implementation:** In `sessions_spawn` context assembly, run Library breadcrumb query against task description, append to executor prompt as "Domain context from Library: ..."

### Phase C: Compound Learning (medium-term)

**C1 — Library growth metrics**
- Track: items/week, tags distribution, coverage gaps, embedding health
- Surface via `library_stats` (already exists, extend it)
- Alerts: "You haven't fed me anything in 2 weeks" or "17/21 items have no embeddings"

**C2 — Tag-based clustering / domain map**
- As Library grows past ~50 items, tag overlap creates implicit clusters
- Visualization or summary: "Your Library covers: distributed-systems (12 items), event-driven (8), security (5), tooling (6)"
- Helps user see gaps: "You have nothing on observability or testing"
- **Implementation:** SQL query on tags JSON + simple grouping. Could be a `library_stats` enhancement.

**C3 — Re-processing pipeline**
- When Librarian prompt improves, re-process existing items using stored `full_text`
- Batch job: read full_text → re-summarize → update summary/concepts/tags → regenerate embedding
- Versioned: increment version, preserve history
- **Implementation:** Dedicated executor task, triggered manually ("re-process Library with new prompt")

**C4 — Library as training signal for SOUL.md evolution**
- After 50+ items, Library tags reveal the user's actual domain
- Cortex can suggest SOUL.md refinements: "Based on your Library, you focus heavily on event-driven architectures and security. Should I update my persona to reflect deeper expertise in these areas?"
- This closes the loop: Library feeds domain knowledge → domain knowledge shapes persona → persona improves all future interactions

### Phase D: Future Work (from architecture doc)

These were explicitly deferred in v2.0 and remain deferred:
- Night Scholar (autonomous reading)
- Echo chamber mitigations / diversity monitoring
- Feedback loops (user rates Library items)
- Domain-specific Librarian prompts (telecom vs software vs HR)

---

## Priority Order

1. **A1 + A3** — Fix embeddings. Without this, 80% of the Library is invisible. Blocking everything.
2. **A2** — Store full_text. Low effort, high future value.
3. **B3** — Library-informed tasks. Direct quality improvement for Router tasks.
4. **B2** — Proactive suggestions. System prompt change only.
5. **C1** — Growth metrics. Quick extension to existing tool.
6. **C2 → C4** — As Library grows past 50 items.

---

## Architecture Verification Summary

The library-architecture.md v2.3 is **solid and well-implemented** with these notes:

| Aspect | Doc Says | Reality | Status |
|--------|----------|---------|--------|
| Breadcrumbs model | Top-10 by embedding similarity | Working, shows ~4 relevant items | ✅ |
| Shard pollution fix | Compressed references only | Implemented per v2.3 | ✅ |
| Ingestion pipeline | Librarian executor → JSON → gateway writes DB | Working, 21 items ingested | ✅ |
| library_get / library_search | Sync tools, same-turn | Working | ✅ |
| Embeddings | All items embedded | 4/21 have embeddings | ⚠️ Critical |
| full_text storage | Raw content preserved | Likely not stored | ⚠️ |
| Add-only DB design | No deletes, version on re-ingest | Not verified | ❓ |
| Option A (executor returns JSON, gateway writes) | Recommended | Implemented | ✅ |
| Role-agnostic design | Domain from user curation | Working as designed | ✅ |

**Bottom line:** The architecture is right. The implementation has an embedding gap that makes 80% of Library items invisible to retrieval. Fix that first, then the evolution path above compounds naturally.
