/**
 * Cortex LLM Caller
 *
 * Makes real LLM calls using the gateway's auth infrastructure.
 * Converts Cortex's AssembledContext into Anthropic Messages API format.
 *
 * Auth flow:
 *   resolveModel() → getApiKeyForModel() → Anthropic SDK → messages.create()
 *   On 401: rotate auth profile and retry once.
 *
 * @see docs/cortex-implementation-tasks.md Task 23
 */

import type { AssembledContext, ContextLayer } from "./context.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CortexLLMCaller {
  (context: AssembledContext): Promise<string>;
}

export interface LLMCallerParams {
  provider: string;
  modelId: string;
  agentDir: string;
  config: any; // OpenClawConfig — avoid tight coupling
  maxResponseTokens: number;
  onError: (err: Error) => void;
}

/** Anthropic Messages API format */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ContextAsMessages {
  system: string;
  messages: AnthropicMessage[];
}

// ---------------------------------------------------------------------------
// Context → Messages
// ---------------------------------------------------------------------------

/**
 * Convert AssembledContext into Anthropic Messages API format.
 *
 * Mapping:
 * - system_floor → system parameter (identity, memory, workspace)
 * - background   → appended to system (cross-channel awareness)
 * - foreground   → messages array (conversation history)
 *
 * The foreground layer is parsed into user/assistant turns.
 * Lines starting with "Cortex:" are assistant messages.
 * All other lines are user messages.
 */
export function contextToMessages(context: AssembledContext): ContextAsMessages {
  // Build system prompt from system_floor + background
  const systemParts: string[] = [];
  const foregroundContent: string[] = [];

  for (const layer of context.layers) {
    if (layer.name === "system_floor" && layer.content) {
      systemParts.push(layer.content);
    } else if (layer.name === "background" && layer.content) {
      systemParts.push(layer.content);
    } else if (layer.name === "foreground" && layer.content) {
      foregroundContent.push(layer.content);
    }
    // archived layers have no content
  }

  const system = systemParts.join("\n\n---\n\n");

  // Parse foreground into message turns
  const messages = parseForegroundToMessages(foregroundContent.join("\n"));

  // Ensure we have at least one user message (API requirement)
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    // If the foreground is empty or ends with assistant, add a minimal user turn
    // This shouldn't happen in normal flow but guards against edge cases
    if (messages.length === 0) {
      messages.push({ role: "user", content: "(no message)" });
    }
  }

  // Ensure messages alternate correctly (Anthropic requirement)
  return { system, messages: consolidateMessages(messages) };
}

/**
 * Parse foreground text into user/assistant message turns.
 *
 * Format from context.ts formatSessionMessage():
 *   "Cortex: <response>"          → assistant
 *   "[webchat] user-id: <text>"   → user
 *   "[whatsapp] user-id: <text>"  → user
 */
function parseForegroundToMessages(foreground: string): AnthropicMessage[] {
  if (!foreground.trim()) return [];

  const lines = foreground.split("\n").filter((l) => l.trim());
  const messages: AnthropicMessage[] = [];

  for (const line of lines) {
    if (line.startsWith("Cortex:")) {
      const content = line.slice("Cortex:".length).trim();
      if (content) {
        messages.push({ role: "assistant", content });
      }
    } else {
      // User message — strip the [channel] prefix for cleaner context
      const content = line.replace(/^\[[\w-]+\]\s*[\w-]+:\s*/, "").trim() || line.trim();
      if (content) {
        messages.push({ role: "user", content });
      }
    }
  }

  return messages;
}

/**
 * Consolidate messages so same-role messages are merged.
 * Anthropic API requires strictly alternating user/assistant roles.
 */
function consolidateMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) return [];

  const consolidated: AnthropicMessage[] = [{ ...messages[0] }];

  for (let i = 1; i < messages.length; i++) {
    const prev = consolidated[consolidated.length - 1];
    if (messages[i].role === prev.role) {
      // Merge consecutive same-role messages
      prev.content += "\n" + messages[i].content;
    } else {
      consolidated.push({ ...messages[i] });
    }
  }

  return consolidated;
}

// ---------------------------------------------------------------------------
// LLM Caller Factory
// ---------------------------------------------------------------------------

