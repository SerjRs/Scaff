/**
 * Sequence numbering contract tests — 0-based indexing at every boundary.
 *
 * These tests exist because the off-by-one bug (or_insert(1) instead of
 * or_insert(0)) proved that 0-based sequencing was never explicitly enforced
 * across the full pipeline. Each test asserts the literal number 0 (or the
 * absence of it) so that changing the starting sequence to 1 breaks tests.
 *
 * Boundaries tested:
 *   1. HTTP upload → server storage (sequence 0 → chunk-0000.wav)
 *   2. Multi-chunk sequence (0, 1, 2 → chunk-0000, chunk-0001, chunk-0002)
 *   3. Gap detection starts at 0 (missing chunk 0 is caught)
 *   4. Gap detection catches missing middle sequence
 *   5. Single chunk at sequence 0 is a valid complete session
 *
 * Companion Rust tests in:
 *   - capture/tests/sequence_contract.rs (ChunkWriter)
 *   - shipper/tests/field_contract.rs (upload body assertions)
 *
 * @see workspace/pipeline/InProgress/041-sequence-numbering-contract/SPEC.md
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { createTestServer } from "../ingest.js";
import { getSession } from "../session-store.js";

// ---------------------------------------------------------------------------
// Constants — must match Rust upload.rs
// ---------------------------------------------------------------------------

const FIELD_SESSION_ID = "session_id";
const FIELD_SEQUENCE = "sequence";
const FIELD_AUDIO = "audio";
const API_KEY = "test-key-123";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let srv: ReturnType<typeof createTestServer>;

function uuid(): string {
  return crypto.randomUUID();
}

/** Minimal valid WAV: 44-byte header + silence. */
function makeWav(extraBytes = 256): Buffer {
  const dataSize = extraBytes;
  const fileSize = 36 + dataSize;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

function buildMultipart(
  fields: Array<{ name: string; value: string }>,
  filePart?: { name: string; filename: string; contentType: string; data: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = "----SeqContract" + Date.now();
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

function uploadChunk(
  baseUrl: string,
  sessionId: string,
  sequence: number,
  wav: Buffer,
): Promise<{ status: number; body: string; json: () => unknown }> {
  const filename = `${sessionId}_chunk-${String(sequence).padStart(4, "0")}_1710700000.wav`;
  const { body, contentType } = buildMultipart(
    [
      { name: FIELD_SESSION_ID, value: sessionId },
      { name: FIELD_SEQUENCE, value: String(sequence) },
    ],
    { name: FIELD_AUDIO, filename, contentType: "audio/wav", data: wav },
  );

  return rawRequest(`${baseUrl}/audio/chunk`, "POST", {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": contentType,
  }, body);
}

function sendSessionEnd(
  baseUrl: string,
  sessionId: string,
): Promise<{ status: number; body: string; json: () => unknown }> {
  return rawRequest(`${baseUrl}/audio/session-end`, "POST", {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  }, JSON.stringify({ [FIELD_SESSION_ID]: sessionId }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sequence numbering contract — 0-based indexing", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seq-contract-"));
    srv = createTestServer({ dataDir: tmpDir });
  });

  afterEach(() => {
    srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: server stores sequence 0 as chunk-0000.wav
  //
  // The server (ingest.ts line 298) formats: chunk-${padStart(4,"0")}.wav
  // Sequence 0 → chunk-0000.wav. NOT chunk-0001.wav.
  // -------------------------------------------------------------------------
  it("server stores sequence 0 as chunk-0000.wav", async () => {
    const sessionId = uuid();
    const res = await uploadChunk(srv.baseUrl, sessionId, 0, makeWav());

    expect(res.status).toBe(200);
    const json = res.json() as { sequence: number };
    expect(json.sequence).toBe(0);

    // chunk-0000.wav MUST exist
    const correctPath = path.join(tmpDir, "inbox", sessionId, "chunk-0000.wav");
    expect(fs.existsSync(correctPath)).toBe(true);

    // chunk-0001.wav MUST NOT exist (catches off-by-one)
    const wrongPath = path.join(tmpDir, "inbox", sessionId, "chunk-0001.wav");
    expect(fs.existsSync(wrongPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 2: server stores sequences 0,1,2 as chunk-0000, chunk-0001, chunk-0002
  //
  // Full sequence: upload 3 chunks starting at 0. Session-end reports no gaps.
  // -------------------------------------------------------------------------
  it("server stores sequences 0,1,2 as chunk-0000, chunk-0001, chunk-0002", async () => {
    const sessionId = uuid();

    for (let seq = 0; seq < 3; seq++) {
      const res = await uploadChunk(srv.baseUrl, sessionId, seq, makeWav());
      expect(res.status).toBe(200);
    }

    // Verify DB state
    const session = getSession(srv.db, sessionId);
    expect(session!.chunksReceived).toBe(3);

    // Session-end — no gaps expected
    const endRes = await sendSessionEnd(srv.baseUrl, sessionId);
    expect(endRes.status).toBe(200);

    const json = endRes.json() as {
      status: string;
      chunks_received: number;
      sequence_gaps: number[];
    };
    expect(json.status).toBe("pending_transcription");
    expect(json.chunks_received).toBe(3);
    expect(json.sequence_gaps).toEqual([]);

    // Verify all 3 files exist with correct 0-based names
    for (let seq = 0; seq < 3; seq++) {
      const chunkPath = path.join(
        tmpDir, "inbox", sessionId,
        `chunk-${String(seq).padStart(4, "0")}.wav`,
      );
      expect(fs.existsSync(chunkPath)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: gap detection catches missing sequence 0
  //
  // Upload chunks 1 and 2, skip 0. Gap detection (ingest.ts line 381)
  // loops from i=0, so missing chunk-0000.wav is caught.
  // This is the scenario the or_insert(1) bug caused.
  // -------------------------------------------------------------------------
  it("gap detection catches missing sequence 0", async () => {
    const sessionId = uuid();

    // Upload only chunks 1 and 2 — skip 0
    for (const seq of [1, 2]) {
      const res = await uploadChunk(srv.baseUrl, sessionId, seq, makeWav());
      expect(res.status).toBe(200);
    }

    expect(getSession(srv.db, sessionId)!.chunksReceived).toBe(2);

    const endRes = await sendSessionEnd(srv.baseUrl, sessionId);
    expect(endRes.status).toBe(200);

    const json = endRes.json() as { sequence_gaps: number[] };
    // Gap detection checks indices 0..chunksReceived-1 = 0..1
    // chunk-0000.wav missing → gap at 0
    expect(json.sequence_gaps).toContain(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: gap detection catches missing middle sequence
  //
  // Upload chunks 0 and 2, skip 1. Gap detection must catch index 1.
  // -------------------------------------------------------------------------
  it("gap detection catches missing middle sequence", async () => {
    const sessionId = uuid();

    // Upload chunks 0 and 2 — skip 1
    for (const seq of [0, 2]) {
      const res = await uploadChunk(srv.baseUrl, sessionId, seq, makeWav());
      expect(res.status).toBe(200);
    }

    expect(getSession(srv.db, sessionId)!.chunksReceived).toBe(2);

    const endRes = await sendSessionEnd(srv.baseUrl, sessionId);
    expect(endRes.status).toBe(200);

    const json = endRes.json() as { sequence_gaps: number[] };
    // Gap detection checks indices 0..1. chunk-0000.wav exists, chunk-0001.wav missing.
    expect(json.sequence_gaps).toContain(1);
    // chunk-0000 exists so 0 should NOT be in gaps
    expect(json.sequence_gaps).not.toContain(0);
  });

  // -------------------------------------------------------------------------
  // Test 5: single chunk at sequence 0 is a valid session
  //
  // One chunk, sequence 0, session-end → pending_transcription with no gaps.
  // -------------------------------------------------------------------------
  it("single chunk at sequence 0 is valid session", async () => {
    const sessionId = uuid();

    const res = await uploadChunk(srv.baseUrl, sessionId, 0, makeWav());
    expect(res.status).toBe(200);

    const session = getSession(srv.db, sessionId);
    expect(session!.chunksReceived).toBe(1);

    const endRes = await sendSessionEnd(srv.baseUrl, sessionId);
    expect(endRes.status).toBe(200);

    const json = endRes.json() as {
      status: string;
      chunks_received: number;
      sequence_gaps: number[];
    };
    expect(json.status).toBe("pending_transcription");
    expect(json.chunks_received).toBe(1);
    expect(json.sequence_gaps).toEqual([]);
  });
});
