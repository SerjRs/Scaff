You are working on the Cortex subsystem of OpenClaw. Your task has 4 steps:

## STEP 1: Rewrite hippocampus tests to use REAL LLM calls (no mocks)

Two test files need rewriting:
- src/cortex/__tests__/e2e-hippocampus-full.test.ts (61 tests, 019 spec)
- src/cortex/__tests__/e2e-webchat-hippo.test.ts (6 tests, 020d spec)

Currently ALL tests use mockLLM and mockEmbedFn. Replace with real calls:

For LLM calls (fact extraction):
```typescript
import { complete } from '../../llm/simple-complete.js';
const realExtractLLM = async (prompt: string) => complete(prompt, { model: 'claude-sonnet-4-5', maxTokens: 2048 });
```

For embeddings (replace mockEmbedFn):
Use the real Ollama nomic-embed-text at 127.0.0.1:11434:
```typescript
async function realEmbedFn(text: string): Promise<Float32Array> {
  const res = await fetch('http://127.0.0.1:11434/api/embeddings', {
    method: 'POST', body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await res.json();
  return new Float32Array(data.embedding);
}
```

For Cortex loop tests (callLLM in startCortex):
```typescript
import { createGatewayLLMCaller } from '../llm-caller.js';
// Use createGatewayLLMCaller with real auth:
const realCallLLM = createGatewayLLMCaller({
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-5',
  agentDir: path.join(os.homedir(), '.openclaw/agents/main/agent'),
  config: {},
  maxResponseTokens: 1024,
  onError: (err) => console.error(err.message),
  debugContext: false,
});
```

Important: real LLM calls are slow (2-10s each). Increase all wait() timeouts to at least 15000ms. Set vitest timeout to 120000ms per test.

Remove ALL mock imports (mockEmbedFn, mockEmbedding, mockLLM). Remove mock usage from hippo-test-utils.ts.

## STEP 2: Run the tests and collect results

Run: `npx vitest run src/cortex/__tests__/e2e-hippocampus-full.test.ts src/cortex/__tests__/e2e-webchat-hippo.test.ts --reporter=verbose`

Write results to workspace/pipeline/Cooking/019-hippocampus-e2e-tests/TEST-RESULTS.md and workspace/pipeline/Cooking/020d-cortex-e2e/TEST-RESULTS.md

## STEP 3: Fix hippocampus code based on failures

KNOWN BUG (fix this regardless): executeMemoryQuery in src/cortex/tools.ts only calls searchColdFacts. It must ALSO call searchGraphFacts from hippocampus.ts and merge results. The graph has 6655 facts that memory_query currently ignores. See spec at workspace/pipeline/Cooking/023-memory-query-graph-search/SPEC.md

Fix any other failures found in step 2 by modifying the source code (src/cortex/*.ts).

## STEP 4: Re-run the tests

Run the same test command again. Write updated results to the TEST-RESULTS.md files.

## KEY FILES
- src/cortex/__tests__/e2e-hippocampus-full.test.ts (019 tests)
- src/cortex/__tests__/e2e-webchat-hippo.test.ts (020d tests)
- src/cortex/__tests__/helpers/hippo-test-utils.ts (mock helpers - rewrite to use real calls)
- src/cortex/tools.ts (executeMemoryQuery - needs 023 fix)
- src/cortex/hippocampus.ts (searchGraphFacts, searchColdFacts, etc)
- src/cortex/llm-caller.ts (createGatewayLLMCaller)
- src/llm/simple-complete.ts (reusable LLM client)
- src/llm/resolve-auth.ts (auth resolution)

## AUTH
OAuth token is at ~/.openclaw/agents/main/agent/auth-profiles.json, profile 'anthropic:scaff', type 'token'.
The complete() function from src/llm/simple-complete.ts handles auth automatically.

## CONSTRAINTS
- Do NOT add any mocks back
- Do NOT skip tests
- Tests must make real API calls to Anthropic (Sonnet) and real embedding calls to Ollama (127.0.0.1:11434)
- If Ollama is not responding, note it in TEST-RESULTS.md but do not mock around it
- When finished, run: openclaw system event --text "Done: hippocampus test rewrite and fixes" --mode now
