/**
 * Audio Ingest API — HTTP endpoint for chunk reception.
 *
 * Standalone HTTP server (node:http) that receives audio chunks from
 * the Rust client (025c), validates, stores, and triggers transcription
 * on session end.
 *
 * Endpoints:
 *   POST /audio/chunk        — multipart upload of a single WAV chunk
 *   POST /audio/session-end  — signal all chunks sent
 *   GET  /audio/session/:id/status — session state query
 *
 * @see workspace/pipeline/InProgress/025d-audio-ingest-api/SPEC.md
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../memory/sqlite.js";
import type { AudioConfig, AudioCaptureConfig } from "./types.js";
import { DEFAULT_AUDIO_CONFIG, DEFAULT_AUDIO_CAPTURE_CONFIG } from "./types.js";
import type { WorkerConfig, WorkerDeps } from "./worker.js";
import { transcribeSession } from "./worker.js";
import {
  initAudioSessionTable,
  upsertSession,
  incrementChunks,
  getSession,
  updateSessionStatus,
} from "./session-store.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function loadAudioConfig(openclawConfigPath: string): AudioConfig {
  try {
    const raw = fs.readFileSync(openclawConfigPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const audio = parsed.audio as Partial<AudioConfig> | undefined;
    if (!audio) return { ...DEFAULT_AUDIO_CONFIG };
    return {
      enabled: audio.enabled ?? DEFAULT_AUDIO_CONFIG.enabled,
      apiKey: audio.apiKey ?? DEFAULT_AUDIO_CONFIG.apiKey,
      maxChunkSizeMB: audio.maxChunkSizeMB ?? DEFAULT_AUDIO_CONFIG.maxChunkSizeMB,
      dataDir: audio.dataDir ?? DEFAULT_AUDIO_CONFIG.dataDir,
      port: audio.port ?? DEFAULT_AUDIO_CONFIG.port,
    };
  } catch {
    return { ...DEFAULT_AUDIO_CONFIG };
  }
}

/** Load audio capture config from the `audioCapture` key in openclaw.json. */
export function loadAudioCaptureConfig(
  partialConfig?: Partial<AudioCaptureConfig>,
): AudioCaptureConfig {
  const d = DEFAULT_AUDIO_CAPTURE_CONFIG;
  if (!partialConfig) return { ...d };
  return {
    enabled: partialConfig.enabled ?? d.enabled,
    apiKey: partialConfig.apiKey ?? d.apiKey,
    maxChunkSizeMB: partialConfig.maxChunkSizeMB ?? d.maxChunkSizeMB,
    dataDir: partialConfig.dataDir ?? d.dataDir,
    port: partialConfig.port ?? d.port,
    whisperBinary: partialConfig.whisperBinary ?? d.whisperBinary,
    whisperModel: partialConfig.whisperModel ?? d.whisperModel,
    whisperLanguage: partialConfig.whisperLanguage ?? d.whisperLanguage,
    whisperThreads: partialConfig.whisperThreads ?? d.whisperThreads,
    retentionDays: partialConfig.retentionDays ?? d.retentionDays,
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function checkAuth(req: http.IncomingMessage, apiKey: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;
  return parts[1] === apiKey;
}

// ---------------------------------------------------------------------------
// Multipart parser (minimal, no deps)
// ---------------------------------------------------------------------------

interface MultipartField {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function parseMultipart(body: Buffer, boundary: string): MultipartField[] {
  const fields: MultipartField[] = [];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  // Split by boundary
  let start = 0;
  const parts: Buffer[] = [];

  while (true) {
    const idx = body.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    if (start > 0) {
      // Content between previous boundary and this one
      // Strip leading \r\n after boundary line
      parts.push(body.subarray(start, idx));
    }
    start = idx + boundaryBuf.length;
    // Skip \r\n or -- after boundary
    if (body[start] === 0x0d && body[start + 1] === 0x0a) {
      start += 2;
    } else if (body[start] === 0x2d && body[start + 1] === 0x2d) {
      break; // end boundary
    }
  }

  for (const part of parts) {
    // Each part: headers \r\n\r\n body \r\n
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headerStr = part.subarray(0, headerEnd).toString("utf-8");
    // Body: strip trailing \r\n
    let data = part.subarray(headerEnd + 4);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.subarray(0, data.length - 2);
    }

    // Parse headers
    const headers: Record<string, string> = {};
    for (const line of headerStr.split("\r\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      headers[line.substring(0, colonIdx).trim().toLowerCase()] = line.substring(colonIdx + 1).trim();
    }

    const disposition = headers["content-disposition"] ?? "";
    const nameMatch = disposition.match(/name="([^"]+)"/);
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    const contentType = headers["content-type"];

    if (nameMatch) {
      fields.push({
        name: nameMatch[1],
        filename: filenameMatch?.[1],
        contentType,
        data,
      });
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Request body reader (raw Buffer)
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let oversize = false;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        oversize = true;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (oversize) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, type: statusToType(status) } });
}

function statusToType(status: number): string {
  switch (status) {
    case 400: return "invalid_request";
    case 401: return "unauthorized";
    case 404: return "not_found";
    case 413: return "payload_too_large";
    default: return "error";
  }
}

// ---------------------------------------------------------------------------
// UUID validation
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(s: string): boolean {
  return UUID_RE.test(s);
}

// ---------------------------------------------------------------------------
// Route: POST /audio/chunk
// ---------------------------------------------------------------------------

async function handleChunkUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: DatabaseSync,
  config: Pick<AudioConfig, "maxChunkSizeMB" | "dataDir">,
): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";
  const boundary = extractBoundary(contentType);
  if (!boundary) {
    sendError(res, 400, "Content-Type must be multipart/form-data with boundary");
    return;
  }

  const maxBytes = config.maxChunkSizeMB * 1024 * 1024;

  let body: Buffer;
  try {
    body = await readBody(req, maxBytes);
  } catch (err) {
    if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
      sendError(res, 413, `Chunk exceeds max size of ${config.maxChunkSizeMB} MB`);
      return;
    }
    sendError(res, 400, "Failed to read request body");
    return;
  }

  const fields = parseMultipart(body, boundary);

  // Extract fields
  const sessionIdField = fields.find((f) => f.name === "session_id");
  const sequenceField = fields.find((f) => f.name === "sequence");
  const fileField = fields.find((f) => f.name === "file");

  if (!sessionIdField || !sequenceField || !fileField) {
    sendError(res, 400, "Missing required fields: session_id, sequence, file");
    return;
  }

  const sessionId = sessionIdField.data.toString("utf-8").trim();
  const sequenceStr = sequenceField.data.toString("utf-8").trim();
  const sequence = Number.parseInt(sequenceStr, 10);

  if (!isValidUUID(sessionId)) {
    sendError(res, 400, "session_id must be a valid UUID");
    return;
  }

  if (!Number.isFinite(sequence) || sequence < 0) {
    sendError(res, 400, "sequence must be a non-negative integer");
    return;
  }

  // Ensure session exists
  const session = upsertSession(db, sessionId);
  if (session.status !== "receiving") {
    sendError(res, 400, `Session ${sessionId} is not in receiving state (current: ${session.status})`);
    return;
  }

  // Write chunk to disk
  const inboxDir = path.join(config.dataDir, "inbox", sessionId);
  fs.mkdirSync(inboxDir, { recursive: true });

  const chunkPath = path.join(inboxDir, `chunk-${String(sequence).padStart(4, "0")}.wav`);
  fs.writeFileSync(chunkPath, fileField.data);

  // Update DB
  incrementChunks(db, sessionId);

  sendJson(res, 200, {
    ok: true,
    session_id: sessionId,
    sequence,
    stored_path: chunkPath,
    size_bytes: fileField.data.length,
  });
}

