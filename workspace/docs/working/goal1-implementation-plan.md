# Goal 1: WhatsApp on Cortex with Persistent Memory — Implementation Plan

*Created: 2026-03-02*
*Status: Not started*

---

## Milestone 1: Hippocampus Produces Useful Recall

**Objective:** Hippocampus reliably extracts, stores, and retrieves facts from conversations.

**Deliverables:**
- [ ] Run Gardener fact extraction on at least 1 live session
- [ ] Hot memory populated with ≥20 facts
- [ ] `memory_query` returns relevant results for test queries
- [ ] Cold storage round-trip: evict a fact → query it → promotes back to hot

**Metric:** 80% recall accuracy on 10 hand-crafted test queries about past conversations.

**Blocked by:** Nothing — can start immediately.

---

## Milestone 2: WhatsApp Shadow Mode — Parity Check

**Objective:** Prove Cortex handles WhatsApp traffic without regressions.

**Deliverables:**
- [ ] Switch WhatsApp to Cortex shadow mode (`"shadow"`)
- [ ] Run shadow mode for 48 hours minimum
- [ ] Compare Cortex responses vs old pipeline for same messages
- [ ] Verify: tools, reactions, media, silent replies all function correctly
- [ ] No dropped messages (100% delivery rate)

**Metric:** 48h shadow run, ≥90% quality parity, 0 dropped messages.

**Blocked by:** Milestone 1 (Hippocampus should be populating facts before we test the full pipeline).

---

## Milestone 3: WhatsApp Live on Cortex

**Objective:** WhatsApp fully on Cortex with cross-channel awareness.

**Deliverables:**
- [ ] Switch WhatsApp to live mode (`"live"`)
- [ ] Cross-channel test: mention something in webchat → reference from WhatsApp → Scaff connects them
- [ ] 72h burn-in with no manual rollback
- [ ] Monitor token cost via `openclaw tokens` — verify stable per-call cost (not growing)

**Metric:** 72h live with no rollback, cross-channel recall works in 5/5 test cases.

**Blocked by:** Milestone 2 (shadow must pass first).

---

## Milestone 4: Memory Across Sessions

**Objective:** Scaff carries context across gateway restarts and multi-day gaps.

**Deliverables:**
- [ ] Gateway restart test: kill → restart → WhatsApp message referencing prior conversation → Scaff picks up context
- [ ] Gap tests: 1-day, 3-day, and 7-day conversation gaps — Scaff recalls without being told
- [ ] Re-enable foreground soft cap (20 messages / 4K tokens) without coherence loss
- [ ] Foreground token cost stabilized under 5K tokens per call

**Metric:** 3/3 gap tests passed (1d, 3d, 7d), foreground under 5K tokens per call.

**Blocked by:** Milestone 3 (needs live Cortex + Hippocampus running for multiple days to have real data).

---

## Success Criteria

All 4 milestones complete. Serj can reference something from a week ago on WhatsApp and Scaff knows what he's talking about — without manual MEMORY.md updates, without re-explaining context, with predictable token costs.
