---
id: "019"
title: "Cortex E2E Test Suite — Full Pipeline via Webchat"
created: "2026-03-15"
author: "scaff"
priority: "high"
status: "cooking"
moved_at: "2026-03-15"
depends_on: []
---

# 019 — Cortex E2E Test Suite via Webchat

## Goal
Comprehensive end-to-end test suite that validates the entire Cortex pipeline through the webchat channel — from message ingestion to LLM response to tool execution to output delivery. Tests use the programmatic `startCortex` API with mock LLMs and a registered webchat adapter, not a real browser.

## Architecture Under Test

```
User message → WebchatAdapter.toEnvelope()
  → Bus (enqueue) → Loop (dequeue)
    → Context Assembly (system floor + foreground + background + hot memory)
      → LLM Call (mock)
        → Tool Calls? → Sync Tool Execution → LLM again
        → Parse Response → Output Router
          → WebchatAdapter.send() → captured
```

## Test Categories

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

### C. Session & Context

**C1. Session history persists across messages**
Send message 1, send message 2 → verify context assembly for message 2 includes message 1 in foreground messages.

**C2. System floor includes SOUL.md**
Write SOUL.md to workspace dir → verify the context passed to callLLM contains SOUL.md content in the system floor.

**C3. Context token budget respected**
Set maxContextTokens low (e.g. 2000) → send many messages → verify context assembly truncates older messages to fit budget.

**C4. Background summaries from other channels**
Send messages on channel "whatsapp", then send webchat message → verify context includes background summary from whatsapp channel.

### D. Sync Tool Execution

**D1. fetch_chat_history tool**
Mock LLM returns a tool_use for `fetch_chat_history` → verify tool executes, returns history, and LLM is called again with tool_result.

**D2. memory_query tool (hot memory)**
Insert hot facts into hippocampus_facts, mock LLM calls `memory_query` → verify results include the inserted facts.

**D3. graph_traverse tool**
Insert facts + edges into hippocampus tables, mock LLM calls `graph_traverse` with a fact_id → verify it returns the fact with connected edges.

**D4. read_file tool**
Create a file in workspace, mock LLM calls `read_file` → verify file content is returned.

**D5. write_file tool**
Mock LLM calls `write_file` with path + content → verify file is created in workspace.

**D6. pipeline_status tool**
Create pipeline directories, mock LLM calls `pipeline_status` → verify it returns the pipeline state.

**D7. pipeline_transition tool**
Create a spec in Cooking, mock LLM calls `pipeline_transition` from Cooking→InProgress → verify file is moved and frontmatter updated.

**D8. cortex_config tool — read**
Mock LLM calls `cortex_config` with action "read" → verify it returns current channel config.

**D9. cortex_config tool — set_channel**
Mock LLM calls `cortex_config` with action "set_channel" → verify config file is updated.

**D10. library_get tool**
Insert an item in library.sqlite, mock LLM calls `library_get(id)` → verify item details returned.

**D11. library_search tool**
Insert items with embeddings, mock LLM calls `library_search(query)` → verify matching items returned.

**D12. code_search tool**
Mock LLM calls `code_search` with a query → verify it returns results (or graceful error if index unavailable).

**D13. Tool call chain — multi-turn**
Mock LLM: first call returns tool_use, after tool_result returns another tool_use, after second tool_result returns final text. Verify the full 3-turn chain completes and final text is delivered.

**D14. Invalid tool name handling**
Mock LLM returns tool_use with non-existent tool name → verify graceful error in tool_result, LLM called again, final response delivered.

**D15. Tool execution error handling**
Mock LLM calls `read_file` on non-existent path → verify error is returned as tool_result, LLM recovers.

### E. Hippocampus Integration

**E1. Hot memory in system floor**
Insert facts into hippocampus_facts, enable hippocampus → verify system floor passed to LLM contains "Known Facts" section with those facts.

**E2. Graph facts with edges in system floor**
Insert facts + edges → verify system floor shows facts with edge breadcrumbs (e.g. `[related_to: other fact]`).

**E3. Fact extraction after conversation (Gardener)**
Send several messages, trigger fact extraction manually via `gardener.runAll()` → verify new facts appear in hippocampus_facts with edges.

**E4. Memory query searches both hot and cold**
Insert hot facts and cold facts, call `memory_query` → verify results from both stores.

**E5. Eviction preserves edge stubs**
Insert fact + edges, evict fact → verify edges have `is_stub=1` and `stub_topic` set.

**E6. Revival on cold search hit**
Evict a graph fact, query cold storage → verify fact is revived (status='active', edges reconnected).

### F. Async Delegation (sessions_spawn)

**F1. sessions_spawn triggers onSpawn callback**
Mock LLM calls `sessions_spawn` tool → verify the onSpawn callback is invoked with task details.

**F2. Task result delivery via ops trigger**
Simulate task completion by enqueuing an ops_trigger envelope → verify LLM is called with task result and delivers summary to webchat.

**F3. Task failure delivery**
Enqueue ops_trigger with taskStatus="failed" → verify LLM receives error context and informs the user.

### G. Foreground Sharding

**G1. Messages assigned to shards**
Enable foreground sharding, send messages → verify cortex_shards table has an active shard with correct message count.

**G2. Shard boundary on token overflow**
Send enough messages to exceed shard token budget → verify a new shard is created.

**G3. Ops trigger assigned to correct shard**
Send webchat messages, then enqueue ops_trigger → verify the trigger is assigned to the active webchat shard (not a new shard).