/**
 * Create a real LLM caller that uses the gateway's auth infrastructure.
 *
 * Uses dynamic imports to avoid hard dependency on gateway internals
 * at module load time (Cortex should be testable standalone).
 */
export function createGatewayLLMCaller(params: LLMCallerParams): CortexLLMCaller {
  return async (context: AssembledContext): Promise<string> => {
    try {
      const { system, messages } = contextToMessages(context);

      // Resolve auth through gateway infrastructure
      const { resolveModel } = await import("../agents/pi-embedded-runner/model.js");
      const { getApiKeyForModel } = await import("../agents/model-auth.js");

      const { model, authStorage } = resolveModel(
        params.provider,
        params.modelId,
        params.agentDir,
        params.config,
      );

      if (!model) {
        params.onError(new Error(`[cortex-llm] Model not found: ${params.provider}/${params.modelId}`));
        return "NO_REPLY";
      }

      // Get API key (with profile resolution)
      const auth = await getApiKeyForModel({
        model,
        cfg: params.config,
        agentDir: params.agentDir,
      });

      if (!auth.apiKey) {
        params.onError(new Error(`[cortex-llm] No API key for ${params.provider}`));
        return "NO_REPLY";
      }

      // Call Anthropic Messages API
      const response = await callAnthropicMessages({
        apiKey: auth.apiKey,
        model: params.modelId,
        system,
        messages,
        maxTokens: params.maxResponseTokens,
      });

      return response;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // On auth failure, try profile rotation
      if (isAuthError(error)) {
        try {
          return await retryWithRotatedProfile(params, context);
        } catch (retryErr) {
          params.onError(
            retryErr instanceof Error ? retryErr : new Error(String(retryErr)),
          );
          return "NO_REPLY";
        }
      }

      params.onError(error);
      return "NO_REPLY";
    }
  };
}

// ---------------------------------------------------------------------------
// Anthropic API call
// ---------------------------------------------------------------------------

async function callAnthropicMessages(params: {
  apiKey: string;
  model: string;
  system: string;
  messages: AnthropicMessage[];
  maxTokens: number;
}): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: params.apiKey });

  const response = await client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: params.messages,
  });

  // Extract text from response
  const textBlocks = response.content.filter(
    (block: any) => block.type === "text",
  );

  if (textBlocks.length === 0) {
    return "NO_REPLY";
  }

  return textBlocks.map((block: any) => block.text).join("\n");
}

// ---------------------------------------------------------------------------
// Auth retry
// ---------------------------------------------------------------------------

function isAuthError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("401") ||
    msg.includes("unauthorized") ||
    msg.includes("authentication") ||
    msg.includes("invalid x-api-key") ||
    msg.includes("invalid api key")
  );
}

async function retryWithRotatedProfile(
  params: LLMCallerParams,
  context: AssembledContext,
): Promise<string> {
  const { resolveModel } = await import("../agents/pi-embedded-runner/model.js");
  const { getApiKeyForModel } = await import("../agents/model-auth.js");

  const { model } = resolveModel(
    params.provider,
    params.modelId,
    params.agentDir,
    params.config,
  );

  if (!model) {
    throw new Error(`[cortex-llm] Model not found on retry: ${params.provider}/${params.modelId}`);
  }

  // Try alternative auth profiles
  // The auth system supports multiple profiles per provider — get all and try the next one
  const auth = await getApiKeyForModel({
    model,
    cfg: params.config,
    agentDir: params.agentDir,
    // preferredProfile is not set — let the system pick the next available
  });

  if (!auth.apiKey) {
    throw new Error(`[cortex-llm] No alternative auth profile for ${params.provider}`);
  }

  const { system, messages } = contextToMessages(context);

  return callAnthropicMessages({
    apiKey: auth.apiKey,
    model: params.modelId,
    system,
    messages,
    maxTokens: params.maxResponseTokens,
  });
}

// ---------------------------------------------------------------------------
// Stub (for testing / shadow mode)
// ---------------------------------------------------------------------------

/** Create a stub LLM caller that always returns NO_REPLY */
export function createStubLLMCaller(): CortexLLMCaller {
  return async (_context: AssembledContext): Promise<string> => {
    return "NO_REPLY";
  };
}
