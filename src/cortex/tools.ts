/**
 * Cortex Retrieval Tools — fetch_chat_history & memory_query
 *
 * Synchronous tools executed within the same LLM turn.
 * Results are fed back as tool_result before the LLM continues.
 *
 * @see docs/hipocampus-implementation.md Phase 3
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { getSessionHistory } from "./session.js";
import { getShardMessages } from "./shards.js";
import { searchColdFacts, searchGraphFacts, queryEdgesForFact, insertHotFact, touchHotFact, reviveFact, touchGraphFact } from "./hippocampus.js";

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

// ---------------------------------------------------------------------------
// Library Tools
// ---------------------------------------------------------------------------

export const LIBRARY_INGEST_TOOL = {
  name: "library_ingest",
  description: `Ingest a URL into the Library for long-term domain knowledge. Use this whenever \
the user shares a URL — every link the user shares should be ingested. The Librarian executor \
will read the content, summarize it, extract key concepts and tags, and store it in the Library \
database. You will be notified when ingestion completes. Do NOT poll — the system will wake you \
with the result.`,
  parameters: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "The URL to ingest into the Library",
      },
    },
    required: ["url"],
  },
};

export const LIBRARY_GET_TOOL = {
  name: "library_get",
  description: `Get the full summary, key concepts, and metadata of a Library item by ID. \
Use when you see a relevant item in the Library breadcrumbs and need its full details \
to answer the user's question. The result is used for this turn only — a compressed \
reference is stored in conversation history.`,
  parameters: {
    type: "object" as const,
    properties: {
      item_id: {
        type: "number",
        description: "Item ID from the Library breadcrumbs (e.g., 7)",
      },
    },
    required: ["item_id"],
  },
};

export const LIBRARY_SEARCH_TOOL = {
  name: "library_search",
  description: `Search the Library for items matching a query. Use when you need knowledge \
that the breadcrumbs don't show, or when you want to explore a specific angle that differs \
from the user's original question. Returns titles, tags, and teasers — use library_get(id) \
to read the full item.`,
  parameters: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Natural language search query",
      },
      limit: {
        type: "number",
        description: "Max results (default 10, max 20)",
      },
    },
    required: ["query"],
  },
};

export const LIBRARY_STATS_TOOL = {
  name: "library_stats",
  description: `Get Library statistics: total items, items by status, recent ingestions, \
tag distribution. Use when the user asks about Library health or what knowledge is stored.`,
  parameters: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export const GRAPH_TRAVERSE_TOOL = {
  name: "graph_traverse",
  description: "Walk the knowledge graph from a fact node. Returns connected facts and their relationships up to N hops. Use when a hot memory breadcrumb shows a connection worth exploring.",
  parameters: {
    type: "object" as const,
    properties: {
      fact_id: { type: "string", description: "Starting fact ID (visible in hot memory breadcrumbs)" },
      depth: { type: "number", description: "Hops to traverse (default 2, max 4)" },
      direction: { type: "string", enum: ["outgoing", "incoming", "both"], description: "Edge direction to follow (default: both)" },
    },
    required: ["fact_id"],
  },
};

/** All Hippocampus tools */
export const HIPPOCAMPUS_TOOLS = [FETCH_CHAT_HISTORY_TOOL, MEMORY_QUERY_TOOL, GRAPH_TRAVERSE_TOOL];

/** Library tools — sync retrieval + async ingestion */
export const LIBRARY_TOOLS = [LIBRARY_INGEST_TOOL, LIBRARY_GET_TOOL, LIBRARY_SEARCH_TOOL, LIBRARY_STATS_TOOL];

/** Core Cortex tools (always available alongside sessions_spawn) */
export const CORTEX_TOOLS = [GET_TASK_STATUS_TOOL, CODE_SEARCH_TOOL];

export const READ_FILE_TOOL = {
  name: "read_file",
  description: `Read the contents of a local file by path. Use for workspace documents, \
architecture specs, config files, or any file you need to reference. Paths are resolved \
relative to the workspace directory. Returns the file contents as text. \
For large files, use offset and limit to read specific line ranges.`,
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "File path (relative to workspace, or absolute)",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-indexed, optional)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read (optional, default 500, max 1000)",
      },
    },
    required: ["path"],
  },
};

