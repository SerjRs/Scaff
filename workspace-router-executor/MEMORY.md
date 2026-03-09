# MEMORY.md — Long-Term Memory

_Curated knowledge that persists across sessions. Raw logs live in `memory/YYYY-MM-DD.md`._

Last recalibrated: 2026-03-07

---

## Shards

Extended memory stored in dedicated files when a topic grows large enough to warrant its own space.

| File | Contents |
|------|----------|
| `memory/long-term/infrastructure.md` | Cortex architecture state, roadmap progress, phase tracking, testing results |

---

## Open Items

### Phase 1: Foundation Hardening — 3/6 done

- ✅ Item 1: Path traversal fix (P1) — `loop.ts` patched
- ✅ Item 2: Resource name sanitization (P2) — `dispatcher.ts` + `subagent-spawn.ts` patched
- 📋 Item 3: Broadcast bootstrap — planned, not executed
- 📋 Item 4: Executor retry — planned, code at `worker.ts:115`
- ✅ Item 5: Auth sync conditional — `server-startup.ts` patched
- 📋 Item 6: Ops trigger delivery retry — planned, code at `gateway-bridge.ts:248-323`

---

## Key People

- **Serj** — the human. Prefers minimal responses, no walls of text. Wants to know what's happening before disappearing.

---

## Working Agreements

- Use `docs/` for implementation tracking with timestamps
- Keep updates short
- Don't go silent without a heads-up
- Prefer `trash` over `rm`

---

## Architecture Snapshot

See `memory/long-term/infrastructure.md` for full detail.

**TL;DR:** Cortex is one brain, one session, all channels. Strict serialization + SQLite durability. Router does complexity-based delegation (Ollama → Sonnet). Hippocampus handles hot/cold memory.

**Known pain point:** Multiple ops_triggers queue behind each other, each needing a full LLM round-trip — user messages get delayed, Serj sees the assistant go silent then dump walls of text.
