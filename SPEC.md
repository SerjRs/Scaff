---
id: "018"
title: "Reusable LLM client — expose OpenClaw auth for scripts and internals"
created: "2026-03-15"
author: "scaff"
priority: "high"
status: "cooking"
moved_at: "2026-03-15"
depends_on: []
---

# 018 — Reusable LLM Client

## Problem
Standalone scripts (like `scripts/library-to-graph.mjs`) can't make authenticated LLM calls. The auth infrastructure (OAuth token refresh, profile resolution, API key retrieval) is buried inside gateway internals (`createGardenerLLMFunction` in `llm-caller.ts`) and depends on bundler-specific helpers (`__name` from tsup) that break when imported directly from source via `tsx`.

There's no clean, importable module that says: "give me a prompt, I'll handle auth and return the response."

## Goal
A single importable module that any TypeScript file in the project — gateway code, Cortex workers, standalone scripts, cron jobs — can use to make authenticated LLM calls through OpenClaw's existing auth profiles.

## What to Build

### New module: `src/llm/simple-complete.ts`

```typescript
export interface CompleteOptions {
  model?: string;           // default: "claude-haiku-4-5"
  provider?: string;        // default: "anthropic"
  maxTokens?: number;       // default: 2048
  temperature?: number;     // default: 0
  systemPrompt?: string;    // optional system prompt
  timeoutMs?: number;       // default: 60_000
}

/**
 * Make an authenticated LLM completion call using OpenClaw's auth profiles.
 * Handles: profile resolution, OAuth token refresh, API call, error handling.
 *
 * @param prompt - User message to send
 * @param opts - Model, provider, and call options
 * @returns The text response from the LLM
 */
export async function complete(prompt: string, opts?: CompleteOptions): Promise<string>
```

**Implementation approach:**

1. **Resolve auth profile:** Load `auth-profiles.json` from the agent directory (default: `~/.openclaw/agents/main/agent/`). Find the profile matching the requested provider. Support `OPENCLAW_AGENT_DIR` env var override.

2. **Get API key:** Use the existing `getApiKeyForModel` from `src/agents/model-auth.ts` — this handles OAuth token refresh, keychain access, and profile fallback. If this function has too many bundler dependencies, extract the core logic into a standalone helper that `model-auth.ts` also calls.

3. **Make API call:** Call the Anthropic Messages API directly via `fetch()` — no dependency on `pi-ai` or `completeSimple`. This keeps the module self-contained:
   ```typescript
   const res = await fetch("https://api.anthropic.com/v1/messages", {
     method: "POST",
     headers: {
       "content-type": "application/json",
       "x-api-key": apiKey,
       "anthropic-version": "2023-06-01",
     },
     body: JSON.stringify({
       model: resolvedModelId,
       max_tokens: opts.maxTokens,
       temperature: opts.temperature,
       messages: [{ role: "user", content: prompt }],
       ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
     }),
     signal: AbortSignal.timeout(opts.timeoutMs),
   });
   ```

4. **Model ID resolution:** Map OpenClaw model aliases to Anthropic API model IDs. Check how `resolveModel` in `src/agents/pi-embedded-runner/model.ts` does this and either reuse or replicate the mapping. Common cases:
   - `claude-haiku-4-5` → whatever Anthropic's API expects
   - `claude-sonnet-4-6` → same
   - `claude-opus-4-6` → same

5. **Error handling:** Throw descriptive errors for auth failure, API errors, timeouts. Include model name and profile ID in error messages for debugging.

### Key design constraints

- **Zero bundler dependencies:** Must work when imported via `tsx` directly from source. No reliance on `__name`, `__export`, or any tsup/esbuild runtime helpers.
- **Minimal imports:** Only import from:
  - Node built-ins (`node:crypto`, `node:fs`, `node:path`)
  - Other `src/` modules that are also clean (no bundler deps)
  - If `getApiKeyForModel` from `model-auth.ts` pulls in too much, extract the auth resolution logic into `src/llm/resolve-auth.ts` as a standalone helper
- **Self-contained API call:** Use raw `fetch()` against Anthropic's API, not `pi-ai`'s `completeSimple`. This avoids the entire `@mariozechner/pi-ai` dependency chain.
- **Testable:** Auth resolution and API call should be mockable for unit tests.

### Refactor `createGardenerLLMFunction`

After `simple-complete.ts` works, refactor `createGardenerLLMFunction` in `src/cortex/llm-caller.ts` to use it internally:

```typescript
export function createGardenerLLMFunction(params): (prompt: string) => Promise<string> {
  return (prompt: string) => complete(prompt, {
    model: params.modelId,
    provider: params.provider,
    maxTokens: params.maxResponseTokens,
    systemPrompt: "You are a concise assistant. Follow instructions exactly.",
  });
}
```

This is a refactor, not a behavior change. Existing tests must still pass.

### Export from package

Export from `src/llm/index.ts`:
```typescript
export { complete, type CompleteOptions } from "./simple-complete.js";
```

## Auth Resolution Deep-Dive

The critical piece is getting a valid API key from OpenClaw's auth system. Current flow in `createGardenerLLMFunction`:

1. `resolveModel(provider, modelId, agentDir, config)` → returns a model object
2. `getProfileCandidates(params)` → returns list of profile IDs to try
3. For each profile: `getApiKeyForModel({ model, cfg, agentDir, profileId })` → returns `{ apiKey }`
4. Use the first working key

The new module needs to replicate this flow but with minimal imports. **Investigation needed:** trace the actual dependency chain of `getApiKeyForModel` to determine if it can be imported cleanly, or if core logic needs extraction.

If `getApiKeyForModel` has deep dependencies that bring in bundler helpers, the alternative is:
1. Read `auth-profiles.json` directly
2. For `type: "token"` profiles, use the token directly as the API key
3. For OAuth profiles, call the refresh endpoint if token is expired
4. This covers the common case without importing the full auth stack

## What NOT to Change
- Auth profile storage format — stays as-is
- `openclaw configure` flow — stays as-is
- Existing `createGardenerLLMFunction` behavior — refactor only, no behavior change
- `pi-ai` usage in the main LLM caller (Cortex conversation loop) — stays as-is

## Tests
- `complete("Say hello")` returns a non-empty string (integration test, needs live API)
- Auth resolution finds the right profile from `auth-profiles.json`
- Missing auth profile throws descriptive error
- API timeout triggers proper error
- `createGardenerLLMFunction` still works after refactor (existing gardener tests pass)

## Files
| File | Change |
|------|--------|
| `src/llm/simple-complete.ts` | **New** — core module |
| `src/llm/resolve-auth.ts` | **New** (maybe) — auth resolution if extraction needed |
| `src/llm/index.ts` | **New** — exports |
| `src/cortex/llm-caller.ts` | Refactor `createGardenerLLMFunction` to use `complete()` |
| `scripts/library-to-graph.ts` | Update to use `import { complete } from '../src/llm/simple-complete.js'` |

## Success Criteria
```bash
# This must work from any script in the project:
npx tsx -e "import { complete } from './src/llm/simple-complete.js'; console.log(await complete('Say hello', { model: 'claude-haiku-4-5' }))"
```