// ---------------------------------------------------------------------------
// Route: POST /audio/session-end
// ---------------------------------------------------------------------------

async function handleSessionEnd(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: DatabaseSync,
  config: Pick<AudioConfig, "dataDir">,
): Promise<void> {
  const maxBytes = 1024 * 64; // 64 KB for JSON payload
  let body: Buffer;
  try {
    body = await readBody(req, maxBytes);
  } catch {
    sendError(res, 400, "Failed to read request body");
    return;
  }

  let parsed: { session_id?: string };
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  const sessionId = parsed.session_id;
  if (!sessionId || !isValidUUID(sessionId)) {
    sendError(res, 400, "session_id is required and must be a valid UUID");
    return;
  }

  const session = getSession(db, sessionId);
  if (!session) {
    sendError(res, 400, `Unknown session: ${sessionId}`);
    return;
  }

  if (session.chunksReceived === 0) {
    sendError(res, 400, `No chunks received for session ${sessionId}`);
    return;
  }

  if (session.status !== "receiving") {
    sendError(res, 400, `Session ${sessionId} is not in receiving state (current: ${session.status})`);
    return;
  }

  // Verify chunk sequence contiguity
  const inboxDir = path.join(config.dataDir, "inbox", sessionId);
  const gaps = detectSequenceGaps(inboxDir, session.chunksReceived);

  // Mark session complete
  updateSessionStatus(db, sessionId, "pending_transcription");

  sendJson(res, 200, {
    ok: true,
    session_id: sessionId,
    status: "pending_transcription",
    chunks_received: session.chunksReceived,
    sequence_gaps: gaps,
  });
}

