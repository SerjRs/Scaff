/**
 * Cortex Processing Loop
 *
 * The main Cortex loop: dequeue → context → LLM → output → checkpoint.
 * Strict serialization — one message at a time.
 *
 * @see docs/cortex-architecture.md §4.3
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  dequeueNext,
  markProcessing,
  markCompleted,
  markFailed,
  checkpoint,
} from "./bus.js";
import type { AdapterRegistry } from "./channel-adapter.js";
import { assembleContext, type AssembledContext, type ToolResultEntry } from "./context.js";
import type { CortexLLMResult } from "./llm-caller.js";
import { routeOutput, parseResponse, isSilentResponse } from "./output.js";
import crypto from "node:crypto";
import { appendToSession, appendResponse, appendToolCall, appendStructuredContent, appendTaskResult, updateChannelState, getChannelStates, storeDispatch, getDispatch } from "./session.js";
import { SYNC_TOOL_NAMES, executeFetchChatHistory, executeMemoryQuery, executeGetTaskStatus, executeCodeSearch, executeReadFile, executeWriteFile, executeMoveFile, executeDeleteFile, executePipelineStatus, executePipelineTransition, executeCortexConfig, executeLibraryGet, executeLibrarySearch, executeLibraryStats, type EmbedFunction, type LibraryToolResult } from "./tools.js";
import { traverseGraph } from "./hippocampus.js";
import {
  assignMessageWithBoundaryDetection,
  assignMessageToShard,
  getActiveShard,
  getShardMessages,
  detectTopicShift,
  applyTopicShift,
  labelShardAsync,
  type ForegroundConfig,
  type ShardLLMFunction,
} from "./shards.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resource resolved and ready for inclusion in the executor's task message */
export interface ResolvedResource {
  name: string;
  content: string;
}

/** Parameters passed to the onSpawn callback when Cortex delegates to the Router */
export interface SpawnParams {
  task: string;
  resultPriority: "urgent" | "normal" | "background";
  envelopeId: string;
  /** Pre-generated task ID — Cortex owns the UUID, Router stores it as-is */
  taskId: string;
  /** Resolved file resources to include in the executor's task message */
  resources?: ResolvedResource[];
  /** Executor type — "coding" routes to coding_run template (Claude Code). Default: agent_run. */
  executor?: "coding";
  /** Channel to route the task result back to (e.g. "webchat", "telegram"). */
  replyChannel?: string;
}

export interface CortexLoopOptions {
  db: DatabaseSync;
  registry: AdapterRegistry;
  workspaceDir: string;
  maxContextTokens: number;
  pollIntervalMs: number;
  /** Enable Hippocampus memory subsystem (hot memory injection, soft caps, idle cutoff) */
  hippocampusEnabled?: boolean;
  /** Embedding function for memory_query tool (default: Ollama nomic-embed-text) */
  embedFn?: EmbedFunction;
  /** Foreground sharding config — when set, messages get shard_id on arrival */
  foregroundConfig?: ForegroundConfig;
  /** Cognitive owner — filters foreground by issuer instead of channel */
  issuer?: string;
  callLLM: (context: AssembledContext) => Promise<CortexLLMResult>;
  onError: (error: Error) => void;
  /** Called after every message completes (including silent/NO_REPLY) */
  onMessageComplete?: (envelopeId: string, replyContext: import("./types.js").ReplyContext | undefined, silent: boolean) => void;
  /** Called when the LLM calls sessions_spawn. Returns job ID or null on failure. */
  onSpawn?: (params: SpawnParams) => string | null;
  /** LLM function for shard operations (topic labeling, semantic detection). Uses Haiku. */
  shardLLMFn?: ShardLLMFunction;
}

