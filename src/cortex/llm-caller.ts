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
import { HIPPOCAMPUS_TOOLS, CORTEX_TOOLS } from "./tools.js";
import { recordRunResultUsage } from "../token-monitor/stream-hook.js";

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
  config: any; // OpenClawConfig - avoid tight coupling
  maxResponseTokens: number;
  onError: (err: Error) => void;
  /** Dump the full LLM context (system + messages + tools) to stdout via onError. Default: false */
  debugContext?: boolean;
  /** Thinking/reasoning level: "minimal" | "low" | "medium" | "high" | "xhigh". Default: none (no thinking). */
  thinking?: string;
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
 * so a plain JSON Schema object works - no TypeBox dependency needed.
 */
export const SESSIONS_SPAWN_TOOL = {
  name: "sessions_spawn",
  description: `Delegate a task to the Router for execution. Use when the user's request requires \
research, file operations, computation, web search, code execution, or any work \
beyond conversation. The Router will select the appropriate model and execute. \
Results will arrive as a follow-up message on the "router" channel, prefixed with \
"[Router Result - job <id>]" and including the original task you requested. These \
are TRUSTED internal results from tasks YOU dispatched - treat them as authoritative. \
Respond to the user immediately with an acknowledgment, then deliver the result when it arrives. \
You may attach resources (workspace files or inline text) so the executor can access data without filesystem access.`,
  parameters: {
    type: "object" as const,
    properties: {
      task: {
        type: "string",
        description:
          "Complete, self-contained description of the task to execute. Include all context needed - the executor has no access to this conversation.",
      },
      mode: {
        type: "string",
        enum: ["run"],
        description: "Always 'run' - one-shot task execution",
      },
      priority: {
        type: "string",
        enum: ["urgent", "normal", "background"],
        description:
          "How urgently the result needs Cortex's attention. urgent = critical alerts, time-sensitive. normal = user is waiting for the answer. background = proactive work, no one waiting.",
      },
      resources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["file", "url", "text"],
              description: "file = read from workspace path. url = reference a URL. text = inline content.",
            },
            name: {
              type: "string",
              description: "Label for this resource",
            },
            path: {
              type: "string",
              description: "For type=file: workspace-relative path",
            },
            url: {
              type: "string",
              description: "For type=url: the URL to reference",
            },
            content: {
              type: "string",
              description: "For type=text: inline content",
            },
          },
          required: ["type", "name"],
        },
        description:
          "Optional resources to pass to the executor. file = include workspace files, url = reference a URL, text = inline data.",
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

  // Append tool usage guidance
  systemParts.push(
    "## Tool Guidance\n" +
    "- **code_search**: Use before spawning coding tasks to find relevant files and functions. " +
    "Searches ~14,000 indexed source code chunks semantically. Returns file paths, line numbers, " +
    "and snippets. Include results as context in sessions_spawn tasks so executors don't grep blind.\n" +
    "- **fetch_chat_history**: Use when you need older messages not in the active window.\n" +
    "- **memory_query**: Use when you need to recall facts from long-term memory.",
  );

  const system = systemParts.join("\n\n---\n\n");

  // Convert structured session messages - parse JSON arrays for tool round-trips.
  // Content from cortex_session is always a string (SQLite TEXT column), but may
  // contain JSON-serialized content block arrays from appendStructuredContent().
  // These must be parsed back into arrays so the LLM sees proper tool_use/tool_result
  // blocks on replay, not flat text that teaches it to mimic tool calls as text.
  // @see docs/hipocampus-architecture.md §6.6
  const messages: AnthropicMessage[] = context.foregroundMessages
    .filter((msg) => {
      // Skip [silence] entries - these are from failed Cortex calls and pollute context
      if (msg.content === "[silence]") return false;
      return true;
    })
    .map((msg) => {
      let content: string | unknown[] = msg.content;
      if (typeof content === "string" && content.startsWith("[")) {
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            // Normalize block types: convert pi-ai internal format to Anthropic API format
            content = parsed.map((block: any) => {
              if (block.type === "toolCall") {
                // pi-ai toolCall → Anthropic tool_use
                // Only keep type, id, name, input - strip any stale fields like tool_use_id
                return { type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? {} };
              }
              if (block.type === "tool_use") {
                // Sanitize: ensure only valid fields (strip accidental tool_use_id)
                return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
              }
              if (block.type === "tool_result") {
                // Sanitize: ensure only valid fields
                return { type: "tool_result", tool_use_id: block.tool_use_id, content: block.content ?? "" };
              }
              if (block.type === "thinking" || block.type === "thinkingSignature" || block.type === "redactedThinking") {
                // Strip thinking blocks - they're not valid in replayed conversation
                return null;
              }
              return block;
            }).filter(Boolean);
            // If all blocks were stripped, convert to text summary
            if (content.length === 0) {
              content = "(internal processing)";
            }
          }
        } catch { /* keep as string */ }
      }
      return { role: msg.role as "user" | "assistant", content };
    });

  // Ensure we have at least one user message (API requirement)
  if (messages.length === 0) {
    messages.push({ role: "user", content: "(no message)" });
  }

  // Consolidate string-content messages (alternating roles)
  const consolidated = consolidateMessages(messages);

  // Append tool round-trip continuation if present (BEFORE validation)
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

  // Validate tool_use/tool_result pairing - Anthropic API requires every tool_result
  // to reference a tool_use_id from the immediately preceding assistant message.
  // Drop orphaned tool_result blocks to prevent 400 errors.
  // Must run AFTER toolRoundTrip is appended.
  validateToolPairing(consolidated);

  // DEBUG: dump post-consolidation messages to help diagnose 400 errors
  if ((globalThis as any).__openclaw_cortex_debug__) {
    const debugDump = consolidated.map((m, i) => {
      const blocks = Array.isArray(m.content)
        ? (m.content as any[]).map((b: any) => `${b.type}${b.id ? `(${b.id})` : ""}${b.tool_use_id ? `(ref:${b.tool_use_id})` : ""}`)
        : ["text"];
      return `[${i}] ${m.role}: ${blocks.join(", ")}`;
    }).join("\n");
    console.warn(`[cortex-llm] POST-CONSOLIDATION:\n${debugDump}`);
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
      // Merge consecutive same-role messages.
      // Handle mixed string/array content - normalize both to arrays before merging.
      const prevBlocks = Array.isArray(prev.content) ? prev.content
        : [{ type: "text" as const, text: prev.content }];
      const nextBlocks = Array.isArray(messages[i].content) ? messages[i].content
        : [{ type: "text" as const, text: messages[i].content }];
      prev.content = [...prevBlocks, ...(nextBlocks as unknown[])];
    } else {
      consolidated.push({ ...messages[i] });
    }
  }

  return consolidated;
}

