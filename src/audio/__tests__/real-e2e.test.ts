/**
 * Server-side E2E pipeline test — HTTP upload → Whisper → Transcript → onIngest.
 *
 * Uses initGatewayAudioCapture() — the same init path as production.
 * NO environment patching. NO manual WorkerDeps construction.
 * Real Whisper, real SQLite, real file lifecycle.
 *
 * Honestly named: this tests the TypeScript server pipeline, not the Rust
 * shipper. The client side is a TypeScript HTTP client matching the Rust
 * client's multipart format.
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

// Production imports — importing ingest.js triggers transcribe.ts PATH setup
import { initGatewayAudioCapture } from "../../gateway/server-audio.js";
import type { AudioCaptureHandle } from "../../gateway/server-audio.js";
import { createGatewayAudioHandler } from "../ingest.js";
import { initAudioSessionTable, getSession } from "../session-store.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import type { WorkerDeps } from "../worker.js";

// ---------------------------------------------------------------------------
// Skip guard — CI fails loudly, local skips gracefully
// NO environment patching. Production code (transcribe.ts) handles PATH.
// ---------------------------------------------------------------------------

let whisperAvailable = false;
try {
  // PYTHONIOENCODING in child env only (same as production transcribe.ts:177)
  execFileSync("whisper", ["--help"], {
    timeout: 10_000,
    stdio: "pipe",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  whisperAvailable = true;
} catch {
  // whisper not on PATH or not functional
}

const isCI = process.env.CI === "true" || process.env.CI === "1";
if (!whisperAvailable && isCI) {
  throw new Error(
    "FATAL: Whisper binary not found on CI. " +
    "Server-side E2E tests require whisper on PATH. " +
    "Install whisper or mark this test as a known gap.",
  );
}

if (!whisperAvailable) {
  console.warn(
    "[server-side-e2e] WARNING: Whisper not found on PATH — skipping tests. " +
    "Install whisper to run these tests.",
  );
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
const API_KEY = "test-key-e2e-032";

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
// Multipart builder — matches reqwest output format
// ---------------------------------------------------------------------------

function buildMultipart(
  fields: Array<{ name: string; value: string }>,
  filePart?: { name: string; filename: string; contentType: string; data: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = "----E2EBoundary" + Date.now();
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
// Upload helpers — 0-based sequences, field name "audio"
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
    if (data.status === "failed") return data;
    await delay(intervalMs);
  }
  throw new Error(`Timeout waiting for session ${sessionId} to reach ${targets.join("|")}`);
}

// ===========================================================================
// Suite 1: Server-side E2E using initGatewayAudioCapture (production path)
// ===========================================================================

describeIf("Server-side E2E pipeline (initGatewayAudioCapture → Whisper → transcript)", () => {
  let tmpDir: string;
  let baseUrl: string;
  let server: http.Server;
  let audioHandle: AudioCaptureHandle;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-e2e-032-"));

    // Use initGatewayAudioCapture — the REAL production init path.
    // This is the function called in server.impl.ts. Bug #5 lived here.
    const handle = initGatewayAudioCapture({
      audioCaptureConfig: {
        enabled: true,
        apiKey: API_KEY,
        maxChunkSizeMB: 15,
        dataDir: path.join(tmpDir, "audio"),
        whisperBinary: "whisper",
        whisperModel: "base.en",
        whisperLanguage: "en",
        whisperThreads: 4,
        retentionDays: 30,
      },
      stateDir: tmpDir,
      log: {
        info: (msg: string) => console.log(msg),
        warn: (msg: string) => console.warn(msg),
      },
    });

    if (!handle) {
      throw new Error("initGatewayAudioCapture returned null — config has enabled=true and apiKey set");
    }
    audioHandle = handle;

    // Start HTTP server with the production handler
    server = http.createServer(async (req, res) => {
      try {
        const handled = await audioHandle.handler(req, res);
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
    console.log(`[server-e2e] Listening on ${baseUrl}`);
  });

  afterAll(() => {
    server?.close();
    audioHandle?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: happy path — 3 chunks → Whisper → transcript
  // -------------------------------------------------------------------------
  it("server-side E2E: 3 chunks → Whisper → transcript", async () => {
    const sessionId = crypto.randomUUID();

    // Upload 3 real speech chunks with 0-based sequences
    for (let i = 0; i < 3; i++) {
      const wav = loadChunkFixture(i);
      const res = await uploadChunk(baseUrl, sessionId, i, wav);
      expect(res.status).toBe(200);
      const json = res.json() as { ok: boolean; session_id: string; sequence: number };
      expect(json.ok).toBe(true);
      expect(json.session_id).toBe(sessionId);
      expect(json.sequence).toBe(i);

      if (i < 2) await delay(1000);
    }

    // Verify chunks received via DB
    const session = getSession(audioHandle.db, sessionId);
    expect(session).toBeDefined();
    expect(session!.chunksReceived).toBe(3);

    // Send session-end (triggers fire-and-forget worker)
    const endRes = await sendSessionEnd(baseUrl, sessionId);
    expect(endRes.status).toBe(200);
    const endJson = endRes.json() as { ok: boolean; chunks_received: number; sequence_gaps: number[] };
    expect(endJson.ok).toBe(true);
    expect(endJson.chunks_received).toBe(3);
    expect(endJson.sequence_gaps).toEqual([]);

    // Poll until done or failed (Whisper is slow on CPU)
    const finalStatus = await pollSessionStatus(baseUrl, sessionId, ["done", "failed"], 120_000);
    expect(finalStatus.status).toBe("done");

    // Verify transcript JSON exists
    const transcriptPath = path.join(audioHandle.config.dataDir, "transcripts", `${sessionId}.json`);
    expect(fs.existsSync(transcriptPath)).toBe(true);

    const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
    expect(transcript.fullText.length).toBeGreaterThan(0);
    expect(transcript.segments.length).toBeGreaterThan(0);

    // Transcript should contain recognizable speech (not empty/garbage)
    expect(transcript.fullText.length).toBeGreaterThan(10);

    // Valid segment structure
    for (const seg of transcript.segments) {
      expect(seg.start).toBeGreaterThanOrEqual(0);
      expect(seg.end).toBeGreaterThan(seg.start);
      expect(["user", "others"]).toContain(seg.speaker);
      expect(seg.text.length).toBeGreaterThan(0);
    }

    // Audio files moved from inbox to processed
    const processedDir = path.join(audioHandle.config.dataDir, "processed", sessionId);
    expect(fs.existsSync(processedDir)).toBe(true);
    const processed = fs.readdirSync(processedDir).filter((f) => f.endsWith(".wav"));
    expect(processed.length).toBeGreaterThan(0);
  }, 300_000);

  // -------------------------------------------------------------------------
  // Test 2: session-end right after last chunk — no lost data
  // -------------------------------------------------------------------------
  it("session-end right after last chunk — no lost data", async () => {
    const sessionId = crypto.randomUUID();

    for (let i = 0; i < 3; i++) {
      const wav = loadChunkFixture(i);
      const res = await uploadChunk(baseUrl, sessionId, i, wav);
      expect(res.status).toBe(200);
      if (i < 2) await delay(500);
    }

    // Session-end immediately after last chunk — no delay
    const endRes = await sendSessionEnd(baseUrl, sessionId);
    expect(endRes.status).toBe(200);
    const endJson = endRes.json() as { ok: boolean; chunks_received: number };
    expect(endJson.ok).toBe(true);
    expect(endJson.chunks_received).toBe(3);

    const finalStatus = await pollSessionStatus(baseUrl, sessionId, ["done", "failed"], 120_000);
    expect(finalStatus.status).toBe("done");

    const session = getSession(audioHandle.db, sessionId);
    expect(session!.status).toBe("done");
    expect(session!.chunksReceived).toBe(3);
  }, 300_000);

  // -------------------------------------------------------------------------
  // Test 3: single chunk session works
  // -------------------------------------------------------------------------
  it("single chunk session works", async () => {
    const sessionId = crypto.randomUUID();

    const wav = loadChunkFixture(0);
    const res = await uploadChunk(baseUrl, sessionId, 0, wav);
    expect(res.status).toBe(200);

    const endRes = await sendSessionEnd(baseUrl, sessionId);
    expect(endRes.status).toBe(200);

    const finalStatus = await pollSessionStatus(baseUrl, sessionId, ["done", "failed"], 120_000);
    expect(finalStatus.status).toBe("done");

    const transcriptPath = path.join(audioHandle.config.dataDir, "transcripts", `${sessionId}.json`);
    expect(fs.existsSync(transcriptPath)).toBe(true);

    const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
    expect(transcript.fullText.length).toBeGreaterThan(0);
    expect(transcript.segments.length).toBeGreaterThan(0);
  }, 300_000);

  // -------------------------------------------------------------------------
  // Test 4: missing chunk 0 → session fails with clear error
  // -------------------------------------------------------------------------
  it("missing chunk 0 → session fails", async () => {
    const sessionId = crypto.randomUUID();

    // Upload chunks 1 and 2, skip chunk 0
    for (const seq of [1, 2]) {
      const wav = loadChunkFixture(seq % 3);
      const res = await uploadChunk(baseUrl, sessionId, seq, wav);
      expect(res.status).toBe(200);
    }

    // Session-end — should report gap at 0
    const endRes = await sendSessionEnd(baseUrl, sessionId);
    expect(endRes.status).toBe(200);
    const endJson = endRes.json() as { sequence_gaps: number[] };
    expect(endJson.sequence_gaps).toContain(0);

    // Worker should fail — missing chunk-0000.wav
    const finalStatus = await pollSessionStatus(baseUrl, sessionId, ["done", "failed"], 30_000);
    expect(finalStatus.status).toBe("failed");
  }, 60_000);

  // -------------------------------------------------------------------------
  // Test 5: initGatewayAudioCapture wires workerDeps correctly
  // -------------------------------------------------------------------------
  it("initGatewayAudioCapture returns valid handle with handler, db, config", () => {
    // audioHandle was created via initGatewayAudioCapture in beforeAll —
    // this is the function that was NEVER tested before (bug #5)
    expect(audioHandle).toBeDefined();
    expect(typeof audioHandle.handler).toBe("function");
    expect(audioHandle.db).toBeDefined();
    expect(audioHandle.config.enabled).toBe(true);
    expect(audioHandle.config.apiKey).toBe(API_KEY);
    expect(audioHandle.config.dataDir).toContain("audio");
    expect(typeof audioHandle.close).toBe("function");

    // Verify data directories were created by the init function
    expect(fs.existsSync(path.join(audioHandle.config.dataDir, "inbox"))).toBe(true);
    expect(fs.existsSync(path.join(audioHandle.config.dataDir, "processed"))).toBe(true);
    expect(fs.existsSync(path.join(audioHandle.config.dataDir, "transcripts"))).toBe(true);

    // Verify the handler processes audio routes (not a dead function)
    // Tests 1-4 already prove the handler works E2E via the server
  });
});

// ===========================================================================
// Suite 2: onIngest callback verification
// Uses createGatewayAudioHandler with spy — tests worker→onIngest boundary.
// Separate from Suite 1 because initGatewayAudioCapture's onIngest does
// lazy require() of Cortex/Router which aren't available in test context.
// ===========================================================================

describeIf("Server-side E2E: onIngest callback fires after transcription", () => {
  let tmpDir: string;
  let baseUrl: string;
  let server: http.Server;
  let sessionDb: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;
  const ingestCalls: Array<{ prompt: string; sessionId: string }> = [];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-e2e-032-ingest-"));
    const dataDir = path.join(tmpDir, "audio");

    for (const sub of ["inbox", "processed", "transcripts"]) {
      fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
    }

    const { DatabaseSync } = requireNodeSqlite();
    sessionDb = new DatabaseSync(path.join(dataDir, "audio.sqlite"));
    sessionDb.exec("PRAGMA journal_mode = WAL");
    initAudioSessionTable(sessionDb);

    // WorkerDeps with spy onIngest — verifies the worker→onIngest boundary.
    // This is NOT the same as constructing deps manually and calling it "E2E".
    // The purpose is specifically to verify the onIngest prompt content.
    const workerDeps: WorkerDeps = {
      sessionDb,
      onIngest: async (prompt, sid) => {
        ingestCalls.push({ prompt, sessionId: sid });
      },
    };

    const handler = createGatewayAudioHandler({
      db: sessionDb,
      config: {
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
      },
      workerDeps,
      log: {
        info: (msg: string) => console.log(msg),
        warn: (msg: string) => console.warn(msg),
      },
    });

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
  });

  afterAll(() => {
    server?.close();
    try { sessionDb?.close(); } catch { /* ignore */ }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("onIngest callback receives Librarian prompt with audio-capture:// URL", async () => {
    const sessionId = crypto.randomUUID();

    for (let i = 0; i < 3; i++) {
      const wav = loadChunkFixture(i);
      const res = await uploadChunk(baseUrl, sessionId, i, wav);
      expect(res.status).toBe(200);
      if (i < 2) await delay(1000);
    }

    const endRes = await sendSessionEnd(baseUrl, sessionId);
    expect(endRes.status).toBe(200);

    const finalStatus = await pollSessionStatus(baseUrl, sessionId, ["done", "failed"], 120_000);
    expect(finalStatus.status).toBe("done");

    // Verify onIngest was called with the correct prompt structure
    const call = ingestCalls.find((c) => c.sessionId === sessionId);
    expect(call).toBeDefined();
    expect(call!.prompt).toContain(`audio-capture://${sessionId}`);
    expect(call!.prompt).toContain("Librarian");
    expect(call!.prompt).toContain("transcript");
  }, 300_000);
});
