# Code Quality Report: `src/cortex/llm-caller.ts`

**File:** `src/cortex/llm-caller.ts` (543 lines)  
**Role:** Cortex LLM Caller — bridges Cortex (the conversational orchestrator) to the LLM inference layer via pi-ai streaming infrastructure. Handles auth profile rotation, message format conversion, tool injection, and token tracking.  
**Analysis Date:** 2026-03-05  

---

## 1. Dependency Fan-In / Fan-Out

### Fan-Out (this file imports from): **7 modules**

| # | Module | Type | Coupling |
|---|--------|------|----------|
| 1 | `./context.js` (AssembledContext) | Static type-only | Low |
| 2 | `./tools.js` (HIPPOCAMPUS_TOOLS, CORTEX_TOOLS) | Static value | Medium |
| 3 | `../token-monitor/stream-hook.js` (recordRunResultUsage) | Static value | Medium |
| 4 | `../agents/pi-embedded-runner/model.js` (resolveModel) | Dynamic import | High — core model resolution |
| 5 | `../agents/model-auth.js` (getApiKeyForModel) | Dynamic import | High — auth secrets |
| 6 | `@mariozechner/pi-ai` (completeSimple) | Dynamic import | **Critical** — external LLM SDK |
| 7 | `node:fs`, `node:path` | Dynamic import (stdlib) | Low |

### Fan-In (other modules import from this file): **5 modules**

| # | Consumer | What it imports |
|---|----------|----------------|
| 1 | `src/cortex/gateway-bridge.ts` | `createGatewayLLMCaller`, `createGardenerLLMFunction` |
| 2 | `src/cortex/index.ts` | `CortexLLMResult` (type) |
| 3 | `src/cortex/loop.ts` | `CortexLLMResult` (type) |
| 4 | `src/cortex/__tests__/e2e-delegation.test.ts` | `CortexLLMResult` (type) |
| 5 | `src/cortex/__tests__/e2e-llm-caller.test.ts` | Multiple exports |
| 6 | `src/cortex/__tests__/e2e-task-ownership.test.ts` | `CortexLLMResult` (type) |

**Summary:** Fan-out = **7**, Fan-in = **5** (3 production + 3 test)

**Coupling Assessment:** Moderate-high. The file sits at a critical junction: it's the *sole* bridge between Cortex's context assembly and the external LLM SDK. The dynamic imports to `pi-embedded-runner/model.js` and `model-auth.js` are intentional (documented: "avoid hard dependency on gateway internals at module load time") but create implicit coupling to 3 gateway-internal modules that could break silently if their signatures change.

---

## 2. Error Handling Coverage

### Async Path Inventory (5 total catch blocks)

| # | Location (line) | Scope | Handling | Verdict |
|---|----------------|-------|----------|---------|
| 1 | L182 | `JSON.parse(content)` in `contextToMessages` | `catch { /* keep as string */ }` | ⚠️ **Silent swallow** — intentional fallback, but no logging at all |
| 2 | L418–427 | Inner `for (profileId)` loop in `createGatewayLLMCaller` | Checks if auth error → `params.onError()` + `continue`. Non-auth → `throw` | ✅ Correct — retry on auth, propagate others |
| 3 | L430–434 | Outer try/catch in `createGatewayLLMCaller` | `params.onError(error)` → returns `{ text: "NO_REPLY", toolCalls: [] }` | ⚠️ **Silent degradation** — swallows ALL errors into NO_REPLY |
| 4 | L462 | `getProfileCandidates` | `catch { return [undefined]; }` | ⚠️ **Silent swallow** — file read failure is completely hidden |
| 5 | L523–528 | Inner loop in `createGardenerLLMFunction` | Same pattern as #2: auth errors → `continue`, others → `throw` | ✅ Correct |

### Missing Error Handling

