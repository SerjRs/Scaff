# ACTIVE-ISSUES.md

*Last updated: 2026-03-04*

## Fixed (pending commit/push)

| # | Issue | Root Cause | Fix | Status |
|---|-------|-----------|-----|--------|
| 1 | Router result truncation — complex tasks (w≥7) return 47-85 char intermediate text instead of full results | `createGatewayExecutor()` returned `payloads[0].text` (first intermediate output) instead of last payload | Iterate from last payload backwards in `gateway-integration.ts` | ✅ Fixed, built, deployed. Not committed. |
| 2 | Evaluator using Opus instead of Sonnet for verification | `verifySonnet()` session key resolved to main agent → Opus model | Added `router-evaluator` to `agents.list` in `openclaw.json` with explicit Sonnet model | ✅ Fixed, committed (`b477e7f17`) |
| 3 | Evaluator token tracking — `tokensIn: 0, tokensOut: 0` | Wrong agentId resolution from session key | Session key changed to `agent:router-evaluator:eval:<uuid>` | ✅ Fixed, committed (`b477e7f17`) |
| 4 | Cortex tool calls output as text (context poisoning) | Tool interactions stored as flat strings → replayed as text → model mimics | Structured content blocks in `cortex_session` + consolidation in `llm-caller.ts` | ✅ Fixed, committed (`b477e7f17`) |
| 5 | Cortex `[silence]` on task completions | Ops-trigger carried empty content, loop used vague prompt, LLM didn't comply | Trigger now carries task result inline via metadata; loop extracts and injects directly (`371f84be5`) | ✅ Fixed, hardened, 6/6 e2e tests pass |

## Open — High Priority

| # | Issue | Details | Next Step |
|---|-------|---------|-----------|
| 15 | ~~**Cold memory empty — Vector Evictor never ran**~~ | Code exists and is wired. 0 cold rows because no hot facts are >14 days old yet (all ≤7 days). Evictor will run when facts age. Not a bug. | ✅ Not a bug — working as designed |
| 16 | ~~**Gardener not running**~~ | All 3 workers implemented and scheduled via setInterval. Gardener starts when hippocampus.enabled=true (confirmed). Intervals: Compactor 10min, Extractor 5min, Evictor 10min. Hot memory has 4606 facts, channel states populated. | ✅ Working |
| 17 | ~~**`memory_query` tool — unclear if wired up**~~ | Fully implemented in tools.ts, exposed to LLM via HIPPOCAMPUS_TOOLS, wired in loop.ts sync tool round-trip. Embeds query → KNN search cold storage → promotes retrieved facts back to hot. | ✅ Working |
| 18 | ~~**`fetch_chat_history` tool — unclear if wired up**~~ | Fully implemented in tools.ts, exposed to LLM, wired in loop.ts. Queries cortex_session by channel with limit/before params. | ✅ Working |
| 19 | **Foreground soft cap — budget-remainder approach** | Implemented as budget-remainder (not explicit soft cap per arch spec). Foreground gets maxTokens - systemFloor - background. No hard "max 20 messages" limit. This is functional but differs from the architecture doc. | Monitor — works, may tune later |
| 6 | **Webchat image attachments silently dropped** | Images sent via webchat are not processed. Pipeline traced to `parseMessageWithAttachments()` in `chat-attachments.ts` but code not yet read. | Read `parseMessageWithAttachments()` and trace the image pipeline. |
| 8 | ~~**Evaluator using Opus instead of Sonnet (regression)**~~ | Fixed: agents.list with both `main` (default) and `router-evaluator` + model param schema change. Token monitor confirmed working: Ollama evaluates, Haiku/Sonnet/Opus dispatch. | ✅ Fixed |

## Open — Medium Priority

| # | Issue | Details | Next Step |
|---|-------|---------|-----------|
| 9 | **WhatsApp gateway disconnects** | 4 disconnects overnight (status 428, 499, 503). All auto-reconnected within seconds. | Monitor — may be normal WA server behavior. Investigate if frequency increases. |
| 14 | **Executor context & performance review** | Review executor's context assembly, prompt size, tool availability, and execution times. Identify bottlenecks and optimization opportunities. | Profile executor runs: measure context token counts, system prompt size, time-to-first-token, and total execution time. |
| 11 | **Executor workspace isolation** | Executor reads from `workspace-router-executor/` not main agent's `workspace/`. By design, but limits what tasks can access. | Evaluate whether executor should share main workspace or get selective file access. |
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