export const WRITE_FILE_TOOL = {
  name: "write_file",
  description: `Write content to a local file. Creates parent directories if needed. \
Overwrites existing files by default. Use append mode to add to existing files. \
Paths are resolved relative to the workspace directory.`,
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "File path (relative to workspace, or absolute)",
      },
      content: {
        type: "string",
        description: "Content to write",
      },
      append: {
        type: "boolean",
        description: "Append to file instead of overwriting (optional, default false)",
      },
    },
    required: ["path", "content"],
  },
};

export const MOVE_FILE_TOOL = {
  name: "move_file",
  description: `Move or rename a local file. Creates destination directories if needed. \
Paths are resolved relative to the workspace directory. \
Use for pipeline task transitions and file organization.`,
  parameters: {
    type: "object" as const,
    properties: {
      from: {
        type: "string",
        description: "Source file path",
      },
      to: {
        type: "string",
        description: "Destination file path",
      },
    },
    required: ["from", "to"],
  },
};

export const DELETE_FILE_TOOL = {
  name: "delete_file",
  description: `Delete a local file. Paths are resolved relative to the workspace directory. \
Files only — refuses to delete directories. Use with care — deletions are permanent.`,
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "File path to delete",
      },
    },
    required: ["path"],
  },
};

export const PIPELINE_STATUS_TOOL = {
  name: "pipeline_status",
  description: `Get the current state of the development pipeline. Returns task counts per stage \
and task summaries. Use when asked about pipeline status, active work, or task progress. \
Use read_file to drill into specific tasks.`,
  parameters: {
    type: "object" as const,
    properties: {
      folder: {
        type: "string",
        description: "Filter to a specific stage: Cooking, ToDo, InProgress, InReview, Done, Canceled (optional — omit for full overview)",
      },
    },
    required: [] as string[],
  },
};

export const PIPELINE_TRANSITION_TOOL = {
  name: "pipeline_transition",
  description: `Move a pipeline task to a new stage. Enforces the state machine: \
Cooking → InProgress → InReview → Done. Cannot skip stages. \
Use this instead of move_file for all pipeline transitions. \
Automatically updates SPEC.md frontmatter (status, moved_at).`,
  parameters: {
    type: "object" as const,
    properties: {
      task: {
        type: "string",
        description: "Task ID or folder name (e.g. '011' or '011-cortex-loop-silence-bugs')",
      },
      to: {
        type: "string",
        enum: ["InProgress", "InReview", "Done", "Canceled"],
        description: "Target stage",
      },
    },
    required: ["task", "to"],
  },
};

export const CORTEX_CONFIG_TOOL = {
  name: "cortex_config",
  description: `Read or modify Cortex's own configuration. Use to check current channel modes \
or to switch channels on/off. Example: to hand off WhatsApp to the main agent, call \
cortex_config({ action: 'set_channel', channel: 'whatsapp', mode: 'off' }).`,
  parameters: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["read", "set_channel"],
        description: "'read' returns the full config. 'set_channel' changes a channel mode.",
      },
      channel: {
        type: "string",
        description: "Channel name for set_channel (e.g. 'whatsapp', 'webchat')",
      },
      mode: {
        type: "string",
        enum: ["off", "live", "shadow"],
        description: "New mode for the channel",
      },
    },
    required: ["action"],
  },
};

/** Tool names that are handled synchronously (round-trip within same turn) */
export const SYNC_TOOL_NAMES = new Set(["fetch_chat_history", "memory_query", "graph_traverse", "get_task_status", "code_search", "library_get", "library_search", "library_stats", "read_file", "write_file", "move_file", "delete_file", "pipeline_status", "pipeline_transition", "cortex_config"]);

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

    // Fix 4: Append path hint so Cortex knows paths are relative to install root
    return output.trim() + "\n\nNote: Paths above are relative to the OpenClaw install root, not the agent workspace. Use code snippets directly or resolve with the install path.";
  } catch (err) {
    return JSON.stringify({
      error: `Code search failed: ${err instanceof Error ? err.message : String(err)}`,
      available: true,
    });
  }
}

