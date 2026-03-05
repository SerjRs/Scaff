# ACTIVE-ISSUES.md

*Last updated: 2026-03-05*

## Fixed

| # | Issue | Root Cause | Fix | Status |
|---|-------|-----------|-----|--------|
| 1 | Router result truncation — complex tasks (w≥7) return 47-85 char intermediate text instead of full results | `createGatewayExecutor()` returned `payloads[0].text` (first intermediate output) instead of last payload | Iterate from last payload backwards in `gateway-integration.ts` | ✅ Fixed |
| 2 | Evaluator using Opus instead of Sonnet for verification | `verifySonnet()` session key resolved to main agent → Opus model | Added `router-evaluator` to `agents.list` with explicit Sonnet model (`b477e7f17`) | ✅ Fixed |
| 3 | Evaluator token tracking — `tokensIn: 0, tokensOut: 0` | Wrong agentId resolution from session key | Session key changed to `agent:router-evaluator:eval:<uuid>` (`b477e7f17`) | ✅ Fixed |
| 4 | Cortex tool calls output as text (context poisoning) | Tool interactions stored as flat strings → replayed as text → model mimics | Structured content blocks in `cortex_session` + consolidation in `llm-caller.ts` (`b477e7f17`) | ✅ Fixed |
| 5 | Cortex `[silence]` on task completions | Ops-trigger carried empty content, loop used vague prompt, LLM didn't comply | Trigger now carries task result inline via metadata; loop extracts and injects directly (`371f84be5`) | ✅ Fixed |
| 8 | Evaluator using Opus instead of Sonnet (regression) | agents.list missing `router-evaluator` after config rewrite | Restored agents.list with `router-evaluator` + model param schema change | ✅ Fixed |
| 15 | Cold memory empty — Vector Evictor never ran | 0 cold rows because no hot facts are >14 days old yet. Evictor will run when facts age. | ✅ Not a bug — working as designed |
| 16 | Gardener not running | All 3 workers implemented and scheduled via setInterval. Confirmed working. | ✅ Working |
| 17 | `memory_query` tool — unclear if wired up | Fully implemented, exposed to LLM, wired in loop.ts. | ✅ Working |
| 18 | `fetch_chat_history` tool — unclear if wired up | Fully implemented, exposed to LLM, wired in loop.ts. | ✅ Working |
| 20 | Cortex does not start after config rewrite | Cortex config lives in `cortex/config.json` (NOT openclaw.json). Also: assistant message prefill incompatible with thinking=high caused 400 errors. | Strip trailing assistant messages in llm-caller.ts when thinking enabled (`b82b57331`). Config validator checks correct file. | ✅ Fixed |
| 21 | Evaluator does not start after config rewrite | 1) `router-evaluator` missing from agents.list. 2) `verifySonnet` had hardcoded `'anthropic/claude-sonnet-4-6'` → gateway double-prefixed to `'anthropic/anthropic/...'`. 3) Ghost token entry from zero-token record() call. | Use `EVALUATOR_MODEL` constant without provider prefix (`6c39f45e0`). Remove redundant record() (`548e3a41b`). Agent model set to `claude-sonnet-4-6`. | ✅ Fixed |

## Open — High Priority

| # | Issue | Details | Next Step |
|---|-------|---------|-----------|
| 6 | **Webchat image attachments silently dropped** | Images sent via webchat are not processed. Pipeline traced to `parseMessageWithAttachments()` in `chat-attachments.ts` but code not yet read. | Read `parseMessageWithAttachments()` and trace the image pipeline. |
| 19 | **Foreground soft cap — budget-remainder approach** | Implemented as budget-remainder (not explicit soft cap per arch spec). Foreground gets maxTokens - systemFloor - background. No hard "max 20 messages" limit. This is functional but differs from the architecture doc. | Monitor — works, may tune later |

## Open — Medium Priority

| # | Issue | Details | Next Step |
|---|-------|---------|-----------|
| 9 | **WhatsApp gateway disconnects** | 4 disconnects overnight (status 428, 499, 503). All auto-reconnected within seconds. | Monitor — may be normal WA server behavior. Investigate if frequency increases. |
| 14 | **Executor context & performance review** | Review executor's context assembly, prompt size, tool availability, and execution times. Identify bottlenecks and optimization opportunities. **Gap:** No mechanism for Cortex to pass resources (files, URLs, data) to the executor beyond stuffing everything into the `task` string. `sessions_spawn` only has a `task` field — no `resources`, `attachments`, or `context_files` param. Cortex must inline all content, bloating the task and wasting tokens. Need to enrich the spawn API with a resource/attachment mechanism so executors can receive structured context without token waste. | Profile executor runs; design resource-passing API for `sessions_spawn`. |
| 11 | **Executor workspace isolation** | Executor reads from `workspace-router-executor/` not main agent's `workspace/`. By design, but limits what tasks can access. Related to #14 gap — even if executor had file access, Cortex has no way to tell it WHICH files to read. | Evaluate whether executor should share main workspace or get selective file access. |
| 12 | **Ollama bypassed under load** | Concurrent evaluations always timeout → Sonnet fallback handles all scoring. Ollama only works for sequential evals. | Consider queue/serialization for Ollama evals, or accept Sonnet-only. |

## Open — Low Priority / Future

| # | Issue | Details |
|---|-------|---------|
| 7 | **Gateway DNA verification patch lost** | Fail-closed patch for DNA verification was lost during update to 2026.2.22-2. Re-apply when stable. |
| 10 | **Immune System runtime policy engine** | Discussed 2026-02-13, not started. |

## Key Files Reference

- `src/router/gateway-integration.ts` — executor factory, Router↔Gateway bridge
- `src/router/evaluator.ts` — task evaluation (Ollama → Sonnet two-stage)
- `src/cortex/loop.ts` — Cortex message processing loop
- `src/cortex/llm-caller.ts` — LLM context building, consolidation
- `src/gateway/server-methods/chat.ts` — webchat handler
- `src/agents/pi-embedded-subscribe.ts` — embedded agent run, assistantTexts collection
- `src/agents/pi-embedded-runner/run/attempt.ts` — run loop, abort/timeout logic
- `src/router/worker.ts` — task execution orchestration

## Databases

- `cortex/bus.sqlite` — `cortex_bus` (message queue), `cortex_session` (conversation)
- `router/queue.sqlite` — `jobs` (active), `jobs_archive` (completed)