- **Dynamic imports (L272-273, L364, L478-479, L503):** Six `await import()` calls are *not* individually try/caught. If `pi-ai` or `model.js` fails to load (missing dependency, corrupted module), the error falls through to the outer catch (#3) which silently returns NO_REPLY. The user gets silence with no diagnostic.
- **`resolveModel` null check (L280):** Model-not-found logs via `onError` then returns NO_REPLY — this is correct but the log uses `new Error()` level for what's really a warning, making it noisy in error tracking.
- **`recordRunResultUsage` (L402):** Called without try/catch. If the token monitor throws, it crashes the entire LLM call even though tracking is non-critical.

### Error Handling Coverage Estimate: **~55%**

Rationale: 2 of 5 catch blocks handle errors properly. 3 silently swallow or degrade. Critical dynamic import failures are masked. The token-monitor call is unprotected. The *happy path* is well-covered, but failure modes are underspecified.

---

## 3. Silent Failure Paths (catch blocks that only log or swallow)

| # | Line | Code Pattern | Risk |
|---|------|-------------|------|
| 1 | **L182** | `catch { /* keep as string */ }` | **Low** — Intentional JSON parse fallback. But if content is `[{broken...`, the LLM receives malformed text instead of structured blocks, potentially causing hallucinated tool calls. Should at minimum `console.debug`. |
| 2 | **L430–434** | `catch (err) { params.onError(error); return { text: "NO_REPLY", toolCalls: [] }; }` | **High** — This is the outermost catch for the *entire* LLM call. Network timeouts, SDK crashes, import failures — all become `NO_REPLY`. The user's message simply vanishes. `onError` logs it, but there's no retry, no escalation, no user-visible error message. |
| 3 | **L462** | `catch { return [undefined]; }` | **Medium** — `auth-profiles.json` read failure is silently eaten. If the file is corrupted or permissions change, all profile-based auth degrades to `undefined` profile without any log. Could cause cascading auth failures that are difficult to diagnose. |

---

## 4. State Management Risks

### Mutable Shared State
- **None detected.** The file is stateless at module scope. `SESSIONS_SPAWN_TOOL` is a `const` object (but not `Object.freeze`'d — a consumer *could* mutate it at runtime, though this is low-risk).

### Singletons
- **None.** Factory functions (`createGatewayLLMCaller`, `createGardenerLLMFunction`) return closures over `params` — proper dependency injection pattern.

### Global Side Effects
- **`recordRunResultUsage` (L402):** This is the one global side effect — it writes to an external token-monitor module. Since it's fire-and-forget without try/catch, a monitor bug could crash the LLM caller.
- **Dynamic imports are re-executed on every call** (L272-273, L364, L478-479, L503). Node.js caches module imports, so this isn't a performance issue, but it means the caller is sensitive to module-level side effects in the imported modules.

### Closure-captured Mutable State
- **`params` object** is captured by both factory closures. If a caller mutates `params` after construction, the LLM caller's behavior changes silently. The `config: any` field is especially dangerous — it's typed as `any` with explicit comment "avoid tight coupling," but this means no TypeScript protection against breaking changes.

---

## 5. Additional Findings

### Code Smells
1. **`params.onError(new Error(...))` used for debug logging** (L285, L290, L370, L395, L399, L414): The error callback is being used as a general-purpose logger. ~8 "DEBUG" messages are wrapped as `Error` objects with stack traces, polluting error monitoring. Should use a separate `onDebug` callback or log level.

2. **Duplicated auth+call logic**: `createGatewayLLMCaller` (L261–436) and `createGardenerLLMFunction` (L476–538) share ~70% identical code (resolve model → get profiles → loop profiles → get auth → call completeSimple → extract text). This violates DRY and means bug fixes must be applied in two places.

3. **`config: any`** (L48): Intentionally loose typing trades safety for decoupling. Any config schema change silently breaks at runtime.

4. **Hardcoded tool_result detection** (L336): `(m.content[0] as any)?.type === "tool_result"` uses raw string matching with `as any` casts — fragile if pi-ai's type format changes.

### Strengths
1. **Excellent documentation**: JSDoc comments explain *why*, not just *what*. Auth flow, pi-ai interaction, and SQLite round-trip are all documented.
2. **Dynamic imports for testability**: Deliberate design choice to avoid loading gateway internals at module scope.
3. **Profile rotation with fallback**: Auth resilience via ordered profile candidates is well-designed.
4. **Message consolidation**: `consolidateMessages()` correctly handles the Anthropic alternating-roles constraint with mixed string/array content.

---

## 6. Quality Grade

### **Grade: C+**

### Justification

| Dimension | Score | Notes |
|-----------|-------|-------|
| **Architecture** | B | Clean factory pattern, good separation of concerns, intentional dynamic imports. But duplication between the two LLM callers is a maintenance liability. |
| **Error Handling** | D+ | The outermost catch silently converts *any* failure into NO_REPLY — this is the file's biggest flaw. Users lose messages with no feedback. Profile resolution silently degrades. Token monitor is unprotected. |
| **Type Safety** | C | `config: any`, pervasive `as any` casts (13+), `unknown[]` for raw content. The TypeScript compiler is largely bypassed in the hot path. |
| **State Management** | A- | Stateless module, proper DI via factories. Only risk is the unprotected `recordRunResultUsage` side effect. |
| **Maintainability** | C | Excellent comments, but the two near-identical LLM caller factories create a DRY violation. Debug logging via `new Error()` is a code smell that will age poorly. |
| **Reliability** | C- | Silent NO_REPLY on any error means the system fails *quietly*. In a user-facing LLM caller, silent failure is worse than loud failure. |

**Bottom line:** The architecture is thoughtful and well-documented, but the error handling philosophy of "swallow and return NO_REPLY" makes this a reliability risk in production. The file needs: (1) an explicit error-vs-debug logging separation, (2) user-visible error propagation for non-transient failures, (3) try/catch around `recordRunResultUsage`, and (4) extraction of shared auth+call logic into a common helper.