/** Execute memory_query — vector search against graph + cold storage, merged + deduped */
export async function executeMemoryQuery(
  db: DatabaseSync,
  args: { query: string; limit?: number },
  embedFn: EmbedFunction = embedViaOllama,
): Promise<string> {
  const limit = args.limit ?? 5;

  // Embed the query
  const queryEmbedding = await embedFn(args.query);

  // Search both sources
  const coldResults = searchColdFacts(db, queryEmbedding, limit);
  const graphResults = searchGraphFacts(db, queryEmbedding, limit);

  // Build a unified result list, deduping by fact text (prefer graph version)
  interface MergedFact {
    text: string;
    distance: number;
    source: "graph" | "cold";
    factId?: string;
    edges?: Array<{ type: string; target: string }>;
    archivedAt?: string;
  }

  const seen = new Set<string>();
  const merged: MergedFact[] = [];

  // Add graph results first (preferred for dedup)
  for (const gf of graphResults) {
    const key = gf.factText.trim();
    if (seen.has(key)) continue;
    seen.add(key);

    // Fetch edges for this graph fact
    const rawEdges = queryEdgesForFact(db, gf.id, 5);
    const edges = rawEdges.map((e) => ({
      type: e.edgeType,
      target: e.targetHint,
    }));

    merged.push({
      text: gf.factText,
      distance: gf.distance,
      source: "graph",
      factId: gf.id,
      edges: edges.length > 0 ? edges : undefined,
    });
  }

  // Add cold results (skip duplicates already seen from graph)
  for (const cf of coldResults) {
    const key = cf.factText.trim();
    if (seen.has(key)) continue;
    seen.add(key);

    merged.push({
      text: cf.factText,
      distance: cf.distance,
      source: "cold",
      archivedAt: cf.archivedAt,
    });
  }

  // Sort by distance (best match first) and trim to limit
  merged.sort((a, b) => a.distance - b.distance);
  const finalResults = merged.slice(0, limit);

  // --- Side effects: revive evicted, touch active, promote to hot ---

  for (const fact of finalResults) {
    if (fact.source === "graph") {
      // Touch active graph fact
      touchGraphFact(db, fact.factId!);
    } else {
      // Check if cold fact matches an evicted graph fact — revive it
      const evictedMatch = db.prepare(
        `SELECT id FROM hippocampus_facts WHERE fact_text = ? AND status = 'evicted'`,
      ).get(fact.text) as { id: string } | undefined;

      if (evictedMatch) {
        reviveFact(db, evictedMatch.id);
      }

      // Also touch if it matches an active graph fact
      const activeMatch = db.prepare(
        `SELECT id FROM hippocampus_facts WHERE fact_text = ? AND status = 'active'`,
      ).get(fact.text) as { id: string } | undefined;

      if (activeMatch) {
        touchGraphFact(db, activeMatch.id);
      }
    }

    // Tracking hook: retrieved facts stay hot
    const existing = db.prepare(
      `SELECT id FROM cortex_hot_memory WHERE fact_text = ?`,
    ).get(fact.text) as { id: string } | undefined;

    if (existing) {
      touchHotFact(db, existing.id);
    } else {
      insertHotFact(db, { factText: fact.text });
    }
  }

  if (finalResults.length === 0) {
    return JSON.stringify({ facts: [], message: "No matching facts found." });
  }

  return JSON.stringify({ facts: finalResults });
}

