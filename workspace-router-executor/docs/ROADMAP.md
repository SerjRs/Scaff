# ROADMAP.md — Cortex Architecture Evolution

*Created: 2026-03-07T07:15:00Z*
*Author: Scaff*
*Goal: Fully autonomous assistant*

## Where We Are

Cortex + Router are built and operational. The async delegation pattern works — Cortex stays present while executors handle work. 30+ test tasks executed successfully across all difficulty levels (2026-03-05).

### What Works
- Cortex processes all channels through unified session
- Router evaluates complexity and routes to Haiku/Sonnet/Opus
- Fire-and-forget async execution with result delivery
- Hippocampus memory (hot + cold)
- Crash recovery on restart

### What Doesn't
- No validation gate — results delivered without quality check
- No executor retry — runtime failures are immediately terminal
- Security vulnerabilities: path traversal (P1), prompt injection (P2)
- Silent message drops at 5 identified points in delivery pipeline
- Broadcast bootstrap race — first webchat message required before delivery works
- No progress tracking on long tasks
- No structured task specs — just string descriptions

## Phase Gates

### Phase 1: Foundation Hardening (CURRENT)
*Gate: All P0-P1 security fixes applied, executor retry working, no silent drops*

Priority items:
1. Path traversal fix — `path.resolve()` + workspace boundary check in `cortex/loop.ts`
2. Resource name sanitization — strip `[]` and newlines in `dispatcher.ts`
3. Broadcast bootstrap — initialize `broadcastFn` at `initGatewayCortex`, not lazily
4. Executor retry — check `retry_count` in `worker.ts` before marking failed, re-queue on transient errors
5. Auth sync conditional — gate behind `router.enabled`
6. Ops trigger delivery retry — at least 1 retry on `appendTaskResult`/`enqueue` failure

### Phase 2: Reliable Delegation
*Gate: Tasks succeed consistently. Failure rate < 5%. No silent losses.*

Build from existing designs:
1. Circuit Breaker + DLQ (circuit-breaker-dlq-design.md) — failure tracking per tier, exponential backoff, poison pill detection
2. Validation gate — executor result → type check + completeness check → deliver or retry
3. Structured task specs — `sessions_spawn` accepts input schema, expected output shape, success criteria
4. Progress checkpointing — long tasks emit intermediate state to SQLite, retry from last checkpoint

### Phase 3: Self-Directing Work
*Gate: Cortex breaks multi-step tasks into subtasks and coordinates execution without human input on the happy path.*

1. Task decomposition — Cortex breaks "design the immune system" into evaluable subtasks
2. Dependency graph — subtask B waits for subtask A's result before starting
3. Intermediate evaluation — Cortex reviews subtask results, adjusts plan
4. Escalation threshold — after N failed self-resolutions, escalate to user
5. Multi-executor coordination — parallel subtasks with merge step

### Phase 4: Judgment & Autonomy
*Gate: Cortex resolves ambiguous decisions using accumulated context, memory, and past patterns. Escalation rate < 20%.*

1. Decision memory — log all past decisions + outcomes, build pattern library
2. Confidence scoring — Cortex rates its own confidence before acting
3. Proactive work — Cortex initiates tasks based on patterns (e.g., "pi-ai is 6 versions behind, should I update?")
4. Self-improvement — Cortex proposes architecture changes, specs them, submits for approval
5. Multi-agent debate — two executors argue opposing approaches, Cortex synthesizes

### Phase 5: Full Assistant
*Gate: Serj reviews work by exception, not by rule.*

1. Cortex manages its own memory curation
2. Cortex manages its own architecture evolution
3. Proactive monitoring and maintenance
4. Trust calibration — earned autonomy based on track record
5. Human escalation is the exception, not the norm

## Implementation Log

*Each step: timestamp, what we're doing, then results after.*

(entries will be appended below as work progresses)

---

### Phase 1, Item 2: Resource Name Sanitization
**Timestamp:** 2026-03-07T08:45:00Z
**Status:** PLANNING

**What we're doing:**
Fix the P2 prompt injection vulnerability in `src/router/dispatcher.ts` and `src/agents/subagent-spawn.ts`. Resource names containing `]`, `[`, or newlines can break the `[Resource: name]...[End Resource: name]` delimiter structure and inject arbitrary instructions into the executor prompt.

