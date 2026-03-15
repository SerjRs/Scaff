---
id: "020b"
title: "Cortex E2E — Session & Context Assembly"
created: "2026-03-15"
author: "scaff"
priority: "high"
status: "cooking"
depends_on: []
---

# 020b — Cortex E2E: Session & Context Assembly

## Goal
Test context assembly through webchat: system floor construction, foreground/background message inclusion, token budget enforcement, and multi-turn session continuity.

## Category: C (Session & Context)

## Test File
`src/cortex/__tests__/e2e-webchat-context.test.ts`

## Tests (~4)

### C. Session & Context

**C1. Session history persists across messages**
Send message 1, send message 2 → verify context assembly for message 2 includes message 1 in foreground messages.

**C2. System floor includes SOUL.md**
Write SOUL.md to workspace dir → verify the context passed to callLLM contains SOUL.md content in the system floor layer.

**C3. Context token budget respected**
Set maxContextTokens low (e.g. 2000) → send many messages → verify context assembly truncates older messages to fit budget.

**C4. Background summaries from other channels**
Send messages on channel "whatsapp", then send webchat message → verify context includes background summary from whatsapp channel.

## Test Infrastructure

Mock callLLM should capture the context it receives so tests can inspect layers:

```typescript
let capturedContext: AssembledContext | null = null;
const callLLM = async (context: AssembledContext) => {
  capturedContext = context;
  return { text: "ok", toolCalls: [] };
};
```

Then assert on `capturedContext.layers`, `capturedContext.foregroundMessages`, etc.

## Test Results
`workspace/pipeline/Cooking/020b-cortex-e2e/TEST-RESULTS.md`
