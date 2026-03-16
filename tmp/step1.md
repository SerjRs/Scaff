Rewrite these 2 test files to use REAL LLM calls instead of mocks:

1. src/cortex/__tests__/e2e-hippocampus-full.test.ts
2. src/cortex/__tests__/e2e-webchat-hippo.test.ts

REPLACE all mockLLM/mockEmbedFn with real calls.

For LLM (fact extraction), use complete() from src/llm/simple-complete.ts:
  import { complete } from '../../llm/simple-complete.js';
  const extractLLM = async (prompt: string) => complete(prompt, { model: 'claude-sonnet-4-5', maxTokens: 2048 });

For embeddings, use real Ollama nomic-embed-text:
  async function embedFn(text: string): Promise<Float32Array> {
    const res = await fetch('http://127.0.0.1:11434/api/embeddings', {
      method: 'POST', body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json() as { embedding: number[] };
    return new Float32Array(data.embedding);
  }

For Cortex loop tests that use startCortex with callLLM, use createGatewayLLMCaller:
  import { createGatewayLLMCaller } from '../llm-caller.js';
  const callLLM = createGatewayLLMCaller({ provider: 'anthropic', modelId: 'claude-sonnet-4-5', agentDir: path.join(os.homedir(), '.openclaw/agents/main/agent'), config: {}, maxResponseTokens: 1024, onError: (err) => console.error(err.message), debugContext: false });

Increase wait() timeouts to 15000ms. Set vitest test timeout to 120000ms.
Remove ALL mock imports and mock helpers. Do NOT add mocks back.
Also update src/cortex/__tests__/helpers/hippo-test-utils.ts to remove mock functions.

After rewriting, run: npx vitest run src/cortex/__tests__/e2e-hippocampus-full.test.ts src/cortex/__tests__/e2e-webchat-hippo.test.ts --reporter=verbose
Write test results to workspace/pipeline/Cooking/019-hippocampus-e2e-tests/TEST-RESULTS.md

When done run: openclaw system event --text "Step1 done: tests rewritten and run" --mode now
