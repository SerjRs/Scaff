# Claude Code Instructions — 018

## Branch
`feat/018-reusable-llm-client`

## Context
Standalone scripts can't make authenticated LLM calls because the auth infrastructure is buried in bundled gateway code. This task creates a clean, importable module that handles auth profile resolution and API calls, usable by both gateway internals and standalone scripts via `tsx`.

**Critical discovery:** OAuth tokens (`sk-ant-oat01-*`) require `Authorization: Bearer` header + special beta headers, NOT `x-api-key`. The Anthropic SDK (`new Anthropic({ authToken })`) handles this. Direct `fetch()` must replicate this behavior.

## What to Build

### 1. New file: `src/llm/resolve-auth.ts`

Reads the OpenClaw auth-profiles.json and returns a valid API key/token.

```typescript
export interface ResolvedAuth {
  token: string;
  isOAuth: boolean;  // true if token starts with "sk-ant-oat01-"
  provider: string;
  profileId: string;
}

/**
 * Resolve auth credentials from OpenClaw auth profiles.
 * Reads auth-profiles.json from the agent directory.
 * 
 * @param provider - Provider to resolve (default: "anthropic")
 * @param agentDir - Agent directory (default: ~/.openclaw/agents/main/agent)
 */
export function resolveAuth(opts?: {
  provider?: string;
  agentDir?: string;
}): ResolvedAuth
```

**Implementation:**
1. Resolve agent dir: `opts.agentDir ?? path.join(homedir(), '.openclaw', 'agents', 'main', 'agent')`
2. Read `auth-profiles.json` from that directory
3. Find profiles matching the provider (default "anthropic"):
   - Check `lastGood[provider]` first
   - Fall back to first profile matching `${provider}:*`
4. For `type: "token"` or `type: "api_key"`: extract the token/key
5. For `type: "oauth"`: extract `access` field (the access token)
6. Detect OAuth: `token.startsWith("sk-ant-oat01-")`
7. If no valid credential found, throw descriptive error

**Dependencies:** Only `node:fs`, `node:path`, `node:os`. Zero external imports.

### 2. New file: `src/llm/simple-complete.ts`

```typescript
export interface CompleteOptions {
  model?: string;           // default: "claude-haiku-4-5"
  provider?: string;        // default: "anthropic"
  maxTokens?: number;       // default: 2048
  temperature?: number;     // default: 0
  systemPrompt?: string;
  timeoutMs?: number;       // default: 60_000
  agentDir?: string;        // override agent dir for auth resolution
}

export async function complete(
  prompt: string,
  opts?: CompleteOptions,
): Promise<string>
```

**Implementation:**
1. Call `resolveAuth({ provider: opts.provider, agentDir: opts.agentDir })`
2. Build the request based on whether token is OAuth or API key:

**For OAuth tokens (`isOAuth: true`):**
```typescript
const headers = {
  "content-type": "application/json",
  "authorization": `Bearer ${auth.token}`,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  "anthropic-dangerous-direct-browser-access": "true",
};
```

**For API keys (`isOAuth: false`):**
```typescript
const headers = {
  "content-type": "application/json",
  "x-api-key": auth.token,
  "anthropic-version": "2023-06-01",
};
```

3. POST to `https://api.anthropic.com/v1/messages`:
```typescript
const body = {
  model: opts.model ?? "claude-haiku-4-5",
  max_tokens: opts.maxTokens ?? 2048,
  temperature: opts.temperature ?? 0,
  messages: [{ role: "user", content: prompt }],
  ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
};
```

4. Parse response: `data.content[0].text`
5. Handle errors with descriptive messages including model, profile ID, status code

**Dependencies:** Only `node:fs`, `node:path`, `node:os`, and `./resolve-auth.js`. Zero external imports. Uses native `fetch()`.

### 3. New file: `src/llm/index.ts`

```typescript
export { complete, type CompleteOptions } from "./simple-complete.js";
export { resolveAuth, type ResolvedAuth } from "./resolve-auth.js";
```

