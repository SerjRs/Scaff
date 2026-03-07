# Gate 2 — WhatsApp Shadow Validation

*Ref: `ROADMAP.md`, `goal1-implementation-plan.md` M2*
*Started: 2026-03-05 (shadow enabled)*
*Updated: 2026-03-07*

---

## Timeline
- **2026-03-05 18:20** — WhatsApp shadow mode enabled in `cortex/config.json`
- **2026-03-05 18:35** — Multi-channel feed wired into `dispatchInboundMessage` (commit c950352fb)
- **2026-03-05 18:57** — Shadow confirmed: Cortex received WhatsApp message in bus (state=completed)
- **2026-03-07 07:15** — Gateway restarted with Hippocampus fixes. Shadow still active.

## Shadow Runtime
- Shadow started: 2026-03-05 18:57 UTC
- Current time: 2026-03-07 07:45 UTC
- Runtime so far: **~37 hours** (target: 48h)
- Target completion: ~2026-03-07 18:57 UTC

## Implementation Steps

### Step 1: Verify shadow is receiving WhatsApp messages
**Plan (2026-03-07 09:50):** Check Cortex bus for WhatsApp messages received in shadow mode since March 5.

**Result (2026-03-07 09:50):**
- 13 WhatsApp messages received in Cortex bus since March 5
- ALL state=completed — no dropped messages ✅
- Sender correctly identified as "Sergiu Robu" with phone +40751845717
- 36 session rows (user + assistant responses + task results)

**Quality assessment from shadow responses:**
- Cortex generating thoughtful replies similar to main agent quality
- Spawning tasks via `sessions_spawn` when user requests work (reading files, checking code)
- Conversation continuity maintained across days (Mar 5 → Mar 6 → Mar 7)
- Emoji/casual messages handled naturally ("😆" → "😄")
- "??" from user correctly interpreted as confusion/check-in

**Concern:** Shadow mode is fully processing (Opus LLM calls) — not just observing. Cost is doubled (main agent + Cortex both process). This is by design for validation but needs awareness.

---

### Step 2: Compare Cortex shadow decisions vs main agent
**Plan:** After 48h, pull all WhatsApp messages from Cortex bus and compare what Cortex would have done vs what the main agent actually did.

**Result:** *(pending — needs 48h mark)*

---

### Step 3: Verify tools, reactions, media, silent replies
**Plan:** Audit Cortex shadow processing for edge cases — did it handle tools correctly? Silent replies? Media?

**Result:** *(pending)*

---

## Exit Criteria
- [ ] 48h shadow run completed (~11h remaining)
- [ ] Comparison report: Cortex vs main agent
- [ ] ≥90% quality parity
- [ ] 0 dropped messages
- [ ] Tools, reactions, media, silent replies all function correctly
