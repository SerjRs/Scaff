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
import type { IngestionDeps } from "../audio/ingest-transcript.js";
import type { WorkerDeps } from "../audio/worker.js";
import { complete } from "../llm/simple-complete.js";

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
  ingestionDeps?: Omit<IngestionDeps, "extractLLM">;
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

  // Build worker deps (optional — only if ingestion DBs are available)
  let workerDeps: WorkerDeps | undefined;
  if (opts.ingestionDeps) {
    const extractLLM = async (prompt: string): Promise<string> => {
      return complete(prompt, { model: "claude-haiku-4-5" });
    };
    workerDeps = {
      sessionDb: db,
      ingestion: {
        ...opts.ingestionDeps,
        extractLLM,
      },
    };
  } else {
    workerDeps = { sessionDb: db };
  }

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
