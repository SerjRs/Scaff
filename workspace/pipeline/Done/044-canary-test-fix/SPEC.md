# 044 — Canary Test Fix

## Problem

The canary test (`src/audio/__tests__/canary.test.ts`) does NOT test the real ingestion path. It uses a spy/stub for `onIngest`, which means:

- ✅ It proves: chunk upload → Whisper → transcript on disk → "a callback fires"
- ❌ It does NOT prove: the real `onIngest` in `server-audio.ts` → `getGatewayCortex()` → `getGatewayRouter()` → Librarian spawn → Library article → Hippocampus facts

**What happened:** A live audio capture test on 2026-03-19 produced a transcript on disk, but nothing landed in Hippocampus. The canary (8 seconds, green) failed to detect this. Root cause: Cortex was disabled in `openclaw.json`, so `getGatewayCortex()` returned null, and the `onIngest` callback silently skipped ingestion. The canary never exercises this code path — it substitutes a fake `onIngest` spy instead.

This is exactly the class of bug (mocked integration boundary) that the entire test rewrite effort (030–043) was designed to eliminate, and we immediately repeated it in the canary.

## Goal

The canary must verify the **real** end-to-end path, not a stub. After this fix, if ingestion is broken in production, the canary must fail.

## What needs to change

1. The canary currently uses `createGatewayAudioHandler()` with a spy `onIngest`. It should use `initGatewayAudioCapture()` — the production init path — so the real `onIngest` (with its lazy requires of Cortex/Router) is exercised.

2. The real `onIngest` does lazy `require()` of `gateway-bridge.js`, `gateway-integration.js`, `session.js`, `db.js` — modules that depend on Cortex and Router singletons. In test context, these singletons aren't running. The test needs to either:
   - Boot minimal Cortex/Router instances (preferred — tests real code), or
   - Provide a way to inject the `onIngest` implementation while still verifying it's the production one (weaker but honest), or
   - At minimum, verify that the `onIngest` callback on the handle returned by `initGatewayAudioCapture()` is wired (not undefined) AND that calling it with a mock Cortex/Router produces the expected side effects (Library task meta row, Router job enqueued)

3. The canary should also verify the final state: a Library article or Hippocampus fact exists for the session — not just that "a function was called."

4. Keep it fast. Target: under 20 seconds. One test.

## Current canary location

`src/audio/__tests__/canary.test.ts` — committed at `2ca0ae92b`

## Key files

- `src/gateway/server-audio.ts` — `initGatewayAudioCapture()` and the real `onIngest` implementation (lines 75–115)
- `src/audio/worker.ts` — calls `deps.onIngest(prompt, sessionId)` after transcription (step 10)
- `src/audio/__tests__/real-e2e.test.ts` — existing E2E tests (same spy problem in Suite 2)
- `src/cortex/gateway-bridge.ts` — `getGatewayCortex()` singleton
- `src/router/gateway-integration.ts` — `getGatewayRouter()` singleton
- `src/library/db.ts` — `storeLibraryTaskMeta()`
- `src/cortex/session.ts` — `storeDispatch()`, `getCortexSessionKey()`
- `src/library/librarian-prompt.ts` — `buildLibrarianPrompt()`

## Acceptance criteria

- [ ] Canary test fails when `onIngest` is broken (e.g., Cortex not available)
- [ ] Canary test verifies a DB-level side effect of ingestion (dispatch row, library task meta, or router job)
- [ ] No spy/stub for `onIngest` — the real implementation is exercised
- [ ] Still under 20 seconds
- [ ] `npx vitest run src/audio/__tests__/canary.test.ts` passes

## Anti-patterns to avoid

- Do NOT replace the real `onIngest` with a spy and call it "tested"
- Do NOT mock `getGatewayCortex()` or `getGatewayRouter()` — if they need setup, set them up
- Do NOT silently catch and ignore errors in the ingestion path
- Do NOT assert that a function "was called" without checking the downstream effect
