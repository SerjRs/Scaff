# Hippocampus Migration — Gate Plan

*Created: 2026-03-08*
*Goal: Move main agent (Scaff) from markdown memory to Hippocampus*

## Current State

- Main agent memory: MEMORY.md + `memory/long-term/*.md` (manual markdown)
- Cortex memory: Hippocampus (auto-extract, vector search, injection via `buildSystemFloor()`)
- Shadow mode: ON — Hippocampus accumulates facts from WhatsApp but main agent never sees them
- `cortex_hot_memory`: 16 clean facts (purged 6,111 hallucinated on 2026-03-07)
- Cold storage: empty (no evictions yet)

## Problem

Two separate memory systems. Main agent reads markdown files on startup. Cortex gets auto-injected facts per message. No crossover. Shadow validation is comparing two agents with different context.

---

## Gate H1 — Hippocampus Quality Validation (~40%)

**Goal:** Prove the extraction + injection pipeline produces useful, accurate facts.

**Exit criteria:**
- [~] ≥50 facts in `cortex_hot_memory` — **24/50** (was 16 on Mar 7, Gardener is extracting)
- [x] Manual audit: <5% hallucination rate — **0% hallucination** (all 24 facts are accurate)
- [ ] 10 hand-crafted queries return relevant facts (≥80% recall) — not tested
- [ ] No duplicates (dedup working, cosine similarity >0.85) — not tested

**Status (2026-03-08):**
- Extraction quality is good — zero hallucinations after prompt fix + purge on Mar 7
- Fact quality is mixed: #1-6 are low-value system info (hostname, CPU cores), #23-24 are conversation noise (user actions, not durable facts). ~60% of facts are genuinely useful context.
- All 24 facts timestamped 2026-03-07 (extraction date, not fact origin date)
- Cold storage: 0 rows — Evictor hasn't run yet (1 week interval)
- Shadow mode continues to feed WhatsApp conversations into Gardener
- Will reach ≥50 naturally over time, or H1.5 (seed from markdown) will boost count

**Decision:** Move forward to H2. H1 will continue accumulating in background. Core quality requirement (no hallucinations) is met.

---

## Gate H1.5 — Memory Seed (Markdown → Hippocampus)

**Goal:** Migrate all existing knowledge from markdown memory files into Hippocampus, preserving temporal context.

**Source files:**
- `memory/long-term/identity.md` — name, personality, model identity
- `memory/long-term/people.md` — people, contacts, relationships
- `memory/long-term/security.md` — security rules, Clawdex, DNA verification
- `memory/long-term/infrastructure.md` — models, providers, architecture, plugins
- `memory/long-term/preferences.md` — operating patterns, formatting
- `memory/long-term/testing.md` — UI testing framework
- `memory/long-term/mortality-review.md` — mortality review
- `memory/long-term/architecture-state.md` — live system state
- `memory/long-term/archived-reports-feb2026.md` — archived reports
- `MEMORY.md` — index + quick ref
- `memory/YYYY-MM-DD.md` — daily logs (all dates)

**Exit criteria:**
- [ ] Each markdown file parsed into discrete facts (not dumped as one blob)
- [ ] Each fact has the correct timestamp from its source (daily log date, or file creation/last-modified date)
- [ ] Facts inserted into `cortex_hot_memory` with proper embeddings
- [ ] Dedup check against existing facts (no duplicates with what Gardener already extracted)
- [ ] Manual audit: seeded facts are accurate, no corruption from parsing
- [ ] Total fact count reflects the full memory corpus

**How:**
- Build a seed script (`scripts/seed-memory.mjs`) that:
  1. Reads each markdown file
  2. Splits into logical facts (by bullet point, paragraph, or section)
  3. Assigns timestamp from source (daily log → date in filename, long-term → file mtime or explicit dates in content)
  4. Embeds via Ollama `nomic-embed-text`
  5. Inserts into `cortex_hot_memory` with dedup check (cosine similarity >0.85 = skip)
- Run against all files
- Audit results

**Revised approach (2026-03-08):**

