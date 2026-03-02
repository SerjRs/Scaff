/**
 * Cortex Processing Loop
 *
 * The main Cortex loop: dequeue → context → LLM → output → checkpoint.
 * Strict serialization — one message at a time.
 *
 * @see docs/cortex-architecture.md §4.3
 */

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
import { appendToSession, appendResponse, appendToolCall, appendTaskResult, updateChannelState, getChannelStates } from "./session.js";
import { SYNC_TOOL_NAMES, executeFetchChatHistory, executeMemoryQuery, executeGetTaskStatus, type EmbedFunction } from "./tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters passed to the onSpawn callback when Cortex delegates to the Router */
export interface SpawnParams {
  task: string;
  replyChannel: string | null;
  resultPriority: "urgent" | "normal" | "background";
  envelopeId: string;
  /** Pre-generated task ID — Cortex owns the UUID, Router stores it as-is */
  taskId: string;
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
  /** Cognitive owner — filters foreground by issuer instead of channel */
  issuer?: string;
  callLLM: (context: AssembledContext) => Promise<CortexLLMResult>;
  onError: (error: Error) => void;
  /** Called after every message completes (including silent/NO_REPLY) */
  onMessageComplete?: (envelopeId: string, replyContext: import("./types.js").ReplyContext | undefined, silent: boolean) => void;
  /** Called when the LLM calls sessions_spawn. Returns job ID or null on failure. */
  onSpawn?: (params: SpawnParams) => string | null;
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
  const { db, registry, workspaceDir, maxContextTokens, pollIntervalMs, hippocampusEnabled, embedFn, issuer, callLLM, onError, onMessageComplete, onSpawn } = opts;

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
      if (isOpsTrigger) {
        // Ops triggers are not real messages — store a brief system notification
        // so the foreground ends with a user-role message (API requirement).
        appendToSession(db, {
          ...msg.envelope,
          content: "[Task update available]",
          sender: { id: "cortex:ops", name: "System", relationship: "system" as const },
        }, issuer);
      } else {
        appendToSession(db, msg.envelope, issuer);
      }

      // 3. Update channel state to foreground (skip for ops triggers)
      if (!isOpsTrigger) {
        updateChannelState(db, msg.envelope.channel, {
          lastMessageAt: msg.envelope.timestamp,
          layer: "foreground",
        });
      }

      try {
        // 4. Assemble context
        let context = await assembleContext({
          db,
          triggerEnvelope: msg.envelope,
          workspaceDir,
          maxTokens: maxContextTokens,
          hippocampusEnabled,
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

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          // Check for sync tool calls
          const syncCalls = llmResult.toolCalls.filter((tc) => SYNC_TOOL_NAMES.has(tc.name));
          if (syncCalls.length === 0) break;

          // Execute sync tools and collect results
          const toolResults: ToolResultEntry[] = [];
          for (const tc of syncCalls) {
            let result: string;
            try {
              if (tc.name === "fetch_chat_history") {
                const args = tc.arguments as Record<string, unknown>;
                const detail = Object.entries(args).map(([k, v]) => `${k}=${v}`).join(", ");
                appendToolCall(db, msg.envelope.id, tc.name, detail, issuer);
                result = executeFetchChatHistory(db, args as any);
              } else if (tc.name === "memory_query") {
                const args = tc.arguments as Record<string, unknown>;
                const detail = `'${String(args.query ?? "").slice(0, 120)}'`;
                appendToolCall(db, msg.envelope.id, tc.name, detail, issuer);
                result = await executeMemoryQuery(db, args as any, embedFn);
              } else if (tc.name === "get_task_status") {
                const args = tc.arguments as Record<string, unknown>;
                const detail = `taskId=${String(args.taskId ?? "").slice(0, 40)}`;
                appendToolCall(db, msg.envelope.id, tc.name, detail, issuer);
                result = executeGetTaskStatus(args as any);
              } else {
                result = JSON.stringify({ error: `Unknown sync tool: ${tc.name}` });
              }
            } catch (err) {
              result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
            }
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
        for (const tc of isOpsTrigger ? [] : llmResult.toolCalls) {
          if (tc.name === "sessions_spawn" && onSpawn) {
            const args = tc.arguments as { task?: string; priority?: string };
            const task = args.task ?? "";
            const resultPriority = (args.priority as "urgent" | "normal" | "background") ?? "normal";
            // Reply channel = source channel if user-facing, null if internal/system
            const replyChannel = (msg.envelope.channel !== "router" && msg.envelope.channel !== "cron")
              ? msg.envelope.channel
              : null;

            // Cortex owns the UUID — Router stores it as-is
            const taskId = crypto.randomUUID();

            // Fire spawn — Router result will arrive via gateway-bridge → appendTaskResult
            const jobId = onSpawn({ task, replyChannel, resultPriority, envelopeId: msg.envelope.id, taskId });

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
              appendToolCall(db, msg.envelope.id, "sessions_spawn", `'${task.slice(0, 120)}', priority=${resultPriority} → FAILED`, issuer);
            } else {
              appendToolCall(db, msg.envelope.id, "sessions_spawn", `'${task.slice(0, 120)}', priority=${resultPriority} → taskId=${taskId}`, issuer);
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

        // 8. Record response in session
        appendResponse(db, output, msg.envelope.id, issuer);

        // 9. Mark completed
        markCompleted(db, msg.envelope.id);

        // 10. Checkpoint
        checkpoint(db, {
          createdAt: new Date().toISOString(),
          sessionSnapshot: `Processed: ${msg.envelope.content.slice(0, 100)}`,
          channelStates: getChannelStates(db),
        });

        processed++;
      } catch (err) {
        // LLM or processing failure
        const error = err instanceof Error ? err : new Error(String(err));
        markFailed(db, msg.envelope.id, error.message);
        onError(error);
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
