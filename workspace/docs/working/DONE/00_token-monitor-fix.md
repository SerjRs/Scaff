# TokenMonitor Fix Spec

**Created:** 2026-03-09
**Last Updated:** 2026-03-09 17:45
**Status:** ✅ All Issues Complete (including CTX column)
**Author:** Scaff (Cortex + Main Agent)

---

## Final State

TokenMonitor: `PID | MODEL | TASK | CHANNEL | TOKENS-IN | TOKENS-OUT | DURATION | STATUS`

All features working:
- **PID**: Gateway PID for persistent agents, `T:<8-char-uuid>` for executor tasks
- **Task**: Actual task text for router executors, "Sub-agent task" for spawned sub-agents, "Sonnet verification" for evaluators, "Live session" for persistent agents, "Ollama scoring" for local eval
- **Status**: Active (persistent), InProgress → Finished/Failed/Canceled (tasks), with 30s auto-cleanup
- **Stale cleanup**: InProgress rows with no LLM activity for 2+ minutes auto-mark as Failed
- **No duplicates**: Single recording path via `pi-embedded-subscribe.ts`
- **Column alignment**: Clean terminal rendering with color-coded status

---

## Open Requirements

### Context Tokens Column

| # | Feature | Status |
|---|---------|--------|
| 9 | `CTX` column — show total context window tokens per agent | ✅ Done |

**Requirement:** Add a `CTX` column to the token monitor display showing the **input tokens sent to the LLM API** on the most recent call for each agent. This is the `prompt_tokens` (or equivalent) returned by the provider API — the full context payload (system prompt + conversation history + tool results) that was actually transmitted to the model.

**Why:** With the foreground token cap at 8K and sharding active, we need real-time visibility into how much context each agent is sending per API call. This number climbs as conversation grows and should drop when sharding trims old shards. Watching it live confirms sharding works and catches agents approaching their context limit before they die.

**Source:** The LLM API response includes `usage.prompt_tokens` (Anthropic) / `usage.input_tokens` / equivalent. The token monitor already tracks per-call token usage — this column surfaces the input side. Value updates on every API call for that agent (shows the latest, not cumulative).

**Display:**
```
PID | MODEL | TASK | CHANNEL | CTX | TOKENS-IN | TOKENS-OUT | DURATION | STATUS
```

`CTX` shows the value in `k` format (e.g., `148k`, `12k`, `200k`) for readability.

---

## Completed Issues

### Phase 1: Structure

| # | Feature | Status | Commits |
|---|---------|--------|---------|
| 1 | PID column | ✅ | 8cd4b6e44 |
| 2 | Status column (Active/InProgress/Finished/Canceled/Failed) | ✅ | 8cd4b6e44 |
| 3 | Auto-cleanup of Finished rows (30s) | ✅ | 8cd4b6e44 |
| 4 | 8-column layout with color-coded status | ✅ | 58a76de71 |

### Phase 2: Bugs

| # | Bug | Root Cause | Fix | Commits |
|---|-----|-----------|-----|---------|
| 5 | Duplicate rows | Two recording paths: `attempt.ts` + `pi-embedded-subscribe.ts` used different sessionId values → different Map keys | Removed `attempt.ts` hook, centralized in `pi-embedded-subscribe.ts` | cb099cfab |
| 6 | Main agent "InProgress" instead of "Active" | `isTask = Boolean(sessionId)` — main agent has a sessionId | Added `persistent` flag to `TokenLedgerEvent`, set by `pi-embedded-subscribe.ts` for main/cortex | 4a713cacf |
| 7 | Evaluator rows stuck InProgress forever | No status update after Sonnet verification; evaluators not in router job table | `verifySonnet()` now returns sessionKey; caller marks Finished/Failed. 2-min stale InProgress cleanup as safety net | 4a713cacf, 7eef46f33 |
| 8 | Task column empty for all rows | `updateTaskBySession()` called before row exists; `pi-embedded-subscribe.ts` didn't pass task | Moved task label to `record()` time via globalThis. Router tasks read from `getCurrentExecutorTaskLabel()`, sub-agents default to "Sub-agent task" | 6c1724740, 7eef46f33 |

### Verified Test Results

**Persistent agents:**
- Main agent: `pid=19296, task=Live session, status=Active` ✅
- Cortex: `pid=19296, task=(Live session via CLI fallback), status=Active` ✅

**Router dispatcher tasks (Cortex webchat):**
- Executor: `pid=T:c8300a95, task=In the OpenClaw project at ~/.openclaw, run:..., status=Finished` ✅
- Evaluator: `pid=19296, task=Sonnet verification, status=Finished` ✅

**Sub-agent tasks (sessions_spawn):**
- Executor: `pid=T:3d735c69, task=Sub-agent task, status=InProgress` ✅

**Auto-cleanup:**
- Evaluator Finished row disappeared after ~30s ✅
- Stale InProgress rows auto-mark Failed after 2 minutes ✅

---

## Files Modified (complete list)

- `src/token-monitor/ledger.ts` — Core: persistent flag, stale cleanup, task field
- `src/token-monitor/stream-hook.ts` — Pass task/persistent through recordRunResultUsage
- `src/token-monitor/cli.ts` — 8-column layout, resolveTaskLabel, color-coded status
- `src/token-monitor/gateway-methods.ts` — Router status sync on snapshot
- `src/token-monitor/index.ts` — Exports
- `src/agents/pi-embedded-subscribe.ts` — Centralized recording with task labels, persistent flag
- `src/agents/pi-embedded-runner/run/attempt.ts` — Removed duplicate recording hook
- `src/router/evaluator.ts` — Status lifecycle for Sonnet verification sessions
- `src/router/dispatcher.ts` — Pass task label to worker
- `src/router/worker.ts` — Forward task label via globalThis
- `src/router/gateway-integration.ts` — Export getCurrentExecutorTaskLabel, registerJobSession
- `src/agents/cli-runner.ts` — CLI runner recording
- `src/cortex/llm-caller.ts` — Cortex recording

## Key Commits

- `8cd4b6e44` — feat: token monitor with PID, status, cleanup
- `58a76de71` — feat: Task column
- `bf70d9e6f` — fix: dedup, status transitions, stale cleanup
- `cb099cfab` — fix: remove duplicate recording paths
- `4a713cacf` — fix: task labels, main agent active, evaluator cleanup
- `6c1724740` — fix: pass task label from dispatcher to worker
- `7eef46f33` — fix: executor Task column — set label during record()
