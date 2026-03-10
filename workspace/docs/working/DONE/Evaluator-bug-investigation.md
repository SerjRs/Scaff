# Router Evaluator Bug Investigation

**Date:** 2026-03-03
**Investigator:** Scaff
**Status:** Full picture established — 3 distinct issues identified

---

## Issue 1: Sonnet Verification Uses Wrong Model (Opus instead of Sonnet)

### Evidence

Every time `verifySonnet()` fires, the embedded runner log shows:
```
embedded run start: model=claude-opus-4-6   ← should be claude-sonnet-4-6
```

The DIAG-ERR lines confirm it consistently:
```
provider=anthropic/claude-opus-4-6   ← after every sonnet verification
```

Meanwhile, the Router executor correctly resolves models per tier:
```
provider=anthropic/claude-haiku-4-5   ← executor for w=1 task
```

### Root Cause

`verifySonnet()` calls `callGateway({ method: "agent", sessionKey: "agent:main:router-evaluator:<uuid>" })` without passing a `model` parameter. The embedded runner resolves model via:

1. Agent's `models.json` → **doesn't exist** for the evaluator agent
2. Global default model → `claude-opus-4-6`

The evaluator never specifies what model to use. It relies on the embedded runner's fallback chain, which always resolves to Opus.

### Impact

