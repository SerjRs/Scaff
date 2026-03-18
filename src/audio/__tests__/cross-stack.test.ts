/**
 * Cross-stack integration tests — Rust shipper client → TypeScript ingest server.
 *
 * These tests build multipart HTTP requests that exactly match what the Rust
 * `upload_chunk()` / `send_session_end()` functions produce (reqwest multipart),
 * and send them to a real in-process TypeScript ingest server.
 *
 * A companion Rust contract test (`shipper/tests/field_contract.rs`) asserts the
 * constants haven't drifted. Together they guarantee cross-stack compatibility.
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
// Contract constants — must match Rust shipper/src/upload.rs
// ---------------------------------------------------------------------------

const FIELD_SESSION_ID = "session_id";
const FIELD_SEQUENCE = "sequence";
const FIELD_AUDIO = "audio";
const CHUNK_UPLOAD_PATH = "/audio/chunk";
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

/** Minimal WAV header (44 bytes) + silence samples. */
function makeWav(extraBytes = 256): Buffer {
  const header = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x24, 0x00, 0x00, 0x00, // chunk size (placeholder)
    0x57, 0x41, 0x56, 0x45, // "WAVE"
    0x66, 0x6d, 0x74, 0x20, // "fmt "
    0x10, 0x00, 0x00, 0x00, // subchunk1 size (16)
    0x01, 0x00,             // PCM
    0x01, 0x00,             // mono
    0x80, 0x3e, 0x00, 0x00, // 16000 Hz
    0x00, 0x7d, 0x00, 0x00, // byte rate
    0x02, 0x00,             // block align
    0x10, 0x00,             // 16 bits
    0x64, 0x61, 0x74, 0x61, // "data"
    0x00, 0x00, 0x00, 0x00, // data size (placeholder)
  ]);
  return Buffer.concat([header, Buffer.alloc(extraBytes)]);
}

// ---------------------------------------------------------------------------
// Manual multipart builder — matches reqwest's output byte-for-byte
// ---------------------------------------------------------------------------

/**
 * Build a multipart/form-data body manually, matching the format that
 * Rust reqwest produces. No normalisation or re-encoding.
 */
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

