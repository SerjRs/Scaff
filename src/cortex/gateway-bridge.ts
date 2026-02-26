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
import type { AssembledContext } from "./context.js";
import { createGatewayLLMCaller, createStubLLMCaller } from "./llm-caller.js";

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

  // Use real LLM caller if any channel is in live mode, otherwise stub
  const hasLiveChannel = Object.values(config.channels).some((mode) => mode === "live");
  const callLLM = hasLiveChannel
    ? createGatewayLLMCaller({
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        agentDir: resolveUserPath(".openclaw/agents/main/agent"),
        config: params.cfg,
        maxResponseTokens: 8192,
        onError: (err) => {
          params.log.warn(`[cortex-llm] ${err.message}`);
        },
      })
    : createStubLLMCaller();

  params.log.warn(`[cortex] LLM: ${hasLiveChannel ? "live (anthropic/claude-sonnet-4-20250514)" : "stub (shadow only)"}`);

  const instance = await startCortex({
    agentId: "main",
    workspaceDir,
    dbPath,
    maxContextTokens: 200_000,
    pollIntervalMs: 500,
    callLLM,
    onError: (err) => {
      params.log.warn(`[cortex] Error: ${err.message}`);
    },
  });

  // Register webchat adapter with live delivery via globalThis callbacks
  // chat.ts registers a delivery callback per runId in __openclaw_cortex_delivery__
  if (hasLiveChannel) {
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
      if (runId && deliveryCallbacks.has(runId)) {
        const deliver = deliveryCallbacks.get(runId)!;
        deliver(target.content);
      } else {
        // No matching runId — broadcast to all connected webchat clients
        // This handles cases where the runId wasn't propagated
        params.log.warn(`[cortex] No delivery callback for runId=${runId} — response may not reach client`);
      }
    });
    instance.registerAdapter(webchatAdapter);
    params.log.warn("[cortex] Webchat adapter registered for live delivery");
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
  (globalThis as any).__openclaw_cortex_createEnvelope__ = (await import("./types.js")).createEnvelope;
  (globalThis as any).__openclaw_cortex_getChannelMode__ = getCortexChannelMode;

  params.log.warn(`[cortex] Started. Channels: ${channelModes || "(all default: " + config.defaultMode + ")"}`);

  return handle;
}

/** Stop Cortex from the gateway. */
export async function stopGatewayCortex(): Promise<void> {
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
