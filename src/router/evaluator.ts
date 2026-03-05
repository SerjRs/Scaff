import { callGateway } from "../gateway/call.js";
import { getTemplate, renderTemplate } from "./templates/index.js";
import type { EvaluatorConfig, EvaluatorResult } from "./types.js";
import { record } from "../token-monitor/ledger.js";
import { normalizeUsage, type UsageLike } from "../agents/usage.js";

const EVALUATOR_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Evaluator — lightweight local LLM complexity scorer via Ollama
//
// Uses the local Ollama instance (llama3.2:3b) for scoring. No API calls
// to Anthropic, no auth issues, no rate limit impact, fast local inference.
// ---------------------------------------------------------------------------

const EVALUATOR_SYSTEM_PROMPT = `You are a task complexity evaluator. Your job is to score how complex a task is on a scale from 1 to 10.

Scoring criteria:
- 1-3: Trivial — simple math, lookups, formatting, one-step answers
- 4-7: Moderate — analysis, summarization, multi-step reasoning, code snippets
- 8-10: Complex — architecture design, deep research, large code review, multi-file refactoring

Respond with ONLY a JSON object, no markdown fencing, no extra text:
{"weight": <number 1-10>, "reasoning": "<brief one-sentence explanation>"}`;

const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";
const OLLAMA_MODEL = "llama3.2:3b";

/**
 * Call Ollama's generate endpoint for a single completion.
 */