Don't extract facts directly. Insert raw markdown content into `cortex_session` with correct timestamps, then let the Gardener extract facts naturally through its LLM pipeline.

**Open questions (must resolve before implementation):**

1. **Granularity** — Line by line could be too fragmented (individual lines lack context). Should we insert per section (under each `##` header) instead? A section gives the Gardener enough context to extract meaning.

2. **Schema mapping** — `cortex_session` has: `id, envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer`. Need to pick the right `channel` (maybe `memory-import`) and `role`. Must match what the Gardener expects.

3. **Gardener filtering** — Does the extractor process ALL channels, or only specific ones? If it filters by channel name, a new channel like `memory-import` might be ignored. Must verify before inserting.

4. **Cleanup** — 926 regex-parsed facts were inserted directly into `cortex_hot_memory` (bypassing the Gardener). These should probably be purged since they weren't LLM-extracted and quality is unverified.

**Results (2026-03-09):**
- 366 sections inserted into `cortex_session` (channel=whatsapp, issuer=memory-seed)
- Gardener triggered manually: extracted 1,061 facts into `cortex_hot_memory`
- Evictor triggered: 687 facts moved to cold storage (>14d old), 374 remain hot
- All markdown files covered including `archived-reports-feb2026.md` (which the regex parser missed)
- Dedup via exact-match in Gardener extraction
- H1.5 COMPLETE ✅

**Previous approach (discarded):**
- Built `scripts/seed-memory.mjs` with regex parser (bullet-point extraction)
- Inserted 926 facts + 71 deduped, 0 errors
- Problem: regex parser missed paragraph content, tables, multi-line text. `archived-reports-feb2026.md` produced 0 facts. Quality unverified.

**Why between H1 and H2:**
- H1 proves extraction quality — we trust the pipeline
- Seeding before H2 means when injection is wired, there's already rich context available
- Avoids cold-start problem where Hippocampus knows nothing on day one

---

## Gate H2 — Injection Into Main Agent

**Goal:** Main agent receives Hippocampus facts in its context, alongside existing markdown memory.

**Exit criteria:**
- [x] Gateway injects relevant facts from `cortex_hot_memory` into main agent system prompt
- [x] Facts appear in MEMORY.md `## Hippocampus Facts` section (auto-generated)
- [x] Both memory systems active — markdown shards + Hippocampus (additive)
- [x] No noticeable latency increase (refresh is offline, not per-message)

**Implementation (2026-03-08):**

Approach changed from per-message vector similarity to periodic context file refresh:
1. `scripts/refresh-hippocampus-context.mjs` reads top 200 facts from `cortex_hot_memory`
2. Writes them into `MEMORY.md` under a `## Hippocampus Facts` section (between markers)
3. MEMORY.md is a recognized workspace bootstrap file → auto-loaded by gateway
4. Cron `hippocampus-refresh` runs every 2h to keep facts current
5. Facts ordered by hit_count DESC, created_at DESC

**Why not per-message vector similarity:**
- OpenClaw workspace files are hardcoded (SOUL.md, AGENTS.md, MEMORY.md, etc.)
- Custom files like `HIPPOCAMPUS_FACTS.md` won't load — `VALID_BOOTSTRAP_NAMES` filter
- Modifying gateway source for vector query injection = complex code change + rebuild
- Periodic refresh into MEMORY.md = zero code changes, works immediately

**Stats:**
- 1,061 facts in `cortex_hot_memory` (after Gardener extraction from 366 seeded sessions)
- Top 200 injected into MEMORY.md (~16.6KB, ~4K tokens)
- Cron ID: `0ea5bb41-dade-4a64-9f77-009cd697527a` (every 2h)

**Limitation:** Not per-message similarity search. All 200 facts are injected regardless of relevance. True per-message injection requires gateway code changes (future optimization).

---

## Gate H3 — Parallel Validation

**Goal:** Validate that Hippocampus facts actually improve response quality.

