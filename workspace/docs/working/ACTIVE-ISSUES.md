# ACTIVE-ISSUES.md

*Last updated: 2026-03-10*

## Fixed

| # | Issue | Root Cause | Fix | Status |
|---|-------|-----------|-----|--------|
| 1 | Router result truncation — complex tasks (w≥7) return 47-85 char intermediate text instead of full results | `createGatewayExecutor()` returned `payloads[0].text` (first intermediate output) instead of last payload | Iterate from last payload backwards in `gateway-integration.ts` | ✅ Fixed |
| 2 | Evaluator using Opus instead of Sonnet for verification | `verifySonnet()` session key resolved to main agent → Opus model | Added `router-evaluator` to `agents.list` with explicit Sonnet model (`b477e7f17`) | ✅ Fixed |
| 3 | Evaluator token tracking — `tokensIn: 0, tokensOut: 0` | Wrong agentId resolution from session key | Session key changed to `agent:router-evaluator:eval:<uuid>` (`b477e7f17`) | ✅ Fixed |
| 4 | Cortex tool calls output as text (context poisoning) | Tool interactions stored as flat strings → replayed as text → model mimics | Structured content blocks in `cortex_session` + consolidation in `llm-caller.ts` (`b477e7f17`) | ✅ Fixed |
| 5 | Cortex `[silence]` on task completions | Ops-trigger carried empty content, loop used vague prompt, LLM didn't comply | Trigger now carries task result inline via metadata; loop extracts and injects directly (`371f84be5`) | ✅ Fixed |
| 8 | Evaluator using Opus instead of Sonnet (regression) | agents.list missing `router-evaluator` after config rewrite | Restored agents.list with `router-evaluator` + model param schema change | ✅ Fixed |
| 11 | Executor workspace isolation | Executor isolated by design (empty workspace, auth only). Cortex passes files via `resources` param in `sessions_spawn`. | E2E verified: file resource read and delivered to executor. | ✅ Fixed |
| 14 | Executor context & resource-passing | `sessions_spawn` now accepts `resources` array (file/url/inline). | 17/17 unit tests + live e2e pass. Commits: `663a82ed6`, `b82b57331`. | ✅ Fixed |
| 15 | Cold memory empty — Vector Evictor never ran | 0 cold rows because no hot facts are >14 days old yet. Evictor will run when facts age. | ✅ Not a bug — working as designed |
| 16 | Gardener not running | All 3 workers implemented and scheduled via setInterval. Confirmed working. | ✅ Working |
| 17 | `memory_query` tool — unclear if wired up | Fully implemented, exposed to LLM, wired in loop.ts. | ✅ Working |
| 18 | `fetch_chat_history` tool — unclear if wired up | Fully implemented, exposed to LLM, wired in loop.ts. | ✅ Working |
| 19 | Foreground soft cap — budget-remainder approach | Implemented as budget-remainder. Foreground sharding fully implemented (43 tests, all passing). | ✅ Fixed — sharding controls foreground budget |
| 20 | Cortex does not start after config rewrite | Cortex config lives in `cortex/config.json` (NOT openclaw.json). Assistant prefill incompatible with thinking=high. | Strip trailing assistant messages in llm-caller.ts (`b82b57331`). | ✅ Fixed |
| 21 | Evaluator does not start after config rewrite | `router-evaluator` missing from agents.list + double-prefixed model. | Use `EVALUATOR_MODEL` constant without provider prefix (`6c39f45e0`). | ✅ Fixed |
| 26 | Cortex session corruption — tool_use/tool_result pairing | Mixed sync+async tool handling: async tool_results stored as duplicates. API rejects with 400 permanently. | Fix sync+async split, validateToolPairing dedup, circuit breaker (`c1cb2a60e`, `901fbf916`). DB cleaned. | ✅ Fixed |
| 27 | Cortex context metadata — sender identity + tool messages | `issuer` field same for all messages (no sender distinction). Tool messages had no timestamp/channel metadata. | Replace `issuer` with actual sender. Inject metadata text block in tool arrays (`28a9936e3`). | ✅ Fixed |
| 28 | Cortex `[silence]` on webchat — SOUL.md "stay silent" rule | Sender showed as "Partner" (not recognized as approved). SOUL.md instruction: "stay silent for unapproved senders." | Removed "stay silent" line from SOUL.md. Cortex has channel-level allowlisting instead. | ✅ Fixed |
| 29 | WhatsApp auto-reply routing to webchat | Cortex config had `"false"` (truthy string) instead of `"off"`. Caused partial dual-delivery. | Changed to `"off"` in cortex/config.json. | ✅ Fixed |
| 30 | Cortex unified context — cross-channel filtering | `buildContext` filtered per channel instead of per issuer. Cross-channel messages invisible. | Issuer-based filtering implemented. Spec: `02_cortex-unified-context.md`. | ✅ Fixed |

