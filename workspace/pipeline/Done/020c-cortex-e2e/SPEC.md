---
id: "020c"
title: "Cortex E2E — Sync Tool Execution"
created: "2026-03-15"
author: "scaff"
priority: "high"
status: "cooking"
depends_on: []
---

# 020c — Cortex E2E: Sync Tool Execution

## Goal
Test every sync tool through the webchat loop: LLM returns tool_use → tool executes → tool_result fed back → LLM responds. Covers all 16+ tools, multi-turn chains, and error handling.

## Category: D (Sync Tool Execution)

## Test File
`src/cortex/__tests__/e2e-webchat-tools.test.ts`

## Tests (~15)

### D. Sync Tool Execution

**D1. fetch_chat_history tool**
Mock LLM returns a tool_use for `fetch_chat_history` → verify tool executes, returns history, and LLM is called again with tool_result.

**D2. memory_query tool (hot memory)**
Insert hot facts into hippocampus_facts, mock LLM calls `memory_query` → verify results include the inserted facts.

**D3. graph_traverse tool**
Insert facts + edges, mock LLM calls `graph_traverse` with a fact_id → verify it returns the subgraph.

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

## Test Infrastructure

Mock LLM with call counter to support multi-turn:
```typescript
let callCount = 0;
const callLLM = async (context) => {
  callCount++;
  if (callCount === 1) {
    return {
      text: "",
      toolCalls: [{ id: "t1", name: "read_file", input: { path: "test.txt" } }],
    };
  }
  return { text: "File says: hello", toolCalls: [] };
};
```

## Test Results
`workspace/pipeline/Cooking/020c-cortex-e2e/TEST-RESULTS.md`
