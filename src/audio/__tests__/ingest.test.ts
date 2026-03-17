import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestServer } from "../ingest.js";
import { getSession } from "../session-store.js";
import type { AudioConfig } from "../types.js";

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

function makeWavData(sizeBytes = 1024): Buffer {
  // Minimal WAV-like data (just raw bytes for testing)
  return Buffer.alloc(sizeBytes, 0x42);
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
    const wavData = makeWavData(2048);
    const { body, contentType } = buildMultipart(
      { session_id: TEST_SESSION_ID, sequence: "0" },
      { name: "file", filename: "chunk.wav", data: wavData },
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
    expect(json.size_bytes).toBe(2048);

    // Verify file on disk
    const expectedPath = path.join(srv.config.dataDir, "inbox", TEST_SESSION_ID, "chunk-0000.wav");
    expect(fs.existsSync(expectedPath)).toBe(true);
    const stored = fs.readFileSync(expectedPath);
    expect(stored.length).toBe(2048);

    // Verify DB session
    const session = getSession(srv.db, TEST_SESSION_ID);
    expect(session).not.toBeNull();
    expect(session!.status).toBe("receiving");
    expect(session!.chunksReceived).toBe(1);
  });

  it("returns 400 when session_id is missing", async () => {
    const { body, contentType } = buildMultipart(
      { sequence: "0" },
      { name: "file", filename: "chunk.wav", data: makeWavData() },
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
      { name: "file", filename: "chunk.wav", data: makeWavData() },
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
      { name: "file", filename: "chunk.wav", data: makeWavData() },
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
        { name: "file", filename: "chunk.wav", data: makeWavData(512) },
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
      { name: "file", filename: "chunk.wav", data: makeWavData(2048) },
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
      { name: "file", filename: "chunk.wav", data: makeWavData(256) },
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
      { name: "file", filename: "chunk.wav", data: makeWavData() },
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
        { name: "file", filename: `chunk-${seq}.wav`, data: makeWavData(1024 + seq * 100) },
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
          { name: "file", filename: "chunk.wav", data: makeWavData(512) },
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