Every Sonnet verification burns Opus tokens (more expensive, unnecessary). The evaluator produces correct results (it's just a weight classifier), but at higher cost than intended.

### Fix

Pass `model: "anthropic/claude-sonnet-4-6"` in the `callGateway` params inside `verifySonnet()`.

---

## Issue 2: Cortex Tool Calling — Works Before 16:55 Rebuild, Breaks After

### Timeline (full log analysis)

**Before rebuild (09:04 — 09:07), tool calling works:**
```
09:04:33 stopReason=toolUse contentLen=3
09:04:33 content blocks: [{"type":"thinking"},{"type":"text"},{"type":"toolCall","name":"sessions_spawn"}]
09:04:33 Tool calls: sessions_spawn({...})
09:04:54 [router/evaluator] ollama failed → falling through to sonnet
09:05:02 [router/evaluator] sonnet verified: w=2
         → Task executed successfully, result delivered back
```

```
09:06:50 stopReason=toolUse contentLen=3
09:06:50 content blocks: [{"type":"thinking"},{"type":"text"},{"type":"toolCall","name":"sessions_spawn"}]
09:06:50 Tool calls: sessions_spawn({...})
09:07:00 [router/evaluator] ollama scored: w=7, verifying with sonnet
09:07:05 [router/evaluator] sonnet verified: w=2
         → Task executed successfully
```

**After 16:25 rebuild, tool calling still works for this session:**
```
16:26:15 stopReason=toolUse contentLen=3
16:26:15 content blocks: [{"type":"thinking"},{"type":"toolCall","name":"memory_query"},{"type":"toolCall","name":"memory_query"}]
         → memory_query works (sync tool)

16:27:43 stopReason=toolUse contentLen=2
16:27:43 content blocks: [{"type":"thinking"},{"type":"toolCall","name":"sessions_spawn"}]
16:27:43 Tool calls: sessions_spawn({...})
16:28:03 [router/evaluator] evaluating...
16:28:09 [router/evaluator] sonnet verified: w=5
         → Task dispatched, but executor returned "AI service temporarily overloaded"

16:28:44 stopReason=toolUse contentLen=2
16:28:44 content blocks: [{"type":"text"},{"type":"toolCall","name":"sessions_spawn"}]
         → Another real tool call
```

**After 16:55 rebuild, tool calling BREAKS:**
```
16:56:03 stopReason=stop contentLen=1          ← stop, not toolUse
16:56:03 content blocks: [{"type":"text"}]     ← no tool_use blocks
16:57:02 stopReason=stop contentLen=1
16:57:02 content blocks: [{"type":"text"}]
16:57:58 stopReason=stop contentLen=1
16:57:58 content blocks: [{"type":"text"}]
```

Cortex outputs `[Tool] sessions_spawn: ...` and `[Tool] get_task_status: ...` as **plain text**, not actual tool calls. The LLM stopReason is `stop` (not `toolUse`), and content blocks have only `{"type":"text"}`.

**After 17:24 rebuild, tool calling WORKS AGAIN:**
```
17:25:33 stopReason=toolUse contentLen=3
17:25:33 content blocks: [{"type":"thinking"},{"type":"text"},{"type":"toolCall","name":"sessions_spawn"}]
17:25:33 Tool calls: sessions_spawn({...})
17:25:50 [router/evaluator] ollama scored: w=9, verifying with sonnet
17:25:53 [router/evaluator] sonnet verified: w=1
17:26:01 provider=anthropic/claude-haiku-4-5   ← executor ran on haiku, correct
```

### Analysis

The 16:55 rebuild broke tool calling. The 17:24 rebuild fixed it. Something in the 16:55 build was wrong. The 16:55 build included my reverted changes (session key change + model param). The 17:24 build reverted those changes, restoring the original evaluator code.

But the evaluator changes shouldn't affect Cortex's tool calling — those are in `evaluator.ts`, not `llm-caller.ts` or `tools.ts`. The more likely explanation: the **cortex_session table had accumulated malformed tool call entries** from the broken period, and these corrupted the LLM context. When the session was reset or messages aged out, tool calling resumed.

Alternatively, the 16:55 build may have had a compilation issue that resolved in the 17:24 rebuild.

### Current Status

As of the last entry (17:25), **tool calling is working**:
- Cortex made a real `sessions_spawn` tool call
- Evaluator fired (Ollama scored 9, Sonnet corrected to 1)
- Executor ran on haiku tier
- Full pipeline operational

---

## Issue 3: Token Monitor Shows Wrong Data for router-evaluator

### Evidence from Serj's token monitor output:
```
router-evaluator │ anthropic/claude-sonnet-4-6 │  0 │  0 │  0 │  1
router-evaluator │ claude-opus-4-6             │  6 │ 94 │  0 │  2
```

### Explanation

- **Line 1** (`anthropic/claude-sonnet-4-6`, 0 tokens, 1 call): This is the Ollama `record()` call. The Ollama call timed out (AbortError), so no tokens were consumed, but `record()` was still called with model=`anthropic/claude-sonnet-4-6` (the EVALUATOR_MODEL constant) and 0 token counts.

- **Line 2** (`claude-opus-4-6`, 6 in / 94 out, 2 calls): These are the Sonnet verification calls — but tracked under Opus because that's the model the embedded runner actually used (Issue 1). The token hook in `pi-embedded-subscribe.ts` records the actual model used, not the intended model.

### Why "router-evaluator" appears at all

The session key `agent:main:router-evaluator:<uuid>` resolves to agentId `main` via `resolveAgentIdFromSessionKey()` (it extracts the 2nd segment: `main`). So by default, evaluator tokens should be under `main`, not `router-evaluator`.

The fact that `router-evaluator` appears means either:
- The manual `record()` call in the Ollama path creates the first entry (with model `anthropic/claude-sonnet-4-6`)
- And somehow the embedded runner entry for the Sonnet verification also appears under `router-evaluator` — possibly because the 16:25 rebuild included code that changed the session key to `agent:router-evaluator:evaluator:<uuid>` (my reverted change from a21a4983e)

After the revert (17:24 rebuild), the session key is back to `agent:main:router-evaluator:<uuid>`, so new evaluator tokens will be recorded under `main` again — making `router-evaluator` invisible in the token monitor (only the Ollama `record()` entry with 0 tokens would appear).

---

## Summary of Current State (post-17:24 rebuild)

| Component | Status | Issue |
|-----------|--------|-------|
| Cortex tool calling | ✅ Working | Was broken in 16:55 build, fixed in 17:24 |
| Evaluator Ollama stage | ⚠️ Intermittent | Times out on cold starts, works after warm-up |
| Evaluator Sonnet verification | ✅ Fires correctly | But uses Opus instead of Sonnet (Issue 1) |
| Evaluator scoring | ✅ Correct | Ollama overshoots (w=9), Sonnet corrects (w=1) |
| Router executor | ✅ Working | Correctly dispatches to haiku/sonnet/opus tier |
| Token monitor for evaluator | ❌ Incorrect | Shows 0 tokens or under wrong agent/model |

## Proposed Fixes (not yet implemented)

### Issue 1 — Evaluator model (per architecture doc §3.3)

The architecture doc specifies: `evaluator.model: anthropic/claude-sonnet-4-6` in `router/config.json`. **This config exists and is correct.** The `evaluate()` function receives it as `config.model`.

The gap: `verifySonnet()` is a standalone function that doesn't accept a model parameter. It calls `callGateway` without `model`, so the embedded runner falls back to the agent's default (Opus).

**Fix (final, after 3 failed attempts):**

Previous attempts failed because:
- Attempt 1: Changed session key to `agent:router-evaluator:...` without creating agent config → auth issues
- Attempt 2: Hardcoded model string in callGateway params → gateway ignores `model` param in RPC
- Attempt 3: Passed `config.model` to callGateway params → same issue, gateway's `agent` method handler doesn't read `model` from RPC params

**Root cause fully traced:** The gateway's agent handler (`src/gateway/server-methods/agent.ts`) resolves model via `resolveDefaultModelForAgent(cfg, agentId)` → `resolveAgentEffectiveModelPrimary(cfg, agentId)` → `resolveAgentConfig(cfg, agentId)?.model`. The `model` field in `callGateway` RPC params is **never read** by the handler.

**Correct fix (2 parts):**
1. Add `router-evaluator` agent config in `openclaw.json`: `agents["router-evaluator"] = { model: "anthropic/claude-sonnet-4-6" }`
2. Change session key from `agent:main:router-evaluator:<uuid>` to `agent:router-evaluator:eval:<uuid>` so `resolveAgentIdFromSessionKey()` extracts `router-evaluator` (not `main`)

This makes the gateway resolve `router-evaluator`'s agent config → finds `model: "anthropic/claude-sonnet-4-6"` → uses Sonnet. No gateway code changes needed.

### Issue 3 — Token tracking
Accept evaluator tokens under `main` for now. The Ollama `record()` call tracks local usage separately. Sonnet tokens will be correctly attributed once the model param is passed (the embedded runner's hook records the actual model used).

### Issue 2 — No fix needed
Tool calling recovered after rebuild; monitor for recurrence.

## Implementation Log (Chronological)

### Attempt 1 — Hardcoded model in callGateway (reverted)
**Commit:** `759fad54d` (reverted in `2d9bad257`)
- Added `model: "anthropic/claude-sonnet-4-6"` hardcoded in `verifySonnet()` callGateway params
- **Why it failed:** Gateway `agent` RPC handler doesn't read `model` from params — it resolves model from agent config via `resolveDefaultModelForAgent(cfg, agentId)`

### Attempt 2 — Session key change + token tracking (reverted)
**Commit:** `a21a4983e` (reverted in `65366961f`)
- Changed session key to `agent:router-evaluator:...`
- Added token tracking
- **Why it failed:** Premature — changed session key without understanding the full model resolution chain, caused auth issues

### Attempt 3 — Pass `config.model` to verifySonnet
- Added `model: string` param to `verifySonnet()`, passed `config.model` from `evaluate()`
- Added `model` to callGateway params
- **Why it failed:** Same root cause as Attempt 1 — gateway ignores `model` in RPC params. Additionally, gateway validates agent params with **strict schema** and rejects unknown properties: `"invalid agent params: at root: unexpected property 'model'"`

### Attempt 4 — `models.json` for router-evaluator agent dir
- Created `agents/router-evaluator/agent/models.json` with `{ "default": "anthropic/claude-sonnet-4-6" }`
- **Why it failed:** `models.json` is for auth/provider discovery, not default model selection. The model resolution chain reads from `resolveAgentConfig(cfg, agentId)?.model` which reads `openclaw.json`'s agent config, not `models.json`

### Attempt 5 — Wrong config format in openclaw.json
- Added `agents["router-evaluator"] = { model: "..." }` as a keyed object
- **Why it failed:** `agents` uses `list: []` array format, not keyed objects. Config validation rejected it and OpenClaw wouldn't start.

### Attempt 6 — Final correct fix ✅
**Files changed:**
1. `evaluator.ts` — Session key changed to `agent:router-evaluator:eval:<uuid>` (was `agent:main:router-evaluator:<uuid>`). Removed `model` param from `verifySonnet()` — gateway rejects it via strict schema validation.
2. `openclaw.json` — Added `agents.list` array:
   ```json
   "agents": {
     "list": [
       { "id": "main", "default": true },
       { "id": "router-evaluator", "model": "anthropic/claude-sonnet-4-6" }
     ],
     "defaults": { "compaction": { "mode": "safeguard" } }
   }
   ```

**How it works:**
- `verifySonnet()` calls `callGateway({ method: "agent", params: { sessionKey: "agent:router-evaluator:eval:<uuid>", ... } })`
- Gateway extracts agentId via `resolveAgentIdFromSessionKey()` → `router-evaluator`
- `resolveDefaultModelForAgent(cfg, "router-evaluator")` → finds agent entry in `openclaw.json` `agents.list` → `model: "anthropic/claude-sonnet-4-6"`
- Embedded runner uses Sonnet ✅

**Model resolution chain (fully traced):**
```
callGateway({ method: "agent", sessionKey })
  → gateway/server-methods/agent.ts: resolveAgentIdFromSessionKey(sessionKey) → "router-evaluator"
  → commands/agent.ts: resolveDefaultModelForAgent(cfg, "router-evaluator")
  → agents/model-selection.ts: resolveAgentEffectiveModelPrimary(cfg, "router-evaluator")
  → agents/agent-scope.ts: resolveAgentExplicitModelPrimary(cfg, "router-evaluator")
  → agents/agent-scope.ts: resolveAgentConfig(cfg, "router-evaluator")?.model
  → agents/agent-scope.ts: listAgentEntries(cfg) → cfg.agents.list array
  → finds { id: "router-evaluator", model: "anthropic/claude-sonnet-4-6" }
  → uses Sonnet ✅
```

**Status:** Needs build + restart to verify. Sonnet verification has been failing silently (falling back to `fallback_weight: 5`) due to the rejected `model` param.

---

## Phase 6 — Structured Tool Round-Trips (implemented same session)

### Problem
Cortex outputs tool calls as text (`[Tool] sessions_spawn: ...`) instead of using the Anthropic `tool_use` API. Root cause: tool interactions stored as flat strings in `cortex_session` teach the model in-context to mimic text-based tool calls.

### Files changed
1. **`src/cortex/session.ts`** — Added `appendStructuredContent()` for storing JSON content block arrays
2. **`src/cortex/loop.ts`** — Stores `_rawContent` (tool_use blocks) as structured content for both sync and async tools; stores `tool_result` blocks instead of flat `[Tool] name: detail` text
3. **`src/cortex/llm-caller.ts`** — `contextToMessages()` parses JSON array strings from SQLite back into structured blocks; `consolidateMessages()` handles mixed string/array merging by normalizing to arrays
4. **`src/cortex/__tests__/e2e-llm-caller.test.ts`** — Updated consolidation test expectation (merged same-role messages now produce array of text blocks instead of `\n`-joined string)

### Known issue discovered during deployment
Old `cortex_session` rows with text-based tool evidence + new structured `tool_result` rows get consolidated together by `consolidateMessages()`. The merged array has `tool_result` blocks next to `text` blocks, and the Anthropic API rejects `tool_result` without `tool_use_id`. **Session must be cleared after deployment.**

### Tests
325/325 passed, 1 skipped. Full cortex test suite green.

---

## Open Questions

- Why did the 16:55 build break tool calling but 17:24 didn't? Both changed evaluator code, not Cortex code. Could be a build artifact issue or stale session context.
- Should Ollama timeout be increased? Currently 20s (`timeoutMs * 2` where timeout=10s). Ollama cold starts can take 30s+.
- The Ollama scoring is wildly off (scores 9 for a simple command, Sonnet corrects to 1). Is the Ollama prompt/model adequate for this task?