export interface CortexLoop {
  stop(): Promise<void>;
  isRunning(): boolean;
  processedCount(): number;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export function startLoop(opts: CortexLoopOptions): CortexLoop {
  const { db, registry, workspaceDir, maxContextTokens, pollIntervalMs, hippocampusEnabled, embedFn, foregroundConfig, issuer, callLLM, onError, onMessageComplete, onSpawn, shardLLMFn } = opts;

  // Semantic check counter — tracks messages per channel since last Tier 2 check
  const semanticCheckCounters = new Map<string, number>();

  // Circuit breaker: track consecutive tool_use/tool_result 400 errors.
  // After 3 consecutive failures with the same error pattern, stop retrying
  // to prevent infinite API call burn on corrupted sessions.
  // @see workspace/docs/working/03_cortex-session-corruption.md
  let consecutiveToolPairingErrors = 0;

  let running = true;
  let processed = 0;
  let currentPromise: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (!running) return;

    try {
      const msg = dequeueNext(db);
      if (!msg) {
        // Nothing to process — schedule next tick
        if (running) {
          timer = setTimeout(() => { void tick(); }, pollIntervalMs);
        }
        return;
      }

      // 1. Mark as processing
      markProcessing(db, msg.envelope.id);

      // Detect ops triggers — lightweight wake-up envelopes that carry no content.
      // They must NOT be stored in cortex_session (they are not conversation messages).
      const isOpsTrigger = msg.envelope.metadata?.ops_trigger === true;

      // 2. Append to unified session
      let appendedContent: string;
      if (isOpsTrigger) {
        // Ops triggers carry the task result inline (via metadata) so the LLM
        // doesn't have to search session history. This eliminates prompt-dependent
        // silence failures. The full result is also persisted by appendTaskResult
        // (called in gateway-bridge before the trigger) for audit/replay.
        const meta = msg.envelope.metadata ?? {};
        const taskId = meta.taskId ?? "unknown";
        const taskDesc = meta.taskDescription ?? "";
        const taskStatus = meta.taskStatus ?? "completed";
        const replyChannel = meta.replyChannel ?? "webchat";
        if (taskStatus === "completed") {
          const result = meta.taskResult ?? "(no result)";
          appendedContent = `[Task completed] Task=${taskId}, Request='${taskDesc}', Channel=${replyChannel}\n\nResult:\n${result}\n\nDeliver this result to the user on the ${replyChannel} channel. Summarize key findings clearly.`;
        } else {
          const error = meta.taskError ?? "Unknown error";
          appendedContent = `[Task failed] Task=${taskId}, Request='${taskDesc}', Channel=${replyChannel}, Error: ${error}\n\nInform the user that the task failed and explain the error.`;
        }
        appendToSession(db, {
          ...msg.envelope,
          content: appendedContent,
          sender: { id: "cortex:ops", name: "System", relationship: "system" as const },
        }, issuer);
      } else {
        appendedContent = msg.envelope.content;
        appendToSession(db, msg.envelope, issuer);
      }

      // 2b. Inline shard assignment (foreground sharding)
      // Hoisted so assistant responses can be assigned to the same shard.
      // Ops-trigger messages MUST be assigned to a shard — they are conversation
      // messages that the user sees. Without shard assignment, they fall into a gap
      // between the old and new shards and become invisible to Cortex on the next turn.
      // @see docs/working/05_cortex-ops-trigger-shard-gap.md (Bug 1)
      let assignedShardId: string | null = null;
      if (foregroundConfig) {
        // For ops triggers, use the reply channel (e.g. "webchat") not the trigger
        // channel ("router") — the shard belongs to the user-facing conversation.
        const shardChannel = isOpsTrigger
          ? (msg.envelope.metadata?.replyChannel as string ?? msg.envelope.channel)
          : msg.envelope.channel;

        const lastId = db.prepare(`SELECT last_insert_rowid() as id`).get() as { id: number | bigint };
        const messageId = Number(lastId.id);
        assignedShardId = assignMessageWithBoundaryDetection(
          db, messageId, shardChannel, appendedContent,
          msg.envelope.timestamp, foregroundConfig, issuer,
        );

        if (isOpsTrigger) {
          // Retroactively assign the appendTaskResult row (written by gateway-bridge
          // before the trigger) to the same shard. That row was stored with shard_id=NULL
          // because gateway-bridge doesn't know which shard is active.
          // The taskId is used as envelope_id in appendTaskResult.
          const taskId = msg.envelope.metadata?.taskId as string | undefined;
          if (taskId) {
            const taskRow = db.prepare(
              `SELECT id FROM cortex_session WHERE envelope_id = ? AND sender_id = 'cortex:ops' AND shard_id IS NULL ORDER BY id DESC LIMIT 1`,
            ).get(taskId) as { id: number } | undefined;
            if (taskRow) {
              assignMessageToShard(db, taskRow.id, assignedShardId);
              // Also update the shard's running counts for this message
              const taskContent = db.prepare(`SELECT content FROM cortex_session WHERE id = ?`).get(taskRow.id) as { content: string } | undefined;
              if (taskContent) {
                const taskTokens = Math.ceil(taskContent.content.length / 4);
                db.prepare(`UPDATE cortex_shards SET last_message_id = MAX(last_message_id, ?), token_count = token_count + ?, message_count = message_count + 1 WHERE id = ?`)
                  .run(taskRow.id, taskTokens, assignedShardId);
              }
            }
          }
        }

        // 2c. Tier 2: Semantic boundary detection (sliding window)
        // Fire async every semanticCheckInterval messages — does not block the loop
        // Counter keyed by issuer (cross-channel) when available, otherwise by channel
        if (shardLLMFn) {
          const counterKey = issuer ?? msg.envelope.channel;
          const count = (semanticCheckCounters.get(counterKey) ?? 0) + 1;
          semanticCheckCounters.set(counterKey, count);

          // Check if the shard was just closed by Tier 1 heuristics
          const shardFilter = issuer ? { issuer } : msg.envelope.channel;
          const currentActive = getActiveShard(db, shardFilter);
          const shardWasClosed = !currentActive || currentActive.id !== assignedShardId;

          if (shardWasClosed) {
            // Tier 1 closed a shard — fire async labeling
            semanticCheckCounters.set(counterKey, 0);
            void labelShardAsync(db, assignedShardId, shardLLMFn).catch((err) => {
              onError(new Error(`[cortex] Shard labeling failed: ${err instanceof Error ? err.message : String(err)}`));
            });
          } else if (count >= foregroundConfig.semanticCheckInterval) {
            // Sliding window interval reached — fire semantic check
            semanticCheckCounters.set(counterKey, 0);
            const shardMsgs = getShardMessages(db, assignedShardId);
            if (shardMsgs.length >= 3) {
              void detectTopicShift(shardMsgs, shardLLMFn).then((result) => {
                if (result.shifted && result.splitAtId != null && result.oldTopic && result.newTopic) {
                  applyTopicShift(db, msg.envelope.channel, assignedShardId!, result.splitAtId, result.oldTopic, result.newTopic, issuer);
                }
              }).catch((err) => {
                onError(new Error(`[cortex] Semantic detection failed: ${err instanceof Error ? err.message : String(err)}`));
              });
            }
          }
        }
      }

      // 3. Update channel state to foreground (skip for ops triggers)
      if (!isOpsTrigger) {
        updateChannelState(db, msg.envelope.channel, {
          lastMessageAt: msg.envelope.timestamp,
          layer: "foreground",
        });
      }

      // Circuit breaker check — skip processing if we've hit too many consecutive
      // tool_use/tool_result errors (session is likely corrupted)
      if (consecutiveToolPairingErrors >= 3) {
        onError(new Error(
          `[cortex] CIRCUIT BREAKER: ${consecutiveToolPairingErrors} consecutive tool pairing errors. ` +
          `Session likely corrupted. Manual DB cleanup required.`,
        ));
        markFailed(db, msg.envelope.id, "Circuit breaker: session corrupted");
        onMessageComplete?.(msg.envelope.id, msg.envelope.replyContext, true);
        if (running) {
          timer = setTimeout(() => { void tick(); }, 0);
        }
        return;
      }

      try {
        // 4. Assemble context
        let context = await assembleContext({
          db,
          triggerEnvelope: msg.envelope,
          workspaceDir,
          maxTokens: maxContextTokens,
          hippocampusEnabled,
          foregroundConfig,
          issuer,
        });

        // For ops triggers: suppress sessions_spawn tool to prevent re-dispatch.
        // The LLM should ONLY relay completed results, not dispatch new work.
        if (isOpsTrigger) {
          context = { ...context, isOpsTrigger: true };
        }

        // 5. Call LLM (with sync tool round-trip loop)
        const MAX_TOOL_ROUNDS = 5;
        let llmResult = await callLLM(context);

        // Capture async tool calls from the ORIGINAL response before sync re-call loop.
        // After sync tools are processed, llmResult is overwritten with the re-call result
        // which no longer contains these async calls. Without this, async tools from mixed
        // sync+async responses are silently lost.
        // @see workspace/docs/working/03_cortex-session-corruption.md
        const originalAsyncCalls = llmResult.toolCalls.filter(
          (tc) => !SYNC_TOOL_NAMES.has(tc.name),
        );
        // Also capture the original raw content for async dispatch storage
        const originalRawContent = llmResult._rawContent;

        // Accumulate all tool round-trips so the LLM sees results from ALL rounds,
        // not just the latest. Fixes compressed reference loop where library_get
        // results from round N vanish in round N+2, causing re-fetch loops.
        // @see workspace/docs/working/06_compressed-reference-loop.md
        const allRoundTrips: Array<{ previousContent: unknown[]; toolResults: ToolResultEntry[] }> = [];

        // Fix 3: Sync tool dedup — cache identical calls within a single turn
        // to prevent wasted API calls when the LLM repeats the same tool call.
        const syncToolCache = new Map<string, string>();

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          // Check for sync tool calls
          const syncCalls = llmResult.toolCalls.filter((tc) => SYNC_TOOL_NAMES.has(tc.name));
          if (syncCalls.length === 0) break;

          // Store the assistant's raw response (with tool_use blocks) as structured content
          if (llmResult._rawContent && llmResult._rawContent.length > 0) {
            appendStructuredContent(db, msg.envelope.id, "assistant", msg.envelope.channel, llmResult._rawContent, issuer, assignedShardId);
          }

          // Execute sync tools and collect results
          const toolResults: ToolResultEntry[] = [];
          for (const tc of syncCalls) {
            let result: string;

            // Fix 3: Check dedup cache before executing
            const dedupKey = crypto.createHash("sha256")
              .update(tc.name + JSON.stringify(tc.arguments))
              .digest("hex");
            const cachedResult = syncToolCache.get(dedupKey);
            if (cachedResult !== undefined) {
              result = cachedResult + "\n[Cached — identical call already executed this turn]";
              appendStructuredContent(db, msg.envelope.id, "user", "internal",
                [{ type: "tool_result", tool_use_id: tc.id, content: result }], issuer, assignedShardId);
              toolResults.push({ toolCallId: tc.id, toolName: tc.name, content: result });
              continue;
            }

            try {
              if (tc.name === "fetch_chat_history") {
                const args = tc.arguments as Record<string, unknown>;
                result = executeFetchChatHistory(db, args as any);
              } else if (tc.name === "memory_query") {
                const args = tc.arguments as Record<string, unknown>;
                result = await executeMemoryQuery(db, args as any, embedFn);
              } else if (tc.name === "get_task_status") {
                const args = tc.arguments as Record<string, unknown>;
                result = executeGetTaskStatus(args as any);
              } else if (tc.name === "code_search") {
                const args = tc.arguments as Record<string, unknown>;
                result = executeCodeSearch(args as any);
              } else if (tc.name === "read_file") {
                const args = tc.arguments as Record<string, unknown>;
                result = executeReadFile(
                  { path: args.path as string, offset: args.offset as number | undefined, limit: args.limit as number | undefined },
                  workspaceDir,
                );
              } else if (tc.name === "write_file") {
                const args = tc.arguments as Record<string, unknown>;
                result = executeWriteFile(
                  { path: args.path as string, content: args.content as string, append: args.append as boolean | undefined },
                  workspaceDir,
                );
              } else if (tc.name === "move_file") {
                const args = tc.arguments as Record<string, unknown>;
                result = executeMoveFile(
                  { from: args.from as string, to: args.to as string },
                  workspaceDir,
                );
              } else if (tc.name === "delete_file") {
                const args = tc.arguments as Record<string, unknown>;
                result = executeDeleteFile(
                  { path: args.path as string },
                  workspaceDir,
                );
              } else if (tc.name === "pipeline_status") {
                const args = tc.arguments as Record<string, unknown>;
                result = executePipelineStatus(
                  { folder: args.folder as string | undefined },
                  workspaceDir,
                );
              } else if (tc.name === "library_get") {
                const args = tc.arguments as Record<string, unknown>;
                const libResult: LibraryToolResult = executeLibraryGet(args as any);
                result = libResult.content;
                // Store compressed reference in shard instead of full content
                if (libResult.shardContent) {
                  appendStructuredContent(db, msg.envelope.id, "user", "internal",
                    [{ type: "tool_result", tool_use_id: tc.id, content: libResult.shardContent }], issuer, assignedShardId);
                  toolResults.push({ toolCallId: tc.id, toolName: tc.name, content: result });
                  continue; // Skip the normal storage below — we stored the compressed version
                }
              } else if (tc.name === "library_search") {
                const args = tc.arguments as Record<string, unknown>;
                const libResult: LibraryToolResult = await executeLibrarySearch(args as any, embedFn);
                result = libResult.content;
                if (libResult.shardContent) {
                  appendStructuredContent(db, msg.envelope.id, "user", "internal",
                    [{ type: "tool_result", tool_use_id: tc.id, content: libResult.shardContent }], issuer, assignedShardId);
                  toolResults.push({ toolCallId: tc.id, toolName: tc.name, content: result });
                  continue;
                }
              } else if (tc.name === "library_stats") {
                result = executeLibraryStats();
              } else if (tc.name === "pipeline_transition") {
                const args = tc.arguments as Record<string, unknown>;
                result = executePipelineTransition(
                  { task: args.task as string, to: args.to as string },
                  workspaceDir,
                );
              } else if (tc.name === "cortex_config") {
                const args = tc.arguments as Record<string, unknown>;
                result = executeCortexConfig({
                  action: args.action as string,
                  channel: args.channel as string | undefined,
                  mode: args.mode as string | undefined,
                });
              } else if (tc.name === "graph_traverse") {
                const args = tc.arguments as Record<string, unknown>;
                result = traverseGraph(
                  db,
                  args.fact_id as string,
                  typeof args.depth === "number" ? Math.min(args.depth, 4) : 2,
                  (args.direction as "outgoing" | "incoming" | "both" | undefined) ?? "both",
                );
              } else {
                result = JSON.stringify({ error: `Unknown sync tool: ${tc.name}` });
              }
            } catch (err) {
              result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
            }
            // Fix 3: Store result in dedup cache
            syncToolCache.set(dedupKey, result);
            // Store tool result as structured content block
            appendStructuredContent(db, msg.envelope.id, "user", "internal",
              [{ type: "tool_result", tool_use_id: tc.id, content: result }], issuer, assignedShardId);
            toolResults.push({ toolCallId: tc.id, toolName: tc.name, content: result });
          }

          // Accumulate this round's data (all prior rounds remain visible to LLM)
          allRoundTrips.push({
            previousContent: llmResult._rawContent ?? [],
            toolResults,
          });

          // Re-call LLM with ALL accumulated tool round-trips
          context = {
            ...context,
            toolRoundTrips: allRoundTrips,
          };
          llmResult = await callLLM(context);
        }

        // Fix 2: Post-sync-loop text guard — if sync tools ran but LLM produced
        // no user-facing text, nudge it once to summarize, then fall back to raw summary.
        if (allRoundTrips.length > 0 && isSilentResponse(llmResult.text)) {
          // Inject system nudge and re-call LLM once
          const nudgeRoundTrip = {
            previousContent: llmResult._rawContent ?? [],
            toolResults: [{
              toolCallId: "__nudge__",
              toolName: "__system__",
              content: "[System: You used tools but produced no response. Summarize your findings for the user.]",
            }],
          };
          context = {
            ...context,
            toolRoundTrips: [...allRoundTrips, nudgeRoundTrip],
          };
          llmResult = await callLLM(context);

          // If nudge still failed, produce a raw tool summary
          if (isSilentResponse(llmResult.text)) {
            const toolNames = allRoundTrips
              .flatMap((rt) => rt.toolResults.map((tr) => tr.toolName))
              .filter((n) => n !== "__system__");
            const uniqueTools = [...new Set(toolNames)];
            llmResult = {
              ...llmResult,
              text: `I used ${uniqueTools.join(", ")} but couldn't produce a summary. Here's what I found:\n\n${
                allRoundTrips.flatMap((rt) => rt.toolResults.map((tr) =>
                  `**${tr.toolName}**: ${tr.content.slice(0, 200)}${tr.content.length > 200 ? "…" : ""}`
                )).join("\n")
              }`,
            };
          }
        }

        const llmResponse = llmResult.text;

        // 5b. Handle async tool calls (sessions_spawn → Router delegation)
        // Skip for ops triggers — the LLM should only relay results, not dispatch.
        // Even if the LLM sneaks a tool call through, we ignore it on trigger turns.
        // IMPORTANT: Use originalAsyncCalls captured before the sync re-call loop,
        // NOT llmResult.toolCalls which is from the stale round-2 re-call.
        const asyncCalls = isOpsTrigger ? [] : originalAsyncCalls.filter((tc) => tc.name === "sessions_spawn" || tc.name === "library_ingest");
        if (asyncCalls.length > 0 && originalRawContent) {
          // Store the original assistant response with tool_use blocks as structured content.
          // Only store if there were NO sync calls (otherwise it was already stored in the sync loop).
          const hadSyncCalls = originalAsyncCalls.length < (originalRawContent as any[]).filter(
            (b: any) => b.type === "toolCall" || b.type === "tool_use",
          ).length;
          if (!hadSyncCalls) {
            appendStructuredContent(db, msg.envelope.id, "assistant", msg.envelope.channel, originalRawContent, issuer, assignedShardId);
          }
        }
        const asyncCallResults: Array<{ id: string; succeeded: boolean }> = [];
        for (const tc of asyncCalls) {
          if (tc.name === "library_ingest") {
            // Library ingestion — fetch URL, build Librarian prompt, spawn via Router
            const url = (tc.arguments as Record<string, unknown>).url as string;
            if (!url) {
              appendStructuredContent(db, msg.envelope.id, "user", "internal",
                [{ type: "tool_result", tool_use_id: tc.id, content: "Error: URL is required." }], issuer, assignedShardId);
              asyncCallResults.push({ id: tc.id, succeeded: false });
              continue;
            }

            // 1. Fetch content upfront so executor doesn't need web access
            let content = "";
            let fetchError = "";
            try {
              const response = await fetch(url, {
                headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenClaw/1.0)" },
                signal: AbortSignal.timeout(30_000),
              });
              if (response.ok) {
                const contentType = response.headers.get("content-type") ?? "";
                const isPdf = contentType.includes("application/pdf") || url.toLowerCase().endsWith(".pdf");

                if (isPdf) {
                  // PDF extraction via pdf-parse
                  try {
                    const pdfBuffer = Buffer.from(await response.arrayBuffer());
                    const os = await import("node:os");
                    const tempPath = path.join(os.tmpdir(), `library-${crypto.randomUUID()}.pdf`);
                    fs.writeFileSync(tempPath, pdfBuffer);
                    try {
                      const { execSync } = await import("node:child_process");
                      content = execSync(`npx -y pdf-parse text "${tempPath}"`, {
                        encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024,
                      });
                    } finally {
                      try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
                    }
                  } catch (pdfErr) {
                    fetchError = `PDF extraction failed: ${pdfErr instanceof Error ? pdfErr.message : String(pdfErr)}`;
                  }
                } else {
                  content = await response.text();
                  // Strip HTML tags for cleaner Librarian input
                  if (contentType.includes("text/html")) {
                    content = content
                      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
                      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
                      .replace(/<[^>]+>/g, " ")
                      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
                      .replace(/\s+/g, " ")
                      .trim();
                  }
                }

                // Truncate to ~50K chars to avoid oversized prompts
                if (content.length > 50_000) {
                  content = content.slice(0, 50_000) + "\n\n[TRUNCATED — content exceeds 50K characters]";
                }
              } else {
                fetchError = `HTTP ${response.status} ${response.statusText}`;
              }
            } catch (err) {
              fetchError = err instanceof Error ? err.message : String(err);
            }

            if (fetchError) {
              // Store failed ingestion in Library DB
              try {
                const { openLibraryDb, insertFailedItem } = await import("../library/db.js");
                const libraryDb = openLibraryDb();
                try { insertFailedItem(libraryDb, url, fetchError); } finally { libraryDb.close(); }
              } catch { /* best-effort */ }
              appendStructuredContent(db, msg.envelope.id, "user", "internal",
                [{ type: "tool_result", tool_use_id: tc.id,
                   content: `Library ingestion failed for ${url}: ${fetchError}. URL tracked for retry.` }], issuer, assignedShardId);
              asyncCallResults.push({ id: tc.id, succeeded: false });
              continue;
            }

            // 2. Build Librarian prompt with pre-fetched content
            const { buildLibrarianPrompt } = await import("../library/librarian-prompt.js");
            const librarianPrompt = buildLibrarianPrompt(url, content);

            // 3. Spawn via Router
            const taskId = crypto.randomUUID();

            // Record dispatch context — stays in Cortex, never enters the pipeline
            const { channel: _, ...channelAttrs } = msg.envelope.replyContext ?? { channel: msg.envelope.channel };
            storeDispatch(db, {
              taskId,
              channel: msg.envelope.channel,
              channelContext: channelAttrs,
              counterpartId: msg.envelope.sender?.id,
              counterpartName: msg.envelope.sender?.name,
              shardId: assignedShardId,
              taskSummary: librarianPrompt.slice(0, 200),
              priority: "normal",
              executor: null,
              issuer,
            });

            const jobId = onSpawn?.({
              task: librarianPrompt,
              resultPriority: "normal",
              envelopeId: msg.envelope.id,
              taskId,
            });

            if (!jobId) {
              appendStructuredContent(db, msg.envelope.id, "user", "internal",
                [{ type: "tool_result", tool_use_id: tc.id, content: "Library ingestion failed: Router not available." }], issuer, assignedShardId);
              asyncCallResults.push({ id: tc.id, succeeded: false });
              continue;
            }

            // 4. Store metadata so gateway-bridge knows this is a library task
            const { storeLibraryTaskMeta } = await import("../library/db.js");
            storeLibraryTaskMeta(db, taskId, url);

            // 5. Tool result — tell LLM not to poll
            appendStructuredContent(db, msg.envelope.id, "user", "internal",
              [{ type: "tool_result", tool_use_id: tc.id,
                 content: `Library ingestion started for: ${url}. Task ID: ${taskId}. You will be notified automatically when complete — do NOT poll.` }], issuer, assignedShardId);
            asyncCallResults.push({ id: tc.id, succeeded: true });

          } else if (tc.name === "sessions_spawn" && onSpawn) {
            const args = tc.arguments as { task?: string; priority?: string; executor?: string; resources?: Array<{ type: string; name?: string; path?: string; url?: string; content?: string }> };
            const task = args.task ?? "";
            const resultPriority = (args.priority as "urgent" | "normal" | "background") ?? "normal";
            const executor = args.executor === "coding" ? "coding" as const : undefined;

            // Cortex owns the UUID — Router stores it as-is
            const taskId = crypto.randomUUID();

            // Record dispatch context — stays in Cortex, never enters the pipeline
            const { channel: _, ...channelAttrs } = msg.envelope.replyContext ?? { channel: msg.envelope.channel };
            storeDispatch(db, {
              taskId,
              channel: msg.envelope.channel,
              channelContext: channelAttrs,
              counterpartId: msg.envelope.sender?.id,
              counterpartName: msg.envelope.sender?.name,
              shardId: assignedShardId,
              taskSummary: task.slice(0, 200),
              priority: resultPriority,
              executor: executor ?? null,
              issuer,
            });

            // Resolve resources — read files from workspace, pass text as-is
            const resolvedResources: ResolvedResource[] = [];
            if (Array.isArray(args.resources)) {
              for (const res of args.resources) {
                const name = typeof res.name === "string" ? res.name : "unnamed";
                if (res.type === "file" && typeof res.path === "string") {
                  // Resolve workspace-relative path against main agent workspace
                  // Security: normalize and constrain to workspace boundary
                  const resolvedPath = path.resolve(workspaceDir, res.path);
                  const normalizedWorkspace = path.resolve(workspaceDir);
                  if (!resolvedPath.startsWith(normalizedWorkspace + path.sep) && resolvedPath !== normalizedWorkspace) {
                    resolvedResources.push({ name, content: `[Access denied: path "${res.path}" is outside workspace boundary]` });
                  } else {
                    try {
                      const content = fs.readFileSync(resolvedPath, "utf-8");
                      resolvedResources.push({ name, content });
                    } catch {
                      resolvedResources.push({ name, content: `[File not found: ${res.path}]` });
                    }
                  }
                } else if (res.type === "url" && typeof res.url === "string") {
                  resolvedResources.push({ name, content: `[URL: ${res.url}]` });
                } else if (res.type === "text" && typeof res.content === "string") {
                  resolvedResources.push({ name, content: res.content });
                }
              }
            }

            // Auto-attach SPEC.md for pipeline tasks (016)
            // If task text mentions a pipeline task ID pattern (3-digit number),
            // scan pipeline directories for a matching SPEC.md and auto-attach if not already included.
            const pipelineIdMatch = task.match(/\b0(\d{2})\b/);
            if (pipelineIdMatch) {
              const taskIdPrefix = pipelineIdMatch[0];
              const hasSpec = resolvedResources.some((r) =>
                r.name.toLowerCase().includes("spec") || r.content.includes("id: \"" + taskIdPrefix + "\""));
              if (!hasSpec) {
                const STAGES = ["Cooking", "ToDo", "InProgress", "InReview"];
                for (const stage of STAGES) {
                  const stageDir = path.join(workspaceDir, "pipeline", stage);
                  if (!fs.existsSync(stageDir)) continue;
                  const entries = fs.readdirSync(stageDir).filter((e) => e.startsWith(taskIdPrefix));
                  if (entries.length > 0) {
                    const specPath = path.join(stageDir, entries[0], "SPEC.md");
                    if (fs.existsSync(specPath)) {
                      try {
                        const specContent = fs.readFileSync(specPath, "utf-8");
                        resolvedResources.push({ name: "SPEC.md (auto-attached)", content: specContent });
                        onError(new Error(`[cortex-loop] Auto-attached SPEC.md from pipeline/${stage}/${entries[0]}`));
                      } catch { /* best-effort */ }
                    }
                    break;
                  }
                }
              }
            }

            // Auto-attach Library domain context for task enrichment (010c)
            try {
              const { openLibraryDbReadonly, searchItems } = require("../library/retrieval.js");
              const libraryDb = openLibraryDbReadonly();
              if (libraryDb && embedFn) {
                try {
                  const taskEmbedding = await embedFn(task.substring(0, 500));
                  const matches = searchItems(libraryDb, taskEmbedding, 3);
                  if (matches.length > 0) {
                    const context = matches.map((m: any) => `[${m.title}]\n${m.summary}`).join("\n---\n");
                    if (context.length <= 4096) {
                      resolvedResources.push({ name: "Library domain context", content: context });
                    }
                  }
                } finally {
                  libraryDb.close();
                }
              }
            } catch { /* best-effort — don't block spawn */ }

            // Fire spawn — Router result will arrive via gateway-bridge → appendTaskResult
            const jobId = onSpawn({
              task, resultPriority, envelopeId: msg.envelope.id, taskId,
              resources: resolvedResources.length > 0 ? resolvedResources : undefined,
              executor,
              replyChannel: msg.envelope.channel,
            });

            if (!jobId) {
              // Spawn failed — write failure directly to session as foreground message
              appendTaskResult(db, {
                taskId,
                description: task.slice(0, 200),
                status: "failed",
                channel: msg.envelope.channel,
                error: "Router spawn failed",
                completedAt: new Date().toISOString(),
                issuer,
              });
              // Store structured tool result for the failure
              appendStructuredContent(db, msg.envelope.id, "user", "internal",
                [{ type: "tool_result", tool_use_id: tc.id, content: `Router spawn failed for task: ${task.slice(0, 120)}` }], issuer, assignedShardId);
              asyncCallResults.push({ id: tc.id, succeeded: false });
            } else {
              // Store structured tool result for the dispatch acknowledgment
              appendStructuredContent(db, msg.envelope.id, "user", "internal",
                [{ type: "tool_result", tool_use_id: tc.id, content: `Task dispatched. [TASK_ID]=${taskId}, Status=Pending, Priority=${resultPriority}. You will be notified automatically when this task completes — do NOT poll get_task_status. The system will wake you with the result. Just inform the user the task is running.` }], issuer, assignedShardId);
              asyncCallResults.push({ id: tc.id, succeeded: true });
            }
          }
        }

        // Fix 1 + Fix 2: Result-aware async feedback (026)
        // Instead of blindly saying "On it", check actual dispatch results.
        let llmResponseFinal = llmResponse;
        if (asyncCalls.length > 0) {
          const allFailed = asyncCallResults.length > 0 && asyncCallResults.every(r => !r.succeeded);
          const someFailed = asyncCallResults.some(r => !r.succeeded) && !allFailed;

          if (allFailed) {
            // ALL async calls failed — suppress any text (LLM-generated or synthetic).
            // The failure results are in the session for the next LLM turn to handle honestly.
            llmResponseFinal = "NO_REPLY";
          } else if (isSilentResponse(llmResponseFinal)) {
            // LLM produced no text — synthesize based on results
            if (someFailed) {
              llmResponseFinal = "Some tasks are running, but others failed — check back shortly.";
            } else {
              // All succeeded — safe to confirm
              llmResponseFinal = "On it — working in the background.";
            }
          }
          // If LLM produced text and not all failed: keep llmResponseFinal as-is (existing behavior)
        }

        // 6. Parse response
        // For ops triggers: resolve the reply channel from the dispatch context
        // so the LLM's response routes to the correct channel (e.g., webchat) instead
        // of defaulting to the trigger's channel ("router").
        let effectiveEnvelope = msg.envelope;
        if (isOpsTrigger) {
          const taskId = msg.envelope.metadata?.taskId as string;
          const dispatch = taskId ? getDispatch(db, taskId) : null;

          if (dispatch) {
            const ctx = dispatch.channelContext ?? {};
            effectiveEnvelope = {
              ...msg.envelope,
              replyContext: {
                channel: dispatch.channel as import("./types.js").ChannelId,
                ...ctx,
              },
            };
          } else {
            // Fallback for in-flight tasks spawned before upgrade
            const replyChannel = msg.envelope.metadata?.replyChannel as string | undefined;
            if (replyChannel) {
              effectiveEnvelope = {
                ...msg.envelope,
                replyContext: { ...msg.envelope.replyContext, channel: replyChannel },
              };
            }
          }
        }

        const output = parseResponse({
          llmResponse: llmResponseFinal,
          triggerEnvelope: effectiveEnvelope,
        });

        // 7. Route output
        await routeOutput({
          output,
          registry,
          onError: (channel, err) => {
            onError(new Error(`Adapter send failed [${channel}]: ${err.message}`));
          },
        });

        // 7b. Notify completion — always fires, even for silent responses
        // Allows live-mode delivery (e.g. webchat) to unblock the client
        onMessageComplete?.(msg.envelope.id, msg.envelope.replyContext, output.targets.length === 0);

        // 8. Record response in session (assigned to same shard as trigger message)
        appendResponse(db, output, msg.envelope.id, issuer, assignedShardId);

        // 9. Mark completed
        markCompleted(db, msg.envelope.id);

        // 10. Checkpoint
        checkpoint(db, {
          createdAt: new Date().toISOString(),
          sessionSnapshot: `Processed: ${msg.envelope.content.slice(0, 100)}`,
          channelStates: getChannelStates(db),
        });

        // Success — reset circuit breaker counter
        consecutiveToolPairingErrors = 0;
        processed++;
      } catch (err) {
        // LLM or processing failure
        const error = err instanceof Error ? err : new Error(String(err));
        markFailed(db, msg.envelope.id, error.message);
        onError(error);

        // Circuit breaker: track consecutive tool_use/tool_result pairing errors
        if (error.message.includes("tool_use") && error.message.includes("tool_result")) {
          consecutiveToolPairingErrors++;
        } else {
          // Different error type — reset counter
          consecutiveToolPairingErrors = 0;
        }

        // Still notify completion so live-mode clients don't hang
        onMessageComplete?.(msg.envelope.id, msg.envelope.replyContext, true);
      }
    } catch (err) {
      // Bus-level error
      onError(err instanceof Error ? err : new Error(String(err)));
    }

    // Continue to next message immediately (no delay between messages)
    if (running) {
      timer = setTimeout(() => { void tick(); }, 0);
    }
  }

  // Start the loop
  currentPromise = tick();

  return {
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      // Wait for current processing to finish
      if (currentPromise) {
        try { await currentPromise; } catch { /* */ }
      }
    },
    isRunning() {
      return running;
    },
    processedCount() {
      return processed;
    },
  };
}
