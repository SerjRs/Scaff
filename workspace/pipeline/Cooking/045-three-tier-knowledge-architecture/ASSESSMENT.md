# SPEC.md Assessment

*Date: 2026-03-20*

---

## Rating: 8/10 — Strong foundation, minor over-engineering, one structural gap filled

### What's Good

- **The three-tier mental model is exactly right.** Breadcrumbs → Knowledge Graph → Sources is a clean, intuitive layering that maps well to how memory should work. The insight that Tier 1 is a *view* into Tier 2 (not a separate store) is the most important architectural decision in the document.
- **Pop/sink over hot/cold.** Eliminating the eviction cycle in favor of continuous ranking is a major simplification. The current codebase has ~150 lines of eviction + stub management (`evictFact`, `reviveFact`, `pruneOldStubs`, `setEdgeStub`) that all go away.
- **Provenance via URI scheme.** The `source_ref` → `kg_sources.uri` → resolver chain is well-designed and extensible. New source types can be added without schema changes.
- **Migration path is realistic.** The 5-phase plan respects the existing codebase and avoids big-bang rewrites.

### What's Over-Engineered

- **`working_memory` table had a `source_type` column.** Breadcrumbs are pointers to facts — the fact already has a source_type. Duplicating it adds write complexity for zero query benefit. Removed in ARCHITECTURE.md.
- **The Synthesizer was described as running "after every Tier 1 → Tier 2 promotion."** But there IS no promotion — facts are born in Tier 2. The spec's own design principle contradicts this phrasing. The Synthesizer simply runs after every fact insertion. Clarified in ARCHITECTURE.md.
- **Daily catch-up Gardener task for synthesis.** With inline synthesis on every insert, a daily catch-up is redundant. A weekly orphan audit is sufficient for edge cases (Ollama down, embedding failures).
- **Two search ranking coefficients (0.6/0.4 for vector/relevance blend).** The spec proposed these as fixed values but they need to be tuned empirically. The formula is kept but flagged as tunable.

### What Was Missing

- **Hard cap on breadcrumbs.** The spec defined 96h TTL but no maximum count. A long active day could create 50+ breadcrumbs, blowing the token budget. ARCHITECTURE.md adds a hard cap of 30 with LRU eviction and extends the TTL to 7 days to bridge weekend inactivity..
- **Score caps.** The `relevance_score` formula had `hit_count × 2` with no cap — a fact accessed 1000 times would have a base score of 2000, permanently dominating. ARCHITECTURE.md caps each component.
- **Initial score for new facts.** The spec set `relevance_score DEFAULT 0.0` — new facts would start at the bottom. Changed to 5.0 so new facts are immediately searchable.
- **Contradicts/supersedes edge creation.** The spec listed these edge types but didn't address how to detect them. Resolved in ARCHITECTURE.md. Instead of waiting for a complex belief-revision system, the Synthesizer uses its existing Haiku call to immediately update status = 'superseded' when a direct replacement is detected, preventing belief lock-in.

---

## Top 3 Ideas Borrowed from References

1. **Three-tier context loading (OpenViking [24]).** L0/L1/L2 loading — abstract, overview, full content — maps directly to our breadcrumbs (L0), search results (L1), and `knowledge_source` (L2). We didn't adopt OpenViking's explicit tier metadata per document, but the *philosophy* of progressive disclosure shaped our token budget design. The fixed 2,000-token injection cap is directly inspired by their "load only what's needed" principle.

2. **Active synthesis over passive retrieval (Always-On Memory [5]).** Google's insight that "active LLM-based consolidation outperforms passive vector retrieval by generating cross-memory insights" validated our Synthesizer design. However, we rejected their separate consolidation agent in favor of inline synthesis — their approach uses a timer-based background agent, which adds scheduling complexity we don't need at our scale. The *idea* is borrowed; the *implementation* is simplified.

3. **Cognitive Memory as generalizable lessons (CrewAI [39]).** The distinction between "saving feedback" and "distilling feedback into generalizable lessons" influenced how we think about fact extraction. Our Fact Extractor should extract not just what happened, but what was *learned* — corrections, preferences, decisions. This is already partially implemented (the `correction` fact type), but the reference validated making it explicit.

---

## Top 3 Ideas We Should NOT Adopt

1. **Structured RAG / inverted index (TypeAgent [2]).** TypeAgent's inverted index approach is impressive — 63/63 book recall vs. classic RAG's 15/63. But it requires building and maintaining a custom index structure with entity extraction, tree-pattern matching, and inference expansion. Our scale (~1,000 facts, not millions of messages) doesn't justify this complexity. Vector KNN + pop/sink ranking is sufficient and far simpler. If we reach 50K+ facts and search quality degrades, revisit.

2. **BFT consensus validation (SAGE [31]).** Routing every memory write through 4 validators with 3/4 quorum is military-grade infrastructure for a single-user, single-agent system. The rho=0.716 learning correlation result is compelling, but it's driven by *having memory at all*, not by the consensus mechanism specifically. Our quality control (Haiku extraction + confidence scoring + human-in-the-loop via Cortex) is sufficient.

3. **Multimodal embeddings (Gemini Embedding 2 [38]).** Unifying text, image, audio, and video into a single embedding space is architecturally elegant. But it requires a cloud API (no local Ollama equivalent yet), costs per-call, and we have no image/video knowledge to embed. Our audio transcripts are already text by the time they reach the KG. When Ollama ships a multimodal embedding model, this becomes compelling.

---

## Complexity Estimate

| Phase | Sessions | Description |
|-------|----------|-------------|
| 1. Schema migration | 1 | Table renames, new columns, backfill scores, create new tables |
| 2. Working memory + injection | 2 | Breadcrumb CRUD, system floor rewrite, `knowledge_search` tool |
| 3. Synthesizer + deep search | 2 | Edge creation logic, vector thresholds, Haiku classification, `knowledge_deep_search` tool |
| 4. Provenance | 1 | URI resolvers, `knowledge_source` tool, source registration |
| 5. Polish + cleanup | 1 | Remove old tables/code, update tests, nightly score decay |
| **Total** | **~7 sessions** | |

Each session is ~2h following the pipeline pattern. The critical path is Phase 2 — once breadcrumbs + injection work, the system is already better than today.

---

## Biggest Risk

**The Synthesizer's vector similarity thresholds (0.35 / 0.55) are untested.** These determine which facts get edges and which are considered unrelated. If the thresholds are too tight, the graph stays sparse and deep search finds nothing. If too loose, every fact connects to every other fact and the graph is noise.

**Mitigation:** Start with the proposed thresholds but make them configurable in `cortex/config.json`. Run the Synthesizer against the existing ~370 active facts in a dry-run mode, inspect the generated edges, and tune before going live. The weekly orphan audit will catch under-connected facts. The weight field on edges provides a secondary quality signal even if the threshold is imperfect.

---

*Assessment complete. The spec is architecturally sound — the primary contribution of this review is simplification (removing hot/cold, capping scores, adding hard limits) and gap-filling (breadcrumb caps, initial scores, deferred features list).*
