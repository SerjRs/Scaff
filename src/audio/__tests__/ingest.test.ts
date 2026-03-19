import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestServer, createGatewayAudioHandler } from "../ingest.js";
import type { AudioGatewayDeps } from "../ingest.js";
import { getSession, initAudioSessionTable } from "../session-store.js";
import type { AudioConfig, AudioCaptureConfig } from "../types.js";
import { DEFAULT_AUDIO_CAPTURE_CONFIG } from "../types.js";
import { buildWav } from "../wav-utils.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let srv: ReturnType<typeof createTestServer>;

const API_KEY = "test-key-123";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}` };
}

/** Build a minimal multipart/form-data body. */
function buildMultipart(
  fields: Record<string, string>,
  file?: { name: string; filename: string; data: Buffer; contentType?: string },
): { body: Buffer; contentType: string } {
  const boundary = "----TestBoundary" + Date.now();
  const parts: Buffer[] = [];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
      `${value}\r\n`,
    ));
  }

  if (file) {
    const ct = file.contentType ?? "application/octet-stream";
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${ct}\r\n\r\n`,
    ));
    parts.push(file.data);
    parts.push(Buffer.from("\r\n"));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const TEST_SESSION_ID = "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4";

/** Build a valid WAV file with silent PCM data (mono 16-bit 16kHz). */
function makeValidWav(durationMs = 100): Buffer {
  const sampleRate = 16000;
  const frames = Math.ceil(sampleRate * durationMs / 1000);
  const pcm = Buffer.alloc(frames * 2); // mono 16-bit silence
  return buildWav(pcm, 1, sampleRate, 16);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-ingest-test-"));
  const dataDir = path.join(tmpDir, "data", "audio");
  const dbPath = path.join(tmpDir, "test.sqlite");

  srv = createTestServer({ dataDir, apiKey: API_KEY }, dbPath);
});