## Open — High Priority

| # | Issue | Details | Next Step |
|---|-------|---------|-----------|
| 6 | **Image attachments silently dropped (Cortex only)** | Images sent via webchat and WhatsApp are not processed by Cortex. Pipeline traced to `parseMessageWithAttachments()` in `chat-attachments.ts` but code not yet read. | Read `parseMessageWithAttachments()` and trace the image pipeline. |
| 31 | **Process-isolated executors** | Executors run in-process with gateway. A stuck/crashed executor can kill everything. Architecture + implementation spec written. Spec: `01_process-isolated-executors.md`. | Implement Phase 1: fork-per-job. |

## Open — Medium Priority

| # | Issue | Details | Next Step |
|---|-------|---------|-----------|
| 12 | **Ollama bypassed under load** | Concurrent evaluations always timeout → Sonnet fallback handles all scoring. Ollama only works for sequential evals. | Consider queue/serialization for Ollama evals, or accept Sonnet-only. |
| 22 | **Hippocampus fact dedup is exact-match only** | `gardener.ts` lines 208-210 and 249-251 check `WHERE fact_text = ?` — exact string match. Architecture spec calls for cosine similarity >0.85 via embeddings, never implemented. MEMORY.md claim about "cosine dedup since 2026-02-23" is a hallucinated Hippocampus fact. | Verify current state — Claude Code may have been asked to remove it. If still exact-match: implement embedding-based dedup via Ollama. |

## Open — Low Priority / Future

| # | Issue | Details |
|---|-------|---------|
| 7 | **Gateway DNA verification patch lost** | Fail-closed patch for DNA verification was lost during update to 2026.2.22-2. Re-apply when stable. |
| 10 | **Immune System runtime policy engine** | Discussed 2026-02-13, not started. |

## Spec vs Implementation Divergences

These are not bugs — the implementation chose a simpler/better path than the original spec.

| # | Spec | Actual Implementation | Notes |
|---|------|----------------------|-------|
| D1 | **`cortex_pending_ops` table + System Floor injection** | `cortex_pending_ops` table **removed**. Results written directly to `cortex_session` via `appendTaskResult()`. | Simpler — no dual-path. Result goes straight to Foreground. |
| D2 | **`[DISPATCHED]` evidence records** | Not implemented. Tool round-trips stored as structured content blocks instead. | Structured tool_use/tool_result blocks serve the same provenance purpose. |
| D3 | **Gardener Fact Extractor uses "Sonnet-tier LLM"** | Uses **Haiku** (`hippocampus.gardenerModel: claude-haiku-4-5`). Changed 2026-03-07 to reduce cost. | Haiku is sufficient for extraction with the improved prompt. |

## Key Files Reference

- `src/router/gateway-integration.ts` — executor factory, Router↔Gateway bridge
- `src/router/evaluator.ts` — task evaluation (Ollama → Sonnet two-stage)
- `src/cortex/loop.ts` — Cortex message processing loop
- `src/cortex/llm-caller.ts` — LLM context building, consolidation, metadata
- `src/cortex/context.ts` — context assembly, sharding, foreground/background
- `src/cortex/shards.ts` — shard management, boundary detection
- `src/cortex/session.ts` — session storage, appendToSession
- `src/cortex/gardener.ts` — fact extraction, compaction, eviction
- `src/gateway/server-methods/chat.ts` — webchat handler
- `src/agents/pi-embedded-subscribe.ts` — embedded agent run
- `src/agents/pi-embedded-runner/run/attempt.ts` — run loop, abort/timeout
- `src/router/worker.ts` — task execution orchestration
- `src/auto-reply/dispatch.ts` — inbound message routing, cortex mode check
- `src/auto-reply/envelope.ts` — message envelope formatting for Main Agent

## Databases

- `cortex/bus.sqlite` — `cortex_bus` (message queue), `cortex_session` (conversation), `cortex_hot_memory` (facts), `cortex_shards` (shard management)
- `router/queue.sqlite` — `jobs` (active), `jobs_archive` (completed)
