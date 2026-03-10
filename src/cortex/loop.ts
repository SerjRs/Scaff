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
import { routeOutput, parseResponse } from "./output.js";
import crypto from "node:crypto";
import { appendToSession, appendResponse, appendToolCall, appendStructuredContent, appendTaskResult, updateChannelState, getChannelStates } from "./session.js";
import { SYNC_TOOL_NAMES, executeFetchChatHistory, executeMemoryQuery, executeGetTaskStatus, executeCodeSearch, type EmbedFunction } from "./tools.js";
import {
  assignMessageWithBoundaryDetection,
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
  replyChannel: string | null;
  resultPriority: "urgent" | "normal" | "background";
  envelopeId: string;
  /** Pre-generated task ID — Cortex owns the UUID, Router stores it as-is */
  taskId: string;
  /** Resolved file resources to include in the executor's task message */
  resources?: ResolvedResource[];
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
      // Hoisted so assistant responses can be assigned to the same shard
      let assignedShardId: string | null = null;
      if (foregroundConfig && !isOpsTrigger) {
        const lastId = db.prepare(`SELECT last_insert_rowid() as id`).get() as { id: number | bigint };
        const messageId = Number(lastId.id);
        assignedShardId = assignMessageWithBoundaryDetection(
          db, messageId, msg.envelope.channel, appendedContent,
          msg.envelope.timestamp, foregroundConfig, issuer,
        );

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
              } else {
                result = JSON.stringify({ error: `Unknown sync tool: ${tc.name}` });
              }
            } catch (err) {
              result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
            }
            // Store tool result as structured content block
            appendStructuredContent(db, msg.envelope.id, "user", "internal",
              [{ type: "tool_result", tool_use_id: tc.id, content: result }], issuer, assignedShardId);
            toolResults.push({ toolCallId: tc.id, toolName: tc.name, content: result });
          }

          // Re-call LLM with tool results appended
          context = {
            ...context,
            toolRoundTrip: {
              previousContent: llmResult._rawContent ?? [],
              toolResults,
            },
          };
          llmResult = await callLLM(context);
        }

        const llmResponse = llmResult.text;

        // 5b. Handle async tool calls (sessions_spawn → Router delegation)
        // Skip for ops triggers — the LLM should only relay results, not dispatch.
        // Even if the LLM sneaks a tool call through, we ignore it on trigger turns.
        // IMPORTANT: Use originalAsyncCalls captured before the sync re-call loop,
        // NOT llmResult.toolCalls which is from the stale round-2 re-call.
        const asyncCalls = isOpsTrigger ? [] : originalAsyncCalls.filter((tc) => tc.name === "sessions_spawn");
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
        for (const tc of asyncCalls) {
          if (tc.name === "sessions_spawn" && onSpawn) {
            const args = tc.arguments as { task?: string; priority?: string; resources?: Array<{ type: string; name?: string; path?: string; url?: string; content?: string }> };
            const task = args.task ?? "";
            const resultPriority = (args.priority as "urgent" | "normal" | "background") ?? "normal";
            // Reply channel = source channel if user-facing, null if internal/system
            const replyChannel = (msg.envelope.channel !== "router" && msg.envelope.channel !== "cron")
              ? msg.envelope.channel
              : null;

            // Cortex owns the UUID — Router stores it as-is
            const taskId = crypto.randomUUID();

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

            // Fire spawn — Router result will arrive via gateway-bridge → appendTaskResult
            const jobId = onSpawn({
              task, replyChannel, resultPriority, envelopeId: msg.envelope.id, taskId,
              resources: resolvedResources.length > 0 ? resolvedResources : undefined,
            });

            if (!jobId) {
              // Spawn failed — write failure directly to session as foreground message
              appendTaskResult(db, {
                taskId,
                description: task.slice(0, 200),
                status: "failed",
                channel: replyChannel ?? msg.envelope.channel,
                error: "Router spawn failed",
                completedAt: new Date().toISOString(),
                issuer,
              });
              // Store structured tool result for the failure
              appendStructuredContent(db, msg.envelope.id, "user", "internal",
                [{ type: "tool_result", tool_use_id: tc.id, content: `Router spawn failed for task: ${task.slice(0, 120)}` }], issuer, assignedShardId);
            } else {
              // Store structured tool result for the dispatch acknowledgment
              appendStructuredContent(db, msg.envelope.id, "user", "internal",
                [{ type: "tool_result", tool_use_id: tc.id, content: `Task dispatched. [TASK_ID]=${taskId}, Status=Pending, Priority=${resultPriority}` }], issuer, assignedShardId);
            }
          }
        }

        // 6. Parse response
        // For ops triggers: resolve the reply channel from the trigger metadata
        // so the LLM's response routes to the correct channel (e.g., webchat) instead
        // of defaulting to the trigger's channel ("router").
        let effectiveEnvelope = msg.envelope;
        if (isOpsTrigger) {
          const replyChannel = msg.envelope.metadata?.replyChannel as string | undefined;
          if (replyChannel) {
            effectiveEnvelope = {
              ...msg.envelope,
              replyContext: { ...msg.envelope.replyContext, channel: replyChannel },
            };
          }
        }

        const output = parseResponse({
          llmResponse,
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
