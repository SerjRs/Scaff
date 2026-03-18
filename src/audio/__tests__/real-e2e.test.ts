/**
 * Real E2E pipeline test — Binary chunks → HTTP upload → Whisper → Hippocampus.
 *
 * NO MOCKS except the LLM for fact extraction (stub with hardcoded JSON).
 * Real Whisper, real SQLite DBs, real ingestion.
 *
 * Requires `whisper` on PATH and `ffmpeg` on PATH.
 * Skips gracefully when whisper is not available.
 *
 * @see workspace/pipeline/InProgress/032-real-e2e-pipeline-test/SPEC.md
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { createGatewayAudioHandler } from "../ingest.js";
import type { AudioCaptureConfig } from "../types.js";
import { initAudioSessionTable, getSession } from "../session-store.js";
import type { WorkerDeps } from "../worker.js";

// ---------------------------------------------------------------------------
// Environment — ensure PYTHONIOENCODING + ffmpeg are available
// ---------------------------------------------------------------------------

const FFMPEG_DIR = path.join(
  os.homedir(),
  "AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin",
);

if (fs.existsSync(FFMPEG_DIR) && !process.env.PATH?.includes(FFMPEG_DIR)) {
  process.env.PATH = `${FFMPEG_DIR}${path.delimiter}${process.env.PATH}`;
}

process.env.PYTHONIOENCODING = "utf-8";

// ---------------------------------------------------------------------------
// Skip guard — skip if whisper binary not available
// ---------------------------------------------------------------------------

let whisperAvailable = false;
try {
  execFileSync("whisper", ["--help"], {
    timeout: 10_000,
    stdio: "pipe",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  whisperAvailable = true;
} catch {
  // whisper not available — tests will be skipped
}

const describeIf = whisperAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Contract constants — must match Rust shipper client
// ---------------------------------------------------------------------------

const FIELD_SESSION_ID = "session_id";
const FIELD_SEQUENCE = "sequence";
const FIELD_AUDIO = "audio";
const CHUNK_UPLOAD_PATH = "/audio/chunk";
const SESSION_END_PATH = "/audio/session-end";
const API_KEY = "test-key-e2e";

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "../../../tools/cortex-audio/fixtures");

function loadChunkFixture(index: number): Buffer {
  const p = path.join(FIXTURE_DIR, `test-speech-chunk-${String(index).padStart(2, "0")}.wav`);
  return fs.readFileSync(p);
}

// ---------------------------------------------------------------------------
// Multipart builder — matches reqwest output (no library)
// ---------------------------------------------------------------------------

function buildMultipart(
  fields: Array<{ name: string; value: string }>,
  filePart?: { name: string; filename: string; contentType: string; data: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = "----RealE2ETest" + Date.now();
  const parts: Buffer[] = [];

  for (const { name, value } of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`,
      ),
    );
  }

  if (filePart) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${filePart.name}"; filename="${filePart.filename}"\r\n` +
          `Content-Type: ${filePart.contentType}\r\n\r\n`,
      ),
    );
    parts.push(filePart.data);
    parts.push(Buffer.from("\r\n"));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function rawRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: Buffer | string,
): Promise<{ status: number; body: string; json: () => unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method,
      headers,
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve({
          status: res.statusCode ?? 0,
          body: text,
          json: () => JSON.parse(text),
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------

async function uploadChunk(
  baseUrl: string,
  sessionId: string,
  sequence: number,
  wavData: Buffer,
): Promise<{ status: number; json: () => unknown }> {
  const timestamp = 1710700000 + sequence * 30;
  const filename = `${sessionId}_chunk-${String(sequence).padStart(4, "0")}_${timestamp}.wav`;

  const { body, contentType } = buildMultipart(
    [
      { name: FIELD_SESSION_ID, value: sessionId },
      { name: FIELD_SEQUENCE, value: String(sequence) },
    ],
    {
      name: FIELD_AUDIO,
      filename,
      contentType: "audio/wav",
      data: wavData,
    },
  );

  return rawRequest(`${baseUrl}${CHUNK_UPLOAD_PATH}`, "POST", {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": contentType,
  }, body);
}

async function sendSessionEnd(
  baseUrl: string,
  sessionId: string,
): Promise<{ status: number; json: () => unknown }> {
  return rawRequest(`${baseUrl}${SESSION_END_PATH}`, "POST", {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  }, JSON.stringify({ [FIELD_SESSION_ID]: sessionId }));
}

async function pollSessionStatus(
  baseUrl: string,
  sessionId: string,
  targetStatus: string | string[],
  timeoutMs: number = 120_000,
  intervalMs: number = 2_000,
): Promise<Record<string, unknown>> {
  const targets = Array.isArray(targetStatus) ? targetStatus : [targetStatus];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await rawRequest(
      `${baseUrl}/audio/session/${sessionId}/status`,
      "GET",
      { Authorization: `Bearer ${API_KEY}` },
    );
    const data = res.json() as Record<string, unknown>;
    if (targets.includes(data.status as string)) return data;
    if (data.status === "failed") return data; // stop polling on failure
    await delay(intervalMs);
  }
  throw new Error(`Timeout waiting for session ${sessionId} to reach ${targets.join("|")}`);
}

// ---------------------------------------------------------------------------
// Test suite — real E2E pipeline
// ---------------------------------------------------------------------------

describeIf("Real E2E pipeline (Whisper + Hippocampus)", () => {
  let tmpDir: string;
  let baseUrl: string;
  let server: http.Server;
  let sessionDb: ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
  const ingestCalls: Array<{ prompt: string; sessionId: string }> = [];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "real-e2e-"));
    const dataDir = path.join(tmpDir, "audio");

    // Ensure data subdirs
    for (const sub of ["inbox", "processed", "transcripts"]) {
      fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
    }

    const { DatabaseSync } = requireNodeSqlite();

    // Session DB
    sessionDb = new DatabaseSync(":memory:");
    sessionDb.exec("PRAGMA journal_mode = WAL");
    initAudioSessionTable(sessionDb);

    // Worker deps (session DB + onIngest callback)
    const workerDeps: WorkerDeps = {
      sessionDb,
      onIngest: async (prompt, sid) => {
        ingestCalls.push({ prompt, sessionId: sid });
      },
    };

    // Audio capture config
    const config: AudioCaptureConfig = {
      enabled: true,
      apiKey: API_KEY,
      maxChunkSizeMB: 15,
      dataDir,
      port: null,
      whisperBinary: "whisper",
      whisperModel: "base.en",
      whisperLanguage: "en",
      whisperThreads: 4,
      retentionDays: 30,
    };

    // Create gateway audio handler with worker integration
    const handler = createGatewayAudioHandler({
      db: sessionDb,
      config,
      workerDeps,
      log: {
        info: (msg: string) => console.log(msg),
        warn: (msg: string) => console.warn(msg),
      },
    });

    // Create HTTP server using the gateway handler
    server = http.createServer(async (req, res) => {
      try {
        const handled = await handler(req, res);
        if (!handled) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Not found" }));
        }
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      }
    });

    server.listen(0);
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    console.log(`[real-e2e] Server listening on ${baseUrl}`);
  });

  afterAll(() => {
    server?.close();
    try { sessionDb?.close(); } catch { /* ignore */ }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: happy path — 3 chunks → transcript → Hippocampus
  // -------------------------------------------------------------------------
  it("happy path — 3 chunks → transcript → Hippocampus", async () => {
    const sessionId = crypto.randomUUID();

    // Upload 3 real speech chunks with 1-second delays
    for (let i = 0; i < 3; i++) {
      const wav = loadChunkFixture(i);
      const res = await uploadChunk(baseUrl, sessionId, i, wav);
      expect(res.status).toBe(200);
      const json = res.json() as { ok: boolean; session_id: string; sequence: number };
      expect(json.ok).toBe(true);
      expect(json.session_id).toBe(sessionId);
      expect(json.sequence).toBe(i);

      if (i < 2) await delay(1000); // realistic timing between chunks
    }

    // Verify chunks received
    const session = getSession(sessionDb, sessionId);
    expect(session).toBeDefined();
    expect(session!.chunksReceived).toBe(3);

    // Send session-end (triggers worker fire-and-forget)
    const endRes = await sendSessionEnd(baseUrl, sessionId);
    expect(endRes.status).toBe(200);
    const endJson = endRes.json() as { ok: boolean; status: string; chunks_received: number; sequence_gaps: number[] };
    expect(endJson.ok).toBe(true);
    expect(endJson.chunks_received).toBe(3);
    expect(endJson.sequence_gaps).toEqual([]);

    // Poll until done or failed (up to 120s — Whisper is slow on CPU)
    const finalStatus = await pollSessionStatus(baseUrl, sessionId, ["done", "failed"], 120_000);
    expect(finalStatus.status).toBe("done");

    // Verify transcript JSON exists
    const dataDir = path.join(tmpDir, "audio");
    const transcriptPath = path.join(dataDir, "transcripts", `${sessionId}.json`);
    expect(fs.existsSync(transcriptPath)).toBe(true);

    const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
    expect(transcript.fullText.length).toBeGreaterThan(0);
    expect(transcript.segments.length).toBeGreaterThan(0);

    // Transcript should contain recognizable speech words
    const fullText = transcript.fullText.toLowerCase();
    expect(fullText).toMatch(/meeting|tuesday|friday|report|quarterly/i);

    // Valid segment structure
    for (const seg of transcript.segments) {
      expect(seg.start).toBeGreaterThanOrEqual(0);
      expect(seg.end).toBeGreaterThan(seg.start);
      expect(["user", "others"]).toContain(seg.speaker);
      expect(seg.text.length).toBeGreaterThan(0);
    }

    // Audio files moved from inbox to processed
    const inboxDir = path.join(dataDir, "inbox", sessionId);
    const processedDir = path.join(dataDir, "processed", sessionId);
    // Inbox should be empty (files moved)
    if (fs.existsSync(inboxDir)) {
      const remaining = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".wav"));
      expect(remaining).toHaveLength(0);
    }
    // Processed should have the chunks
    expect(fs.existsSync(processedDir)).toBe(true);
    const processed = fs.readdirSync(processedDir).filter((f) => f.endsWith(".wav"));
    expect(processed.length).toBeGreaterThan(0);

    // onIngest callback was called with Librarian prompt
    const call = ingestCalls.find((c) => c.sessionId === sessionId);
    expect(call).toBeDefined();
    expect(call!.prompt).toContain(`audio-capture://${sessionId}`);
    expect(call!.prompt).toContain("Librarian");
  }, 300_000);

  // -------------------------------------------------------------------------
  // Test 2: chunk ordering preserved across network
  // -------------------------------------------------------------------------
  it("chunk ordering preserved across network", async () => {
    const sessionId = crypto.randomUUID();

    // Upload 5 chunks (reuse the 3 fixtures, cycling through them)
    for (let i = 0; i < 5; i++) {
      const wav = loadChunkFixture(i % 3);
      const res = await uploadChunk(baseUrl, sessionId, i, wav);
      expect(res.status).toBe(200);
      const json = res.json() as { ok: boolean; sequence: number };
      expect(json.ok).toBe(true);
      expect(json.sequence).toBe(i);

      if (i < 4) await delay(300); // small delays
    }

    // Verify all 5 received
    const session = getSession(sessionDb, sessionId);
    expect(session!.chunksReceived).toBe(5);

    // Verify chunk files exist in correct sequence
    const dataDir = path.join(tmpDir, "audio");
    for (let i = 0; i < 5; i++) {
      const chunkPath = path.join(
        dataDir, "inbox", sessionId,
        `chunk-${String(i).padStart(4, "0")}.wav`,
      );
      expect(fs.existsSync(chunkPath)).toBe(true);
    }

    // Send session-end and check no sequence gaps
    const endRes = await sendSessionEnd(baseUrl, sessionId);
    expect(endRes.status).toBe(200);
    const endJson = endRes.json() as { sequence_gaps: number[] };
    expect(endJson.sequence_gaps).toEqual([]);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 3: session-end right after last chunk
  // -------------------------------------------------------------------------
  it("session-end right after last chunk — no delay", async () => {
    const sessionId = crypto.randomUUID();

    // Upload 3 chunks with delays between them
    for (let i = 0; i < 3; i++) {
      const wav = loadChunkFixture(i);
      const res = await uploadChunk(baseUrl, sessionId, i, wav);
      expect(res.status).toBe(200);
      if (i < 2) await delay(1000);
    }

    // Send session-end immediately — no delay after last chunk
    const endRes = await sendSessionEnd(baseUrl, sessionId);
    expect(endRes.status).toBe(200);
    const endJson = endRes.json() as { ok: boolean; chunks_received: number };
    expect(endJson.ok).toBe(true);
    expect(endJson.chunks_received).toBe(3);

    // Wait for completion
    const finalStatus = await pollSessionStatus(baseUrl, sessionId, ["done", "failed"], 120_000);
    expect(finalStatus.status).toBe("done");

    // Verify session completed successfully
    const session = getSession(sessionDb, sessionId);
    expect(session!.status).toBe("done");
    expect(session!.chunksReceived).toBe(3);
  }, 300_000);

  // -------------------------------------------------------------------------
  // Test 4: single chunk session
  // -------------------------------------------------------------------------
  it("single chunk session", async () => {
    const sessionId = crypto.randomUUID();

    // Upload 1 chunk only
    const wav = loadChunkFixture(0);
    const res = await uploadChunk(baseUrl, sessionId, 0, wav);
    expect(res.status).toBe(200);

    // Send session-end
    const endRes = await sendSessionEnd(baseUrl, sessionId);
    expect(endRes.status).toBe(200);

    // Wait for completion
    const finalStatus = await pollSessionStatus(baseUrl, sessionId, ["done", "failed"], 120_000);
    expect(finalStatus.status).toBe("done");

    // Verify transcript exists
    const dataDir = path.join(tmpDir, "audio");
    const transcriptPath = path.join(dataDir, "transcripts", `${sessionId}.json`);
    expect(fs.existsSync(transcriptPath)).toBe(true);

    const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
    expect(transcript.fullText.length).toBeGreaterThan(0);
    expect(transcript.segments.length).toBeGreaterThan(0);
  }, 300_000);
});