/** Execute read_file — read local file contents synchronously */
export function executeReadFile(
  args: { path: string; offset?: number; limit?: number },
  workspaceDir: string,
): string {
  const MAX_LINES = 1000;
  const DEFAULT_LINES = 500;
  const MAX_BYTES = 100_000; // 100KB cap

  // Resolve path: relative paths resolve against workspace
  let filePath = args.path;
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(workspaceDir, filePath);
  }

  // Security: block reads outside the project directory
  const projectRoot = path.resolve(workspaceDir, "..");
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(projectRoot)) {
    return `Error: path "${args.path}" is outside the project directory.`;
  }

  // Check existence
  if (!fs.existsSync(resolved)) {
    return `Error: file not found: ${args.path}`;
  }

  // Check size
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    // Return directory listing instead
    const entries = fs.readdirSync(resolved);
    return `Directory: ${args.path}\n${entries.join("\n")}`;
  }
  if (stat.size > MAX_BYTES * 5) {
    return `Error: file too large (${(stat.size / 1024).toFixed(0)}KB). Use offset/limit to read in chunks.`;
  }

  // Read file
  const content = fs.readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  // Apply offset/limit
  const offset = Math.max(1, args.offset ?? 1);
  const limit = Math.min(args.limit ?? DEFAULT_LINES, MAX_LINES);
  const startIdx = offset - 1; // 0-indexed
  const slice = lines.slice(startIdx, startIdx + limit);

  // Truncate if content exceeds byte cap
  let result = slice.join("\n");
  if (result.length > MAX_BYTES) {
    result = result.substring(0, MAX_BYTES) + "\n\n[TRUNCATED — content exceeds 100KB]";
  }

  // Header with metadata
  const header = `File: ${args.path} (${totalLines} lines, ${(stat.size / 1024).toFixed(1)}KB)`;
  const endLine = offset + slice.length - 1;
  if (slice.length < totalLines) {
    const remaining = totalLines - endLine;
    let paginationHint = "";
    if (remaining > 0) {
      paginationHint = `\n\n[${remaining} more lines. Use offset=${endLine + 1} to continue reading.]`;
    }
    return `${header}\nShowing lines ${offset}-${endLine} of ${totalLines}:\n\n${result}${paginationHint}`;
  }
  return `${header}\n\n${result}`;
}

/** Execute write_file — write or append to a local file */
export function executeWriteFile(
  args: { path: string; content: string; append?: boolean },
  workspaceDir: string,
): string {
  // Resolve path: relative paths resolve against workspace
  let filePath = args.path;
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(workspaceDir, filePath);
  }

  // Security: block writes outside the project directory
  const projectRoot = path.resolve(workspaceDir, "..");
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(projectRoot)) {
    return `Error: path "${args.path}" is outside the project directory.`;
  }

  // Create parent directories if needed
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write or append
  if (args.append) {
    fs.appendFileSync(resolved, args.content, "utf-8");
    return `Appended to: ${args.path} (${args.content.length} chars)`;
  } else {
    fs.writeFileSync(resolved, args.content, "utf-8");
    return `Wrote: ${args.path} (${args.content.length} chars)`;
  }
}

/** Execute move_file — move or rename a local file */
export function executeMoveFile(
  args: { from: string; to: string },
  workspaceDir: string,
): string {
  // Resolve both paths
  let fromPath = args.from;
  let toPath = args.to;
  if (!path.isAbsolute(fromPath)) {
    fromPath = path.join(workspaceDir, fromPath);
  }
  if (!path.isAbsolute(toPath)) {
    toPath = path.join(workspaceDir, toPath);
  }

  // Security: both paths must be inside project root
  const projectRoot = path.resolve(workspaceDir, "..");
  const resolvedFrom = path.resolve(fromPath);
  const resolvedTo = path.resolve(toPath);
  if (!resolvedFrom.startsWith(projectRoot)) {
    return `Error: source path "${args.from}" is outside the project directory.`;
  }
  if (!resolvedTo.startsWith(projectRoot)) {
    return `Error: destination path "${args.to}" is outside the project directory.`;
  }

  // Source must exist and be a file
  if (!fs.existsSync(resolvedFrom)) {
    return `Error: source not found: ${args.from}`;
  }
  const stat = fs.statSync(resolvedFrom);
  if (stat.isDirectory()) {
    return `Error: source is a directory, not a file: ${args.from}`;
  }

  // Create destination parent dirs
  const destDir = path.dirname(resolvedTo);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Move
  fs.renameSync(resolvedFrom, resolvedTo);
  return `Moved: ${args.from} → ${args.to}`;
}

/** Execute delete_file — delete a local file */
export function executeDeleteFile(
  args: { path: string },
  workspaceDir: string,
): string {
  // Resolve path
  let filePath = args.path;
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(workspaceDir, filePath);
  }

  // Security: block deletes outside project root
  const projectRoot = path.resolve(workspaceDir, "..");
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(projectRoot)) {
    return `Error: path "${args.path}" is outside the project directory.`;
  }

  // Must exist
  if (!fs.existsSync(resolved)) {
    return `Error: file not found: ${args.path}`;
  }

  // Must be a file, not directory
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return `Error: "${args.path}" is a directory. Only files can be deleted.`;
  }

  // Delete
  fs.unlinkSync(resolved);
  return `Deleted: ${args.path}`;
}