### 4. Refactor `createGardenerLLMFunction` in `src/cortex/llm-caller.ts`

Replace the current implementation (lines ~817-875) that uses `resolveModel`, `getApiKeyForModel`, and `completeSimple` from `pi-ai` with a call to `complete()`:

```typescript
export function createGardenerLLMFunction(params: LLMCallerParams): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const { complete } = await import("../llm/simple-complete.js");
    return complete(prompt, {
      model: params.modelId,
      provider: params.provider,
      maxTokens: params.maxResponseTokens ?? 2048,
      agentDir: params.agentDir,
      systemPrompt: "You are a concise assistant. Follow instructions exactly.",
    });
  };
}
```

This replaces ~50 lines of code with ~8 lines. The existing `getProfileCandidates` function (lines 783-806) can be removed since `resolveAuth` handles profile resolution.

**Important:** Keep the `LLMCallerParams` interface and the function signature unchanged — only the implementation body changes. Existing callers (gateway-bridge.ts) must not need changes.

### 5. Update migration script: `scripts/library-to-graph.mjs`

Change the `callLLM` function to use the new module. Since it's an .mjs file, either:
- Rename to `scripts/library-to-graph.ts` and use `tsx`
- Or keep .mjs and use dynamic import: `const { complete } = await import('../src/llm/simple-complete.js')`

The simplest approach: rename to `.ts` and import directly:
```typescript
import { complete } from "../src/llm/simple-complete.js";

async function callLLM(prompt: string): Promise<string> {
  return complete(prompt, { model: "claude-haiku-4-5" });
}
```

Update the script's shebang to `#!/usr/bin/env npx tsx`.

## Files to Create/Modify
| File | Change |
|------|--------|
| `src/llm/resolve-auth.ts` | **New** — auth profile reader |
| `src/llm/simple-complete.ts` | **New** — self-contained LLM completion |
| `src/llm/index.ts` | **New** — exports |
| `src/cortex/llm-caller.ts` | Refactor `createGardenerLLMFunction` to use `complete()` |
| `scripts/library-to-graph.mjs` | Update to use `complete()` from llm module (rename to .ts) |

## Tests

Write tests in `src/llm/__tests__/simple-complete.test.ts`:

1. **`resolveAuth` reads auth-profiles.json correctly** — create a temp dir with a mock auth-profiles.json containing a token profile, verify it returns the token
2. **`resolveAuth` detects OAuth tokens** — token starting with `sk-ant-oat01-` → `isOAuth: true`
3. **`resolveAuth` detects API keys** — token starting with `sk-ant-api03-` → `isOAuth: false`
4. **`resolveAuth` throws on missing profile** — empty profiles → descriptive error
5. **`resolveAuth` uses lastGood profile** — multiple profiles, lastGood set → returns that one
6. **OAuth tokens use Bearer header** — mock fetch, call `complete()` with an OAuth token, verify `Authorization: Bearer` header is used (not `x-api-key`)
7. **API keys use x-api-key header** — mock fetch, call `complete()` with an API key, verify `x-api-key` header is used

For fetch mocking, use `vi.stubGlobal('fetch', mockFetch)` in vitest. The mock should return a valid Anthropic Messages API response:
```json
{ "content": [{ "type": "text", "text": "mocked response" }] }
```

For `resolveAuth` tests, create temp directories with mock `auth-profiles.json` files.

## Constraints
- **Zero bundler dependencies** in `src/llm/` — only Node built-ins
- **Zero external package imports** — no `@mariozechner/pi-ai`, no `Anthropic` SDK
- `resolveAuth` must be synchronous (reads file sync) — `complete` is async (makes HTTP call)
- Do NOT modify `createGatewayLLMCaller` (the main Cortex conversation LLM) — only `createGardenerLLMFunction`
- Keep `LLMCallerParams` interface unchanged
- When done, commit, push branch, create PR, then run: `openclaw system event --text "Done 018 reusable LLM client"`