**Plan:**
1. Read the current `formatResourceBlocks` or equivalent code in dispatcher.ts
2. Read the equivalent in subagent-spawn.ts
3. Sanitize resource `name`: strip or escape `[`, `]`, newlines
4. Sanitize resource `content`: escape any occurrence of `[End Resource:` to prevent delimiter escape
5. Enforce max content length (64KB)
6. Add test cases

**Expected result:** Resource names and content cannot break prompt delimiters. Injection via crafted names is blocked.

**Results:**
(pending)

---

---

### Phase 1, Item 3: Broadcast Bootstrap Fix
**Timestamp:** 2026-03-07T08:45:00Z
**Status:** PLANNING

**What we're doing:**
Fix the HIGH severity broadcast bootstrap race condition. Currently `__openclaw_cortex_webchat_broadcast__` is only set when the first webchat `chat.send` arrives. If an executor completes before the user has sent a webchat message, the result is silently dropped.

**Plan:**
1. Read `gateway-bridge.ts` to find where the broadcast function is set
2. Read `chat.ts` to find where broadcastChatFinal is defined
3. Move broadcast function initialization from lazy (first chat.send) to eager (initGatewayCortex)
4. Verify the broadcast function has access to the required context at init time
5. Add test case

**Expected result:** Executor results can be delivered via webchat even before the user sends their first message.

**Results:**
(pending)

---
---

### Phase 1, Item 1: Path Traversal Fix
**Timestamp:** 2026-03-07T09:14:00Z
**Status:** ✅ DONE

**Results:**
- Added `import path from "node:path"` (line 11)
- Replaced vulnerable path resolution (lines 241-251) with hardened version (lines 241-256)
- `path.resolve(workspaceDir, res.path)` normalizes all paths
- `startsWith(normalizedWorkspace + path.sep)` boundary check blocks traversal
- Absolute paths outside workspace return `[Access denied]` instead of reading
- Files: `.openclaw/src/cortex/loop.ts`

---

### Phase 1, Item 5: Auth Sync Conditional
**Timestamp:** 2026-03-07T09:14:00Z
**Status:** ✅ DONE

**Results:**
- Wrapped `syncExecutorAuth()` call in `if (params.cfg.router?.enabled)` guard
- Updated comment from "unconditionally" to "only if router enabled"
- Auth files no longer copied when router is disabled
- Files: `.openclaw/src/gateway/server-startup.ts`

---

### Phase 1, Item 4: Executor Retry
**Timestamp:** 2026-03-07T09:15:00Z
**Status:** PLANNING

**What we're doing:**
Add retry logic for transient executor failures in `worker.ts`. Currently runtime errors are immediately terminal — `status: "failed"` with no retry. The watchdog retry (MAX_RETRIES=2) only covers gateway crashes, not runtime failures.

**Plan:**
1. In `worker.ts` catch block (line 115), add a `SELECT retry_count FROM jobs` before deciding
2. If `retry_count < MAX_RETRIES` (2), reset to `pending` + increment `retry_count` + emit `job:retry`
3. If `retry_count >= MAX_RETRIES`, mark `failed` as before + emit `job:failed`
4. Add poison pill detection: if error matches `context_window_exceeded`, `invalid_request`, or `content_policy`, skip retry and fail immediately
5. Verify `retry_count` column exists in schema

**Expected result:** Transient executor failures get up to 2 retries before permanent failure. Poison pill errors fail immediately.

**Results:**
(pending)

---

### Phase 1, Item 6: Ops Trigger Delivery Retry
**Timestamp:** 2026-03-07T09:15:00Z
**Status:** PLANNING

**What we're doing:**
Add retry mechanism for ops trigger delivery in `gateway-bridge.ts`. Currently if `appendTaskResult` or `instance.enqueue` throws, the result is silently lost forever. The most dangerous case: `appendTaskResult` succeeds but `enqueue` fails — result in DB but Cortex never processes it.

**Plan:**
1. Separate `appendTaskResult` and `instance.enqueue` into individual try/catch blocks
2. If `enqueue` fails, retry once after 1 second delay
3. Add a startup sweep in `initGatewayCortex` that checks for task results in `cortex_session` that have no corresponding processed ops_trigger in `cortex_bus` — re-fire them
4. This gives us crash-resilient delivery without a new table

**Expected result:** Ops trigger delivery survives transient failures and gateway restarts. No more silent result loss.

**Results:**
(pending)

---