async function callOllama(
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        system: EVALUATOR_SYSTEM_PROMPT,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 128,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as { response?: string };
    // Record Ollama usage in token monitor
    const ollamaData = data as { response?: string; prompt_eval_count?: number; eval_count?: number };
    record({
      agentId: "router-evaluator",
      model: OLLAMA_MODEL,
      tokensIn: ollamaData.prompt_eval_count ?? 0,
      tokensOut: ollamaData.eval_count ?? 0,
      cached: 0,
    });
    return data.response ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Warm up Ollama by loading the model into memory.
 * Call on gateway startup so first evaluator request isn't cold.
 */
export async function warmOllama(): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: "hello",
        system: "Reply OK.",
        stream: false,
        options: { num_predict: 4 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.ok) {
      console.log(`[router/evaluator] Ollama warmed up (${OLLAMA_MODEL})`);
    } else {
      console.error(`[router/evaluator] Ollama warm-up failed: ${response.status}`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[router/evaluator] Ollama warm-up error: ${detail}`);
  }
}

/**
 * Clamp a number to the 1-10 range.
 */
function clamp(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

/**
 * Parse an evaluator response into an EvaluatorResult.
 * Tries JSON first, then falls back to extracting a bare number.
 */
export function parseEvaluatorResponse(
  text: string,
  fallbackWeight: number,
): EvaluatorResult {
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        weight?: unknown;
        reasoning?: unknown;
      };
      if (typeof parsed.weight === "number" && !Number.isNaN(parsed.weight)) {
        return {
          weight: clamp(parsed.weight),
          reasoning:
            typeof parsed.reasoning === "string"
              ? parsed.reasoning
              : "no reasoning provided",
        };
      }
    } catch {
      // JSON parse failed, fall through
    }
  }

  const numberMatch = text.match(/\b(\d{1,2})\b/);
  if (numberMatch) {
    const num = parseInt(numberMatch[1], 10);
    if (num >= 1 && num <= 10) {
      return {
        weight: num,
        reasoning: "extracted number from non-JSON response",
      };
    }
    if (num > 0) {
      return {
        weight: clamp(num),
        reasoning: "extracted and clamped number from non-JSON response",
      };
    }
  }

  return {
    weight: fallbackWeight,
    reasoning: "could not parse evaluator response, using fallback",
  };
}

/**
 * Evaluate task complexity using local Ollama (llama3.2:3b).
 *
 * Never throws — always returns an EvaluatorResult.
 */
/**
 * Call Sonnet via callGateway to verify a weight score.
 * Used when Ollama scores > 2 — we don't trust the local model for complex tasks.
 */
async function verifySonnet(
  userMessage: string,
  timeoutMs: number,
): Promise<string> {
  const idempotencyKey = crypto.randomUUID();
  const sessionKey = `agent:router-evaluator:eval:${idempotencyKey}`;

  const response = await callGateway<{
    result?: unknown;
    summary?: string;
  }>({
    method: "agent",
    params: {
      message: `${EVALUATOR_SYSTEM_PROMPT}\n\n${userMessage}`,
      sessionKey,
      deliver: false,
      model: 'anthropic/claude-sonnet-4-6',
      idempotencyKey,
    },
    expectFinal: true,
    timeoutMs,
  });

  // Record token usage for the Router Evaluator
  const resultObj = response?.result as Record<string, unknown> | undefined;
  const usage = (resultObj as any)?.usage;
  if (usage && typeof usage === "object") {
    const normalized = normalizeUsage(usage as UsageLike);
    if (normalized) {
      record({
        agentId: "router-evaluator",
        model: EVALUATOR_MODEL,
        tokensIn: normalized.input ?? 0,
        tokensOut: normalized.output ?? 0,
        cached: normalized.cacheRead ?? 0,
      });
    }
  }

  // Extract text from gateway response (shape: result.payloads[0].text)
  const payloads = resultObj?.payloads as Array<{ text?: string }> | undefined;
  if (payloads?.[0]?.text) return payloads[0].text;
  if (typeof response?.result === "string") return response.result;
  if (typeof response?.summary === "string") return response.summary;
  return JSON.stringify(response ?? "");
}

/**
 * Two-stage evaluator:
 * 1. Ollama (local, fast, free) scores the task
 * 2. If weight ≤ 3 → trust Ollama, return immediately (Haiku tier)
 * 3. If weight > 3 → verify with Sonnet via callGateway (proper auth)
 *
 * Never throws — always returns an EvaluatorResult.
 */
export async function evaluate(
  config: EvaluatorConfig,
  task: string,
  context?: string,
): Promise<EvaluatorResult> {
  try {
    // 1. Load and render template
    const template = getTemplate(config.tier, "agent_run");
    const rendered = renderTemplate(template, {
      task,
      context: context ?? "none",
      issuer: "router-evaluator",
      constraints: "Respond with a complexity score only.",
    });

    const userMessage = `Score the complexity of the following task:\n\n${rendered}`;
    const timeoutMs = (config.timeout ?? 10) * 1000;

    // 2. Stage 1: Ollama (local)
    // Give Ollama 2x the configured timeout — cold model loads can take 4-5s
    // before inference even starts, and concurrent requests queue behind loading.
    console.log(`[router/evaluator] ===== EVALUATE START =====`);
    console.log(`[router/evaluator] config: model=${config.model} tier=${config.tier} timeout=${config.timeout}s fallback=${config.fallback_weight}`);
    console.log(`[router/evaluator] task: ${task.slice(0, 150)}`);
    let ollamaResult: EvaluatorResult | null = null;
    try {
      console.log(`[router/evaluator] calling ollama (timeout=${timeoutMs * 2}ms)...`);
      const ollamaText = await callOllama(userMessage, timeoutMs * 2);
      console.log(`[router/evaluator] ollama raw response: ${ollamaText.slice(0, 200)}`);
      ollamaResult = parseEvaluatorResponse(ollamaText, config.fallback_weight);
      console.log(`[router/evaluator] ollama scored: w=${ollamaResult.weight} (${ollamaResult.reasoning})`);
    } catch (ollamaErr) {
      const detail = ollamaErr instanceof Error ? ollamaErr.message : String(ollamaErr);
      const stack = ollamaErr instanceof Error ? ollamaErr.stack : undefined;
      console.error(`[router/evaluator] ollama failed: ${detail} — falling through to sonnet`);
      if (stack) console.error(`[router/evaluator] ollama stack: ${stack}`);
    }

    // 3. If Ollama succeeded and says ≤3 → trust it, skip Sonnet
    if (ollamaResult && ollamaResult.weight <= 2) {
      console.log(`[router/evaluator] weight ≤3, trusting ollama → haiku`);
      console.log(`[router/evaluator] ===== EVALUATE END: w=${ollamaResult.weight} tier=haiku =====`);
      return ollamaResult;
    }

    // 4. Stage 2: Sonnet verification (when Ollama scored >3 OR failed entirely)
    const reason = ollamaResult
      ? `weight ${ollamaResult.weight} > 3`
      : "ollama unavailable";
    console.log(`[router/evaluator] ${reason}, verifying with sonnet...`);
    console.log(`[router/evaluator] sessionKey will use agent=router-evaluator, config.model=${config.model}`);
    try {
      const sonnetText = await verifySonnet(userMessage, timeoutMs * 3);
      console.log(`[router/evaluator] sonnet raw response: ${String(sonnetText).slice(0, 200)}`);
      const sonnetResult = parseEvaluatorResponse(sonnetText, config.fallback_weight);
      console.log(`[router/evaluator] sonnet verified: w=${sonnetResult.weight} (${sonnetResult.reasoning})`);
      console.log(`[router/evaluator] ===== EVALUATE END: w=${sonnetResult.weight} tier=${sonnetResult.weight <= 3 ? 'haiku' : sonnetResult.weight <= 7 ? 'sonnet' : 'opus'} =====`);
      // Record Sonnet verification usage in token monitor
      record({
        agentId: "router-evaluator",
        model: config.model,
        tokensIn: 0,
        tokensOut: 0,
        cached: 0,
      });
      return sonnetResult;
    } catch (sonnetErr) {
      const detail = sonnetErr instanceof Error ? sonnetErr.message : String(sonnetErr);
      const stack = sonnetErr instanceof Error ? sonnetErr.stack : undefined;
      console.error(`[router/evaluator] sonnet verification failed: ${detail}`);
      if (stack) console.error(`[router/evaluator] sonnet stack: ${stack}`);
      // Fall back to Ollama's score if available, otherwise fallback weight
      if (ollamaResult) {
        console.log(`[router/evaluator] using ollama score: w=${ollamaResult.weight}`);
        console.log(`[router/evaluator] ===== EVALUATE END: w=${ollamaResult.weight} (sonnet failed, using ollama) =====`);
        return ollamaResult;
      }
      console.log(`[router/evaluator] ===== EVALUATE END: w=${config.fallback_weight} (both failed, using fallback) =====`);
      return {
        weight: config.fallback_weight,
        reasoning: "both ollama and sonnet failed, using fallback",
      };
    }
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    const reason = isTimeout
      ? "evaluator timed out, using fallback"
      : "evaluator failed, using fallback";
    const detail = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`[router/evaluator] ${reason}: ${detail}`);
    if (stack) console.error(`[router/evaluator] stack: ${stack}`);

    return {
      weight: config.fallback_weight,
      reasoning: reason,
    };
  }
}
