/**
 * Cortex Service Entry
 *
 * Single entry point to start/stop Cortex. Initializes bus, session tables,
 * adapters, recovery, and the processing loop.
 *
 * @see docs/cortex-architecture.md
 */

import type { DatabaseSync } from "node:sqlite";
import { initBus, enqueue, countPending } from "./bus.js";
import { createAdapterRegistry, type AdapterRegistry, type ChannelAdapter } from "./channel-adapter.js";
import type { AssembledContext } from "./context.js";
import { startGardener, type GardenerInstance, type FactExtractorLLM } from "./gardener.js";
import { initHotMemoryTable, initColdStorage } from "./hippocampus.js";
import type { CortexLLMResult } from "./llm-caller.js";
import { startLoop, type CortexLoop, type SpawnParams } from "./loop.js";
import type { EmbedFunction } from "./tools.js";
import { repairBusState } from "./recovery.js";
import { initSessionTables, getChannelStates, getPendingOps } from "./session.js";
import type { ChannelId, CortexEnvelope, ChannelState, PendingOperation } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CortexConfig {
  agentId: string;
  workspaceDir: string;
  dbPath?: string;
  maxContextTokens: number;
  pollIntervalMs?: number;
  /** Enable Hippocampus memory subsystem (hot memory + cold storage) */
  hippocampusEnabled?: boolean;
  callLLM: (context: AssembledContext) => Promise<CortexLLMResult>;
  onError?: (error: Error) => void;
  /** Called after every message completes (including silent/NO_REPLY and failures) */
  onMessageComplete?: (envelopeId: string, replyContext: import("./types.js").ReplyContext | undefined, silent: boolean) => void;
  /** Called when the LLM calls sessions_spawn. Returns job ID or null on failure. */
  onSpawn?: (params: SpawnParams) => string | null;
  /** Embedding function for Hippocampus (memory_query + evictor). Default: Ollama nomic-embed-text */
  embedFn?: EmbedFunction;
  /** LLM function for Gardener summarization (channel compactor) */
  gardenerSummarizeLLM?: FactExtractorLLM;
  /** LLM function for Gardener fact extraction */
  gardenerExtractLLM?: FactExtractorLLM;
}

export interface CortexInstance {
  enqueue(envelope: CortexEnvelope): string;
  registerAdapter(adapter: ChannelAdapter): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  stats(): CortexStats;
  /** Exposed for testing / shadow mode */
  readonly db: DatabaseSync;
  readonly registry: AdapterRegistry;
}

export interface CortexStats {
  processedCount: number;
  pendingCount: number;
  activeChannels: ChannelState[];
  pendingOps: PendingOperation[];
  uptimeMs: number;
}

// ---------------------------------------------------------------------------
// Singleton guard
// ---------------------------------------------------------------------------

let activeInstance: CortexInstance | null = null;

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

/** Start Cortex. Only one instance allowed at a time. */
export async function startCortex(config: CortexConfig): Promise<CortexInstance> {
  if (activeInstance) {
    throw new Error("Cortex is already running. Stop the existing instance first.");
  }

  const startTime = Date.now();
  const onError = config.onError ?? (() => {});

  // 1. Init database
  const db = initBus(config.dbPath, {
    allowExtensionLoading: config.hippocampusEnabled === true,
  });
  initSessionTables(db);

  // 1b. Hippocampus memory subsystem (gated)
  if (config.hippocampusEnabled) {
    initHotMemoryTable(db);
    await initColdStorage(db);
  }

  // 2. Recovery — reset any stalled messages from previous crash
  const repair = repairBusState(db);
  if (repair.stalledReset > 0) {
    onError(new Error(`Cortex recovery: reset ${repair.stalledReset} stalled message(s)`));
  }

  // 3. Create adapter registry
  const registry = createAdapterRegistry();

  // 4. Start processing loop
  let loop: CortexLoop | null = null;

  // Defer loop start until at least one adapter is registered
  // (or start immediately if called with startLoop)
  function ensureLoop(): CortexLoop {
    if (!loop) {
      loop = startLoop({
        db,
        registry,
        workspaceDir: config.workspaceDir,
        maxContextTokens: config.maxContextTokens,
        pollIntervalMs: config.pollIntervalMs ?? 500,
        hippocampusEnabled: config.hippocampusEnabled,
        embedFn: config.embedFn,
        callLLM: config.callLLM,
        onError,
        onMessageComplete: config.onMessageComplete,
        onSpawn: config.onSpawn,
      });
    }
    return loop;
  }

  // 5. Start Gardener (gated by hippocampus + availability of LLM functions)
  let gardener: GardenerInstance | null = null;
  if (config.hippocampusEnabled && config.gardenerSummarizeLLM && config.gardenerExtractLLM) {
    const { embedViaOllama } = await import("./tools.js");
    gardener = startGardener({
      db,
      summarize: config.gardenerSummarizeLLM,
      extractLLM: config.gardenerExtractLLM,
      embedFn: config.embedFn ?? embedViaOllama,
      onError,
    });
  }

  const instance: CortexInstance = {
    enqueue(envelope: CortexEnvelope): string {
      ensureLoop();
      return enqueue(db, envelope);
    },

    registerAdapter(adapter: ChannelAdapter): void {
      registry.register(adapter);
    },

    async stop(): Promise<void> {
      if (gardener) {
        gardener.stop();
        gardener = null;
      }
      if (loop) {
        await loop.stop();
        loop = null;
      }
      try { db.close(); } catch { /* */ }
      activeInstance = null;
    },

    isRunning(): boolean {
      return loop?.isRunning() ?? false;
    },

    stats(): CortexStats {
      return {
        processedCount: loop?.processedCount() ?? 0,
        pendingCount: countPending(db),
        activeChannels: getChannelStates(db),
        pendingOps: getPendingOps(db),
        uptimeMs: Date.now() - startTime,
      };
    },

    db,
    registry,
  };

  activeInstance = instance;
  return instance;
}

/** Stop Cortex and clean up. */
export async function stopCortex(instance: CortexInstance): Promise<void> {
  await instance.stop();
}

/** Reset the singleton (for testing only). */
export function _resetSingleton(): void {
  activeInstance = null;
}
