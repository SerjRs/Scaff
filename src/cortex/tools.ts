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
import { getShardMessages } from "./shards.js";
import { searchColdFacts, insertHotFact, touchHotFact } from "./hippocampus.js";

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const FETCH_CHAT_HISTORY_TOOL = {
  name: "fetch_chat_history",
  description: `Retrieve older chat messages from a specific channel. Use when you need \
verbatim context that was excluded from the active window by the soft cap. \
Returns chronological messages for the given channel. \
When shard_id is provided, returns all messages from that specific shard (coherent topic block).`,
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
      shard_id: {
        type: "string",
        description: "Shard ID — when provided, returns all messages from this shard (ignores channel/limit/before)",
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

export const GET_TASK_STATUS_TOOL = {
  name: "get_task_status",
  description: `Check the status of a previously spawned task by its ID. Use when you want to \
know whether a task completed, failed, or is still running. Returns status, result or error, \
timing information, and the model tier used.`,
  parameters: {
    type: "object" as const,
    properties: {
      taskId: {
        type: "string",
        description: "The task ID returned when sessions_spawn was called",
      },
    },
    required: ["taskId"],
  },
};

export const CODE_SEARCH_TOOL = {
  name: "code_search",
  description: `Semantic search over the OpenClaw source code index (~2,300 files, ~14,000 chunks). \
Use before spawning coding tasks to find relevant files, functions, and code blocks. \
Returns file paths, line numbers, chunk names, and code snippets ranked by relevance. \
Much cheaper than having executors grep blindly.`,
  parameters: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Natural language or code query to search for",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 5, max: 20)",
      },
    },
    required: ["query"],
  },
};

/** All Hippocampus tools */
export const HIPPOCAMPUS_TOOLS = [FETCH_CHAT_HISTORY_TOOL, MEMORY_QUERY_TOOL];

/** Core Cortex tools (always available alongside sessions_spawn) */
export const CORTEX_TOOLS = [GET_TASK_STATUS_TOOL, CODE_SEARCH_TOOL];

/** Tool names that are handled synchronously (round-trip within same turn) */
export const SYNC_TOOL_NAMES = new Set(["fetch_chat_history", "memory_query", "get_task_status", "code_search"]);

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

/** Execute get_task_status — query Router queue for task by ID */
export function executeGetTaskStatus(args: { taskId: string }): string {
  try {
    const path = require("node:path");
    const { resolveStateDir } = require("../config/paths.js");
    const { DatabaseSync: SqliteDB } = require("node:sqlite");

    const stateDir = resolveStateDir(process.env);
    const queuePath = path.join(stateDir, "router", "queue.sqlite");
    const qdb = new SqliteDB(queuePath, { readOnly: true });

    // Check active jobs first, then archive
    let job = qdb.prepare("SELECT * FROM jobs WHERE id = ?").get(args.taskId) as any;
    let source = "active";
    if (!job) {
      job = qdb.prepare("SELECT * FROM jobs_archive WHERE id = ?").get(args.taskId) as any;
      source = "archive";
    }

    qdb.close();

    if (!job) {
      return JSON.stringify({ found: false, taskId: args.taskId, message: "Task not found in Router queue." });
    }

    // Parse payload for the original task description
    let taskDescription = "";
    try {
      const payload = JSON.parse(job.payload ?? "{}");
      taskDescription = payload.message ?? "";
    } catch { /* best-effort */ }

    const result: Record<string, unknown> = {
      found: true,
      taskId: args.taskId,
      status: job.status,
      tier: job.tier,
      weight: job.weight,
      task: taskDescription.substring(0, 200),
      createdAt: job.created_at,
      startedAt: job.started_at ?? null,
      finishedAt: job.finished_at ?? null,
      deliveredAt: job.delivered_at ?? null,
      source,
    };

    if (job.status === "completed" && job.result) {
      result.result = String(job.result).substring(0, 500);
    }
    if (job.status === "failed" && job.error) {
      result.error = String(job.error).substring(0, 500);
    }
    if (job.retry_count > 0) {
      result.retryCount = job.retry_count;
    }

    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({
      found: false,
      taskId: args.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Execute fetch_chat_history — deterministic relational query */
export function executeFetchChatHistory(
  db: DatabaseSync,
  args: { channel: string; limit?: number; before?: string; shard_id?: string },
): string {
  // Shard mode: return all messages from a specific shard
  if (args.shard_id) {
    const shardMessages = getShardMessages(db, args.shard_id);
    return JSON.stringify(
      shardMessages.map((m) => ({
        role: m.role,
        channel: m.channel,
        sender: m.senderId,
        content: m.content,
        timestamp: m.timestamp,
      })),
    );
  }

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

/** Execute code_search — semantic search over the source code index */
export function executeCodeSearch(args: { query: string; limit?: number }): string {
  try {
    const path = require("node:path");
    const { execSync } = require("node:child_process");
    const fs = require("node:fs");
    const { resolveStateDir } = require("../config/paths.js");

    const openclawDir = resolveStateDir();
    const searchScript = path.join(openclawDir, "scripts", "code-search.mjs");
    const dbPath = path.join(openclawDir, "scaff-tools", "code-index.sqlite");

    if (!fs.existsSync(dbPath)) {
      return JSON.stringify({ error: "Code index not found. Run: node scripts/code-index.mjs", available: false });
    }
    if (!fs.existsSync(searchScript)) {
      return JSON.stringify({ error: "Search script not found", available: false });
    }

    const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
    const escapedQuery = args.query.replace(/"/g, '\\"');
    const output = execSync(
      `node "${searchScript}" --top ${limit} "${escapedQuery}"`,
      { cwd: openclawDir, timeout: 30_000, encoding: "utf-8" },
    );

    return output.trim();
  } catch (err) {
    return JSON.stringify({
      error: `Code search failed: ${err instanceof Error ? err.message : String(err)}`,
      available: true,
    });
  }
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
