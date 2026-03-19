/**
 * Cross-stack integration tests — verifies the TypeScript ingest server
 * accepts requests matching the EXACT format the Rust shipper produces.
 *
 * Every field name, content type, header, and body format in this file is
 * derived from reading the Rust source:
 *
 *   tools/cortex-audio/shipper/src/upload.rs
 *     - upload_chunk(): multipart form with fields session_id (text),
 *       sequence (text), audio (file part, mime "audio/wav")
 *     - Auth header: "Bearer {api_key}"
 *     - send_session_end(): JSON body {"session_id":"<id>"}, Content-Type application/json
 *
 *   tools/cortex-audio/capture/src/chunker.rs
 *     - Filename: {session_id}_chunk-{seq:04}_{timestamp}.wav
 *     - Sequence starts at 0 (ChunkWriter::new sets self.sequence = 0)
 *
 *   tools/cortex-audio/shipper/src/lib.rs
 *     - next_seq: or_insert(0) — 0-based sequencing
 *
 * A companion Rust contract test (shipper/tests/field_contract.rs) asserts
 * the constants and multipart body content haven't drifted.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createTestServer } from "../ingest.js";
import { getSession } from "../session-store.js";

// ---------------------------------------------------------------------------
// Contract constants — derived from Rust shipper/src/upload.rs lines 7-11
// ---------------------------------------------------------------------------

/** upload.rs line 7: pub const FIELD_SESSION_ID: &str = "session_id"; */
const FIELD_SESSION_ID = "session_id";

/** upload.rs line 8: pub const FIELD_SEQUENCE: &str = "sequence"; */
const FIELD_SEQUENCE = "sequence";

/** upload.rs line 9: pub const FIELD_AUDIO: &str = "audio"; */
const FIELD_AUDIO = "audio";

/** upload.rs line 10: pub const CHUNK_UPLOAD_PATH: &str = "/audio/chunk"; */
const CHUNK_UPLOAD_PATH = "/audio/chunk";

/** upload.rs line 11: pub const SESSION_END_PATH: &str = "/audio/session-end"; */
const SESSION_END_PATH = "/audio/session-end";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const API_KEY = "test-key-123";
let tmpDir: string;
let srv: ReturnType<typeof createTestServer>;

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Minimal valid WAV file: 44-byte header + silence samples.
 * Mono, 16-bit, 16kHz — matches what the Rust capture engine produces.
 */
function makeWav(extraBytes = 256): Buffer {
  const dataSize = extraBytes;
  const fileSize = 36 + dataSize;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // subchunk1 size
  header.writeUInt16LE(1, 20);  // PCM
  header.writeUInt16LE(1, 22);  // mono
  header.writeUInt32LE(16000, 24); // sample rate
  header.writeUInt32LE(32000, 28); // byte rate
  header.writeUInt16LE(2, 32);  // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

// ---------------------------------------------------------------------------
// Multipart builder — matches reqwest::multipart::Form output structure
//
// Rust reqwest builds multipart/form-data per RFC 7578. The field order
// matches upload.rs lines 39-48:
//   1. text(FIELD_SESSION_ID, session_id)
//   2. text(FIELD_SEQUENCE, sequence.to_string())
//   3. part(FIELD_AUDIO, Part::bytes(data).file_name(name).mime_str("audio/wav"))
// ---------------------------------------------------------------------------

function buildMultipart(
  fields: Array<{ name: string; value: string }>,
  filePart?: { name: string; filename: string; contentType: string; data: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = "----CrossStackTest" + Date.now();
  const parts: Buffer[] = [];

  for (const { name, value } of fields) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
    ));
  }

  if (filePart) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${filePart.name}"; filename="${filePart.filename}"\r\n` +
      `Content-Type: ${filePart.contentType}\r\n\r\n`,
    ));
    parts.push(filePart.data);
    parts.push(Buffer.from("\r\n"));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Send a raw HTTP request matching how the Rust client sends requests. */
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

/**
 * Upload a chunk matching the exact Rust upload_chunk() format.
 * See upload.rs lines 39-55.
 */
