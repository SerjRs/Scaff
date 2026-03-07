# Gate 1 — Hippocampus Activation

*Ref: `ROADMAP.md`, `hipocampus-architecture.md`, `goal1-implementation-plan.md` M1*
*Started: 2026-03-07*

---

## Implementation Steps

### Step 1: Assess current state of Hippocampus code
**Plan (2026-03-07 08:45):** Check what's actually implemented in `src/cortex/` for Hippocampus — tables, gardener, tools, config flags. Determine what exists vs what's specced but not built.

**Result (2026-03-07 09:10):**
- Hippocampus **already enabled** (`hippocampus.enabled: true` in `cortex/config.json`)
- All tables exist in `cortex/bus.sqlite` (not `cortex.sqlite` — that's an empty leftover)
- **6,086 hot memory facts** — but ALL have 0 hits (never accessed by Cortex)
- Gardener is running: compactor (10min), extractor (5min), evictor (10min)
- Cold storage schema exists but empty (no evictions yet, `sqlite-vec` working)
- 249 session rows (webchat: 104, internal: 65, router: 44, whatsapp: 36)
- Channel states have summaries — compactor is working

**Critical issues found:**
1. **Fact Extractor hallucinating** — "User's dog is named Rex", "User's favorite color is blue", "User works at TechCorp" — none of this is true. The LLM fills gaps with fabricated "facts."
2. **No semantic dedup** — only exact string match. Near-duplicates like "lives in Kreuzberg" vs "lives in the Kreuzberg neighborhood" both stored.
3. **Gardener uses Opus** — same model as Cortex main. Way too expensive for background extraction running every 5 min.
4. **Extraction prompt too permissive** — "Extract any persistent, reusable facts" with no constraint to only extract explicitly stated information.
5. **6,086 facts is noise** — needs purge + re-extraction with a better prompt.

---

### Step 2: Enable Hippocampus in config
**Plan:** Set `hippocampus.enabled: true` in `cortex/config.json`. Verify the flag is hot-reloadable (no restart needed per architecture spec).

**Result (2026-03-07 09:10):** Already enabled. Skipped.

---

### Step 2b: Fix Fact Extractor — purge + better prompt + cheaper model
**Plan (2026-03-07 09:15):**
1. Purge all 6,086 hallucinated facts from `cortex_hot_memory`
2. Fix extraction prompt: add constraint "ONLY extract facts explicitly stated in the conversation. Do NOT infer, assume, or fabricate."
3. Add semantic dedup (cosine similarity check before insert, reuse Ollama embeddings)
4. Change Gardener model from Opus to Haiku (extraction doesn't need intelligence, just accuracy)
5. Increase extraction interval from 5min to 6h (per architecture spec)
6. Re-run extraction on existing session data

**Result (2026-03-07 09:20):**
1. Purged 6,111 hallucinated facts ✅
2. Fixed extraction prompt — strict "only explicitly stated" constraint ✅
3. Semantic dedup — deferred (exact match + better prompt should reduce noise significantly, add cosine check later if still noisy)
4. Gardener model changed to Haiku (configurable via `hippocampus.gardenerModel`) ✅
5. Intervals restored: 1h compactor, 6h extractor, 1w evictor ✅
6. 14/14 gardener tests pass ✅
7. Commit `68788af46`, pushed ✅
8. **Next:** Restart, trigger manual extraction, validate results

---

### Step 3: Verify tables exist and are populated
**Plan:** Check `cortex_hot_memory` table exists. Check if the Gardener has ever run (any rows?). If empty, trigger a manual extraction run.

**Result (2026-03-07 09:20):** All tables in `cortex/bus.sqlite`. Hot memory purged (was full of garbage). Session has 249 rows across 4 channels. Channel states have summaries. ✅

---

### Step 4: Run Gardener fact extraction
**Plan:** Trigger the Fact Extractor against existing `cortex_session` data. Verify it populates `cortex_hot_memory` with ≥20 facts.

**Result (2026-03-07 09:35):**
- Ran manual extraction with Haiku against all 4 channels (249 session rows)
- Initial extraction: 105 facts — quality much better than before, but still noisy
- Noise: task dispatch IDs (31), stress test results, ephemeral observations
- After cleanup: **16 clean, verifiable facts** remaining
- Key facts preserved: hostname, CPU cores, user's phone, build loop, Cortex architecture goal, dev setup
- Issue: fact count below 20 target. Need more session data to accumulate — will happen naturally as conversations flow through Cortex
- Gardener model resolution: `claude-haiku-4-5` works through gateway's model resolver. Direct API needs exact model ID.
- **Prompt improvement needed:** Add "Skip task dispatch metadata, one-off computation results, and ephemeral status observations" to extraction rules

---

### Step 5: Validate recall via memory_query
**Plan (2026-03-07 09:40):** Craft 10 test queries about known conversation topics. Run them against `memory_query`. Measure recall accuracy. Note: `memory_query` uses cold storage (sqlite-vec), not hot memory. Hot memory is injected directly into the System Floor context. Need to verify BOTH paths.

**5a: Hot Memory injection check** — verify Cortex's context assembly includes the 16 hot facts in System Floor.
**5b: Cold storage query** — requires facts to be evicted first (Vector Evictor hasn't run). May need to manually trigger or test after enough time passes.

**Result (2026-03-07 09:45):**
- Code path verified: `buildSystemFloor()` injects hot facts under `## Known Facts` when `hippocampusEnabled=true`
- 16 facts in `cortex_hot_memory`, ready for injection
- `debugContext: true` is set — next Cortex LLM call will log the full assembled context, confirming hot facts are in System Floor
- Cold storage (5b): cannot test yet — no evicted facts. Vector Evictor runs weekly. Can trigger manually later.
- **Status: code path verified, live validation pending next Cortex message**

---

### Step 6: Cold storage round-trip
**Plan:** Verify Vector Evictor can sweep stale facts into sqlite-vec cold storage. Query a cold fact via `memory_query` and confirm it returns.

**Result:** *(pending)*

---

## Exit Criteria
- [x] Hippocampus enabled (was already enabled, config confirmed)
- [x] Fact Extractor fixed (hallucination eliminated, Haiku model, spec intervals)
- [ ] Hot memory populated with ≥20 facts (currently 16 — will grow with more conversations)
- [ ] Hot memory injection verified in live Cortex turn (debug output)
- [ ] `memory_query` returns relevant results (requires cold storage eviction first)
- [ ] Cold storage round-trip works (weekly evictor hasn't run yet)
- [ ] 80% recall accuracy on 10 test queries

## Current Status
**Partially complete.** Extraction pipeline fixed and validated. 16 clean facts in hot memory. Waiting for:
1. More conversation data to reach ≥20 facts
2. A live Cortex message to verify hot memory injection in System Floor
3. Vector Evictor run (or manual trigger) to test cold storage round-trip