afterEach(() => {
  srv.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe("auth", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await fetch(`${srv.baseUrl}/audio/chunk`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong API key", async () => {
    const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with malformed Authorization header", async () => {
    const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /audio/chunk
// ---------------------------------------------------------------------------

describe("POST /audio/chunk", () => {
  it("stores a valid chunk and returns 200", async () => {
    const wavData = makeValidWav(200);
    const { body, contentType } = buildMultipart(
      { session_id: TEST_SESSION_ID, sequence: "0" },
      { name: "audio", filename: "chunk.wav", data: wavData },
    );

    const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": contentType },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.session_id).toBe(TEST_SESSION_ID);
    expect(json.sequence).toBe(0);
    expect(json.size_bytes).toBe(wavData.length);

    // Verify file on disk — stored as chunk-0000.wav with valid WAV header
    const expectedPath = path.join(srv.config.dataDir, "inbox", TEST_SESSION_ID, "chunk-0000.wav");
    expect(fs.existsSync(expectedPath)).toBe(true);
    const stored = fs.readFileSync(expectedPath);
    expect(stored.length).toBe(wavData.length);
    // Verify RIFF header (valid WAV)
    expect(stored.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(stored.subarray(8, 12).toString("ascii")).toBe("WAVE");

    // Verify DB session
    const session = getSession(srv.db, TEST_SESSION_ID);
    expect(session).not.toBeNull();
    expect(session!.status).toBe("receiving");
    expect(session!.chunksReceived).toBe(1);
  });

  it("returns 400 when session_id is missing", async () => {
    const { body, contentType } = buildMultipart(
      { sequence: "0" },
      { name: "audio", filename: "chunk.wav", data: makeValidWav() },
    );

    const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": contentType },
      body,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when session_id is not a UUID", async () => {
    const { body, contentType } = buildMultipart(
      { session_id: "not-a-uuid", sequence: "0" },
      { name: "audio", filename: "chunk.wav", data: makeValidWav() },
    );

    const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": contentType },
      body,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when sequence is negative", async () => {
    const { body, contentType } = buildMultipart(
      { session_id: TEST_SESSION_ID, sequence: "-1" },
      { name: "audio", filename: "chunk.wav", data: makeValidWav() },
    );

    const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": contentType },
      body,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when Content-Type is not multipart", async () => {
    const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: TEST_SESSION_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("stores multiple chunks with different sequences", async () => {
    for (let seq = 0; seq < 3; seq++) {
      const { body, contentType } = buildMultipart(
        { session_id: TEST_SESSION_ID, sequence: String(seq) },
        { name: "audio", filename: "chunk.wav", data: makeValidWav() },
      );

      const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": contentType },
        body,
      });
      expect(res.status).toBe(200);
    }

    // Verify all files
    for (let seq = 0; seq < 3; seq++) {
      const p = path.join(srv.config.dataDir, "inbox", TEST_SESSION_ID, `chunk-${String(seq).padStart(4, "0")}.wav`);
      expect(fs.existsSync(p)).toBe(true);
    }

    const session = getSession(srv.db, TEST_SESSION_ID);
    expect(session!.chunksReceived).toBe(3);
  });

  it("returns 413 when chunk exceeds max size", async () => {
    // Create server with 1 KB max
    srv.close();
    const dataDir = path.join(tmpDir, "data2", "audio");
    const dbPath = path.join(tmpDir, "test2.sqlite");
    srv = createTestServer({ dataDir, apiKey: API_KEY, maxChunkSizeMB: 0.001 }, dbPath);

    const { body, contentType } = buildMultipart(
      { session_id: TEST_SESSION_ID, sequence: "0" },
      { name: "audio", filename: "chunk.wav", data: makeValidWav(500) },
    );

    const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": contentType },
      body,
    });
    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// POST /audio/session-end
// ---------------------------------------------------------------------------

describe("POST /audio/session-end", () => {
  async function uploadChunk(sessionId: string, sequence: number): Promise<void> {
    const { body, contentType } = buildMultipart(
      { session_id: sessionId, sequence: String(sequence) },
      { name: "audio", filename: "chunk.wav", data: makeValidWav() },
    );
    const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": contentType },
      body,
    });
    expect(res.status).toBe(200);
  }

  it("marks session as pending_transcription when chunks exist", async () => {
    await uploadChunk(TEST_SESSION_ID, 0);
    await uploadChunk(TEST_SESSION_ID, 1);

    const res = await fetch(`${srv.baseUrl}/audio/session-end`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: TEST_SESSION_ID }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.status).toBe("pending_transcription");
    expect(json.chunks_received).toBe(2);
    expect(json.sequence_gaps).toEqual([]);

    const session = getSession(srv.db, TEST_SESSION_ID);
    expect(session!.status).toBe("pending_transcription");
    expect(session!.completedAt).not.toBeNull();
  });

  it("returns 400 for unknown session", async () => {
    const res = await fetch(`${srv.baseUrl}/audio/session-end`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: TEST_SESSION_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when no chunks received", async () => {
    // Create session but don't upload chunks — need to manually insert
    const { initAudioSessionTable, upsertSession } = await import("../session-store.js");
    upsertSession(srv.db, TEST_SESSION_ID);

    const res = await fetch(`${srv.baseUrl}/audio/session-end`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: TEST_SESSION_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 with invalid JSON body", async () => {
    const res = await fetch(`${srv.baseUrl}/audio/session-end`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("detects sequence gaps", async () => {
    await uploadChunk(TEST_SESSION_ID, 0);
    await uploadChunk(TEST_SESSION_ID, 2); // skip 1

    const res = await fetch(`${srv.baseUrl}/audio/session-end`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: TEST_SESSION_ID }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.sequence_gaps).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// GET /audio/session/:id/status
// ---------------------------------------------------------------------------

describe("GET /audio/session/:id/status", () => {
  it("returns session status after chunks uploaded", async () => {
    // Upload a chunk first to create session
    const { body, contentType } = buildMultipart(
      { session_id: TEST_SESSION_ID, sequence: "0" },
      { name: "audio", filename: "chunk.wav", data: makeValidWav() },
    );
    await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": contentType },
      body,
    });

    const res = await fetch(`${srv.baseUrl}/audio/session/${TEST_SESSION_ID}/status`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.session_id).toBe(TEST_SESSION_ID);
    expect(json.status).toBe("receiving");
    expect(json.chunks_received).toBe(1);
    expect(json.created_at).toBeDefined();
  });

  it("returns 404 for unknown session", async () => {
    const res = await fetch(`${srv.baseUrl}/audio/session/${TEST_SESSION_ID}/status`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid session ID", async () => {
    const res = await fetch(`${srv.baseUrl}/audio/session/not-a-uuid/status`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Config: disabled audio
// ---------------------------------------------------------------------------

describe("disabled audio", () => {
  it("returns 404 when audio is disabled", async () => {
    srv.close();
    const dataDir = path.join(tmpDir, "data-disabled", "audio");
    const dbPath = path.join(tmpDir, "test-disabled.sqlite");
    srv = createTestServer({ dataDir, apiKey: API_KEY, enabled: false }, dbPath);

    const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    const json = await res.json() as any;
    expect(json.error.message).toContain("disabled");
  });
});

// ---------------------------------------------------------------------------
// E2E: Full upload cycle
// ---------------------------------------------------------------------------

describe("E2E: full upload cycle", () => {
  it("uploads 3 chunks, ends session, verifies files and DB", async () => {
    for (let seq = 0; seq < 3; seq++) {
      const { body, contentType } = buildMultipart(
        { session_id: TEST_SESSION_ID, sequence: String(seq) },
        { name: "audio", filename: `chunk-${seq}.wav`, data: makeValidWav(100 + seq * 50) },
      );
      const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": contentType },
        body,
      });
      expect(res.status).toBe(200);
    }

    // End session
    const endRes = await fetch(`${srv.baseUrl}/audio/session-end`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: TEST_SESSION_ID }),
    });
    expect(endRes.status).toBe(200);
    const endJson = await endRes.json() as any;
    expect(endJson.status).toBe("pending_transcription");
    expect(endJson.sequence_gaps).toEqual([]);

    // Verify files on disk
    const inboxDir = path.join(srv.config.dataDir, "inbox", TEST_SESSION_ID);
    expect(fs.readdirSync(inboxDir).sort()).toEqual([
      "chunk-0000.wav",
      "chunk-0001.wav",
      "chunk-0002.wav",
    ]);

    // Verify DB
    const session = getSession(srv.db, TEST_SESSION_ID);
    expect(session!.status).toBe("pending_transcription");
    expect(session!.chunksReceived).toBe(3);

    // Verify status endpoint
    const statusRes = await fetch(`${srv.baseUrl}/audio/session/${TEST_SESSION_ID}/status`, {
      headers: authHeaders(),
    });
    expect(statusRes.status).toBe(200);
    const statusJson = await statusRes.json() as any;
    expect(statusJson.status).toBe("pending_transcription");
  });
});

// ---------------------------------------------------------------------------
// E2E: Concurrent sessions
// ---------------------------------------------------------------------------

describe("E2E: concurrent sessions", () => {
  it("handles two sessions uploading simultaneously", async () => {
    const sessionA = "aaaaaaaa-1111-2222-3333-444444444444";
    const sessionB = "bbbbbbbb-1111-2222-3333-444444444444";

    // Upload chunks interleaved
    for (let seq = 0; seq < 2; seq++) {
      const uploads = [sessionA, sessionB].map(async (sid) => {
        const { body, contentType } = buildMultipart(
          { session_id: sid, sequence: String(seq) },
          { name: "audio", filename: "chunk.wav", data: makeValidWav() },
        );
        const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": contentType },
          body,
        });
        expect(res.status).toBe(200);
      });
      await Promise.all(uploads);
    }

    // Both sessions should have 2 chunks each
    const sA = getSession(srv.db, sessionA);
    const sB = getSession(srv.db, sessionB);
    expect(sA!.chunksReceived).toBe(2);
    expect(sB!.chunksReceived).toBe(2);

    // Files should be isolated
    const dirA = path.join(srv.config.dataDir, "inbox", sessionA);
    const dirB = path.join(srv.config.dataDir, "inbox", sessionB);
    expect(fs.readdirSync(dirA).length).toBe(2);
    expect(fs.readdirSync(dirB).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Backward compat: "file" field name (deprecated)
// ---------------------------------------------------------------------------

describe("backward compat: 'file' field name (deprecated)", () => {
  // The Rust client sends "audio" (current contract). The old field name
  // "file" is still accepted for backward compatibility but should not be
  // used by new clients. This test ensures the server keeps accepting it.
  it("still accepts 'file' field name for backward compatibility", async () => {
    const wavData = makeValidWav();
    const { body, contentType } = buildMultipart(
      { session_id: TEST_SESSION_ID, sequence: "0" },
      { name: "file", filename: "chunk.wav", data: wavData }, // deprecated field name
    );

    const res = await fetch(`${srv.baseUrl}/audio/chunk`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": contentType },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.session_id).toBe(TEST_SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// Session-end triggers transcription (via createGatewayAudioHandler)
// ---------------------------------------------------------------------------

describe("session-end triggers transcription via gateway handler", () => {
  it("fires workerDeps callback after session-end", async () => {
    // Use createGatewayAudioHandler (production factory) with workerDeps
    const { DatabaseSync } = requireNodeSqlite();
    const dataDir = path.join(tmpDir, "data-gw", "audio");
    const dbPath = path.join(tmpDir, "gw.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    initAudioSessionTable(db);
    for (const sub of ["inbox", "processed", "transcripts"]) {
      fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
    }

    const transcribedSessions: string[] = [];
    const config: AudioCaptureConfig = {
      ...DEFAULT_AUDIO_CAPTURE_CONFIG,
      enabled: true,
      apiKey: API_KEY,
      dataDir,
    };

    const deps: AudioGatewayDeps = {
      db,
      config,
      workerDeps: {
        sessionDb: db,
        onIngest: async (prompt, sessionId) => {
          transcribedSessions.push(sessionId);
        },
      },
    };

    const handler = createGatewayAudioHandler(deps);

    // Create a real HTTP server with the gateway handler
    const gwServer = (await import("node:http")).createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end('{"error":"not found"}');
      }
    });
    gwServer.listen(0);
    const gwAddr = gwServer.address() as { port: number };
    const gwUrl = `http://127.0.0.1:${gwAddr.port}`;

    try {
      // Upload 2 chunks via the gateway handler
      for (let seq = 0; seq < 2; seq++) {
        const { body, contentType } = buildMultipart(
          { session_id: TEST_SESSION_ID, sequence: String(seq) },
          { name: "audio", filename: "chunk.wav", data: makeValidWav() },
        );
        const res = await fetch(`${gwUrl}/audio/chunk`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": contentType },
          body,
        });
        expect(res.status).toBe(200);
      }

      // Send session-end — this should trigger transcription fire-and-forget
      const endRes = await fetch(`${gwUrl}/audio/session-end`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: TEST_SESSION_ID }),
      });
      expect(endRes.status).toBe(200);
      const endJson = await endRes.json() as any;
      expect(endJson.status).toBe("pending_transcription");

      // Response confirms pending_transcription (sent before worker starts)
      // The DB may already be updated by the fire-and-forget worker, so
      // rely on the HTTP response for the pre-worker state.

      // Wait for the fire-and-forget worker to attempt transcription.
      // It will fail (no whisper binary) but it MUST attempt — proving the
      // session-end → worker trigger path is wired.
      await new Promise((r) => setTimeout(r, 1000));

      const afterWorker = getSession(db, TEST_SESSION_ID);
      expect(afterWorker).not.toBeNull();
      // Worker tried to run and failed (no whisper) — status must be
      // "transcribing" or "failed", NOT still "pending_transcription".
      // This proves the fire-and-forget trigger works.
      expect(["transcribing", "failed"]).toContain(afterWorker!.status);
      if (afterWorker!.status === "failed") {
        expect(afterWorker!.error).toBeTruthy();
      }
    } finally {
      gwServer.close();
      try { db.close(); } catch { /* ignore */ }
    }
  });
});
