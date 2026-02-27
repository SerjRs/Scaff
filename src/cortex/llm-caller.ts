/**
 * Cortex LLM Caller
 *
 * Makes real LLM calls using the same pi-ai streaming infrastructure
 * as the main agent. This ensures OAuth tokens, beta headers, Claude Code
 * identity preamble, and cache control are all handled identically.
 *
 * Auth flow:
 *   resolveModel() → getApiKeyForModel() → pi-ai completeSimple()
 *   pi-ai internally creates the Anthropic client with correct auth
 *   (authToken + defaultHeaders for OAuth, apiKey for regular keys).
 *
 * @see docs/cortex-implementation-tasks.md Task 23
 */

import type { AssembledContext } from "./context.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A tool call extracted from the LLM response */
export interface CortexToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Structured result from a Cortex LLM call */
export interface CortexLLMResult {
  text: string;
  toolCalls: CortexToolCall[];
}

export interface CortexLLMCaller {
  (context: AssembledContext): Promise<CortexLLMResult>;
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
// sessions_spawn tool definition
// ---------------------------------------------------------------------------

/**
 * The single tool available to Cortex. Delegates tasks to the Router
 * for execution by a sub-agent with the appropriate model tier.
 *
 * pi-ai's convertTools() reads .properties and .required from the schema,
 * so a plain JSON Schema object works — no TypeBox dependency needed.
 */
export const SESSIONS_SPAWN_TOOL = {
  name: "sessions_spawn",
  description: `Delegate a task to the Router for execution. Use when the user's request requires \
research, file operations, computation, web search, code execution, or any work \
beyond conversation. The Router will select the appropriate model and execute. \
Results will arrive as a follow-up message — respond to the user immediately \
with an acknowledgment ("Let me look into that") then deliver the result when it arrives.`,
  parameters: {
    type: "object" as const,
    properties: {
      task: {
        type: "string",
        description:
          "Complete, self-contained description of the task to execute. Include all context needed — the executor has no access to this conversation.",
      },
      mode: {
        type: "string",
        enum: ["run"],
        description: "Always 'run' — one-shot task execution",
      },
      priority: {
        type: "string",
        enum: ["urgent", "normal", "background"],
        description:
          "How urgently the result needs Cortex's attention. urgent = critical alerts, time-sensitive. normal = user is waiting for the answer. background = proactive work, no one waiting.",
      },
    },
    required: ["task"],
  },
};

// ---------------------------------------------------------------------------
// Context → Messages
// ---------------------------------------------------------------------------

/**
 * Convert AssembledContext into Anthropic Messages API format.
 *
 * Mapping:
 * - system_floor → system parameter (identity, memory, workspace)
 * - background   → appended to system (cross-channel awareness)
 * - foregroundMessages → messages array (structured, no text round-trip)
 */
export function contextToMessages(context: AssembledContext): ContextAsMessages {
  // Build system prompt from system_floor + background
  const systemParts: string[] = [];

  for (const layer of context.layers) {
    if (layer.name === "system_floor" && layer.content) {
      systemParts.push(layer.content);
    } else if (layer.name === "background" && layer.content) {
      systemParts.push(layer.content);
    }
    // foreground is handled via foregroundMessages (structured)
    // archived layers have no content
  }

  const system = systemParts.join("\n\n---\n\n");

  // Convert structured session messages directly — no lossy text parsing
  const messages: AnthropicMessage[] = context.foregroundMessages.map((msg) => ({
    role: msg.role as "user" | "assistant",
    content: msg.content,
  }));

  // Ensure we have at least one user message (API requirement)
  if (messages.length === 0) {
    messages.push({ role: "user", content: "(no message)" });
  }

  // Ensure messages alternate correctly (Anthropic requirement)
  return { system, messages: consolidateMessages(messages) };
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
 * Create a real LLM caller that uses the same pi-ai streaming infrastructure
 * as the main agent (runEmbeddedPiAgent → streamSimple → streamAnthropic).
 *
 * pi-ai's streamAnthropic → createClient() handles:
 * - OAuth token detection (sk-ant-oat-*)
 * - authToken vs apiKey distinction
 * - Required beta headers (claude-code-20250219, oauth-2025-04-20, etc.)
 * - Claude Code identity preamble in system prompt
 * - Cache control and prompt caching
 *
 * Uses dynamic imports to avoid hard dependency on gateway internals
 * at module load time (Cortex should be testable standalone).
 */
export function createGatewayLLMCaller(params: LLMCallerParams): CortexLLMCaller {
  return async (context: AssembledContext): Promise<CortexLLMResult> => {
    try {
      const { system, messages } = contextToMessages(context);

      // Resolve model through the same path as the main agent
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
        return { text: "NO_REPLY", toolCalls: [] };
      }

      params.onError(new Error(`[cortex-llm] DEBUG model: api=${(model as any).api} id=${(model as any).id}`));

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

          params.onError(new Error(`[cortex-llm] DEBUG auth: profile=${profileId} key=${auth.apiKey ? auth.apiKey.substring(0, 20) + "..." : "null"}`));

          if (!auth.apiKey) continue;

          // Build properly-typed pi-ai messages.
          // UserMessage accepts string content; AssistantMessage requires array content.
          const piMessages = messages.map((m) => {
            if (m.role === "user") {
              return { role: "user" as const, content: m.content, timestamp: Date.now() };
            }
            return {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: m.content }],
              api: (model as any).api,
              provider: params.provider,
              model: (model as any).id ?? params.modelId,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop" as const,
              timestamp: Date.now(),
            };
          });

          // Use pi-ai's completeSimple — the same function the main agent
          // uses via createAgentSession → streamSimple. This goes through
          // pi-ai's streamAnthropic → createClient which handles all OAuth
          // complexity (headers, betas, Claude Code identity).
          const { completeSimple } = await import("@mariozechner/pi-ai");

          const result = await completeSimple(
            model,
            {
              systemPrompt: system,
              messages: piMessages as any,
              tools: [SESSIONS_SPAWN_TOOL] as any,
            },
            {
              apiKey: auth.apiKey,
              maxTokens: params.maxResponseTokens,
            } as any,
          );

          params.onError(new Error(`[cortex-llm] DEBUG result: stopReason=${result.stopReason} errorMsg=${result.errorMessage ?? "none"} contentLen=${result.content?.length ?? 0}`));

          // Extract text blocks
          const textContent = result.content
            ?.filter((block: any) => block.type === "text")
            ?.map((block: any) => (block as any).text)
            ?.join("\n");

          // Extract tool calls (sessions_spawn)
          const toolCalls: CortexToolCall[] = result.content
            ?.filter((block: any) => block.type === "toolCall")
            ?.map((block: any) => ({
              id: block.id as string,
              name: block.name as string,
              arguments: (block.arguments ?? {}) as Record<string, unknown>,
            })) ?? [];

          if (toolCalls.length > 0) {
            params.onError(new Error(`[cortex-llm] Tool calls: ${toolCalls.map((t) => `${t.name}(${JSON.stringify(t.arguments).substring(0, 100)})`).join(", ")}`));
          }

          params.onError(new Error(`[cortex-llm] DEBUG textContent: "${textContent?.substring(0, 80) ?? "undefined"}"`));

          return { text: textContent || "NO_REPLY", toolCalls };
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
      return { text: "NO_REPLY", toolCalls: [] };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      params.onError(error);
      return { text: "NO_REPLY", toolCalls: [] };
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
// Stub (for testing / shadow mode)
// ---------------------------------------------------------------------------

/** Create a stub LLM caller that always returns NO_REPLY */
export function createStubLLMCaller(): CortexLLMCaller {
  return async (_context: AssembledContext): Promise<CortexLLMResult> => {
    return { text: "NO_REPLY", toolCalls: [] };
  };
}