/** Check for missing chunk files in the sequence 0..expectedCount-1. */
function detectSequenceGaps(inboxDir: string, expectedCount: number): number[] {
  const gaps: number[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const chunkPath = path.join(inboxDir, `chunk-${String(i).padStart(4, "0")}.wav`);
    if (!fs.existsSync(chunkPath)) {
      gaps.push(i);
    }
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Route: GET /audio/session/:id/status
// ---------------------------------------------------------------------------

function handleSessionStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: DatabaseSync,
  sessionId: string,
): void {
  if (!isValidUUID(sessionId)) {
    sendError(res, 400, "Invalid session ID");
    return;
  }

  const session = getSession(db, sessionId);
  if (!session) {
    sendError(res, 404, `Session not found: ${sessionId}`);
    return;
  }

  sendJson(res, 200, {
    session_id: session.sessionId,
    status: session.status,
    chunks_received: session.chunksReceived,
    created_at: session.createdAt,
    completed_at: session.completedAt,
    error: session.error,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const SESSION_STATUS_RE = /^\/audio\/session\/([^/]+)\/status$/;

export function createAudioRequestHandler(db: DatabaseSync, config: AudioConfig) {
  return async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // Auth check (all audio endpoints)
    if (url.startsWith("/audio/")) {
      if (!config.enabled) {
        sendError(res, 404, "Audio ingest is disabled");
        return true;
      }

      if (!checkAuth(req, config.apiKey)) {
        sendError(res, 401, "Unauthorized");
        return true;
      }
    } else {
      return false; // not an audio route
    }

    // POST /audio/chunk
    if (url === "/audio/chunk" && method === "POST") {
      await handleChunkUpload(req, res, db, config);
      return true;
    }

    // POST /audio/session-end
    if (url === "/audio/session-end" && method === "POST") {
      await handleSessionEnd(req, res, db, config);
      return true;
    }

    // GET /audio/session/:id/status
    const statusMatch = url.match(SESSION_STATUS_RE);
    if (statusMatch && method === "GET") {
      handleSessionStatus(req, res, db, statusMatch[1]);
      return true;
    }

    sendError(res, 404, "Not found");
    return true;
  };
}

// ---------------------------------------------------------------------------
// Gateway-compatible handler (with worker integration)
// ---------------------------------------------------------------------------

export interface AudioGatewayDeps {
  db: DatabaseSync;
  config: AudioCaptureConfig;
  workerDeps?: WorkerDeps;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Create an audio HTTP request handler for the gateway.
 *
 * Same pattern as `handleSlackHttpRequest`, `handlePluginRequest`:
 * returns `true` if the request was handled, `false` to let other handlers try.
 *
 * When `workerDeps` is provided, session-end triggers the transcription
 * pipeline asynchronously (fire-and-forget after responding).
 */
export function createGatewayAudioHandler(deps: AudioGatewayDeps) {
  const { db, config, workerDeps, log } = deps;

  const workerConfig: WorkerConfig = {
    dataDir: config.dataDir,
    whisper: {
      whisperBinary: config.whisperBinary,
      whisperModel: config.whisperModel,
      language: config.whisperLanguage,
      threads: config.whisperThreads,
    },
  };

  return async function handleAudioHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    if (!url.startsWith("/audio/")) {
      return false;
    }

    if (!config.enabled) {
      return false; // disabled → skip silently, let other handlers try
    }

    if (!checkAuth(req, config.apiKey)) {
      sendError(res, 401, "Unauthorized");
      return true;
    }

    // POST /audio/chunk
    if (url === "/audio/chunk" && method === "POST") {
      await handleChunkUpload(req, res, db, config);
      return true;
    }

    // POST /audio/session-end
    if (url === "/audio/session-end" && method === "POST") {
      await handleSessionEnd(req, res, db, config);

      // Fire-and-forget: trigger worker pipeline after responding
      if (workerDeps) {
        void triggerPendingTranscriptions(db, workerConfig, workerDeps, log);
      }
      return true;
    }

    // GET /audio/session/:id/status
    const statusMatch = url.match(SESSION_STATUS_RE);
    if (statusMatch && method === "GET") {
      handleSessionStatus(req, res, db, statusMatch[1]);
      return true;
    }

    sendError(res, 404, "Not found");
    return true;
  };
}

/** Find sessions in pending_transcription state and run the worker on them. */
async function triggerPendingTranscriptions(
  db: DatabaseSync,
  workerConfig: WorkerConfig,
  workerDeps: WorkerDeps,
  log?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  try {
    const rows = db.prepare(
      `SELECT session_id FROM audio_sessions WHERE status = 'pending_transcription'`,
    ).all() as Array<{ session_id: string }>;

    for (const row of rows) {
      try {
        log?.info(`[audio] Starting transcription for session ${row.session_id}`);
        await transcribeSession(row.session_id, workerConfig, workerDeps);
        log?.info(`[audio] Transcription complete for session ${row.session_id}`);
      } catch (err) {
        log?.warn(`[audio] Transcription failed for session ${row.session_id}: ${String(err)}`);
      }
    }
  } catch (err) {
    log?.warn(`[audio] Failed to query pending transcriptions: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface AudioIngestServer {
  server: http.Server;
  db: DatabaseSync;
  config: AudioConfig;
  close: () => void;
}

/**
 * Start the audio ingest HTTP server.
 *
 * @param config Audio config (or loaded from openclaw.json)
 * @param dbPath Path to SQLite database (defaults to bus.sqlite pattern)
 */
export function startAudioIngestServer(
  config: AudioConfig,
  dbPath?: string,
): AudioIngestServer {
  const { DatabaseSync } = requireNodeSqlite();
  const resolvedDbPath = dbPath ?? path.join(config.dataDir, "audio.sqlite");

  const dir = path.dirname(resolvedDbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(resolvedDbPath);
  db.exec("PRAGMA journal_mode = WAL");
  initAudioSessionTable(db);

  // Ensure data dirs exist
  for (const sub of ["inbox", "processed", "transcripts"]) {
    fs.mkdirSync(path.join(config.dataDir, sub), { recursive: true });
  }

  const handler = createAudioRequestHandler(db, config);

  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handler(req, res);
      if (!handled) {
        sendError(res, 404, "Not found");
      }
    } catch (err) {
      console.error("[audio-ingest] Unhandled error:", err);
      if (!res.headersSent) {
        sendError(res, 500, "Internal server error");
      }
    }
  });

  server.listen(config.port);

  return {
    server,
    db,
    config,
    close: () => {
      server.close();
      try { db.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * Create an audio ingest server for testing (ephemeral DB, random port).
 */
export function createTestServer(
  configOverrides?: Partial<AudioConfig>,
  dbPath?: string,
): AudioIngestServer & { port: number; baseUrl: string } {
  const { DatabaseSync } = requireNodeSqlite();
  const tmpDb = dbPath ?? ":memory:";
  const db = tmpDb === ":memory:" ? new DatabaseSync(tmpDb) : (() => {
    const dir = path.dirname(tmpDb);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return new DatabaseSync(tmpDb);
  })();

  db.exec("PRAGMA journal_mode = WAL");
  initAudioSessionTable(db);

  const config: AudioConfig = {
    ...DEFAULT_AUDIO_CONFIG,
    enabled: true,
    apiKey: "test-key-123",
    ...configOverrides,
  };

  // Ensure data dirs exist
  for (const sub of ["inbox", "processed", "transcripts"]) {
    fs.mkdirSync(path.join(config.dataDir, sub), { recursive: true });
  }

  const handler = createAudioRequestHandler(db, config);

  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handler(req, res);
      if (!handled) {
        sendError(res, 404, "Not found");
      }
    } catch (err) {
      if (!res.headersSent) {
        sendError(res, 500, "Internal server error");
      }
    }
  });

  // Listen on port 0 for random available port
  server.listen(0);
  const addr = server.address() as { port: number };

  return {
    server,
    db,
    config,
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => {
      server.close();
      try { db.close(); } catch { /* ignore */ }
    },
  };
}
