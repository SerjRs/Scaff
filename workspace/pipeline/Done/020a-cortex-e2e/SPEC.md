---
id: "020a"
title: "Cortex E2E — Message Flow & Routing (webchat)"
created: "2026-03-15"
author: "scaff"
priority: "high"
status: "cooking"
depends_on: []
---

# 020a — Cortex E2E: Message Flow, Routing & Silence

## Goal
Test the core message pipeline through webchat: ingestion → bus → loop → LLM → output routing. Also covers silent response suppression and webchat-specific behavior.

## Categories: A (Message Flow), B (Silent Responses), K (Webchat-Specific)

## Test File
`src/cortex/__tests__/e2e-webchat-flow.test.ts`

## Tests (~13)

### A. Message Flow & Routing

**A1. Basic webchat round-trip**
Send a message through webchat → LLM returns text → verify adapter.send() receives the response with correct channel and content.

**A2. Priority handling — webchat is always urgent**
Enqueue a webchat message and a background cron message simultaneously. Verify webchat is processed first (webchat has `priority: "urgent"`).

**A3. Multi-channel routing — webchat reply stays on webchat**
Send from webchat, verify output is routed back to webchat (not leaked to other registered adapters).

**A4. Cross-channel: LLM requests delivery to different channel**
Mock LLM returns a response targeting a different channel (e.g. whatsapp). Verify the output is routed to the correct adapter.

**A5. Sender resolution**
Webchat messages use `senderId` from the raw message. Verify the envelope has correct sender identity and relationship="partner".

### B. Silent Responses

**B1. NO_REPLY suppression**
LLM returns "NO_REPLY" → no adapter.send() called, but message is marked completed.

**B2. HEARTBEAT_OK suppression**
LLM returns "HEARTBEAT_OK" → no output, message completed.

**B3. Empty response handling**
LLM returns empty string → verify graceful handling (no crash, message completed).

### K. Webchat-Specific Behavior

**K1. Webchat messages get priority: urgent**
Verify WebchatAdapter.toEnvelope() sets priority="urgent" on all messages.

**K2. Webchat message with custom messageId**
Send raw webchat message with messageId → verify it's preserved in envelope replyContext.

**K3. Webchat adapter availability toggle**
Set webchat adapter to unavailable → send message targeting webchat → verify output routing handles gracefully.

**K4. Concurrent webchat messages — serial processing**
Enqueue 3 webchat messages rapidly → verify they're processed one at a time in order (strict serialization).

**K5. WebchatAdapter.toEnvelope maps all fields**
Send raw message with all optional fields (messageId, senderId, timestamp) → verify each is mapped correctly in the envelope.

## Test Infrastructure

```typescript
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";

const instance = await startCortex({
  agentId: "main",
  workspaceDir: tmpWorkspaceDir,
  dbPath: tmpBusDbPath,
  maxContextTokens: 10000,
  pollIntervalMs: 50,
  callLLM: mockCallLLM,
});

// Capture outputs
const sent: OutputMessage[] = [];
instance.registerAdapter({
  channelId: "webchat",
  send: async (msg) => { sent.push(msg); },
  isAvailable: () => true,
});
```

## Test Results
Test suite writes results to:
`workspace/pipeline/Cooking/020a-cortex-e2e/TEST-RESULTS.md`

Use the same `TestReporter` pattern from `helpers/hippo-test-utils.ts`.
