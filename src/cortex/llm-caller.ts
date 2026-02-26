/**
 * Cortex LLM Caller
 *
 * Makes real LLM calls using the gateway's auth infrastructure.
 * Converts Cortex's AssembledContext into Anthropic Messages API format.
 *
 * Auth flow:
 *   resolveModel() → getApiKeyForModel() → Anthropic SDK → messages.create()
 *   OAuth tokens (sk-ant-oat01-*) use authToken param (Bearer header).
 *   Regular API keys (sk-ant-api*) use apiKey param (x-api-key header).
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
// Auth helpers
// ---------------------------------------------------------------------------

/** Detect if an API key is an OAuth token (needs Bearer auth) vs regular key */
function isOAuthToken(key: string): boolean {
  return key.startsWith("sk-ant-oat");
}

/**
 * Create an Anthropic client with the correct auth method.
 * OAuth tokens → authToken (Authorization: Bearer)
 * Regular keys → apiKey (x-api-key header)
 */
async function createAnthropicClient(key: string) {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  if (isOAuthToken(key)) {
    return new Anthropic({ authToken: key });
  }
  return new Anthropic({ apiKey: key });
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

      const { model } = resolveModel(
        params.provider,
        params.modelId,
        params.agentDir,
        params.config,
      );

      if (!model) {
        params.onError(new Error(`[cortex-llm] Model not found: ${params.provider}/${params.modelId}`));
        return "NO_REPLY";
      }

      // Try profiles in order: lastGood first, then others
      const profiles = await getProfileCandidates(params);

      for (const profileId of profiles) {
        try {
          const auth = await getApiKeyForModel({
            model,
            cfg: params.config,
            agentDir: params.agentDir,
            profileId,
          });

          if (!auth.apiKey) continue;

          const response = await callAnthropicMessages({
            key: auth.apiKey,
            model: params.modelId,
            system,
            messages,
            maxTokens: params.maxResponseTokens,
          });

          return response;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("401") || msg.includes("authentication") || msg.includes("invalid")) {
            params.onError(new Error(`[cortex-llm] Auth failed for profile ${profileId}: ${msg}`));
            continue; // Try next profile
          }
          throw err; // Non-auth error — don't retry
        }
      }

      params.onError(new Error(`[cortex-llm] All auth profiles exhausted`));
      return "NO_REPLY";
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      params.onError(error);
      return "NO_REPLY";
    }
  };
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

async function getProfileCandidates(params: LLMCallerParams): Promise<(string | undefined)[]> {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const profilesPath = path.join(params.agentDir, "auth-profiles.json");
    const data = JSON.parse(fs.readFileSync(profilesPath, "utf-8"));

    const lastGood = data.lastGood?.[params.provider];
    const allProfiles = Object.keys(data.profiles ?? {}).filter((id) =>
      id.startsWith(`${params.provider}:`),
    );

    // lastGood first, then others
    const candidates: string[] = [];
    if (lastGood) candidates.push(lastGood);
    for (const p of allProfiles) {
      if (p !== lastGood) candidates.push(p);
    }

    return candidates.length > 0 ? candidates : [undefined];
  } catch {
    return [undefined]; // Fallback: let getApiKeyForModel pick
  }
}

// ---------------------------------------------------------------------------
// Anthropic API call
// ---------------------------------------------------------------------------

async function callAnthropicMessages(params: {
  key: string;
  model: string;
  system: string;
  messages: AnthropicMessage[];
  maxTokens: number;
}): Promise<string> {
  const client = await createAnthropicClient(params.key);

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
// Stub (for testing / shadow mode)
// ---------------------------------------------------------------------------

/** Create a stub LLM caller that always returns NO_REPLY */
export function createStubLLMCaller(): CortexLLMCaller {
  return async (_context: AssembledContext): Promise<string> => {
    return "NO_REPLY";
  };
}
