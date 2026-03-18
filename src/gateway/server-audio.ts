/**
 * Gateway audio capture initialization.
 *
 * Creates the audio HTTP handler and initializes the session DB + data dirs
 * when `audioCapture.enabled` is true in openclaw.json.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { loadAudioCaptureConfig, createGatewayAudioHandler } from "../audio/ingest.js";
import { initAudioSessionTable } from "../audio/session-store.js";
import type { AudioCaptureConfig } from "../audio/types.js";
import type { WorkerDeps } from "../audio/worker.js";
import crypto from "node:crypto";

export interface AudioCaptureHandle {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  db: DatabaseSync;
  config: AudioCaptureConfig;
  close: () => void;
}

/**
 * Initialize audio capture for the gateway.
 *
 * - Loads config from `cfg.audioCapture`
 * - Creates session DB in `dataDir/audio.sqlite`
 * - Ensures data directories exist
 * - Creates the HTTP handler with optional worker integration
 *
 * Returns `null` if audio capture is disabled.
 */
export function initGatewayAudioCapture(opts: {
  audioCaptureConfig?: Partial<AudioCaptureConfig>;
  stateDir: string;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): AudioCaptureHandle | null {
  const config = loadAudioCaptureConfig(opts.audioCaptureConfig);
  if (!config.enabled) {
    return null;
  }

  if (!config.apiKey) {
    opts.log.warn("[audio] audioCapture.enabled is true but apiKey is empty — disabling");
    return null;
  }

  const { DatabaseSync: DBSync } = requireNodeSqlite();

  // Resolve dataDir relative to stateDir if not absolute
  const dataDir = path.isAbsolute(config.dataDir)
    ? config.dataDir
    : path.join(opts.stateDir, config.dataDir);
  const resolvedConfig = { ...config, dataDir };

  // Create DB
  const dbPath = path.join(dataDir, "audio.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DBSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  initAudioSessionTable(db);

  // Ensure data subdirectories
  for (const sub of ["inbox", "processed", "transcripts"]) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }

  // Build worker deps with lazy Librarian ingestion via Router
  // Cortex and Router are initialized after audio — resolve at call time via singletons
  const workerDeps: WorkerDeps = {
    sessionDb: db,
    onIngest: (librarianPrompt: string, sessionId: string) => {
      try {
        // Lazy-import singletons — Cortex + Router may not be ready at init time
        const { getGatewayCortex } = require("../cortex/gateway-bridge.js");
        const { getGatewayRouter } = require("../router/gateway-integration.js");
        const { storeDispatch } = require("../cortex/session.js");
        const { storeLibraryTaskMeta } = require("../library/db.js");
        const { getCortexSessionKey } = require("../cortex/session.js");

        const cortex = getGatewayCortex();
        const router = getGatewayRouter();
        if (!cortex?.instance?.db || !router) {
          opts.log.warn(`[audio] Librarian ingestion skipped for session ${sessionId} — Cortex or Router not available`);
          return;
        }

        const cortexDb = cortex.instance.db;
        const taskId = crypto.randomUUID();
        const url = `audio-capture://${sessionId}`;

        // Store dispatch context with null channel (no user conversation to notify)
        storeDispatch(cortexDb, {
          taskId,
          channel: null,
          taskSummary: librarianPrompt.slice(0, 200),
          priority: "normal",
        });

        // Link taskId to URL so gateway-bridge knows this is a Library task
        storeLibraryTaskMeta(cortexDb, taskId, url);

        // Spawn executor via Router (same pattern as gateway-bridge onSpawn)
        const issuer = getCortexSessionKey("main");
        const jobId = router.enqueue("agent_run", { message: librarianPrompt, context: JSON.stringify({ source: "audio-capture" }) }, issuer, taskId);

        opts.log.info(`[audio] Librarian ingestion spawned: taskId=${taskId}, jobId=${jobId}, session=${sessionId}`);
      } catch (err) {
        opts.log.warn(`[audio] Librarian ingestion failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };

  const handler = createGatewayAudioHandler({
    db,
    config: resolvedConfig,
    workerDeps,
    log: opts.log,
  });

  opts.log.info(`[audio] Audio capture enabled (dataDir=${dataDir})`);

  return {
    handler,
    db,
    config: resolvedConfig,
    close: () => {
      try { db.close(); } catch { /* ignore */ }
    },
  };
}
