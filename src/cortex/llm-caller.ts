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
import { HIPPOCAMPUS_TOOLS, CORTEX_TOOLS, LIBRARY_TOOLS, READ_FILE_TOOL, WRITE_FILE_TOOL, MOVE_FILE_TOOL, DELETE_FILE_TOOL, PIPELINE_STATUS_TOOL, PIPELINE_TRANSITION_TOOL, CORTEX_CONFIG_TOOL, GRAPH_TRAVERSE_TOOL } from "./tools.js";
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
      executor: {
        type: "string",
        enum: ["auto", "coding"],
        description:
          "Executor type. 'auto' (default) = standard LLM executor. 'coding' = spawns Claude Code CLI for implementation tasks (gets opus tier, 15min timeout). Use 'coding' when the task requires creating/editing code across multiple files, running tests, or creating PRs.",
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
// Sender aliasing — avoids leaking PII (phone numbers) into LLM context
// ---------------------------------------------------------------------------

/**
 * Create a sender label function scoped to one contextToMessages() call.
 * Uses display name when available (e.g. "Serj"), falls back to aliased ID
 * (e.g. "user-1") to avoid leaking PII like phone numbers into LLM context.
 */
function createSenderLabeler(): (senderId: string | undefined, senderName: string | undefined, channel: string) => string {
  const aliases = new Map<string, string>();
  let counter = 0;
  return (senderId: string | undefined, senderName: string | undefined, channel: string): string => {
    // Prefer display name when available (no PII concern)
    if (senderName) return senderName;
    if (!senderId) return "user";
    const key = `${senderId}:${channel}`;
    if (!aliases.has(key)) {
      aliases.set(key, `user-${++counter}`);
    }
    return aliases.get(key)!;
  };
}

/**
 * Derive a readable label from an issuer string for assistant messages.
 * Every message in cortex_session has an issuer (column DEFAULT 'agent:main:cortex',
 * every INSERT sets it explicitly), so undefined should never occur.
 *
 * Examples:
 *   "agent:main:cortex"              → "Scaff[cortex]"
 *   "router-evaluator"               → "router-evaluator"
 *   "agent:router-executor:session"   → "router-executor"
 */
function issuerLabel(issuer: string | undefined): string {
  if (!issuer) {
    // Should never happen — indicates a bug in context assembly.
    // Return a noticeable label so it's easy to spot and trace.
    return "UNKNOWN_ISSUER";
  }
  // Main cortex agent → persona name + role
  if (issuer === "agent:main:cortex") return "Scaff[cortex]";
  // Other agent:X:Y patterns → extract the agent name (middle segment)
  const agentMatch = issuer.match(/^agent:([^:]+):/);
  if (agentMatch) return agentMatch[1];
  // Bare identifiers like "router-evaluator" → use as-is
  return issuer;
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

  // Append key paths for self-awareness
  {
    const { resolveStateDir } = require("../config/paths.js") as { resolveStateDir: (env?: Record<string, string | undefined>) => string };
    const installRoot = resolveStateDir(process.env);
    systemParts.push(
      "## Key Paths\n" +
      `- **Workspace** (read_file/write_file root): files are resolved relative to the workspace directory\n` +
      `- **Install root**: ${installRoot} (code_search paths are relative to this)\n` +
      `- **Cortex config**: use cortex_config tool (not read_file) to read/modify\n` +
      `- **Source files** from code_search: prepend the install root path to read them with read_file\n` +
      `- When the user says "switch to main" or "move to main", they mean: set your WhatsApp/webchat channel to "off" via cortex_config so the main agent handles messages instead of you.`,
    );
  }

  // Append tool usage guidance
  systemParts.push(
    "## Tool Guidance\n" +
    "- **code_search**: Use before spawning coding tasks to find relevant files and functions. " +
    "Searches ~14,000 indexed source code chunks semantically. Returns file paths, line numbers, " +
    "and snippets. Include results as context in sessions_spawn tasks so executors don't grep blind.\n" +
    "- **fetch_chat_history**: Use when you need older messages not in the active window.\n" +
    "- **memory_query**: Use when you need to recall facts from long-term memory.\n" +
    "- **read_file**: Read local files (docs, configs, architecture specs). Paths relative to workspace. Use offset/limit for large files (default limit: 500 lines). When output says 'N more lines', use offset to continue.\n" +
    "- **write_file**: Write or append to local files. Creates parent dirs. Paths relative to workspace.\n" +
    "- **move_file**: Move or rename files. For pipeline stage transitions, use pipeline_transition instead.\n" +
    "- **delete_file**: Delete a file. Files only, no directories. Use with care.\n" +
    "- **pipeline_status**: Get pipeline overview — task counts and summaries per stage.\n" +
    "- **pipeline_transition**: Move a pipeline task between stages. Enforces the state machine: " +
    "Cooking → InProgress → InReview → Done. Cannot skip stages (e.g., InProgress → Done is blocked — must go through InReview). " +
    "Automatically updates SPEC.md frontmatter. Use this instead of move_file for pipeline.\n" +
    "- **graph_traverse**: Walk the knowledge graph from a fact. Use when hot memory breadcrumbs show a connection you want to explore deeper. The fact_id is shown in brackets in the Knowledge Graph section.\n" +
    "- **cortex_config**: Read or modify your own Cortex config (channel modes). " +
    "Use to switch channels on/off. Example: cortex_config({ action: 'set_channel', channel: 'whatsapp', mode: 'off' }) " +
    "to hand off to the main agent.\n" +
    "- **sessions_spawn executor param**: Pass `executor: \"coding\"` when the task requires multi-file code changes, " +
    "running tests, creating branches/PRs, or any work best handled by Claude Code CLI. " +
    "This routes to the coding_run template (opus tier, 15min timeout). Default (\"auto\") uses the standard LLM executor.\n\n" +
    "## Sync vs Async Tools\n" +
    "Sync tools execute instantly in the same LLM turn — use for all local operations:\n" +
    "  read_file, write_file, move_file, delete_file, code_search, memory_query, graph_traverse,\n" +
    "  pipeline_status, pipeline_transition, cortex_config, get_task_status, fetch_chat_history\n\n" +
    "sessions_spawn dispatches to an external executor (Router → Claude Code or LLM agent). " +
    "Use ONLY for work that requires writing/modifying code, running tests, creating branches/PRs, " +
    "or complex multi-step tasks needing their own agent. " +
    "NEVER use sessions_spawn to move files, read files, or do anything a sync tool handles. " +
    "A file move that takes 1 sync tool call should not become a 30-second async dispatch.\n\n" +
    "## Pipeline Tasks\n" +
    "When spawning a coding task for a pipeline item, ALWAYS include the SPEC.md as a resource:\n" +
    "  resources: [{ type: 'file', name: 'SPEC', path: 'pipeline/<Stage>/<taskFolder>/SPEC.md' }]\n" +
    "The executor cannot read your conversation — the SPEC is its only context.\n\n" +
    "When a coding executor completes: move to InReview first (pipeline_transition), review the diff, " +
    "THEN move to Done. Never skip InReview.\n\n" +
    "## Library\n" +
    "When the user shares a URL, always call library_ingest(url) to store it in the Library. " +
    "Every link the user shares is domain knowledge worth retaining.\n\n" +
    "Article-derived facts are indexed in the Knowledge Graph — they appear in Hot Memory " +
    "with sourced_from edges linking back to the source article. " +
    "Use graph_traverse to explore domain knowledge from any fact.\n\n" +
    "Use library_get(id) to read the full article text when you need details beyond the extracted facts. " +
    "Use library_search(query) to find items not yet surfaced through the graph. " +
    "When you detect a knowledge gap — the user asks about something you can't answer well " +
    "and the graph has no relevant facts — suggest they share relevant links: " +
    "\"I don't have deep context on [topic]. If you have docs or articles, drop a link and I'll learn it.\"",
  );

  const system = systemParts.join("\n\n---\n\n");

  // Convert structured session messages - parse JSON arrays for tool round-trips.
  // Content from cortex_session is always a string (SQLite TEXT column), but may
  // contain JSON-serialized content block arrays from appendStructuredContent().
  // These must be parsed back into arrays so the LLM sees proper tool_use/tool_result
  // blocks on replay, not flat text that teaches it to mimic tool calls as text.
  // @see docs/hipocampus-architecture.md §6.6
  const labelSender = createSenderLabeler();
  const messages: AnthropicMessage[] = context.foregroundMessages
    .filter((msg) => {
      // Skip [silence] entries - these are from failed Cortex calls and pollute context
      if (msg.content === "[silence]") return false;
      return true;
    })
    .map((msg) => {
      let content: string | unknown[] = msg.content;
      // First: try parsing JSON-serialized structured content (tool round-trips)
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
        } catch { /* not JSON — keep as string */ }
      }
      // Prefix context metadata so the LLM knows when, who, and which channel for every message.
      // Uses aliased sender IDs to avoid leaking PII (phone numbers) into LLM context.
      // Strategy differs by role due to API constraints:
      //   - assistant (tool_use): prepend text block (API supports text + tool_use mixing)
      //   - user (tool_result): embed metadata in tool_result.content string
      //     (API rejects text blocks alongside tool_result blocks)
      const ts = msg.timestamp?.replace("T", " ").replace(/\.\d+Z$/, "") ?? "";
      const sender = msg.role === "assistant" ? issuerLabel(msg.issuer) : labelSender(msg.senderId, msg.senderName, msg.channel);
      const meta = `[${ts}:${sender}:${msg.channel}]`;

      if (typeof content === "string") {
        content = `${meta} ${content}`;
      } else if (Array.isArray(content)) {
        if (msg.role === "assistant") {
          // tool_use: prepend text block (API supports text + tool_use in assistant messages)
          content = [{ type: "text", text: meta }, ...content];
        } else {
          // tool_result: embed metadata INTO content string
          // (API rejects text blocks before/between tool_result blocks — verified 2026-03-10)
          content = content.map((block: any) => {
            if (block.type === "tool_result" && typeof block.content === "string") {
              return { ...block, content: `${meta}\n${block.content}` };
            }
            return block;
          });
        }
      }
      return { role: msg.role as "user" | "assistant", content };
    });

  // Ensure we have at least one user message (API requirement)
  if (messages.length === 0) {
    messages.push({ role: "user", content: "(no message)" });
  }

  // Consolidate string-content messages (alternating roles)
  const consolidated = consolidateMessages(messages);

  // Append tool round-trip continuation if present (BEFORE validation).
  // Prefer accumulated toolRoundTrips (all rounds) over singular toolRoundTrip (legacy).
  // This ensures the LLM sees full results from ALL prior sync tool rounds,
  // preventing the compressed reference loop where early-round results vanish.
  // @see workspace/docs/working/06_compressed-reference-loop.md
  if (context.toolRoundTrips && context.toolRoundTrips.length > 0) {
    for (const trip of context.toolRoundTrips) {
      // Assistant message with raw content blocks (text + tool_use)
      consolidated.push({
        role: "assistant",
        content: trip.previousContent,
      });
      // User message with tool results
      consolidated.push({
        role: "user",
        content: trip.toolResults.map((r) => ({
          type: "tool_result",
          tool_use_id: r.toolCallId,
          content: r.content,
        })),
      });
    }
  } else if (context.toolRoundTrip) {
    // Legacy single round-trip (backward compat)
    consolidated.push({
      role: "assistant",
      content: context.toolRoundTrip.previousContent,
    });
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

      // Validate each tool_result block + deduplicate.
      // Anthropic API requires exactly ONE tool_result per tool_use_id.
      // Duplicates cause 400: "each tool_use must have a single result"
      const seenResultIds = new Set<string>();
      msg.content = (msg.content as any[]).map((block: any) => {
        if (block.type === "tool_result") {
          if (!block.tool_use_id || !validIds.has(block.tool_use_id)) {
            // Orphaned tool_result - convert to text
            const summary = typeof block.content === "string"
              ? block.content.substring(0, 200)
              : JSON.stringify(block.content ?? "").substring(0, 200);
            return { type: "text", text: `[Tool result: ${summary}]` };
          }
          if (seenResultIds.has(block.tool_use_id)) {
            // Duplicate tool_result for same tool_use_id - convert to text
            const summary = typeof block.content === "string"
              ? block.content.substring(0, 200)
              : JSON.stringify(block.content ?? "").substring(0, 200);
            return { type: "text", text: `[Duplicate tool result: ${summary}]` };
          }
          seenResultIds.add(block.tool_use_id);
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
      // Also handles: last message in array, or next message is not a user message.
      const hasToolUse = (msg.content as any[]).some((b: any) => b.type === "tool_use");
      if (hasToolUse) {
        const resultIds = new Set<string>();
        if (i + 1 < messages.length && messages[i + 1].role === "user") {
          const nextContent = messages[i + 1].content;
          if (Array.isArray(nextContent)) {
            for (const block of nextContent as any[]) {
              if (block.type === "tool_result" && block.tool_use_id) {
                resultIds.add(block.tool_use_id);
              }
            }
          }
        }
        // Any tool_use without a matching tool_result is orphaned — convert to text
        msg.content = (msg.content as any[]).map((block: any) => {
          if (block.type === "tool_use" && !resultIds.has(block.id)) {
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

          // Select tools: sessions_spawn + get_task_status + library + file I/O always; hippocampus when enabled
          const FILE_IO_TOOLS = [READ_FILE_TOOL, WRITE_FILE_TOOL, MOVE_FILE_TOOL, DELETE_FILE_TOOL, PIPELINE_STATUS_TOOL, PIPELINE_TRANSITION_TOOL, CORTEX_CONFIG_TOOL, GRAPH_TRAVERSE_TOOL];
          const tools = context.hippocampusEnabled
            ? [SESSIONS_SPAWN_TOOL, ...CORTEX_TOOLS, ...HIPPOCAMPUS_TOOLS, ...LIBRARY_TOOLS, ...FILE_IO_TOOLS]
            : [SESSIONS_SPAWN_TOOL, ...CORTEX_TOOLS, ...LIBRARY_TOOLS, ...FILE_IO_TOOLS];

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
// Gardener LLM Caller (simple prompt → text)
// ---------------------------------------------------------------------------

/**
 * Create a simple prompt→text LLM function for the Gardener subsystem.
 * Uses the reusable LLM client (src/llm/) for auth resolution and API calls.
 * Used for fact extraction and channel summarization (background tasks).
 */
export function createGardenerLLMFunction(params: LLMCallerParams): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const { complete } = await import("../llm/simple-complete.js");
    return complete(prompt, {
      model: params.modelId,
      provider: params.provider,
      maxTokens: params.maxResponseTokens ?? 2048,
      agentDir: params.agentDir,
      systemPrompt: "You are a concise assistant. Follow instructions exactly.",
    });
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
