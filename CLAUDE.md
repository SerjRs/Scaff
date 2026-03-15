# Claude Code Instructions — 020b

## Branch
`feat/020b-cortex-e2e-context`

## Task
Create `src/cortex/__tests__/e2e-webchat-context.test.ts` — E2E tests for Cortex session history and context assembly through webchat.

## What to Build

Read the SPEC: `workspace/pipeline/InProgress/020b-cortex-e2e/SPEC.md`

~4 tests in category C (Session & Context):
- C1: Session history persists across messages
- C2: System floor includes SOUL.md
- C3: Context token budget respected (maxContextTokens)
- C4: Background summaries from other channels

## Key Approach

The mock `callLLM` should **capture the context/messages** it receives so tests can inspect what layers Cortex assembled:

```typescript
let capturedMessages: any[] = [];
const callLLM = async (messages: any[], tools: any[]) => {
  capturedMessages = messages;
  return { content: [{ type: "text", text: "ok" }] };
};
```

Then assert on `capturedMessages` to verify system floor content, foreground messages, token truncation, etc.

**IMPORTANT:** Check the actual `callLLM` signature by reading `src/cortex/loop.ts` and `src/cortex/llm-caller.ts`. Match it exactly.

## Patterns

Follow the pattern from the 020a test file: `src/cortex/__tests__/e2e-webchat-flow.test.ts`

Also look at:
- `src/cortex/context.ts` — `assembleContext()`, `loadSystemFloor()`, `buildForeground()`, `buildBackground()`
- `src/cortex/__tests__/e2e-hippocampus-full.test.ts` — TestReporter pattern

## Test Results

Use `TestReporter` from `src/cortex/__tests__/helpers/hippo-test-utils.ts`.
Write to: `workspace/pipeline/InProgress/020b-cortex-e2e/TEST-RESULTS.md`

## Steps

1. Read SPEC.md, existing 020a test file, and context.ts/loop.ts for patterns
2. Create `src/cortex/__tests__/e2e-webchat-context.test.ts`
3. Run: `pnpm install && npx vitest run src/cortex/__tests__/e2e-webchat-context.test.ts --reporter=verbose`
4. Fix failures
5. Commit, push, create PR: `gh pr create --title "test(cortex): 020b — E2E webchat context assembly" --base main`
6. Signal: `openclaw system event --text "Done 020b"`

## Constraints
- Do NOT modify source files — test-only
- All deterministic (mock LLMs, no network)
- Temp dirs + temp DBs, cleanup in afterEach