/** Send a raw HTTP request and return { status, body }. */
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("cross-stack: Rust shipper → TypeScript ingest", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-stack-"));
    srv = createTestServer({ dataDir: tmpDir });
  });

  afterEach(() => {
    srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Test 1: upload_chunk with Rust client field names
  // -----------------------------------------------------------------------
  it("upload_chunk with Rust client field names", async () => {
    const sessionId = uuid();
    const wav = makeWav();

    const { body, contentType } = buildMultipart(
      [
        { name: FIELD_SESSION_ID, value: sessionId },
        { name: FIELD_SEQUENCE, value: "0" },
      ],
      {
        name: FIELD_AUDIO,
        filename: `${sessionId}_chunk-0000_1710700000.wav`,
        contentType: "audio/wav",
        data: wav,
      },
    );

    const res = await rawRequest(
      `${srv.baseUrl}${CHUNK_UPLOAD_PATH}`,
      "POST",
      {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": contentType,
      },
      body,
    );

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

    // Verify chunk file written to disk
    const chunkPath = path.join(tmpDir, "inbox", sessionId, "chunk-0000.wav");
    expect(fs.existsSync(chunkPath)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 2: session-end after chunk upload
  // -----------------------------------------------------------------------
  it("session-end after chunk upload", async () => {
    const sessionId = uuid();
    const wav = makeWav();

    // Upload one chunk first
    const { body: chunkBody, contentType } = buildMultipart(
      [
        { name: FIELD_SESSION_ID, value: sessionId },
        { name: FIELD_SEQUENCE, value: "0" },
      ],
      {
        name: FIELD_AUDIO,
        filename: `${sessionId}_chunk-0000_1710700000.wav`,
        contentType: "audio/wav",
        data: wav,
      },
    );

    const chunkRes = await rawRequest(
      `${srv.baseUrl}${CHUNK_UPLOAD_PATH}`,
      "POST",
      { Authorization: `Bearer ${API_KEY}`, "Content-Type": contentType },
      chunkBody,
    );
    expect(chunkRes.status).toBe(200);

    // Send session-end (matches Rust send_session_end format exactly)
    const endBody = JSON.stringify({ [FIELD_SESSION_ID]: sessionId });
    const endRes = await rawRequest(
      `${srv.baseUrl}${SESSION_END_PATH}`,
      "POST",
      {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      endBody,
    );

    expect(endRes.status).toBe(200);
    const json = endRes.json() as { ok: boolean; status: string; chunks_received: number };
    expect(json.ok).toBe(true);
    expect(json.status).toBe("pending_transcription");
    expect(json.chunks_received).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 3: full shipper flow with capture engine filenames
  // -----------------------------------------------------------------------
  it("full shipper flow with capture engine filenames", async () => {
    const sessionId = uuid();
    const chunkCount = 3;

    // Upload multiple chunks with capture-engine filename format
    for (let seq = 0; seq < chunkCount; seq++) {
      const timestamp = 1710700000 + seq * 30;
      const filename = `${sessionId}_chunk-${String(seq).padStart(4, "0")}_${timestamp}.wav`;
      const wav = makeWav();

      const { body, contentType } = buildMultipart(
        [
          { name: FIELD_SESSION_ID, value: sessionId },
          { name: FIELD_SEQUENCE, value: String(seq) },
        ],
        {
          name: FIELD_AUDIO,
          filename,
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
    }

    // Verify all chunks received
    const session = getSession(srv.db, sessionId);
    expect(session).toBeDefined();
    expect(session!.chunksReceived).toBe(chunkCount);

    // Send session-end
    const endRes = await rawRequest(
      `${srv.baseUrl}${SESSION_END_PATH}`,
      "POST",
      {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({ [FIELD_SESSION_ID]: sessionId }),
    );

    expect(endRes.status).toBe(200);
    const json = endRes.json() as { status: string; chunks_received: number; sequence_gaps: number[] };
    expect(json.status).toBe("pending_transcription");
    expect(json.chunks_received).toBe(chunkCount);
    expect(json.sequence_gaps).toEqual([]);

    // Verify chunk files exist in inbox
    for (let seq = 0; seq < chunkCount; seq++) {
      const chunkPath = path.join(
        tmpDir, "inbox", sessionId,
        `chunk-${String(seq).padStart(4, "0")}.wav`,
      );
      expect(fs.existsSync(chunkPath)).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // Test 4: field name contract — server accepts both "audio" and "file"
  // -----------------------------------------------------------------------
  it("field name contract: server accepts 'audio' field name", async () => {
    const sessionId = uuid();
    const wav = makeWav();

    const { body, contentType } = buildMultipart(
      [
        { name: "session_id", value: sessionId },
        { name: "sequence", value: "0" },
      ],
      { name: "audio", filename: "chunk.wav", contentType: "audio/wav", data: wav },
    );

    const res = await rawRequest(
      `${srv.baseUrl}/audio/chunk`,
      "POST",
      { Authorization: `Bearer ${API_KEY}`, "Content-Type": contentType },
      body,
    );
    expect(res.status).toBe(200);
  });

  it("field name contract: server also accepts 'file' field name (backwards compat)", async () => {
    const sessionId = uuid();
    const wav = makeWav();

    const { body, contentType } = buildMultipart(
      [
        { name: "session_id", value: sessionId },
        { name: "sequence", value: "0" },
      ],
      { name: "file", filename: "chunk.wav", contentType: "audio/wav", data: wav },
    );

    const res = await rawRequest(
      `${srv.baseUrl}/audio/chunk`,
      "POST",
      { Authorization: `Bearer ${API_KEY}`, "Content-Type": contentType },
      body,
    );
    expect(res.status).toBe(200);
  });
});
