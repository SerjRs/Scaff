# ACTIVE-ISSUES.md

*Last updated: 2026-03-04*

## Fixed (pending commit/push)

| # | Issue | Root Cause | Fix | Status |
|---|-------|-----------|-----|--------|
| 1 | Router result truncation — complex tasks (w≥7) return 47-85 char intermediate text instead of full results | `createGatewayExecutor()` returned `payloads[0].text` (first intermediate output) instead of last payload | Iterate from last payload backwards in `gateway-integration.ts` | ✅ Fixed, built, deployed. Not committed. |
| 2 | Evaluator using Opus instead of Sonnet for verification | `verifySonnet()` session key resolved to main agent → Opus model | Added `router-evaluator` to `agents.list` in `openclaw.json` with explicit Sonnet model | ✅ Fixed, committed (`b477e7f17`) |
| 3 | Evaluator token tracking — `tokensIn: 0, tokensOut: 0` | Wrong agentId resolution from session key | Session key changed to `agent:router-evaluator:eval:<uuid>` | ✅ Fixed, committed (`b477e7f17`) |
| 4 | Cortex tool calls output as text (context poisoning) | Tool interactions stored as flat strings → replayed as text → model mimics | Structured content blocks in `cortex_session` + consolidation in `llm-caller.ts` | ✅ Fixed, committed (`b477e7f17`) |

## Open — High Priority

| # | Issue | Details | Next Step |
|---|-------|---------|-----------|
| 5 | **Cortex `[silence]` on task completions** | Router tasks complete successfully but Cortex responds `[silence]` to ops-trigger callbacks instead of relaying results to webchat. All 5 stress test results (w=4 to w=9) were ignored. **Regression introduced by the truncation fix (#1)** — started happening after the `payloads[0] → payloads[last]` change was deployed. The fix itself is correct (results are full in the DB), but something in how Cortex processes the completion signal broke. | Investigate Cortex ops-trigger handler — how does it process `[Task update available]` messages and why does it produce `[silence]`? Check `cortex/loop.ts`, the Router channel handler, and whether the payload shape changed. |
| 6 | **Webchat image attachments silently dropped** | Images sent via webchat are not processed. Pipeline traced to `parseMessageWithAttachments()` in `chat-attachments.ts` but code not yet read. | Read `parseMessageWithAttachments()` and trace the image pipeline. |

## Open — Medium Priority

| # | Issue | Details | Next Step |
|---|-------|---------|-----------|
| 7 | **Gateway DNA verification patch lost** | Fail-closed patch for DNA verification was lost during update to 2026.2.22-2. | Re-apply the patch. |
| 8 | **Evaluator `verifySonnet()` session key format** | Uses `agent:main:router-evaluator:${idempotencyKey}` — the `main` prefix may cause issues. Should be `agent:router-evaluator:eval:${uuid}` per fix in #3, but `verifySonnet()` may still use old format internally. | Verify the session key in `verifySonnet()` matches the fixed format. |
| 9 | **WhatsApp gateway disconnects** | 4 disconnects overnight (status 428, 499, 503). All auto-reconnected within seconds. | Monitor — may be normal WA server behavior. Investigate if frequency increases. |

## Open — Low Priority / Future

| # | Issue | Details |
|---|-------|---------|
| 10 | **Immune System runtime policy engine** | Discussed 2026-02-13, not started. |
| 11 | **Executor workspace isolation** | Executor reads from `workspace-router-executor/` not main agent's `workspace/`. By design, but limits what tasks can access. |
| 12 | **Ollama bypassed under load** | Concurrent evaluations always timeout → Sonnet fallback handles all scoring. Ollama only works for sequential evals. |
| 13 | **No Brave API key** | Web searches from executor/Cortex fail. |

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
