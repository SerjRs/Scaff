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
| 15 | **Cold memory empty — Vector Evictor never ran** | `cortex_cold_memory` table exists with 0 rows. The weekly Gardener task that embeds stale hot facts into `sqlite-vec` cold storage has never executed. No long-term semantic retrieval available. | Verify Vector Evictor code exists, wire it up as a Gardener cron task. |
| 16 | **Gardener not running** | None of the 3 Gardener subsystems are active: Fact Extractor (6h), Channel Compactor (hourly), Vector Evictor (weekly). Hot memory is only populated by auto-capture, not curated extraction. No compression of inactive channels. | Implement and schedule all 3 Gardener tasks as cron jobs. |
| 17 | **`memory_query` tool — unclear if wired up** | The hippocampus architecture defines a semantic recall tool against cold storage (`sqlite-vec`). Unknown if it's exposed to Cortex as a callable tool. | Check Cortex tool definitions, verify `memory_query` is registered and functional. |
| 18 | **`fetch_chat_history` tool — unclear if wired up** | The hippocampus architecture defines a chronological recall tool against `cortex_session`. Unknown if it's exposed to Cortex. | Check Cortex tool definitions, verify `fetch_chat_history` is registered and functional. |
| 19 | **Foreground soft cap partially implemented** | The architecture specifies a soft cap (last 20 messages or ~4K tokens) on Foreground context, with `fetch_chat_history` for on-demand expansion. Current implementation may not enforce the cap or may use a different limit. | Audit `buildForeground()` / context assembly for soft cap enforcement. |
| 6 | **Webchat image attachments silently dropped** | Images sent via webchat are not processed. Pipeline traced to `parseMessageWithAttachments()` in `chat-attachments.ts` but code not yet read. | Read `parseMessageWithAttachments()` and trace the image pipeline. |
| 8 | **Evaluator using Opus instead of Sonnet (regression)** | Token monitor shows `router-evaluator` making 8 calls on `claude-opus-4-6` vs 4 on `anthropic/claude-sonnet-4-6`. The model resolution or session key is still falling back to the main agent's Opus model. Regressed after build `bc67a41`. | Trace evaluator model resolution: check `verifySonnet()`, session key format, and `agents.list` config for `router-evaluator`. |

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
