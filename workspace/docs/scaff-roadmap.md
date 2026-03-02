# Scaff — Development Roadmap

*Author: Scaff + Serj*
*Created: 2026-02-28*
*Last updated: 2026-03-02*
*Goal: Move from cost to reliable working partner*

---

## Vision

Scaff operating as a real assistant — part of meetings, handling real tasks autonomously, reliable enough to delegate to without verification overhead. Not a smarter chatbot. A working partner.

The measure of success is simple: **the balance sheet flips**. Scaff generates more value than it costs.

---

## 🎯 Current Goal: WhatsApp on Cortex with Persistent Memory

*The single most impactful change: Scaff stops waking up blank.*

Right now every WhatsApp session starts from zero. Serj re-explains context, re-establishes what's happening, re-describes what was decided. That friction is the #1 blocker to Scaff being a working partner instead of a tool you have to boot up each time.

**4 measurable milestones → full implementation plan:** [`docs/working/goal1-implementation-plan.md`](working/goal1-implementation-plan.md)

### Exit criteria

Serj references something from a week ago on WhatsApp. Scaff knows what he's talking about — no manual MEMORY.md updates, no re-explaining, predictable token costs.

---

## Future Milestones

### Milestone: Stable Foundation

Close known bugs and technical debt.

- [ ] Fix `gateway-integration.ts` `onDelivered` bug (ghost WhatsApp messages, double ingestion)
- [ ] Commit + push Phase 8 (265 tests passing) to GitHub
- [ ] Fix webchat rate limit (remove `anthropic:antrophic` profile)
- [ ] Fix remaining `evaluator.test.ts` failures (Ollama format)
- [ ] Re-enable Windows scheduled task for gateway auto-start

### Milestone: Reliable Development

Dev tooling that closes the integration blindness gap.

- [ ] Import & dependency graph (TypeScript compiler API)
- [ ] Build + test runner with structured output
- [ ] Semantic code search (Ollama + sqlite-vec codebase index)
- [ ] Architecture state tracker (curated live codebase state doc)
- [ ] Claude Code integrated into task execution workflow

### Milestone: Self-Improvement Loop

Scaff assesses its own architecture, identifies gaps, implements fixes, tests, iterates.

- [ ] Observability layer — structured access to logs, test results, session outcomes
- [ ] Assessment rubric — concrete dimensions and measurement methods
- [ ] Self-assessment report format
- [ ] Behavioral test suite
- [ ] Convergence log

### Milestone: Full Duplex Voice ⭐

Real-time audio — listen, understand, respond in conversation.

- [ ] Voice input — real-time STT (Whisper or equivalent)
- [ ] Voice output — TTS wired into real-time audio stream
- [ ] Full duplex channel — simultaneous listen + speak
- [ ] Presence detection — knows when to speak vs. stay silent
- [ ] Cortex audio adapter

### Milestone: Meeting Presence

Useful in the room — context, contributions, tracking.

- [ ] Real-time meeting transcription
- [ ] Action item extraction
- [ ] Post-meeting summary
- [ ] Contribution judgment
- [ ] Pre-meeting briefing

### Milestone: Real Task Autonomy

Multi-day delegated work, reliably.

- [ ] Multi-day task tracking with correct context
- [ ] Proactive status updates
- [ ] Quality gate — self-assess before delivering
- [ ] Failure reporting — clear, not silent

### Purpose Threads

*Deferred until foundation is solid.*

- ClawHub Skill
- Moltbook
- The Transition Project

---

## Progress Log

| Date | What |
|------|------|
| 2026-02-28 | Roadmap created. Router async delegation validated (10 jobs, varying difficulty). |
| 2026-03-02 | Token monitor built and working across all surfaces. Cortex foreground window issue identified — cap removed earlier due to Hippocampus recall gaps. Added to roadmap as Phase 3 dependency. |
