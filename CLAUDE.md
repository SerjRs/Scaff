# Claude Code Instructions — 020a

## Branch
`feat/020a-cortex-e2e-flow`

## Task
Create `src/cortex/__tests__/e2e-webchat-flow.test.ts` — E2E tests for Cortex message flow, routing, silence handling, and webchat-specific behavior.

## What to Build

Read `SPEC.md` in the workspace pipeline dir for the full test list:
`workspace/pipeline/InProgress/020a-cortex-e2e/SPEC.md`

~13 tests across categories A (Message Flow), B (Silent Responses), K (Webchat-Specific).

## Key Architecture

Tests use the **programmatic** Cortex API — no gateway, no browser, no WebSocket:

```typescript
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { WebchatAdapter, type WebchatRawMessage } from "../adapters/webchat.js";
import { createEnvelope } from "../types.js";
```

### How webchat works in tests:
1. `startCortex(config)` — starts the Cortex loop with mock callLLM
2. `instance.registerAdapter(adapter)` — register a WebchatAdapter that captures sent messages
3. `instance.enqueue(envelope)` — inject a message (use WebchatAdapter.toEnvelope or createEnvelope directly)
4. Wait for loop to process (small delay or poll)
5. Assert on captured outputs

### Capturing outputs:
```typescript
const sent: OutputTarget[] = [];
const adapter = new WebchatAdapter(async (target) => { sent.push(target); });
instance.registerAdapter(adapter);
```

### Creating envelopes:
```typescript
// Via adapter
const envelope = adapter.toEnvelope(
  { content: "hello", senderId: "serj" },
  { resolve: (ch, id) => ({ id, name: "Serj", relationship: "partner" as const }) }
);

// Or directly
const envelope = createEnvelope({
  channel: "webchat",
  sender: { id: "serj", name: "Serj", relationship: "partner" },
  content: "hello",
  priority: "urgent",
});
```

### Mock LLM:
```typescript
const callLLM = async (messages: any[], tools: any[]) => {
  return { content: [{ type: "text", text: "Hello back!" }] };
};
```

**IMPORTANT:** Check the actual `callLLM` signature in `src/cortex/index.ts` and `src/cortex/loop.ts` before implementing. The mock must match the real signature.

### Wait for processing:
The loop processes on a poll interval. Use a small wait:
```typescript
await new Promise(r => setTimeout(r, 300));
```

## Test Results

Use `TestReporter` from `src/cortex/__tests__/helpers/hippo-test-utils.ts` (already exists).

Write results to: `workspace/pipeline/InProgress/020a-cortex-e2e/TEST-RESULTS.md`

```typescript
const REPORT_PATH = path.resolve(
  __dirname, "../../../../workspace/pipeline/InProgress/020a-cortex-e2e/TEST-RESULTS.md"
);
```

## Existing Patterns

Look at these existing E2E tests for patterns:
- `src/cortex/__tests__/e2e-hippocampus-full.test.ts` — reporter + dump helpers
- `src/cortex/__tests__/e2e-silence.test.ts` — silence/NO_REPLY handling
- `src/cortex/__tests__/e2e-multichannel.test.ts` — cross-channel routing
- `src/cortex/__tests__/e2e-priority.test.ts` — priority handling

## Steps

1. Read the SPEC.md and existing test files to understand patterns
2. Read `src/cortex/index.ts`, `src/cortex/loop.ts`, `src/cortex/output.ts` to understand the callLLM signature and output routing
3. Read `src/cortex/adapters/webchat.ts` for the WebchatAdapter API
4. Create `src/cortex/__tests__/e2e-webchat-flow.test.ts` with all ~13 tests
5. Run tests: `pnpm install && npx vitest run src/cortex/__tests__/e2e-webchat-flow.test.ts --reporter=verbose`
6. Fix any failures
7. Verify TEST-RESULTS.md is generated
8. Commit and push
9. Create PR: `gh pr create --title "test(cortex): 020a — E2E webchat flow & routing" --body "..." --base main`
10. Signal: `openclaw system event --text "Done 020a — webchat flow tests"`

## Constraints
- Do NOT modify source files — test-only task
- All tests must be deterministic (mock LLMs, no network)
- Use temp dirs + temp DBs, cleanup in afterEach
- `pnpm install` first if node_modules is missing