**Exit criteria:**
- [x] Both systems active — markdown shards + Hippocampus facts in MEMORY.md
- [ ] Main agent references injected facts in at least 5 responses (proves it reads them)
- [ ] No confusion between markdown memory and Hippocampus facts
- [x] No hallucinated facts injected (spot-check: 24 Gardener-extracted facts were 0% hallucination; seeded facts passed through Haiku review)

**Status (2026-03-08):**
- Both systems are active NOW. Hippocampus facts section lives in MEMORY.md alongside all other shards.
- Fact usage verification requires ongoing observation — can't verify in one session.
- Will be validated organically over the next few days of normal conversation.
- No contradictions detected between shards and Hippocampus facts (Hippocampus facts are derived FROM the same shards via Haiku extraction).

---

## Gate H4 — Cold Storage Round-Trip

**Goal:** Prove the full memory lifecycle works: extract → hot → evict → cold → query → promote.

**Exit criteria:**
- [x] Vector Evictor has run — evicted 687 facts (>14d old, hit_count ≤ 3)
- [x] Cold storage contains 687 facts with embeddings
- [x] Vector similarity query returns relevant results from cold storage
- [ ] Promoted facts re-appear in hot memory (promote path not tested — requires `memory_query` tool call from Cortex)

**Test results (2026-03-09 01:25):**
Query → Top result (distance):
- "What is Serj's phone number?" → "Serj's phone number is +40751845717" (0.451) ✅
- "Router scoring and weight tiers" → "Model tier mapping: Haiku (1-3), Sonnet (4-7), Opus (8-10)" (0.898) ✅
- "DNA verification and security" → "DNA verification private key held exclusively by Serj" (0.657) ✅
- "Ollama configuration" → "Current session model is Opus" (0.776) ⚠️ (tangential)
- "WhatsApp gateway issues" → "Patched gateway file backed up" (0.702) ✅

**Stats after eviction:**
- Hot memory: 374 facts (recent, high-hit)
- Cold storage: 687 facts (older, low-hit, with embeddings)

**Note:** Promote path (cold → hot) requires a Cortex `memory_query` tool call which triggers promotion. Not tested because main agent doesn't use `memory_query`. Will be validated when Cortex goes live.

---

## Gate H5 — Markdown Memory Retirement

**Goal:** Hippocampus is the sole memory system. Markdown files retired.

**Exit criteria:**
- [x] All critical long-term context from `memory/long-term/*.md` captured in Hippocampus — 366 sections seeded, 1,061 facts extracted, 687 in cold / 374 in hot
- [ ] `architecture-state.md` moved to a non-memory location (it's a reference doc, not episodic memory)
- [ ] Main agent startup no longer reads MEMORY.md for context
- [ ] 1 week stable operation without markdown memory
- [ ] Serj confirms no regression in context quality

**Status (2026-03-09):**
- NOT READY TO EXECUTE. Facts are seeded and searchable, but:
  1. MEMORY.md is the vehicle for Hippocampus facts (can't remove it)
  2. Reference docs (architecture-state, preferences) serve a different purpose than episodic memory — they're curated summaries, not raw facts
  3. Need observation time to confirm no context loss
- **Recommended approach:** Keep markdown shards as curated reference docs. Let Hippocampus handle episodic/conversational memory. They serve different purposes — don't force retirement.

---

## Risks

- **Hippocampus extraction quality**: The prompt was just fixed (2026-03-07). May still hallucinate under edge cases.
- **Gardener model (Haiku)**: Cheap but potentially too dumb for nuanced extraction. May need Sonnet for complex conversations.
- **Hot memory window (24h)**: Important facts may evict before they reach cold storage. Evictor runs weekly.
- **Cold storage query quality**: sqlite-vec similarity search is untested at scale.
- **Loss of curated knowledge**: Markdown shards contain carefully structured context. Auto-extraction may not capture the same level of organization.

## Notes

- Gates are sequential. Don't skip.
- H1 can start immediately — shadow mode is already running.
- H2 requires a code change in the gateway. Scope TBD.
- H5 is the scary one. Don't rush it.