function uploadChunkLikeRust(
  baseUrl: string,
  sessionId: string,
  sequence: number,
  wav: Buffer,
  timestamp = 1710700000,
): Promise<{ status: number; body: string; json: () => unknown }> {
  // Filename format from chunker.rs line 125-128:
  //   format!("{}_chunk-{:04}_{}.wav", self.session_id, self.sequence, ts)
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
      data: wav,
    },
  );

  // Auth header from upload.rs line 52:
  //   .header("Authorization", format!("Bearer {}", api_key))
  return rawRequest(
    `${baseUrl}${CHUNK_UPLOAD_PATH}`,
    "POST",
    {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": contentType,
    },
    body,
  );
}

/**
 * Send session-end matching the exact Rust send_session_end() format.
 * See upload.rs lines 77-82.
 */
function sendSessionEndLikeRust(
  baseUrl: string,
  sessionId: string,
): Promise<{ status: number; body: string; json: () => unknown }> {
  // Body from upload.rs line 80:
  //   .body(format!(r#"{{"{}":"{}"}}"#, FIELD_SESSION_ID, session_id))
  const endBody = JSON.stringify({ [FIELD_SESSION_ID]: sessionId });

  return rawRequest(
    `${baseUrl}${SESSION_END_PATH}`,
    "POST",
    {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    endBody,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("cross-stack contract: TypeScript multipart (matching Rust format) → TypeScript ingest server", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-stack-"));
    srv = createTestServer({ dataDir: tmpDir });
  });

  afterEach(() => {
    srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Test 1: server accepts multipart with field names matching Rust client
  //
  // Verifies: the three field names from upload.rs (session_id, sequence,
  // audio) are accepted by the TS server's parseMultipart + field lookup.
  // -----------------------------------------------------------------------
  it("server accepts multipart with field names matching Rust client", async () => {
    const sessionId = uuid();
    const wav = makeWav();

    const res = await uploadChunkLikeRust(srv.baseUrl, sessionId, 0, wav);

    expect(res.status).toBe(200);
    const json = res.json() as { ok: boolean; session_id: string; sequence: number };
    expect(json.ok).toBe(true);
    expect(json.session_id).toBe(sessionId);
    expect(json.sequence).toBe(0);

    // Verify server-side state
    const session = getSession(srv.db, sessionId);
    expect(session).toBeDefined();
    expect(session!.chunksReceived).toBe(1);
    expect(session!.status).toBe("receiving");

    // Verify chunk file written to disk with correct name
    const chunkPath = path.join(tmpDir, "inbox", sessionId, "chunk-0000.wav");
    expect(fs.existsSync(chunkPath)).toBe(true);
    // Verify the WAV data round-tripped (not silently dropped or truncated)
    const stored = fs.readFileSync(chunkPath);
    expect(stored.length).toBe(wav.length);
  });

  // -----------------------------------------------------------------------
  // Test 2: first chunk has sequence 0 — 0-based contract
  //
  // This is the test that would have caught bug #1 (or_insert(1)).
  // The capture engine (chunker.rs line 41) starts at sequence 0.
  // The shipper (lib.rs line 131) starts next_seq at 0.
  // The server must accept sequence 0 and store as chunk-0000.wav.
  // -----------------------------------------------------------------------
  it("first chunk has sequence 0 — 0-based contract", async () => {
    const sessionId = uuid();
    const wav = makeWav();

    const res = await uploadChunkLikeRust(srv.baseUrl, sessionId, 0, wav);

    expect(res.status).toBe(200);
    const json = res.json() as { sequence: number };
    expect(json.sequence).toBe(0);

    // Server stores it as chunk-0000.wav (0-padded, 0-based)
    const chunkPath = path.join(tmpDir, "inbox", sessionId, "chunk-0000.wav");
    expect(fs.existsSync(chunkPath)).toBe(true);

    // Explicitly verify: chunk-0001.wav does NOT exist (no off-by-one)
    const wrongPath = path.join(tmpDir, "inbox", sessionId, "chunk-0001.wav");
    expect(fs.existsSync(wrongPath)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 3: chunks 0, 1, 2 uploaded and stored in order
  //
  // Full sequence contract: three chunks starting at 0, stored as
  // chunk-0000, chunk-0001, chunk-0002. Session-end reports no gaps.
  // -----------------------------------------------------------------------
  it("chunks 0, 1, 2 uploaded and stored in order", async () => {
    const sessionId = uuid();
    const chunkCount = 3;

    for (let seq = 0; seq < chunkCount; seq++) {
      const wav = makeWav();
      const timestamp = 1710700000 + seq * 30;
      const res = await uploadChunkLikeRust(srv.baseUrl, sessionId, seq, wav, timestamp);
      expect(res.status).toBe(200);
    }

    // Verify all chunks received
    const session = getSession(srv.db, sessionId);
    expect(session).toBeDefined();
    expect(session!.chunksReceived).toBe(chunkCount);

    // Send session-end
    const endRes = await sendSessionEndLikeRust(srv.baseUrl, sessionId);
    expect(endRes.status).toBe(200);

    const json = endRes.json() as {
      status: string;
      chunks_received: number;
      sequence_gaps: number[];
    };
    expect(json.status).toBe("pending_transcription");
    expect(json.chunks_received).toBe(chunkCount);
    expect(json.sequence_gaps).toEqual([]);

    // Verify chunk files exist with correct 0-based names
    for (let seq = 0; seq < chunkCount; seq++) {
      const chunkPath = path.join(
        tmpDir, "inbox", sessionId,
        `chunk-${String(seq).padStart(4, "0")}.wav`,
      );
      expect(fs.existsSync(chunkPath)).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // Test 4: missing chunk 0 triggers gap detection
  //
  // If the shipper skips chunk 0 (the bug), session-end must detect the gap.
  // Upload chunks 1 and 2 only. Expect sequence_gaps to include 0.
  // -----------------------------------------------------------------------
  it("missing chunk 0 triggers gap detection", async () => {
    const sessionId = uuid();

    // Upload chunks 1 and 2 — skip 0
    for (const seq of [1, 2]) {
      const wav = makeWav();
      const res = await uploadChunkLikeRust(srv.baseUrl, sessionId, seq, wav);
      expect(res.status).toBe(200);
    }

    // Session has 2 chunks received
    const session = getSession(srv.db, sessionId);
    expect(session!.chunksReceived).toBe(2);

    // Send session-end — server checks for gaps in 0..chunksReceived-1
    const endRes = await sendSessionEndLikeRust(srv.baseUrl, sessionId);
    expect(endRes.status).toBe(200);

    const json = endRes.json() as { sequence_gaps: number[] };
    // Gap detection loops 0..chunksReceived(2), so checks for chunk-0000 and chunk-0001.
    // chunk-0000 is missing → gap at 0.
    // chunk-0001 exists (we uploaded seq=1 which stores as chunk-0001).
    expect(json.sequence_gaps).toContain(0);
  });

  // -----------------------------------------------------------------------
  // Test 5: session-end body format matches Rust client
  //
  // Rust send_session_end() (upload.rs lines 77-82) sends:
  //   POST /audio/session-end
  //   Authorization: Bearer {api_key}
  //   Content-Type: application/json
  //   Body: {"session_id":"<uuid>"}
  // -----------------------------------------------------------------------
  it("session-end body format matches Rust client", async () => {
    const sessionId = uuid();
    const wav = makeWav();

    // Must upload at least one chunk first
    await uploadChunkLikeRust(srv.baseUrl, sessionId, 0, wav);

    const endRes = await sendSessionEndLikeRust(srv.baseUrl, sessionId);
    expect(endRes.status).toBe(200);

    const json = endRes.json() as {
      ok: boolean;
      session_id: string;
      status: string;
      chunks_received: number;
    };
    expect(json.ok).toBe(true);
    expect(json.session_id).toBe(sessionId);
    expect(json.status).toBe("pending_transcription");
    expect(json.chunks_received).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 6: backward compat — "file" field name still accepted
  //
  // The Rust client uses "audio" (upload.rs line 9), but the server
  // also accepts "file" for backward compatibility (ingest.ts line 266:
  //   f.name === "file" || f.name === "audio")
  // This is DEPRECATED — new clients must use "audio".
  // -----------------------------------------------------------------------
  it("backward compat — 'file' field name still accepted (deprecated)", async () => {
    const sessionId = uuid();
    const wav = makeWav();

    const { body, contentType } = buildMultipart(
      [
        { name: FIELD_SESSION_ID, value: sessionId },
        { name: FIELD_SEQUENCE, value: "0" },
      ],
      {
        name: "file", // deprecated — Rust client uses "audio"
        filename: "chunk.wav",
        contentType: "audio/wav",
        data: wav,
      },
    );

    const res = await rawRequest(
      `${srv.baseUrl}${CHUNK_UPLOAD_PATH}`,
      "POST",
      { Authorization: `Bearer ${API_KEY}`, "Content-Type": contentType },
      body,
    );

    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // Test 7: auth header format matches Rust client
  //
  // Rust upload.rs line 52:
  //   .header("Authorization", format!("Bearer {}", api_key))
  // Must be exactly "Bearer <key>" — not "bearer", not "Token", not empty.
  // -----------------------------------------------------------------------
  it("auth header format matches Rust client", async () => {
    const sessionId = uuid();
    const wav = makeWav();

    // Correct auth — matches Rust format
    const goodRes = await uploadChunkLikeRust(srv.baseUrl, sessionId, 0, wav);
    expect(goodRes.status).toBe(200);

    // Wrong auth scheme — "Token" instead of "Bearer"
    const { body: body2, contentType: ct2 } = buildMultipart(
      [
        { name: FIELD_SESSION_ID, value: uuid() },
        { name: FIELD_SEQUENCE, value: "0" },
      ],
      { name: FIELD_AUDIO, filename: "chunk.wav", contentType: "audio/wav", data: wav },
    );
    const badScheme = await rawRequest(
      `${srv.baseUrl}${CHUNK_UPLOAD_PATH}`,
      "POST",
      { Authorization: `Token ${API_KEY}`, "Content-Type": ct2 },
      body2,
    );
    expect(badScheme.status).toBe(401);

    // Missing auth header entirely
    const { body: body3, contentType: ct3 } = buildMultipart(
      [
        { name: FIELD_SESSION_ID, value: uuid() },
        { name: FIELD_SEQUENCE, value: "0" },
      ],
      { name: FIELD_AUDIO, filename: "chunk.wav", contentType: "audio/wav", data: wav },
    );
    const noAuth = await rawRequest(
      `${srv.baseUrl}${CHUNK_UPLOAD_PATH}`,
      "POST",
      { "Content-Type": ct3 },
      body3,
    );
    expect(noAuth.status).toBe(401);

    // Wrong key
    const { body: body4, contentType: ct4 } = buildMultipart(
      [
        { name: FIELD_SESSION_ID, value: uuid() },
        { name: FIELD_SEQUENCE, value: "0" },
      ],
      { name: FIELD_AUDIO, filename: "chunk.wav", contentType: "audio/wav", data: wav },
    );
    const wrongKey = await rawRequest(
      `${srv.baseUrl}${CHUNK_UPLOAD_PATH}`,
      "POST",
      { Authorization: "Bearer wrong-key", "Content-Type": ct4 },
      body4,
    );
    expect(wrongKey.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Test 8: capture engine filename format is parseable by server
  //
  // The capture engine (chunker.rs line 125-128) produces filenames like:
  //   {session_id}_chunk-{seq:04}_{timestamp}.wav
  // The Rust shipper passes this filename as the multipart file part's
  // filename (upload.rs line 33-37). The server must accept it.
  // -----------------------------------------------------------------------
  it("capture engine filename format is accepted by server", async () => {
    const sessionId = uuid();
    const wav = makeWav();
    const timestamp = Math.floor(Date.now() / 1000);
    const captureFilename = `${sessionId}_chunk-0000_${timestamp}.wav`;

    const { body, contentType } = buildMultipart(
      [
        { name: FIELD_SESSION_ID, value: sessionId },
        { name: FIELD_SEQUENCE, value: "0" },
      ],
      {
        name: FIELD_AUDIO,
        filename: captureFilename,
        contentType: "audio/wav",
        data: wav,
      },
    );

    const res = await rawRequest(
      `${srv.baseUrl}${CHUNK_UPLOAD_PATH}`,
      "POST",
      { Authorization: `Bearer ${API_KEY}`, "Content-Type": contentType },
      body,
    );

    expect(res.status).toBe(200);

    // Server stores by sequence number, not by original filename
    const storedPath = path.join(tmpDir, "inbox", sessionId, "chunk-0000.wav");
    expect(fs.existsSync(storedPath)).toBe(true);
  });
});
