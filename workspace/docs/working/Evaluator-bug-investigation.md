# Router Evaluator Bug Investigation

**Date:** 2026-03-03
**Investigator:** Scaff
**Status:** Root cause identified

## Problem

Token monitor shows `router-evaluator` using `claude-opus-4-6` instead of `claude-sonnet-4-6`. The Sonnet verification step of the evaluator was designed to use Sonnet, but it's running on Opus.

Token monitor output (post-rebuild at 16:25):
```
router-evaluator │ anthropic/claude-sonnet-4-6 │  0 │  0 │  0 │  1   ← Ollama (0 tokens = timeout)
router-evaluator │ claude-opus-4-6             │  6 │ 94 │  0 │  2   ← Sonnet verification... on OPUS!
```

## Root Cause

From gateway log at `2026-03-03T16:28:04.861Z`:
```
embedded run start: runId=ff0aee51 provider=anthropic model=claude-opus-4-6 thinking=low
```

The evaluator's `verifySonnet()` calls `callGateway({ method: "agent", sessionKey: "agent:router-evaluator:evaluator:uuid" })`. The embedded runner resolves model for this session by looking up the `router-evaluator` agent's config. 

**The `router-evaluator` agent has no `models.json`** — so the embedded runner falls back to the **default model** (`claude-opus-4-6`).

The evaluator source code in `evaluator.ts` doesn't pass a model parameter in the `callGateway` call — it relies on the embedded runner to pick the model. The embedded runner picks from agent config → global default → hardcoded fallback. Since `router-evaluator` agent has no model config, it gets the global default: Opus.

## Evidence (from logs)

### Evaluator flow at 16:28 (post-rebuild):
1. `16:28:03.966Z` — Ollama failed (AbortError timeout)
2. `16:28:03.980Z` — Falls through to Sonnet verification
3. `16:28:04.357Z` — callGateway agent request sent
4. `16:28:04.861Z` — **embedded run start: model=claude-opus-4-6** ← WRONG, should be sonnet
5. `16:28:09.318Z` — Sonnet verified: w=5 (result is correct, but used Opus for a Sonnet job)

### Evaluator flow at 09:04-09:07 (pre-rebuild, old session key):
Same pattern — the old session key `agent:main:router-evaluator:uuid` resolved to agent `main`, which also uses Opus as its default model. So Sonnet verification has **never** actually used Sonnet.

### Comparison: Router executor immediately after (16:28:09):
```
embedded run start: runId=f233085f model=claude-sonnet-4-6
```
The executor correctly gets Sonnet because `router-executor` agent resolves model from the Router's tier config. The evaluator has no such model override.

## The Design Gap

`verifySonnet()` in `evaluator.ts`:
```typescript
const response = await callGateway({
  method: "agent",
  params: {
    message: prompt,
    sessionKey: `agent:router-evaluator:evaluator:${idempotencyKey}`,
    deliver: false,
    idempotencyKey,
  },
});
```

No `model` parameter is passed. The embedded runner picks model from:
1. Agent's `models.json` → **doesn't exist** for `router-evaluator`
2. Global default → `claude-opus-4-6`

## Router Queue Analysis

110 archived jobs total. Weight distribution:
- w=1-3 → haiku (most jobs): evaluator correctly classifies simple tasks
- w=4-5 → sonnet: evaluator + Sonnet verification working for moderate tasks
- w=0 → none scored opus-level in practice

Last job (3a36c10f at 16:27): result was "The AI service is temporarily overloaded" — executor API overload.

**The evaluator IS functioning** — it scores tasks, Sonnet verifies when weight >3, tier selection works. The bug is specifically that Sonnet verification uses Opus instead of Sonnet (model not passed explicitly).

## Post-Rebuild Status (16:55 rebuild)

After the Sonnet model fix was deployed:
- **No evaluator calls have occurred** — the evaluator hasn't been triggered
- Token monitor shows empty for `router-evaluator` because no evaluator ran post-rebuild

### Critical Finding: Cortex sessions_spawn is broken post-rebuild

At 17:02:56, Cortex LLM returned:
```
content blocks: [{"type":"thinking"},{"type":"text"}]
textContent: "[Tool] sessions_spawn: 'Read the file at C:\Users\Temp User\.openclaw\src\gatewa"
```

**There is no `tool_use` block** — the LLM is outputting `[Tool] sessions_spawn` as plain text, not as an actual tool call. The Cortex loop sees text and routes it to webchat output. No tool execution happens, so the Router never receives the task.

This means:
- Zero jobs entered the Router queue post-rebuild
- The evaluator never fired
- The Sonnet model fix is deployed but unverifiable
- **Cortex's tool calling is broken** — the LLM stopped making real tool calls

Possible cause: the `completeSimple` call may not be passing the tool definitions correctly after the rebuild, or the thinking=high parameter changed how the model structures its responses (thinking models may format tool calls differently).

## Fix Required

Pass the model explicitly in the `callGateway` call, or create a `models.json` for the `router-evaluator` agent that specifies Sonnet.

**Option A** (code change): Add `model: "anthropic/claude-sonnet-4-6"` to the callGateway params.

**Option B** (config): Create `agents/router-evaluator/agent/models.json` with Sonnet as default.

Option A is more explicit and less fragile. The evaluator is purpose-built for Sonnet verification — the model shouldn't be determined by agent config fallbacks.

## Ollama Issue (secondary)

Ollama keeps timing out despite warm-up:
- `16:25:23` — Ollama warmed up successfully
- `16:28:03` — 3 minutes later, Ollama AbortError timeout

The warm-up loads the model, but Ollama may be unloading it due to memory pressure or idle timeout (default 5 min keepalive). Under the current 20s timeout (`timeoutMs * 2` where timeout=10s), Ollama cold starts still exceed the limit.

**Not critical** — when Ollama fails, the Sonnet verification takes over. But it means every evaluation costs Sonnet tokens instead of being free (local).
