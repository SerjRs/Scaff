/**
 * Cortex Retrieval Tools — fetch_chat_history & memory_query
 *
 * Synchronous tools executed within the same LLM turn.
 * Results are fed back as tool_result before the LLM continues.
 *
 * @see docs/hipocampus-implementation.md Phase 3
 */

import type { DatabaseSync } from "node:sqlite";
import { getSessionHistory } from "./session.js";
import { searchColdFacts, insertHotFact, touchHotFact } from "./hippocampus.js";

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const FETCH_CHAT_HISTORY_TOOL = {
  name: "fetch_chat_history",
  description: `Retrieve older chat messages from a specific channel. Use when you need \
verbatim context that was excluded from the active window by the soft cap. \
Returns chronological messages for the given channel.`,
  parameters: {
    type: "object" as const,
    properties: {
      channel: {
        type: "string",
        description: "Channel to fetch history from (e.g. 'webchat', 'whatsapp')",
      },
      limit: {
        type: "number",
        description: "Maximum number of messages to return (default: 20)",
      },
      before: {
        type: "string",
        description: "ISO timestamp — only return messages before this time",
      },
    },
    required: ["channel"],
  },
};

export const MEMORY_QUERY_TOOL = {
  name: "memory_query",
  description: `Search long-term memory for facts and knowledge. Use when you need to recall \
information that isn't in the current conversation — user preferences, past decisions, \
previously mentioned details. Returns matching facts ranked by relevance.`,
  parameters: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Natural language query describing what you want to recall",
      },
      limit: {
        type: "number",
        description: "Maximum number of facts to return (default: 5)",
      },
    },
    required: ["query"],
  },
};

/** All Hippocampus tools */
export const HIPPOCAMPUS_TOOLS = [FETCH_CHAT_HISTORY_TOOL, MEMORY_QUERY_TOOL];

/** Tool names that are handled synchronously (round-trip within same turn) */
export const SYNC_TOOL_NAMES = new Set(["fetch_chat_history", "memory_query"]);

// ---------------------------------------------------------------------------
// Embed Function Type
// ---------------------------------------------------------------------------

/** Embed text into a vector. Injectable for testing. */
export type EmbedFunction = (text: string) => Promise<Float32Array>;

/** Default: call local Ollama nomic-embed-text */
export async function embedViaOllama(text: string): Promise<Float32Array> {
  const resp = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  if (!resp.ok) {
    throw new Error(`Ollama embedding failed: ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json() as { embedding: number[] };
  return new Float32Array(data.embedding);
}

// ---------------------------------------------------------------------------
// Tool Executors
// ---------------------------------------------------------------------------

/** Execute fetch_chat_history — deterministic relational query */
export function executeFetchChatHistory(
  db: DatabaseSync,
  args: { channel: string; limit?: number; before?: string },
): string {
  const limit = args.limit ?? 20;

  // Get session history for the channel
  const allMessages = getSessionHistory(db, { channel: args.channel });

  // Filter by `before` timestamp if provided
  let messages = allMessages;
  if (args.before) {
    messages = allMessages.filter((m) => m.timestamp < args.before!);
  }

  // Take the last N messages (chronological order)
  const result = messages.slice(-limit);

  return JSON.stringify(
    result.map((m) => ({
      role: m.role,
      channel: m.channel,
      sender: m.senderId,
      content: m.content,
      timestamp: m.timestamp,
    })),
  );
}

/** Execute memory_query — vector search against cold storage + hot tracking */
export async function executeMemoryQuery(
  db: DatabaseSync,
  args: { query: string; limit?: number },
  embedFn: EmbedFunction = embedViaOllama,
): Promise<string> {
  const limit = args.limit ?? 5;

  // Embed the query
  const queryEmbedding = await embedFn(args.query);

  // Search cold storage
  const results = searchColdFacts(db, queryEmbedding, limit);

  // Tracking hook: retrieved facts stay hot
  for (const fact of results) {
    // Check if fact already exists in hot memory (by exact text)
    const existing = db.prepare(
      `SELECT id FROM cortex_hot_memory WHERE fact_text = ?`,
    ).get(fact.factText) as { id: string } | undefined;

    if (existing) {
      // Touch existing hot fact
      touchHotFact(db, existing.id);
    } else {
      // Promote cold fact back to hot memory
      insertHotFact(db, { factText: fact.factText });
    }
  }

  if (results.length === 0) {
    return JSON.stringify({ facts: [], message: "No matching facts found." });
  }

  return JSON.stringify({
    facts: results.map((r) => ({
      text: r.factText,
      distance: r.distance,
      archivedAt: r.archivedAt,
    })),
  });
}