/** Parse YAML frontmatter between --- markers. Returns key-value pairs. */
function parseYamlFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return result;
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/** Execute pipeline_status — scan pipeline folder structure and return summary */
export function executePipelineStatus(
  args: { folder?: string },
  workspaceDir: string,
): string {
  const STAGES = ["Cooking", "ToDo", "InProgress", "InReview", "Done", "Canceled"];
  const pipelineRoot = path.join(workspaceDir, "pipeline");

  if (!fs.existsSync(pipelineRoot)) {
    return "📋 Pipeline Status\n\nPipeline directory not found.";
  }

  const stagesToScan = args.folder
    ? STAGES.filter((s) => s.toLowerCase() === args.folder!.toLowerCase())
    : STAGES;

  if (args.folder && stagesToScan.length === 0) {
    return `Error: unknown stage "${args.folder}". Valid stages: ${STAGES.join(", ")}`;
  }

  const isFiltered = !!args.folder;
  const sections: string[] = ["📋 Pipeline Status", ""];

  for (const stage of STAGES) {
    const stageDir = path.join(pipelineRoot, stage);
    if (!fs.existsSync(stageDir)) {
      if (stagesToScan.includes(stage)) {
        sections.push(`${stage} (0)`);
      }
      continue;
    }

    // List subdirectories (task folders), skip files like README.md
    let entries: string[];
    try {
      entries = fs.readdirSync(stageDir).filter((entry) => {
        const entryPath = path.join(stageDir, entry);
        try {
          return fs.statSync(entryPath).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      if (stagesToScan.includes(stage)) {
        sections.push(`${stage} (0)`);
      }
      continue;
    }

    if (!stagesToScan.includes(stage)) {
      // Show count-only line for non-filtered stages
      sections.push(`${stage} (${entries.length})`);
      continue;
    }

    sections.push(`${stage} (${entries.length}):`);

    for (const taskFolder of entries.sort()) {
      const specPath = path.join(stageDir, taskFolder, "SPEC.md");
      let meta: Record<string, string> = {};
      if (fs.existsSync(specPath)) {
        try {
          const specContent = fs.readFileSync(specPath, "utf-8");
          meta = parseYamlFrontmatter(specContent);
        } catch { /* best-effort */ }
      }

      const id = meta.id || taskFolder.split("-")[0] || "?";
      const title = meta.title || taskFolder;
      const priority = meta.priority ? ` [${meta.priority}]` : "";
      const movedAt = meta.moved_at ? `, ${meta.moved_at}` : "";

      if (isFiltered) {
        // Detailed view when filtered to a single stage
        const executor = meta.executor ? `executor=${meta.executor}` : "";
        const branch = meta.branch ? `branch=${meta.branch}` : "";
        const pr = meta.pr ? `PR=${meta.pr}` : "";
        const details = [executor, branch, pr].filter(Boolean).join(", ");
        const detailStr = details ? ` (${details})` : "";
        sections.push(`  ${id} — ${title}${priority}${detailStr}${movedAt}`);
      } else {
        // Compact view for full overview
        const author = meta.author ? ` (${meta.author}${movedAt})` : movedAt ? ` (${movedAt.slice(2)})` : "";
        sections.push(`  ${id} — ${title}${priority}${author}`);
      }
    }
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Library Tool Executors
// ---------------------------------------------------------------------------

/** Result type for library sync tools — supports compressed shard persistence */
export interface LibraryToolResult {
  content: string;
  /** When set, this is stored in the shard instead of the full content */
  shardContent?: string;
}

/** Execute library_get — retrieve full item details by ID */
export function executeLibraryGet(args: { item_id: number }): LibraryToolResult {
  try {
    const { openLibraryDbReadonly, getItemById, formatItem, formatCompressedReference } = require("../library/retrieval.js");
    const libraryDb = openLibraryDbReadonly();
    if (!libraryDb) {
      return { content: "Library not available." };
    }

    try {
      const item = getItemById(libraryDb, args.item_id);
      if (!item) {
        return { content: `Library item [id:${args.item_id}] not found.` };
      }
      return {
        content: formatItem(item),
        shardContent: formatCompressedReference(item),
      };
    } finally {
      libraryDb.close();
    }
  } catch (err) {
    return { content: `Library get failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Execute library_search — semantic search across the Library */
export async function executeLibrarySearch(
  args: { query: string; limit?: number },
  embedFn: EmbedFunction = embedViaOllama,
): Promise<LibraryToolResult> {
  try {
    const { openLibraryDbReadonly, searchItems, formatSearchResults, formatCompressedSearchRef } = require("../library/retrieval.js");
    const libraryDb = openLibraryDbReadonly();
    if (!libraryDb) {
      return { content: "Library not available." };
    }

    try {
      const queryEmbedding = await embedFn(args.query);
      const limit = Math.min(args.limit ?? 10, 20);
      const results = searchItems(libraryDb, queryEmbedding, limit);
      return {
        content: formatSearchResults(results),
        shardContent: formatCompressedSearchRef(args.query, results.length),
      };
    } finally {
      libraryDb.close();
    }
  } catch (err) {
    return { content: `Library search failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Pipeline Transition Executor
// ---------------------------------------------------------------------------

const PIPELINE_STAGES = ["Cooking", "ToDo", "InProgress", "InReview", "Done", "Canceled"] as const;

/** Valid transitions — state machine enforcement */
const VALID_TRANSITIONS: Record<string, string[]> = {
  Cooking: ["InProgress"],
  ToDo: ["InProgress"],
  InProgress: ["InReview", "Canceled"],
  InReview: ["Done", "InProgress", "Canceled"],
};

/** Execute pipeline_transition — move a task to a new stage with validation */
export function executePipelineTransition(
  args: { task: string; to: string },
  workspaceDir: string,
): string {
  const pipelineRoot = path.join(workspaceDir, "pipeline");
  if (!fs.existsSync(pipelineRoot)) {
    return "Error: pipeline directory not found.";
  }

  // Validate target stage
  const validStages = ["InProgress", "InReview", "Done", "Canceled"];
  if (!validStages.includes(args.to)) {
    return `Error: invalid target stage "${args.to}". Valid: ${validStages.join(", ")}`;
  }

  // Find the task folder by scanning all stages
  let currentStage: string | null = null;
  let taskFolder: string | null = null;

  for (const stage of PIPELINE_STAGES) {
    const stageDir = path.join(pipelineRoot, stage);
    if (!fs.existsSync(stageDir)) continue;

    const entries = fs.readdirSync(stageDir).filter((e) => {
      try { return fs.statSync(path.join(stageDir, e)).isDirectory(); } catch { return false; }
    });

    for (const entry of entries) {
      // Match by task ID prefix (e.g. "011" matches "011-cortex-loop-silence-bugs")
      // or by full folder name
      if (entry === args.task || entry.startsWith(args.task + "-")) {
        currentStage = stage;
        taskFolder = entry;
        break;
      }
    }
    if (currentStage) break;
  }

  if (!currentStage || !taskFolder) {
    return `Error: task "${args.task}" not found in any pipeline stage.`;
  }

  // Check if already in target stage
  if (currentStage === args.to) {
    return `Task "${taskFolder}" is already in ${args.to}.`;
  }

  // Validate transition
  const allowed = VALID_TRANSITIONS[currentStage];
  if (!allowed || !allowed.includes(args.to)) {
    return `Error: invalid transition ${currentStage} → ${args.to}. From ${currentStage}, allowed targets: ${allowed?.join(", ") ?? "none (final state)"}.`;
  }

  // Move the entire folder
  const srcDir = path.join(pipelineRoot, currentStage, taskFolder);
  const destDir = path.join(pipelineRoot, args.to, taskFolder);

  // Create target stage directory if needed
  const targetStageDir = path.join(pipelineRoot, args.to);
  if (!fs.existsSync(targetStageDir)) {
    fs.mkdirSync(targetStageDir, { recursive: true });
  }

  // Copy files recursively (fs.renameSync fails across drives on Windows)
  _copyDirSync(srcDir, destDir);
  _rmDirSync(srcDir);

  // Update SPEC.md frontmatter
  const specPath = path.join(destDir, "SPEC.md");
  if (fs.existsSync(specPath)) {
    let specContent = fs.readFileSync(specPath, "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    const statusMap: Record<string, string> = {
      InProgress: "in_progress",
      InReview: "in_review",
      Done: "done",
      Canceled: "canceled",
    };
    const newStatus = statusMap[args.to] ?? args.to.toLowerCase();

    // Update status field
    specContent = specContent.replace(
      /^(status:\s*)["']?[^"'\n]+["']?/m,
      `$1"${newStatus}"`,
    );
    // Update moved_at field
    specContent = specContent.replace(
      /^(moved_at:\s*)["']?[^"'\n]+["']?/m,
      `$1"${today}"`,
    );

    fs.writeFileSync(specPath, specContent, "utf-8");
  }

  return `✅ Moved "${taskFolder}": ${currentStage} → ${args.to}`;
}

/** Recursively copy a directory */
function _copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      _copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Recursively remove a directory */
function _rmDirSync(dir: string): void {
  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    if (fs.statSync(entryPath).isDirectory()) {
      _rmDirSync(entryPath);
    } else {
      fs.unlinkSync(entryPath);
    }
  }
  fs.rmdirSync(dir);
}

// ---------------------------------------------------------------------------
// Cortex Config Executor
// ---------------------------------------------------------------------------

/** Execute cortex_config — read or modify Cortex's own config */
export function executeCortexConfig(
  args: { action: string; channel?: string; mode?: string },
): string {
  try {
    const { resolveStateDir } = require("../config/paths.js");
    const stateDir = resolveStateDir(process.env);
    const configPath = path.join(stateDir, "cortex", "config.json");

    if (!fs.existsSync(configPath)) {
      return "Error: cortex config not found.";
    }

    if (args.action === "read") {
      const content = fs.readFileSync(configPath, "utf-8");
      return `Cortex config (${configPath}):\n${content}`;
    }

    if (args.action === "set_channel") {
      if (!args.channel) return "Error: channel is required for set_channel.";
      if (!args.mode) return "Error: mode is required for set_channel.";

      const validModes = ["off", "live", "shadow"];
      if (!validModes.includes(args.mode)) {
        return `Error: invalid mode "${args.mode}". Valid: ${validModes.join(", ")}`;
      }

      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (!config.channels) config.channels = {};
      const oldMode = config.channels[args.channel] ?? "unset";
      config.channels[args.channel] = args.mode;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 4), "utf-8");

      return `✅ Cortex channel "${args.channel}": ${oldMode} → ${args.mode}`;
    }

    return `Error: unknown action "${args.action}". Valid: read, set_channel.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Execute library_stats — return Library health statistics */
export function executeLibraryStats(): string {
  try {
    const { openLibraryDbReadonly } = require("../library/retrieval.js");
    const libraryDb = openLibraryDbReadonly();
    if (!libraryDb) {
      return "Library not initialized (no items ingested yet).";
    }

    try {
      const total = libraryDb.prepare("SELECT COUNT(*) as c FROM items").get() as { c: number };
      const byStatus = libraryDb.prepare(
        "SELECT status, COUNT(*) as c FROM items GROUP BY status ORDER BY c DESC",
      ).all() as { status: string; c: number }[];
      const recent = libraryDb.prepare(
        "SELECT id, title, tags, ingested_at FROM items WHERE status = 'active' ORDER BY ingested_at DESC LIMIT 5",
      ).all() as { id: number; title: string; tags: string; ingested_at: string }[];

      // Embedding health: try sqlite-vec virtual table, gracefully degrade
      let embeddingCount = 0;
      let embeddingHealthLine = "";
      try {
        const row = libraryDb.prepare("SELECT COUNT(*) as c FROM item_embeddings").get() as { c: number };
        embeddingCount = row.c;
        const activeCount = byStatus.find((s) => s.status === "active")?.c ?? total.c;
        const pct = activeCount > 0 ? Math.round((embeddingCount / activeCount) * 100) : 0;
        const missing = activeCount - embeddingCount;
        if (pct < 80) {
          embeddingHealthLine = `Embedding health: ${embeddingCount}/${activeCount} ⚠️ (${missing} items invisible to search)`;
        } else {
          embeddingHealthLine = `Embedding health: ${embeddingCount}/${activeCount} ✅`;
        }
      } catch {
        embeddingHealthLine = "Embedding health: unavailable (sqlite-vec not loaded)";
      }

      // Weekly trend: group items by ISO week from ingested_at (last 3 weeks)
      const weeklyTrendParts: string[] = [];
      try {
        const now = new Date();
        for (let w = 0; w < 3; w++) {
          const weekStart = new Date(now);
          weekStart.setDate(now.getDate() - now.getDay() + 1 - (w * 7)); // Monday of week
          weekStart.setHours(0, 0, 0, 0);
          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekStart.getDate() + 7);
          const row = libraryDb.prepare(
            "SELECT COUNT(*) as c FROM items WHERE ingested_at >= ? AND ingested_at < ? AND status = 'active'",
          ).get(weekStart.toISOString(), weekEnd.toISOString()) as { c: number };
          const label = w === 0 ? "This week" : w === 1 ? "Last week" : "2 weeks ago";
          weeklyTrendParts.push(`${label}: ${row.c}`);
        }
      } catch { /* best-effort */ }

      // Tag frequency
      const allTags = libraryDb.prepare(
        "SELECT tags FROM items WHERE status = 'active'",
      ).all() as { tags: string }[];
      const tagCounts = new Map<string, number>();
      for (const row of allTags) {
        try {
          const tags = JSON.parse(row.tags) as string[];
          for (const tag of tags) {
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        } catch { /* skip malformed */ }
      }
      const topTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([tag, count]) => `${tag} (${count})`);

      // Domain coverage: cluster tags into high-level categories
      const domainMap: Record<string, string[]> = {
        "AI/Agents": ["ai", "agents", "llm", "machine-learning", "ml", "ai-agents", "nlp", "embeddings", "rag", "prompt-engineering"],
        "Security": ["security", "auth", "authentication", "authorization", "encryption", "oauth", "vulnerabilities"],
        "Infrastructure": ["infrastructure", "devops", "cloud", "kubernetes", "docker", "ci-cd", "monitoring", "deployment"],
        "Frontend": ["frontend", "react", "vue", "angular", "css", "ui", "ux", "web"],
        "Backend": ["backend", "api", "database", "sql", "rest", "graphql", "microservices"],
      };

      const domainCounts = new Map<string, number>();
      let categorizedTotal = 0;
      for (const [domain, keywords] of Object.entries(domainMap)) {
        let count = 0;
        for (const [tag, tagCount] of tagCounts) {
          if (keywords.some((kw) => tag.toLowerCase().includes(kw))) {
            count += tagCount;
          }
        }
        if (count > 0) {
          domainCounts.set(domain, count);
          categorizedTotal += count;
        }
      }
      // "Other" = items with tags that didn't match any domain
      const totalTagged = [...tagCounts.values()].reduce((a, b) => a + b, 0);
      const otherCount = totalTagged - categorizedTotal;
      if (otherCount > 0) {
        domainCounts.set("Other", otherCount);
      }

      const domainLines = [...domainCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([domain, count]) => `  ${domain}: ${count} items`);

      const lines = [
        `📚 Library Statistics`,
        `Total items: ${total.c} (${byStatus.map((s) => `${s.status}: ${s.c}`).join(", ")})`,
        embeddingHealthLine,
        weeklyTrendParts.length > 0 ? weeklyTrendParts.join(" | ") : "",
        ``,
        `Recent ingestions:`,
        ...recent.map((r) => {
          let tags: string[];
          try { tags = JSON.parse(r.tags); } catch { tags = []; }
          return `  [id:${r.id}] "${r.title}" — ${tags.slice(0, 3).join(", ")} (${r.ingested_at.slice(0, 10)})`;
        }),
        ``,
        `Top tags: ${topTags.join(", ")}`,
        ``,
        ...(domainLines.length > 0 ? [`Domain coverage:`, ...domainLines] : []),
      ].filter((line) => line !== undefined);

      return lines.join("\n");
    } finally {
      libraryDb.close();
    }
  } catch (err) {
    return `Library stats failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
