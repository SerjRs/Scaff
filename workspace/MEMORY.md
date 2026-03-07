# MEMORY.md — Index

*Last recalibrated: 2026-02-24*

## Shards
- `memory/long-term/architecture-state.md` — **READ FIRST** — live system state, what's running, config, message flows, critical rules
- `memory/long-term/identity.md` — name, personality, avatar, partnership agreement, model identity
- `memory/long-term/people.md` — people, contacts
- `memory/long-term/security.md` — security rules, Clawdex, DNA verification
- `memory/long-term/infrastructure.md` — models, providers, architecture, backups, plugins, Router
- `memory/long-term/preferences.md` — operating patterns, delegation, formatting
- `memory/long-term/testing.md` — UI testing framework
- `memory/long-term/mortality-review.md` — mortality review (2026-02-10, timeless)
- `memory/long-term/archived-reports-feb2026.md` — archived reports from Feb 2026
- `memory/long-term/MEMORY_old_backup.md` — old MEMORY.md backup (pre-sharding)

## Memory Architecture

### 3 Layers
1. **Session Tail** — last ~20 messages, sent to Cortex. Truncated to keep context small.
2. **Hot Memory** — Redis-backed vector store (24h sliding window). Auto-captures facts/preferences. ~10 relevant snippets injected per message.
3. **Long Memory** — Curated markdown files in `memory/long-term/`. Manually maintained.

### Storage
| What | Where | Who writes | Retention |
|------|-------|-----------|-----------|
| Active session | `agents/main/sessions/<id>.jsonl` | Gateway (auto) | Truncated tail |
| Session backup | `agents/main/sessions/<id>_backup.jsonl` | Gateway (auto) | Full, never truncated |
| Hot Memory | Redis vector DB | System (auto) | 24h sliding window |
| Daily logs | `memory/YYYY-MM-DD.md` | System (auto) | Persistent |
| Long-term shards | `memory/long-term/*.md` | Scaff (manual) | Persistent |

### Key Notes
- Daily logs are auto-created by the system
- Hot Memory has dedup (cosine similarity > 0.85 = replace) since 2026-02-23
- Session backup is the true source of truth for full conversation replay

## Quick Ref
- **Model:** anthropic/claude-opus-4-6
- **OpenClaw:** 2026.2.25 (source build from git, single install at `.openclaw`)
- **Host:** DianaE (Windows)
- **Channel:** WhatsApp
- **Clawdex:** mandatory before skill installs
- **Purpose:** See PURPOSE.md

## Open Items (as of 2026-02-24)
- [x] ~~Verify/create Windows scheduled tasks for daily backups (local 4:00 AM, cloud 4:15 AM)~~ — done 2026-02-24
- [x] ~~Add rclone to system PATH~~ — confirmed in PATH, resolves to v1.69.1
- [ ] Re-apply gateway fail-closed patch for DNA verification (lost during update to 2026.2.22-2)
- [x] ~~Hot memory flush cron~~ — removed; Hot Memory disabled by Serj
- [ ] PURPOSE.md threads: ClawHub skill, Moltbook, Transition Project (all not started)
- [ ] Immune System runtime policy engine (discussed 2026-02-13, not started)
