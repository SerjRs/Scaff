/**
 * Cortex Gateway Bridge
 *
 * Thin integration layer between the OpenClaw gateway and the Cortex system.
 * Reads cortex/config.json, starts/stops Cortex, provides the shadow hook.
 *
 * This is the ONLY file that bridges the two systems. All Cortex logic
 * lives in src/cortex/. All gateway logic lives in src/gateway/.
 *
 * @see docs/cortex-architecture.md (Safety Architecture)
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";
import { startCortex, stopCortex, _resetSingleton, type CortexInstance } from "./index.js";
import { resolveChannelMode, createShadowHook, type ShadowHook } from "./shadow.js";
import type { CortexModeConfig, CortexEnvelope, ChannelId, CortexMode } from "./types.js";
import { createGatewayLLMCaller, createGardenerLLMFunction } from "./llm-caller.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GatewayCortexHandle {
  instance: CortexInstance | null;
  shadowHook: ShadowHook | null;
  config: CortexModeConfig;
  getChannelMode(channel: ChannelId): CortexMode;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let handle: GatewayCortexHandle | null = null;
/** Cleanup function for Router event listener — called on stop */
let routerListenerCleanup: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_FILENAME = "cortex/config.json";

function loadCortexConfig(): CortexModeConfig | null {
  try {
    const stateDir = resolveStateDir(process.env);
    const configPath = path.join(stateDir, CONFIG_FILENAME);
    if (!fs.existsSync(configPath)) return null;
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return {
      enabled: raw.enabled === true,
      model: raw.model ?? null,
      thinking: raw.thinking ?? null,
      defaultMode: raw.defaultMode ?? "off",
      channels: raw.channels ?? {},
      hippocampus: {
        enabled: raw.hippocampus?.enabled === true,
        gardenerCompactorIntervalMs: raw.hippocampus?.gardenerCompactorIntervalMs,
        gardenerExtractorIntervalMs: raw.hippocampus?.gardenerExtractorIntervalMs,
        gardenerEvictorIntervalMs: raw.hippocampus?.gardenerEvictorIntervalMs,
        foreground: raw.hippocampus?.foreground ?? undefined,
      },
      debugContext: raw.debugContext === true,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Init / Stop
// ---------------------------------------------------------------------------

/** Initialize Cortex from the gateway. Returns null if disabled. */
export async function initGatewayCortex(params: {
  cfg: { workspace?: string; [key: string]: unknown };
  defaultWorkspaceDir: string;
  log: { warn: (msg: string) => void };
}): Promise<GatewayCortexHandle | null> {
  const config = loadCortexConfig();

  if (!config || !config.enabled) {
    params.log.warn("[cortex] Cortex disabled (no config or enabled=false)");
    return null;
  }

  const stateDir = resolveStateDir(process.env);
  const dbPath = path.join(stateDir, "cortex", "bus.sqlite");
  const workspaceDir = params.defaultWorkspaceDir;

  params.log.warn(`[cortex] Starting (mode: ${config.defaultMode})`);

  // Resolve model: cortex/config.json.model → cfg.agents.defaults.model → cfg.model → fallback
  const cortexConfigModel = (config as any).model;
  const rawModel = cortexConfigModel ?? (params.cfg as any).agents?.defaults?.model ?? (params.cfg as any).model;
  const cortexModel = typeof rawModel === "string"
    ? rawModel
    : (rawModel?.id ?? "claude-sonnet-4-6");

  // Always use real LLM caller — hot-reload means channels can switch to live at any time
  const callLLM = createGatewayLLMCaller({
    provider: "anthropic",
    modelId: cortexModel,
    agentDir: resolveUserPath(".openclaw/agents/main/agent"),
    config: params.cfg,
    maxResponseTokens: 8192,
    onError: (err) => {
      params.log.warn(`[cortex-llm] ${err.message}`);
      // TEMP DEBUG: write to file to diagnose silence issue
      try {
        const fs = require("node:fs");
        fs.appendFileSync("C:\\Users\\Temp User\\.openclaw\\cortex-debug.log",
          `[${new Date().toISOString()}] ${err.message}\n`);
      } catch { /* ignore */ }
    },
    debugContext: config.debugContext,
    ...(config.thinking ? { thinking: config.thinking } : {}),
  });

  params.log.warn(`[cortex] LLM: live (anthropic/${cortexModel}${config.thinking ? `, thinking=${config.thinking}` : ""})`);

  // Gardener LLM functions — use Haiku for cost efficiency (extraction is simple, doesn't need Opus)
  const gardenerModel = (config as any).hippocampus?.gardenerModel ?? "claude-haiku-4-5";
  const gardenerLLMParams = {
    provider: "anthropic",
    modelId: gardenerModel,
    agentDir: resolveUserPath(".openclaw/agents/main/agent"),
    config: params.cfg,
    maxResponseTokens: 2048,
    onError: (err: Error) => {
      params.log.warn(`[cortex-gardener] ${err.message}`);
    },
  };
  const gardenerLLM = createGardenerLLMFunction(gardenerLLMParams);
  params.log.warn(`[cortex] Gardener LLM: anthropic/${gardenerModel}`);

  // Pre-import Router and session modules for the synchronous onSpawn callback
  const { getGatewayRouter } = await import("../router/gateway-integration.js");
  const { getCortexSessionKey } = await import("./session.js");

  // Build foreground sharding config from hippocampus.foreground (if configured)
  let foregroundConfig: import("./shards.js").ForegroundConfig | undefined;
  if (config.hippocampus?.enabled) {
    const { DEFAULT_FOREGROUND_CONFIG } = await import("./shards.js");
    const fgRaw = (config.hippocampus as any).foreground;
    foregroundConfig = {
      ...DEFAULT_FOREGROUND_CONFIG,
      ...(fgRaw ?? {}),
    };
    params.log.warn(`[cortex] Foreground sharding: tokenCap=${foregroundConfig.tokenCap}, maxShardTokens=${foregroundConfig.maxShardTokens}, timeGapMinutes=${foregroundConfig.timeGapMinutes}`);
  }

  const instance = await startCortex({
    agentId: "main",
    workspaceDir,
    dbPath,
    maxContextTokens: 200_000,
    pollIntervalMs: 500,
    hippocampusEnabled: config.hippocampus?.enabled === true,
    foregroundConfig,
    shardLLMFn: foregroundConfig ? gardenerLLM : undefined,
    gardenerSummarizeLLM: config.hippocampus?.enabled ? gardenerLLM : undefined,
    gardenerExtractLLM: config.hippocampus?.enabled ? gardenerLLM : undefined,
    // Gardener interval overrides from config (for testing)
    gardenerCompactorIntervalMs: config.hippocampus?.gardenerCompactorIntervalMs,
    gardenerExtractorIntervalMs: config.hippocampus?.gardenerExtractorIntervalMs,
    gardenerEvictorIntervalMs: config.hippocampus?.gardenerEvictorIntervalMs,
    callLLM,
    onError: (err) => {
      params.log.warn(`[cortex] Error: ${err.message}`);
    },
    // When a message completes silently (NO_REPLY or error), fire any pending
    // delivery callbacks so live-mode webchat clients don't hang indefinitely
    onMessageComplete: (_envelopeId, replyContext, silent) => {
      if (!silent) return; // Adapter already fired the callback for non-silent
      const runId = replyContext?.messageId;
      if (!runId) return;
      const deliveryCallbacks = (globalThis as any).__openclaw_cortex_delivery__ as
        | Map<string, (content: string) => void>
        | undefined;
      if (deliveryCallbacks?.has(runId)) {
        // Fire with empty string — broadcastChatFinal will handle gracefully
        deliveryCallbacks.get(runId)!("");
      }
    },
    // Fire-and-forget delegation to the Router when Cortex calls sessions_spawn
    onSpawn: ({ task, resultPriority, taskId, resources, executor }) => {
      try {
        const router = getGatewayRouter();
        if (!router) {
          params.log.warn("[cortex] Cannot spawn: Router not available");
          return null;
        }

        const issuer = getCortexSessionKey("main");

        const payload: Record<string, unknown> = {
          message: task,
          context: JSON.stringify({ source: "cortex" }),
        };
        if (resources && resources.length > 0) {
          payload.resources = resources;
        }

        // Route to coding_run when executor="coding" (Claude Code template, weight≥7, 15min timeout)
        const jobType = executor === "coding" ? "coding_run" as const : "agent_run" as const;

        const jobId = router.enqueue(
          jobType,
          payload,
          issuer,
          taskId,
        );

        params.log.warn(`[cortex] Spawned Router job ${jobId}: ${task.slice(0, 80)}`);
        return jobId;
      } catch (err) {
        params.log.warn(`[cortex] Spawn failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
  });

  // Register webchat adapter with live delivery via globalThis callbacks
  // Always register webchat adapter — hot-reload means channels can switch to live at any time
  // chat.ts registers a delivery callback per runId in __openclaw_cortex_delivery__
  const { WebchatAdapter } = await import("./adapters/webchat.js");
  const webchatAdapter = new WebchatAdapter(async (target) => {
    // Gate on live mode — suppress sends in shadow mode
    const webchatMode = getCortexChannelMode("webchat" as ChannelId);
    if (webchatMode !== "live") {
      params.log.warn(`[cortex] Webchat adapter: suppressed send (mode=${webchatMode}, shadow observe only)`);
      return;
    }

    const deliveryCallbacks = (globalThis as any).__openclaw_cortex_delivery__ as
      | Map<string, (content: string) => void>
      | undefined;

    if (!deliveryCallbacks) {
      params.log.warn("[cortex] No delivery callbacks registered — webchat response dropped");
      return;
    }

    // Find the delivery callback by runId from the replyContext
    const runId = target.replyTo;
    if (runId && deliveryCallbacks?.has(runId)) {
      const deliver = deliveryCallbacks.get(runId)!;
      deliver(target.content);
    } else {
      // No matching runId — this is an async message (e.g. Cortex responding
      // to a Router result ingested via the bus). Use the broadcast function
      // set up by chat.ts to push directly to connected webchat clients.
      const broadcastFn = (globalThis as any).__openclaw_cortex_webchat_broadcast__ as
        | ((content: string) => void)
        | undefined;
      if (broadcastFn) {
        broadcastFn(target.content);
        params.log.warn(`[cortex] Async webchat broadcast delivered`);
      } else {
        params.log.warn(`[cortex] No delivery callback for runId=${runId} and no broadcast function — response dropped`);
      }
    }
  });
  instance.registerAdapter(webchatAdapter);
  params.log.warn("[cortex] Webchat adapter registered for live delivery");

  // Register WhatsApp adapter for live delivery
  const { WhatsAppAdapter } = await import("./adapters/whatsapp.js");
  const whatsappAdapter = new WhatsAppAdapter(async (target) => {
    try {
      // Gate on live mode — in shadow mode, Cortex processes messages but must NOT
      // send replies (the main agent handles delivery). Without this check, shadow
      // mode causes dual replies: both Cortex and main agent send to WhatsApp.
      const whatsappMode = getCortexChannelMode("whatsapp" as ChannelId);
      if (whatsappMode !== "live") {
        params.log.warn(`[cortex] WhatsApp adapter: suppressed send (mode=${whatsappMode}, shadow observe only)`);
        return;
      }
      // threadId = chatId (set from replyContext.threadId in output.ts)
      const chatId = target.threadId ?? target.replyTo ?? null;
      if (!chatId || !target.content?.trim()) {
        params.log.warn(`[cortex] WhatsApp adapter: missing chatId(threadId=${target.threadId}, replyTo=${target.replyTo}) or content(${target.content?.length ?? 0} chars) — response dropped`);
        return;
      }
      const { sendMessageWhatsApp } = await import("../web/outbound.js");
      await sendMessageWhatsApp(chatId, target.content, { verbose: false });
      params.log.warn(`[cortex] WhatsApp reply delivered to ${chatId.substring(0, 8)}...`);
    } catch (err) {
      params.log.warn(`[cortex] WhatsApp send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  instance.registerAdapter(whatsappAdapter);
  params.log.warn("[cortex] WhatsApp adapter registered for live delivery");

  // Subscribe to Router job deliveries — ingest results into Cortex bus (§6.2, §6.3)
  // Router is just another channel; results enter the unified state like any message.
  // The Router Notifier (§3.7) handles delivery for non-Cortex issuers via callGateway.
  const cortexIssuer = getCortexSessionKey("main");
  const { createEnvelope } = await import("./types.js");
  const { appendTaskResult, getDispatch, completeDispatch } = await import("./session.js");

  try {
    const { routerEvents } = await import("../router/worker.js");

    const onJobDelivered = ({ jobId, job }: { jobId: string; job: any }) => {
      if (job.issuer !== cortexIssuer) return; // Not a Cortex-issued job

      try {
        let taskDescription = "";
        try {
          const payload = JSON.parse(job.payload ?? "{}");
          taskDescription = payload.message ?? "";
        } catch { /* best-effort parse */ }

        // Restore channel from dispatch context (owned by Cortex, not the pipeline)
        const dispatch = getDispatch(instance.db, jobId);
        const replyChannel = dispatch?.channel ?? "webchat";

        const completedAt = new Date().toISOString();

        // Library task detection — intercept Librarian executor results
        // Check if this job is a Library ingestion task (stored by loop.ts library_ingest handler)
        // Uses require() (not await import()) because this callback is synchronous.
        try {
          const libDb = require("../library/db.js");
          const libraryUrl = libDb.getLibraryTaskMeta(instance.db, jobId);

          if (libraryUrl) {
            if (job.status === "completed") {
              try {
                const rawResult = job.result ?? "";
                // Parse JSON from executor result (may have markdown wrapping)
                let jsonStr = rawResult;
                const jsonMatch = rawResult.match(/\{[\s\S]*\}/);
                if (jsonMatch) jsonStr = jsonMatch[0];

                const parsed = JSON.parse(jsonStr) as {
                  title: string; summary: string; key_concepts: string[];
                  tags: string[]; content_type: string; source_quality: string;
                  full_text?: string;
                  facts?: Array<{ id: string; text: string; type?: string; confidence?: string }>;
                  edges?: Array<{ from: string; to: string; type: string }>;
                };

                // Write to Library DB
                const libraryDb = libDb.openLibraryDb();
                try {
                  const itemId = libDb.insertItem(libraryDb, {
                    url: libraryUrl, title: parsed.title, summary: parsed.summary,
                    key_concepts: parsed.key_concepts, tags: parsed.tags,
                    content_type: parsed.content_type, source_quality: parsed.source_quality,
                    full_text: parsed.full_text,
                  });

                  // Generate embedding async (fire-and-forget — item is stored regardless)
                  const libEmbed = require("../library/embeddings.js");
                  const textToEmbed = `${parsed.title}. ${parsed.summary} ${parsed.key_concepts.join(". ")}`;
                  void (async () => {
                    let lastErr: unknown;
                    for (let attempt = 0; attempt < 2; attempt++) {
                      try {
                        const embedding: number[] = await libEmbed.generateEmbedding(textToEmbed, 15_000);
                        const eDb = libDb.openLibraryDb();
                        try { libDb.insertEmbedding(eDb, itemId, embedding); } finally { eDb.close(); }
                        return;
                      } catch (err) {
                        lastErr = err;
                        if (attempt === 0) await new Promise(r => setTimeout(r, 2_000));
                      }
                    }
                    params.log.warn(`[library] Embedding failed for item ${itemId} after 2 attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
                  })();

                  // Check if this was an update (version > 1)
                  const versionRow = libraryDb.prepare("SELECT version FROM items WHERE id = ?").get(itemId) as { version: number } | undefined;
                  const tagStr = parsed.tags.slice(0, 5).join(", ");
                  if (versionRow && versionRow.version > 1) {
                    job.result = `📚 Updated: "${parsed.title}" (v${versionRow.version}) — tags: [${tagStr}]`;
                  } else {
                    job.result = `📚 Stored: "${parsed.title}" — tags: [${tagStr}]`;
                  }
                  taskDescription = `Library ingestion: ${libraryUrl}`;

                  // --- Graph ingestion (017e): extract facts+edges into hippocampus ---
                  // Wrapped in async IIFE — outer callback is synchronous
                  (async () => {
                    try {
                      const hippo = require("./hippocampus.js");
                      const { dedupAndInsertGraphFact } = require("./gardener.js");
                      const parsedFacts = parsed.facts as Array<{ id: string; text: string; type?: string; confidence?: string }> | undefined;
                      const parsedEdges = parsed.edges as Array<{ from: string; to: string; type: string }> | undefined;

                      async function embedForLibrary(text: string): Promise<Float32Array> {
                        const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
                        });
                        const json = await res.json() as { embedding: number[] };
                        return new Float32Array(json.embedding);
                      }

                      if (parsedFacts && parsedFacts.length > 0) {
                        // Create article source node with embedding
                        let sourceEmbedding: Float32Array | undefined;
                        try {
                          sourceEmbedding = await embedForLibrary(`Article: ${parsed.title}`);
                        } catch { /* graceful — insert without embedding */ }

                        const sourceFactId = hippo.insertFact(instance.db, {
                          factText: `Article: ${parsed.title}`,
                          factType: "source",
                          confidence: "high",
                          sourceType: "article",
                          sourceRef: `library://item/${itemId}`,
                          embedding: sourceEmbedding,
                        });

                        // Map local IDs (f1, f2...) to real UUIDs
                        const idMap = new Map<string, string>();

                        for (const f of parsedFacts) {
                          if (!f.text?.trim()) continue;
                          const { factId } = await dedupAndInsertGraphFact(
                            instance.db,
                            { id: f.id, text: f.text.trim(), type: f.type ?? "fact", confidence: f.confidence ?? "medium" },
                            "article",
                            embedForLibrary,
                            `library://item/${itemId}`,
                          );
                          idMap.set(f.id, factId);

                          // Link fact to article source
                          hippo.insertEdge(instance.db, {
                            fromFactId: factId,
                            toFactId: sourceFactId,
                            edgeType: "sourced_from",
                          });
                        }

                        // Insert edges between facts
                        if (parsedEdges) {
                          for (const e of parsedEdges) {
                            const fromId = idMap.get(e.from);
                            const toId = idMap.get(e.to);
                            if (fromId && toId && fromId !== toId) {
                              hippo.insertEdge(instance.db, {
                                fromFactId: fromId,
                                toFactId: toId,
                                edgeType: e.type,
                              });
                            }
                          }
                        }

                        params.log.warn(`[library] Graph: ${parsedFacts.length} facts + ${parsedEdges?.length ?? 0} edges from "${parsed.title}"`);
                      }
                    } catch (graphErr) {
                      // Graph ingestion is best-effort — don't fail the Library write
                      params.log.warn(`[library] Graph ingestion failed: ${graphErr instanceof Error ? graphErr.message : String(graphErr)}`);
                    }
                  })();
                } finally {
                  libraryDb.close();
                }
              } catch (parseErr) {
                params.log.warn(`[library] Parse failed for ${libraryUrl}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
                try {
                  const libraryDb = libDb.openLibraryDb();
                  try { libDb.insertFailedItem(libraryDb, libraryUrl, `Parse error: ${parseErr}`); } finally { libraryDb.close(); }
                } catch { /* best-effort */ }
                job.result = `📚 Library ingestion failed for ${libraryUrl}: could not parse executor result.`;
                taskDescription = `Library ingestion (failed): ${libraryUrl}`;
              }
            } else {
              // Task failed — store failure in Library DB
              try {
                const libraryDb = libDb.openLibraryDb();
                try { libDb.insertFailedItem(libraryDb, libraryUrl, job.error ?? "Unknown error"); } finally { libraryDb.close(); }
              } catch { /* best-effort */ }
              taskDescription = `Library ingestion (failed): ${libraryUrl}`;
            }

            libDb.removeLibraryTaskMeta(instance.db, jobId);
          }
        } catch (libErr) {
          params.log.warn(`[library] Task detection error: ${libErr instanceof Error ? libErr.message : String(libErr)}`);
        }

        // Update dispatch lifecycle
        completeDispatch(instance.db, jobId,
          job.status === "completed" ? "completed" : "failed",
          job.result,
          job.error,
        );

        // Null channel = system-initiated task (e.g. audio transcript ingestion).
        // Library DB writes already happened above. Skip user notification + ops-trigger.
        if (!dispatch?.channel) {
          params.log.warn(`[cortex] Router result ingested (no-channel): job=${jobId} status=${job.status}`);
          return;
        }

        if (job.status === "completed") {
          const result = job.result ?? "Task completed.";

          // Detect pipeline tasks: description or result references pipeline paths or key files
          const isPipelineTask =
            taskDescription.includes("pipeline/InProgress/") ||
            taskDescription.includes("CLAUDE.md") ||
            taskDescription.includes("SPEC.md") ||
            taskDescription.includes("STATE.md") ||
            result.includes("pipeline/InProgress/") ||
            result.includes("CLAUDE.md") ||
            result.includes("feat/");  // branch names from coding executor PRs

          const reviewChecklist = isPipelineTask
            ? "\n\n[PIPELINE REVIEW REQUIRED]\n" +
              "The executor reports success. Before replying to the user, complete each step:\n" +
              "1. Review: did the build pass? Check result for errors.\n" +
              "2. Merge: if a PR was created, merge it (gh pr merge <number> --squash)\n" +
              "3. Move: move task folder from InProgress to Done (use move_file)\n" +
              "4. Update STATE.md with final status\n" +
              "5. Inform the user: what was done, PR link, merged status"
            : "";

          // Write result directly to session as a foreground message
          appendTaskResult(instance.db, {
            taskId: jobId,
            description: taskDescription,
            status: "completed",
            channel: replyChannel,
            result: result + reviewChecklist,
            completedAt,
            issuer: cortexIssuer,
          });
        } else {
          const error = job.error ?? "Unknown error";
          appendTaskResult(instance.db, {
            taskId: jobId,
            description: taskDescription,
            status: "failed",
            channel: replyChannel,
            error,
            completedAt,
            issuer: cortexIssuer,
          });
        }

        // Send ops trigger to wake the Cortex loop — carry result inline so the loop
        // doesn't depend on the LLM finding it in session history.
        const triggerMeta: Record<string, unknown> = {
          ops_trigger: true,
          replyChannel,
          taskId: jobId,
          taskDescription,
          taskStatus: job.status,
        };
        if (job.status === "completed") {
          triggerMeta.taskResult = job.result ?? "Task completed.";
        } else {
          triggerMeta.taskError = job.error ?? "Unknown error";
        }
        const trigger = createEnvelope({
          channel: "router",
          sender: { id: "cortex:ops", name: "System", relationship: "system" as const },
          content: "",
          metadata: triggerMeta,
        });
        instance.enqueue(trigger);

        params.log.warn(`[cortex] Router result ingested: job=${jobId} status=${job.status}`);
      } catch (err) {
        params.log.warn(`[cortex] Failed to ingest Router result: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    routerEvents.on("job:delivered", onJobDelivered);
    routerListenerCleanup = () => {
      routerEvents.removeListener("job:delivered", onJobDelivered);
    };
    params.log.warn("[cortex] Subscribed to Router job:delivered events");
  } catch {
    params.log.warn("[cortex] Router not available — skipping job:delivered subscription");
  }

  const shadowHook = createShadowHook(instance);

  handle = {
    instance,
    shadowHook,
    config,
    getChannelMode(channel: ChannelId): CortexMode {
      // Re-read config on each call for hot-reload support
      const freshConfig = loadCortexConfig();
      return resolveChannelMode(freshConfig, channel);
    },
  };

  const channelModes = Object.entries(config.channels)
    .map(([ch, mode]) => `${ch}=${mode}`)
    .join(", ");
  // Expose Cortex functions on globalThis so bundled dynamic imports
  // in chat.ts (and other channel handlers) can reach them without relative paths.
  // Same pattern as Router's globalThis.__openclaw_router_instance__.
  (globalThis as any).__openclaw_cortex_feed__ = feedCortex;
  (globalThis as any).__openclaw_cortex_createEnvelope__ = createEnvelope;
  (globalThis as any).__openclaw_cortex_getChannelMode__ = getCortexChannelMode;
  (globalThis as any).__openclaw_cortex_appendMainReply__ = appendMainAgentReply;
  (globalThis as any).__openclaw_cortex_debug__ = config.debugContext;

  // Expose partner name from USER.md so channel handlers can tag sender identity
  const partnerName = readPartnerName(workspaceDir);
  if (partnerName) {
    (globalThis as any).__openclaw_cortex_partner_name__ = partnerName;
    params.log.warn(`[cortex] Partner name: ${partnerName}`);
  }

  params.log.warn(`[cortex] Started. Channels: ${channelModes || "(all default: " + config.defaultMode + ")"}`);

  return handle;
}

/** Stop Cortex from the gateway. */
export async function stopGatewayCortex(): Promise<void> {
  if (routerListenerCleanup) {
    routerListenerCleanup();
    routerListenerCleanup = null;
  }
  if (handle?.instance) {
    await stopCortex(handle.instance);
    handle = null;
    _resetSingleton();
  }
}

/** Get the current Cortex handle (for channel handlers to check mode). */
export function getGatewayCortex(): GatewayCortexHandle | null {
  return handle;
}

/** Test-only: inject a Cortex handle without booting the full stack. */
export function _setGatewayCortexForTest(h: GatewayCortexHandle | null): void {
  handle = h;
}

/** Check if Cortex is active and what mode a channel is in. */
export function getCortexChannelMode(channel: ChannelId): CortexMode {
  if (!handle) return "off";
  return handle.getChannelMode(channel);
}

/** Feed a message to Cortex (for shadow or live mode). */
export function feedCortex(envelope: CortexEnvelope): void {
  if (!handle?.instance) return;

  const mode = handle.getChannelMode(envelope.channel);
  if (mode === "off") return;

  if (mode === "shadow" && handle.shadowHook) {
    handle.shadowHook.observe(envelope);
  } else if (mode === "live") {
    handle.instance.enqueue(envelope);
  }
}

/**
 * Write the main agent's actual reply to cortex_session.
 * Called from dispatch-from-config.ts after the main agent responds.
 * This allows the Gardener to extract facts from real conversations,
 * not just Cortex shadow responses.
 */
export function appendMainAgentReply(params: {
  channel: string;
  userMessage: string;
  assistantReply: string;
  envelopeId?: string;
}): void {
  if (!handle?.instance) return;

  const mode = handle.getChannelMode(params.channel as ChannelId);
  if (mode === "off") return;

  try {
    const db = handle.instance.db;
    if (!db) return;

    const { randomUUID } = require("node:crypto");
    const envId = params.envelopeId || randomUUID();
    const now = new Date().toISOString();
    const issuer = "main-agent";

    // Write the assistant reply (user message already written by shadow feed)
    if (params.assistantReply?.trim()) {
      db.prepare(`
        INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp, metadata, issuer)
        VALUES (?, 'assistant', ?, 'scaff', ?, ?, NULL, ?)
      `).run(envId, params.channel, params.assistantReply, now, issuer);
    }
  } catch {
    // Non-critical — don't break the main reply path
  }
}

// LLM callers moved to llm-caller.ts (Task 23)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read partner name from USER.md in the workspace directory. */
function readPartnerName(workspaceDir: string): string | undefined {
  try {
    const userMdPath = path.join(workspaceDir, "USER.md");
    if (!fs.existsSync(userMdPath)) return undefined;
    const content = fs.readFileSync(userMdPath, "utf-8");
    const match = content.match(/\*\*Name:\*\*\s*(.+)/);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}
