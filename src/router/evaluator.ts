import { callGateway } from "../gateway/call.js";
import { getTemplate, renderTemplate } from "./templates/index.js";
import type { EvaluatorConfig, EvaluatorResult } from "./types.js";

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
    return data.response ?? "";
  } finally {
    clearTimeout(timer);
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
 * Used when Ollama scores > 3 — we don't trust the local model for complex tasks.
 */
async function verifySonnet(
  userMessage: string,
  timeoutMs: number,
): Promise<string> {
  const idempotencyKey = crypto.randomUUID();
  const sessionKey = `agent:main:router-evaluator:${idempotencyKey}`;

  const response = await callGateway<{
    result?: unknown;
    summary?: string;
  }>({
    method: "agent",
    params: {
      message: `${EVALUATOR_SYSTEM_PROMPT}\n\n${userMessage}`,
      sessionKey,
      deliver: false,
      idempotencyKey,
    },
    expectFinal: true,
    timeoutMs,
  });

  // Extract text from gateway response (shape: result.payloads[0].text)
  const result = response?.result as Record<string, unknown> | undefined;
  const payloads = result?.payloads as Array<{ text?: string }> | undefined;
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
    const ollamaText = await callOllama(userMessage, timeoutMs);
    const ollamaResult = parseEvaluatorResponse(ollamaText, config.fallback_weight);

    console.log(`[router/evaluator] ollama scored: w=${ollamaResult.weight} (${ollamaResult.reasoning})`);

    // 3. If Ollama says ≤3 → trust it, skip Sonnet
    if (ollamaResult.weight <= 3) {
      console.log(`[router/evaluator] weight ≤3, trusting ollama → haiku`);
      return ollamaResult;
    }

    // 4. Stage 2: Sonnet verification for weight > 3
    console.log(`[router/evaluator] weight ${ollamaResult.weight} > 3, verifying with sonnet...`);
    try {
      const sonnetText = await verifySonnet(userMessage, timeoutMs * 3);
      const sonnetResult = parseEvaluatorResponse(sonnetText, config.fallback_weight);
      console.log(`[router/evaluator] sonnet verified: w=${sonnetResult.weight} (${sonnetResult.reasoning})`);
      return sonnetResult;
    } catch (sonnetErr) {
      // Sonnet failed — fall back to Ollama's score
      const detail = sonnetErr instanceof Error ? sonnetErr.message : String(sonnetErr);
      console.log(`[router/evaluator] sonnet verification failed, using ollama score: ${detail}`);
      return ollamaResult;
    }
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    const reason = isTimeout
      ? "evaluator timed out, using fallback"
      : "evaluator failed, using fallback";
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`[router/evaluator] ${reason}: ${detail}`);

    return {
      weight: config.fallback_weight,
      reasoning: reason,
    };
  }
}