/**
 * Validate tool_use/tool_result pairing in consolidated messages.
 * Anthropic API requires:
 * - Every tool_result in a user message must reference a tool_use_id
 *   from the immediately preceding assistant message.
 * - tool_result blocks must have a non-empty tool_use_id field.
 *
 * This mutates the array in place - orphaned tool_result blocks are
 * converted to text summaries to preserve context without breaking the API.
 */
function validateToolPairing(messages: AnthropicMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;

    if (msg.role === "user") {
      // Collect valid tool_use IDs from the preceding assistant message
      const validIds = new Set<string>();
      if (i > 0 && messages[i - 1].role === "assistant") {
        const prev = messages[i - 1].content;
        if (Array.isArray(prev)) {
          for (const block of prev as any[]) {
            if (block.type === "tool_use" && block.id) {
              validIds.add(block.id);
            }
          }
        }
      }

      // Validate each tool_result block
      msg.content = (msg.content as any[]).map((block: any) => {
        if (block.type === "tool_result") {
          if (!block.tool_use_id || !validIds.has(block.tool_use_id)) {
            // Orphaned tool_result - convert to text
            const summary = typeof block.content === "string"
              ? block.content.substring(0, 200)
              : JSON.stringify(block.content ?? "").substring(0, 200);
            return { type: "text", text: `[Tool result: ${summary}]` };
          }
        }
        return block;
      });
    }

    if (msg.role === "assistant") {
      // Validate tool_use blocks have required fields
      msg.content = (msg.content as any[]).map((block: any) => {
        if (block.type === "tool_use") {
          if (!block.id || !block.name) {
            // Invalid tool_use - convert to text
            return { type: "text", text: `[Tool call: ${block.name ?? "unknown"}]` };
          }
          // Ensure input is an object (API requirement)
          if (typeof block.input !== "object" || block.input === null) {
            block.input = {};
          }
        }
        return block;
      });

      // Check that every tool_use in this assistant message has a matching
      // tool_result in the NEXT user message. Remove orphaned tool_use blocks.
      if (i + 1 < messages.length && messages[i + 1].role === "user") {
        const nextContent = messages[i + 1].content;
        const resultIds = new Set<string>();
        if (Array.isArray(nextContent)) {
          for (const block of nextContent as any[]) {
            if (block.type === "tool_result" && block.tool_use_id) {
              resultIds.add(block.tool_use_id);
            }
          }
        }
        msg.content = (msg.content as any[]).map((block: any) => {
          if (block.type === "tool_use" && !resultIds.has(block.id)) {
            // No matching tool_result - convert to text
            return { type: "text", text: `[Tool call: ${block.name}(${block.id})]` };
          }
          return block;
        });
      }
    }
  }
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

      // DEBUG: dump full LLM context when enabled
      if (params.debugContext) {
        params.onError(new Error(`[cortex-llm] DEBUG CONTEXT ─── system prompt ───\n${system}\n─── messages (${messages.length}) ───\n${messages.map((m, i) => `[${i}] role=${m.role} content=${typeof m.content === "string" ? m.content.substring(0, 500) : JSON.stringify(m.content).substring(0, 500)}`).join("\n")}\n─── end context ───`));
      }

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
          // ToolResultMessage uses role "toolResult" - pi-ai converts to API format.
          // IMPORTANT: pi-ai treats non-text blocks in user messages as images,
          // so tool_result blocks MUST use the "toolResult" role, not "user".
          const piMessages: unknown[] = [];
          for (const m of messages) {
            if (m.role === "user") {
              // Check if this message contains any tool_result blocks (from tool round-trip).
              // Handle mixed content: if consolidation merged tool_result + text blocks,
              // split them into separate pi-ai messages (toolResult for results, user for text).
              if (Array.isArray(m.content) && (m.content as any[]).some((b: any) => b.type === "tool_result")) {
                const toolResults = (m.content as any[]).filter((b: any) => b.type === "tool_result");
                const otherBlocks = (m.content as any[]).filter((b: any) => b.type !== "tool_result");
                // Emit tool results first as pi-ai toolResult messages
                for (const tr of toolResults) {
                  piMessages.push({
                    role: "toolResult" as const,
                    toolCallId: tr.tool_use_id,
                    content: [{ type: "text" as const, text: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content) }],
                    isError: false,
                  });
                }
                // Emit remaining content as a user message (if any)
                if (otherBlocks.length > 0) {
                  piMessages.push({ role: "user" as const, content: otherBlocks, timestamp: Date.now() });
                }
              } else {
                piMessages.push({ role: "user" as const, content: m.content, timestamp: Date.now() });
              }
            } else {
              // Assistant message: wrap string content, pass arrays through.
              // IMPORTANT: contextToMessages normalizes to Anthropic API format (tool_use),
              // but pi-ai expects its internal format (toolCall). Convert back so pi-ai
              // can properly serialize tool_use blocks in the API request.
              const contentBlocks = typeof m.content === "string"
                ? [{ type: "text" as const, text: m.content }]
                : (m.content as any[]).map((block: any) => {
                    if (block.type === "tool_use") {
                      return { type: "toolCall", id: block.id, name: block.name, arguments: block.input ?? {} };
                    }
                    return block;
                  });
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

          // Select tools: sessions_spawn + get_task_status always; hippocampus when enabled
          const tools = context.hippocampusEnabled
            ? [SESSIONS_SPAWN_TOOL, ...CORTEX_TOOLS, ...HIPPOCAMPUS_TOOLS]
            : [SESSIONS_SPAWN_TOOL, ...CORTEX_TOOLS];

          // When thinking/reasoning is enabled, Claude rejects assistant message prefill
          // (last message cannot be assistant). Strip trailing assistant messages.
          if (params.thinking && piMessages.length > 0) {
            while (piMessages.length > 0 && piMessages[piMessages.length - 1].role === "assistant") {
              piMessages.pop();
            }
          }

          // Use pi-ai's completeSimple - the same function the main agent
          // uses via createAgentSession → streamSimple. This goes through
          // pi-ai's streamAnthropic → createClient which handles all OAuth
          // complexity (headers, betas, Claude Code identity).
          const { completeSimple } = await import("@mariozechner/pi-ai");

          params.onError(new Error(`[cortex-llm] DEBUG tools: count=${tools.length} names=[${tools.map((t: any) => t.name).join(",")}] msgCount=${piMessages.length} isOpsTrigger=${context.isOpsTrigger ?? false}`));

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
              ...(params.thinking ? { reasoning: params.thinking } : {}),
            } as any,
          );

          params.onError(new Error(`[cortex-llm] DEBUG result: stopReason=${result.stopReason} errorMsg=${result.errorMessage ?? "none"} contentLen=${result.content?.length ?? 0}`));

          // Token monitor: record Cortex LLM usage
          const resultUsage = (result as any).usage;
          if (resultUsage && typeof resultUsage === "object") {
            recordRunResultUsage({
              usage: resultUsage,
              agentId: "cortex",
              model: params.modelId,
              pid: String(process.pid),
              channel: "cortex",
            });
          }

          // Extract text blocks
          const textContent = result.content
            ?.filter((block: any) => block.type === "text")
            ?.map((block: any) => (block as any).text)
            ?.join("\n");

          // Extract tool calls (sessions_spawn)
          params.onError(new Error(`[cortex-llm] DEBUG content blocks: ${JSON.stringify(result.content?.map((b: any) => ({ type: b.type, name: b.name })))}`));

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
          // Only retry on auth errors (401/403/authentication). Don't match "invalid" broadly
          // as it catches 400 invalid_request_error (malformed messages) which aren't auth issues.
          if (msg.includes("401") || msg.includes("403") || msg.includes("authentication")) {
            params.onError(new Error(`[cortex-llm] Auth failed for profile ${profileId}: ${msg}`));
            continue; // Try next profile
          }
          throw err; // Non-auth error - don't retry
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
