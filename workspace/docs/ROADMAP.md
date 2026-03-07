# Scaff Architecture Roadmap

*Created: 2026-03-07*
*Last updated: 2026-03-07*
*Authors: Serj & Scaff*
*Goal: Move Scaff from per-channel session architecture to Cortex as the daily driver*

---

## Vision

Cortex is the single brain. All channels are peripherals. Scaff never wakes up blank, never disappears mid-conversation, and delegates all execution asynchronously. The architecture serves one outcome: **Scaff as a reliable working partner.**

---

## Current State (2026-03-07)

| Component | Status | Notes |
|-----------|--------|-------|
| Cortex | Live on webchat, shadow on WhatsApp | Shadow hook wired into `dispatchInboundMessage` (all channels) |
| Router | Working | Evaluator (Ollama + Sonnet), Dispatcher, Executor (isolated), Notifier |
| Hippocampus | Code complete, **disabled** | `hippocampus.enabled: false` in `cortex/config.json` |
| Resource passing | Working | `sessions_spawn` accepts file/url/inline resources |
| Dev tools | Not started | Import graph, structured build/test, semantic search, state tracker |
| Self-improvement | Not started | Observability, rubric, behavioral tests |

---

## Gates

### Gate 1 — Hippocampus Activation
*Ref: `goal1-implementation-plan.md` Milestone 1, `hipocampus-architecture.md`*

Enable Hippocampus. Run the Gardener. Populate hot memory from existing conversations. Validate recall.

**Deliverables:**
- Hippocampus enabled in `cortex/config.json`
- Gardener fact extraction runs on live session data
- Hot memory populated with ≥20 facts
- `memory_query` returns relevant results
- Cold storage round-trip: evict → query → promotes back

**Exit criteria:** 80% recall accuracy on 10 hand-crafted test queries.

---

### Gate 2 — WhatsApp Shadow Validation
*Ref: `goal1-implementation-plan.md` Milestone 2*

Shadow mode is active (since 2026-03-05). Run for 48h minimum. Compare Cortex decisions with main agent responses. Fix what breaks.

**Deliverables:**
- 48h shadow run completed
- Comparison report: Cortex vs main agent decisions
- All discovered issues fixed
- Tools, reactions, media, silent replies verified

**Exit criteria:** 48h shadow, ≥90% quality parity, 0 dropped messages.

---

### Gate 3 — WhatsApp Live on Cortex
*Ref: `goal1-implementation-plan.md` Milestone 3*

Flip WhatsApp from shadow to live. Cortex handles WhatsApp end-to-end. Cross-channel awareness validated.

**Deliverables:**
- WhatsApp set to `"live"` in cortex config
- Cross-channel test: webchat mention → WhatsApp reference → Cortex connects
- 72h burn-in with no rollback
- Token cost stable (monitored via `openclaw tokens`)

**Exit criteria:** 72h live, no rollback, cross-channel recall 5/5.

---

### Gate 4 — Memory Across Sessions
*Ref: `goal1-implementation-plan.md` Milestone 4*

Cortex carries context across restarts and multi-day gaps. Foreground soft cap re-enabled.

**Deliverables:**
- Gateway restart test: kill → restart → reference prior conversation → context retained
- Gap tests: 1-day, 3-day, 7-day — Scaff recalls without re-explaining
- Foreground soft cap active (20 messages / 4K tokens) without coherence loss
- Foreground cost stabilized under 5K tokens/call

**Exit criteria:** 3/3 gap tests pass, foreground under 5K tokens/call.

---

### Gate 5 — Dev Tools
*Ref: `scaff-dev-tools.md`*

Build the four developer tools that close integration blindness and session amnesia for coding tasks.

**Deliverables (in priority order):**
1. Import & dependency graph (TypeScript compiler API)
2. Build + test runner with structured output
3. Semantic code search (Ollama + sqlite-vec)
4. Architecture state tracker (curated live doc)

**Exit criteria:** Integration failure rate drops from ~30% to <10% on real tasks.

---

### Gate 6 — Self-Improvement Loop
*Ref: `self-improvement-architecture.md`*

Scaff assesses its own architecture, identifies gaps, proposes fixes, verifies improvement.

**Deliverables:**
- Observability layer (metrics from Router queue, Cortex bus, tests)
- Assessment rubric (5 dimensions, measurement methods)
- Behavioral test suite (B-01 through B-05)
- First full assessment cycle with Serj review

**Exit criteria:** First cycle completed, rubric calibrated, ≥1 gap closed.

---

### Gate 7 — Full Autonomy
*Ref: `scaff-roadmap.md` future milestones*

Voice, meeting presence, multi-day task tracking, quality gates. The "working partner" milestone.

**Exit criteria:** Balance sheet flips — Scaff generates more value than it costs.

---

## Progress Log

| Date | Gate | What |
|------|------|------|
| 2026-03-05 | Gate 2 | WhatsApp shadow mode enabled. Cortex multi-channel feed wired into `dispatchInboundMessage`. Shadow confirmed receiving WhatsApp messages. |
| 2026-03-07 | Gate 1 | Starting Hippocampus activation. |