### H. Recovery & Error Handling

**H1. LLM call failure → message marked failed**
Mock callLLM that throws an error → verify message is marked "failed" in bus, adapter.send receives error notification.

**H2. Adapter send failure → error logged, loop continues**
Register adapter whose send() throws → send message, verify error is captured but loop continues processing next message.

**H3. Queue ordering preserved on failure**
Enqueue 3 messages, first one's LLM call fails → verify messages 2 and 3 still process in order.

**H4. Idempotent message processing**
Enqueue same message ID twice → verify it's only processed once.

### I. Library Integration

**I1. library_ingest tool triggers executor**
Mock LLM calls `library_ingest(url)` → verify the task meta is stored and onSpawn is called.

**I2. Article ingestion writes to graph**
Simulate complete library ingestion (executor returns JSON with facts/edges) → verify hippocampus_facts and hippocampus_edges populated with sourced_from edges.

### J. Configuration & Mode

**J1. Hippocampus disabled — no memory tables queried**
Start Cortex with `hippocampusEnabled: false` → verify no hippocampus tools available and no hot memory in system floor.

**J2. Shadow mode — no output delivered**
Configure cortex_config for shadow mode on webchat → verify LLM is called but adapter.send() is NOT called.

**J3. Cortex config persistence**
Set channel mode via cortex_config tool → restart Cortex → verify mode persists.

### K. Webchat-Specific Behavior

**K1. Webchat messages get priority: urgent**
Verify WebchatAdapter.toEnvelope() sets priority="urgent" on all messages.

**K2. Webchat message with custom messageId**
Send raw webchat message with messageId → verify it's preserved in envelope replyContext.

**K3. Webchat adapter availability toggle**
Set webchat adapter to unavailable → send message targeting webchat → verify output routing handles gracefully.

**K4. Concurrent webchat messages — serial processing**
Enqueue 3 webchat messages rapidly → verify they're processed one at a time in order (strict serialization).

## Test Infrastructure

All tests use the programmatic API:
```typescript
import { startCortex, _resetSingleton, type CortexInstance } from "../index.js";

const instance = await startCortex({
  agentId: "main",
  workspaceDir: tmpWorkspaceDir,
  dbPath: tmpBusDbPath,
  maxContextTokens: 10000,
  pollIntervalMs: 50,
  hippocampusEnabled: true,
  embedFn: mockEmbedFn,
  gardenerSummarizeLLM: mockSummarizeLLM,
  gardenerExtractLLM: mockExtractLLM,
  callLLM: mockCallLLM,   // <-- controls what "the LLM" returns
});

// Register webchat adapter to capture outputs
const sent: OutputTarget[] = [];
instance.registerAdapter({
  channelId: "webchat",
  toEnvelope: (raw) => webchatAdapter.toEnvelope(raw, senderResolver),
  send: async (target) => { sent.push(target); },
  isAvailable: () => true,
});

// Send message
instance.enqueue(createEnvelope({ ... }));
await wait(500);  // loop processes

// Assert
expect(sent).toHaveLength(1);
expect(sent[0].content).toContain("expected response");
```

### Mock LLM Patterns

**Simple text response:**
```typescript
callLLM: async () => ({ text: "Hello!", toolCalls: [] })
```

**Tool call → response:**
```typescript
let callCount = 0;
callLLM: async (context) => {
  callCount++;
  if (callCount === 1) {
    return {
      text: "",
      toolCalls: [{
        id: "tool_1",
        name: "read_file",
        input: { path: "test.txt" },
      }],
    };
  }
  // After tool result
  return { text: "File contents: ...", toolCalls: [] };
}
```

**Conditional response based on context:**
```typescript
callLLM: async (context) => {
  const lastMsg = context.foregroundMessages.at(-1);
  if (lastMsg?.content.includes("hello")) {
    return { text: "Hi there!", toolCalls: [] };
  }
  return { text: "I don't understand.", toolCalls: [] };
}
```

## Files
| File | Description |
|------|-------------|
| `src/cortex/__tests__/e2e-webchat-flow.test.ts` | Categories A, B, K — message flow, routing, silence, webchat-specific |
| `src/cortex/__tests__/e2e-webchat-context.test.ts` | Category C — session, context assembly, token budget |
| `src/cortex/__tests__/e2e-webchat-tools.test.ts` | Category D — all sync tool execution tests |
| `src/cortex/__tests__/e2e-webchat-hippo.test.ts` | Category E — hippocampus integration |
| `src/cortex/__tests__/e2e-webchat-delegation.test.ts` | Category F — async delegation, task results |
| `src/cortex/__tests__/e2e-webchat-sharding.test.ts` | Category G — foreground sharding |
| `src/cortex/__tests__/e2e-webchat-recovery.test.ts` | Category H — recovery, error handling |
| `src/cortex/__tests__/e2e-webchat-library.test.ts` | Category I — library integration |
| `src/cortex/__tests__/e2e-webchat-config.test.ts` | Category J — configuration, modes |

## Estimated Test Count
~45 tests across 9 files.

## Notes
- These tests intentionally overlap with some existing e2e tests (e2e-silence, e2e-hippocampus, etc.) but test through the webchat adapter specifically
- All tests are self-contained: temp dirs, temp DBs, cleanup in afterEach
- No real LLM calls, no network, no browser — pure programmatic testing
- Tests should run in <30 seconds total (mock LLMs are instant)
