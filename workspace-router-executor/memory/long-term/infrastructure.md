## Cortex Architecture — Current State (2026-03-07)

### What's Built
- Cortex: unified processing brain, one session all channels, strict serialization, crash durability via SQLite
- Router: complexity-based routing (Ollama → Sonnet verification), fire-and-forget async delegation
- Evaluator: two-stage (llama3.2:3b local, weight ≤2 trusted, >2 → Sonnet verify)
- Tiers: Haiku (1-3), Sonnet (4-7), Opus (8-10)
- Hippocampus: hot memory (flat table) + cold storage (sqlite-vec KNN)
- Gardener: channel compactor, fact extractor, vector evictor
- Tools: sync (fetch_chat_history, memory_query) + async (sessions_spawn → Router)
- Recovery: watchdog 30s, hung detection 90s, MAX_RETRIES=2, crash recovery on startup

### Architecture Docs
- `.openclaw/docs/cortex-architecture.md` — full Cortex design
- `.openclaw/docs/router-architecture.md` — full Router design
- Workspace design docs: circuit-breaker-dlq-design.md, immune-system-design.md, flight-recorder-design.md, zero-trust-analysis.md

### Roadmap (docs/ROADMAP.md)
- Phase 1: Foundation Hardening (CURRENT) — 3/6 done
- Phase 2: Reliable Delegation — not started
- Phase 3: Self-Directing Work — not started
- Phase 4: Judgment & Autonomy — not started
- Phase 5: Full Assistant — end goal

### Phase 1 Progress
- ✅ Item 1: Path traversal fix (P1) — `loop.ts` patched with path.resolve + boundary check
- ✅ Item 2: Resource name sanitization (P2) — `dispatcher.ts` + `subagent-spawn.ts` patched
- 📋 Item 3: Broadcast bootstrap — planned, not executed (medium complexity, request-scoped context issue)
- 📋 Item 4: Executor retry — planned, code located at `worker.ts:115`
- ✅ Item 5: Auth sync conditional — `server-startup.ts` patched
- 📋 Item 6: Ops trigger delivery retry — planned, code located at `gateway-bridge.ts:248-323`

### Known Issue: Message Delivery Lag
- Cortex processes one message at a time (strict serialization)
- Multiple ops_triggers queue up, each needs full LLM round-trip
- User messages queue behind ops_triggers — causes "disappearing" behavior
- Serj's core frustration: assistant goes silent, then dumps walls of text

### Key Testing Results (2026-03-05)
- 30+ tasks executed across 3 rounds, 100% success rate
- Opus tasks: 2/4 succeeded, 2/4 timed out at 300s gateway timeout
- 14 reliability findings in delivery pipeline (2 critical, 4 high, 4 medium, 4 low)
- 20 failure modes mapped in task execution pipeline

### Working Process Agreement
- Use docs/ folder for implementation tracking
- Each step: timestamp what we plan to do, then log results after
- Don't disappear without telling Serj what's happening
- Keep updates short, no monologues
- Serj prefers minimal responses, not walls of text
