# Token Monitor — Hook Points Spec

## Goal
Build a token usage monitor that tracks input/output tokens per LLM call across ALL surfaces.

## Architecture Decision: Single Hook Point

**The token monitor hooks into `pi-embedded-subscribe.ts` → `recordAssistantUsage()`.**

This is the ONE place where every embedded LLM response's usage passes through — regardless of whether the request came from WhatsApp, webchat, TUI, or cron. This avoids double-counting and covers all surfaces.

For CLI-based providers (Claude Code CLI, Codex), usage is hooked in `cli-runner.ts` since those don't go through the embedded subscribe path.

## Hooked Files

### `src/agents/pi-embedded-subscribe.ts` → `recordAssistantUsage()` (line ~259)
- **PRIMARY HOOK** — fires for every assistant message with usage
- Covers: webchat, TUI, WhatsApp, Telegram, Discord, cron (embedded runner)
- Has access to `state.lastAssistant` for model/provider, and `params.sessionKey` for agent ID
- Uses `resolveAgentIdFromSessionKey()` from `../../config/sessions.js`

### `src/agents/cli-runner.ts` (after output parsing, ~line 327)
- **CLI HOOK** — fires for CLI-based providers (Claude Code, Codex)
- Has `params.sessionKey` and `modelId` in scope

## NOT hooked (removed to prevent double-counting)

- ~~`src/auto-reply/reply/agent-runner.ts`~~ — would double-count with subscribe hook
- ~~`src/auto-reply/reply/followup-runner.ts`~~ — would double-count with subscribe hook

## Key Supporting Files

### `src/agents/usage.ts`
- `normalizeUsage(raw)` — converts any provider format into `{ input, output, cacheRead, cacheWrite, total }`
- `UsageLike` type accepts all known formats
- **Canonical normalizer** — used by both hooks

### `src/token-monitor/ledger.ts`
- In-memory `Map<string, TokenLedgerRow>` keyed by `agentId\0model`
- `record(event)` — upserts usage into the map
- `snapshot()` — returns sorted rows
- `reset()` — clears the map
- Resets on gateway restart (by design)

### `src/token-monitor/stream-hook.ts`
- `recordRunResultUsage({ usage, agentId, model })` — normalizes and feeds into ledger
- `createTokenLedgerHook({ agentId, modelId })` — alternative message-scanning hook (unused)

### `src/token-monitor/gateway-methods.ts`
- `usage.tokens` → returns snapshot with rows + totals
- `usage.tokens.reset` → clears the ledger

### `src/token-monitor/cli.ts`
- `openclaw tokens` — table display
- `openclaw tokens --watch` — live 2s refresh
- `openclaw tokens --json` — machine-readable
- `openclaw tokens --reset` — clear ledger

### `src/token-monitor/launcher.ts`
- Auto-launches `openclaw tokens --watch` in a separate terminal window on gateway start

## Wiring Checklist

- [x] `recordAssistantUsage` in `pi-embedded-subscribe.ts` calls `recordRunResultUsage`
- [x] `cli-runner.ts` calls `recordRunResultUsage` after output
- [x] `tokenMonitorHandlers` spread into `src/gateway/server-methods.ts`
- [x] `registerTokensCommand(program)` in `src/cli/program/command-registry.ts`
- [x] No double-counting (agent-runner/followup-runner hooks removed)

## Where Usage Comes From

The assistant message carries `.usage` with provider-specific fields:
- **Anthropic:** `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`
- **OpenAI/OpenRouter:** `{ prompt_tokens, completion_tokens, total_tokens }`
- **Google:** varies, check `src/agents/pi-embedded-runner/google.ts`

All unified through `normalizeUsage()` → `{ input, output, cacheRead, cacheWrite, total }`.
