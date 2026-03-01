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
      defaultMode: raw.defaultMode ?? "off",
      channels: raw.channels ?? {},
      hippocampus: { enabled: raw.hippocampus?.enabled === true },
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

  // Resolve model from config — defaults to claude-sonnet-4-6 if not configured
  // cfg.model / cfg.agents.defaults.model can be a Model object ({ id, provider }) or a plain string
  const rawModel = (params.cfg as any).agents?.defaults?.model ?? (params.cfg as any).model;
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
    },
  });

  params.log.warn(`[cortex] LLM: live (anthropic/${cortexModel})`);

  // Gardener LLM functions — reuse same auth/model infrastructure
  // Uses the same model as Cortex main LLM for now (could be Haiku for cost efficiency)
  const gardenerLLMParams = {
    provider: "anthropic",
    modelId: cortexModel,
    agentDir: resolveUserPath(".openclaw/agents/main/agent"),
    config: params.cfg,
    maxResponseTokens: 2048,
    onError: (err: Error) => {
      params.log.warn(`[cortex-gardener] ${err.message}`);
    },
  };
  const gardenerLLM = createGardenerLLMFunction(gardenerLLMParams);

  // Pre-import Router and session modules for the synchronous onSpawn callback
  const { getGatewayRouter } = await import("../router/gateway-integration.js");
  const { getCortexSessionKey } = await import("./session.js");

  const instance = await startCortex({
    agentId: "main",
    workspaceDir,
    dbPath,
    maxContextTokens: 200_000,
    pollIntervalMs: 500,
    hippocampusEnabled: config.hippocampus?.enabled === true,
    gardenerSummarizeLLM: config.hippocampus?.enabled ? gardenerLLM : undefined,
    gardenerExtractLLM: config.hippocampus?.enabled ? gardenerLLM : undefined,
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
    onSpawn: ({ task, replyChannel, resultPriority, taskId }) => {
      try {
        const router = getGatewayRouter();
        if (!router) {
          params.log.warn("[cortex] Cannot spawn: Router not available");
          return null;
        }

        const issuer = getCortexSessionKey("main");

        const jobId = router.enqueue(
          "agent_run",
          {
            message: task,
            context: JSON.stringify({ replyChannel, resultPriority, source: "cortex" }),
          },
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

  // Subscribe to Router job deliveries — ingest results into Cortex bus (§6.2, §6.3)
  // Router is just another channel; results enter the unified state like any message.
  // The Router Notifier (§3.7) handles delivery for non-Cortex issuers via callGateway.
  const cortexIssuer = getCortexSessionKey("main");
  const { createEnvelope } = await import("./types.js");
  const { completePendingOp, failPendingOp, getPendingOps } = await import("./session.js");

  // Startup cleanup: fail any orphaned pending ops from prior crashes/restarts.
  // These would pollute the System Floor indefinitely since no job:failed event will fire.
  try {
    const orphaned = getPendingOps(instance.db).filter((op) => op.status === "pending");
    for (const op of orphaned) {
      failPendingOp(instance.db, op.id, "orphaned from prior session (startup cleanup)");
    }
    if (orphaned.length > 0) {
      params.log.warn(`[cortex] Startup: cleaned up ${orphaned.length} orphaned pending op(s)`);
    }
  } catch {
    // Best-effort
  }

  try {
    const { routerEvents } = await import("../router/worker.js");

    const onJobDelivered = ({ jobId, job }: { jobId: string; job: any }) => {
      if (job.issuer !== cortexIssuer) return; // Not a Cortex-issued job

      try {
        // Store raw result in the pending op (System Floor will format it)
        const rawResult = job.status === "completed"
          ? (job.result ?? "Task completed.")
          : `Error: ${job.error ?? "Unknown error"}`;

        // Mark pending op as completed with the raw result (lifecycle: pending → completed)
        // The System Floor in context.ts renders it as [TASK_ID]=..., Status=Completed, Result='...'
        completePendingOp(instance.db, jobId, rawResult);

        // Send a lightweight ops trigger to wake the Cortex loop.
        // NO result content in the envelope — result lives exclusively in the
        // System Floor via cortex_pending_ops (single-path delivery §6.4).
        const trigger = createEnvelope({
          channel: "router",
          sender: { id: "cortex:ops", name: "System", relationship: "system" as const },
          content: "",
          metadata: { ops_trigger: true },
        });
        instance.enqueue(trigger);

        params.log.warn(`[cortex] Router result ingested: job=${jobId} status=${job.status}`);
      } catch (err) {
        params.log.warn(`[cortex] Failed to ingest Router result: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    // Clean up Cortex pending ops when Router jobs fail (eval/dispatch crash, worker error)
    const onJobFailed = ({ jobId, error }: { jobId: string; error: string }) => {
      try {
        failPendingOp(instance.db, jobId, error);

        // Send ops trigger so the loop picks up the failure from System Floor
        const trigger = createEnvelope({
          channel: "router",
          sender: { id: "cortex:ops", name: "System", relationship: "system" as const },
          content: "",
          metadata: { ops_trigger: true },
        });
        instance.enqueue(trigger);

        params.log.warn(`[cortex] Pending op failed for Router job ${jobId}: ${error}`);
      } catch {
        // Best-effort — don't block the Router
      }
    };

    routerEvents.on("job:delivered", onJobDelivered);
    routerEvents.on("job:failed", onJobFailed);
    routerListenerCleanup = () => {
      routerEvents.removeListener("job:delivered", onJobDelivered);
      routerEvents.removeListener("job:failed", onJobFailed);
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

// LLM callers moved to llm-caller.ts (Task 23)
