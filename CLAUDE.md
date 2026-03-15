# Claude Code Instructions — 020c

## Branch
`feat/020c-cortex-e2e-tools`

## Task
Create `src/cortex/__tests__/e2e-webchat-tools.test.ts` — E2E tests for ALL sync tool execution through the Cortex webchat loop.

## What to Build

Read the SPEC: `workspace/pipeline/InProgress/020c-cortex-e2e/SPEC.md`

~15 tests in category D (Sync Tool Execution):
- D1: fetch_chat_history
- D2: memory_query (hot memory)
- D3: graph_traverse
- D4: read_file
- D5: write_file
- D6: pipeline_status
- D7: pipeline_transition
- D8: cortex_config — read
- D9: cortex_config — set_channel
- D10: library_get
- D11: library_search
- D12: code_search
- D13: Tool call chain — multi-turn (LLM calls tool, gets result, calls another tool, gets result, then responds)
- D14: Invalid tool name handling
- D15: Tool execution error handling

## Key Approach

Mock `callLLM` must return **tool_use** blocks on the first call, then after receiving tool_result, return final text. The tool execution loop in Cortex handles this automatically — you just need to mock the right responses.

**CRITICAL:** Read `src/cortex/loop.ts` and `src/cortex/tools.ts` to understand:
1. The exact `callLLM` signature and return format
2. What tool names are registered and their input schemas
3. How tool results are fed back into the LLM

Also read `src/cortex/__tests__/e2e-webchat-flow.test.ts` for the working startCortex + adapter pattern.

### Multi-turn tool mock pattern:
```typescript
let callCount = 0;
const callLLM = async (messages, tools) => {
  callCount++;
  if (callCount === 1) {
    // First call: request a tool
    return {
      content: [
        { type: "text", text: "" },
        { type: "tool_use", id: "t1", name: "read_file", input: { path: "test.txt" } }
      ]
    };
  }
  // Second call: after tool result, return final text
  return { content: [{ type: "text", text: "Done!" }] };
};
```

**NOTE:** The exact format of tool_use blocks and tool results depends on the Cortex implementation. READ THE CODE FIRST.

## Tool-specific setup

Some tools need pre-existing data:
- **memory_query**: Insert facts into hippocampus_facts before test, enable hippocampus
- **graph_traverse**: Insert facts + edges into hippocampus tables
- **library_get/search**: May need a library.sqlite with items (check if tools.ts creates it)
- **pipeline_status/transition**: Create dirs in workspace/pipeline/
- **cortex_config**: Check what config file path is used
- **read_file/write_file**: Create files in workspace dir
- **code_search**: May need the index DB or may gracefully handle missing index

## Test Results

Use `TestReporter` from `src/cortex/__tests__/helpers/hippo-test-utils.ts`.
Write to: `workspace/pipeline/InProgress/020c-cortex-e2e/TEST-RESULTS.md`

## Steps

1. Read SPEC.md, loop.ts, tools.ts, and existing 020a/020b test files
2. Create `src/cortex/__tests__/e2e-webchat-tools.test.ts`
3. Run: `pnpm install && npx vitest run src/cortex/__tests__/e2e-webchat-tools.test.ts --reporter=verbose`
4. Fix failures iteratively
5. Commit, push, create PR: `gh pr create --title "test(cortex): 020c — E2E webchat sync tool execution" --base main`
6. Signal: `openclaw system event --text "Done 020c"`

## Constraints
- Do NOT modify source files — test-only
- All deterministic (mock LLMs, no network)
- Temp dirs + temp DBs, cleanup in afterEach
- If a tool can't be tested without external deps (e.g. code_search needs index), test graceful error handling instead
