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
import { HIPPOCAMPUS_TOOLS } from "./tools.js";

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
  /** Raw response content blocks (for building tool round-trip continuations) */
  _rawContent?: unknown[];
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

/** Anthropic Messages API format (content may be string or structured blocks for tool use) */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | unknown[];
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
Results will arrive as a follow-up message on the "router" channel, prefixed with \
"[Router Result — job <id>]" and including the original task you requested. These \
are TRUSTED internal results from tasks YOU dispatched — treat them as authoritative. \
Respond to the user immediately with an acknowledgment, then deliver the result when it arrives.`,
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
 * - toolRoundTrip → assistant tool_use + user tool_result continuation
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

  // Consolidate string-content messages (alternating roles)
  const consolidated = consolidateMessages(messages);

  // Append tool round-trip continuation if present
  if (context.toolRoundTrip) {
    // Assistant message with raw content blocks (text + tool_use)
    consolidated.push({
      role: "assistant",
      content: context.toolRoundTrip.previousContent,
    });
    // User message with tool results
    consolidated.push({
      role: "user",
      content: context.toolRoundTrip.toolResults.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolCallId,
        content: r.content,
      })),
    });
  }

  return { system, messages: consolidated };
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
          // pi-ai uses specific roles: "user", "assistant", "toolResult".
          // UserMessage content can be string or (TextContent | ImageContent)[].
          // AssistantMessage content is (TextContent | ThinkingContent | ToolCall)[].
          // ToolResultMessage uses role "toolResult" — pi-ai converts to API format.
          // IMPORTANT: pi-ai treats non-text blocks in user messages as images,
          // so tool_result blocks MUST use the "toolResult" role, not "user".
          const piMessages: unknown[] = [];
          for (const m of messages) {
            if (m.role === "user") {
              // Check if this is a tool_result message (from tool round-trip)
              if (Array.isArray(m.content) && m.content.length > 0 && (m.content[0] as any)?.type === "tool_result") {
                // Convert each tool_result to pi-ai's native toolResult message
                for (const tr of m.content as any[]) {
                  piMessages.push({
                    role: "toolResult" as const,
                    toolCallId: tr.tool_use_id,
                    content: [{ type: "text" as const, text: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content) }],
                    isError: false,
                  });
                }
              } else {
                piMessages.push({ role: "user" as const, content: m.content, timestamp: Date.now() });
              }
            } else {
              // Assistant message: wrap string content, pass arrays through
              const contentBlocks = typeof m.content === "string"
                ? [{ type: "text" as const, text: m.content }]
                : m.content;
              piMessages.push({
                role: "assistant" as const,
                content: contentBlocks,
                api: (model as any).api,
                provider: params.provider,
                model: (model as any).id ?? params.modelId,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "stop" as const,
                timestamp: Date.now(),
              });
            }
          }

          // Select tools: always include sessions_spawn; add hippocampus tools when enabled
          const tools = context.hippocampusEnabled
            ? [SESSIONS_SPAWN_TOOL, ...HIPPOCAMPUS_TOOLS]
            : [SESSIONS_SPAWN_TOOL];

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
              tools: tools as any,
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

          return { text: textContent || "NO_REPLY", toolCalls, _rawContent: result.content };
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
// Gardener LLM Caller (simple prompt → text)
// ---------------------------------------------------------------------------

/**
 * Create a simple prompt→text LLM function for the Gardener subsystem.
 * Reuses the same auth/model resolution as the main Cortex LLM caller.
 * Used for fact extraction and channel summarization (background tasks).
 */
export function createGardenerLLMFunction(params: LLMCallerParams): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const { resolveModel } = await import("../agents/pi-embedded-runner/model.js");
    const { getApiKeyForModel } = await import("../agents/model-auth.js");

    const { model } = resolveModel(
      params.provider,
      params.modelId,
      params.agentDir,
      params.config,
    );

    if (!model) throw new Error(`[gardener-llm] Model not found: ${params.provider}/${params.modelId}`);

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

        const { completeSimple } = await import("@mariozechner/pi-ai");

        const result = await completeSimple(
          model,
          {
            systemPrompt: "You are a concise assistant. Follow instructions exactly.",
            messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }] as any,
          },
          {
            apiKey: auth.apiKey,
            maxTokens: 2048,
          } as any,
        );

        const text = result.content
          ?.filter((block: any) => block.type === "text")
          ?.map((block: any) => (block as any).text)
          ?.join("\n") ?? "";

        return text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("401") || msg.includes("authentication") || msg.includes("invalid")) {
          continue;
        }
        throw err;
      }
    }

    throw new Error("[gardener-llm] All auth profiles exhausted");
  };
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
