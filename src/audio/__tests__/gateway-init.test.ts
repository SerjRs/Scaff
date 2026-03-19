/**
 * Integration tests for initGatewayAudioCapture() — the single function that
 * wires the entire audio pipeline in production.
 *
 * Bug #5 (ingestion never wired) lived here. These tests call
 * initGatewayAudioCapture() directly — NOT createGatewayAudioHandler().
 *
 * Real SQLite, real file I/O, no mocks, no environment patching.
 *
 * @see workspace/pipeline/InProgress/037-gateway-init-integration-test/SPEC.md
 */

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { initGatewayAudioCapture } from "../../gateway/server-audio.js";
import type { AudioCaptureHandle } from "../../gateway/server-audio.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = "test-init-key-037";

/** Track handles and temp dirs for cleanup. */
const cleanups: Array<() => void> = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-init-test-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeLog(): { info: (msg: string) => void; warn: (msg: string) => void; messages: string[] } {
  const messages: string[] = [];
  return {
    info: (msg: string) => messages.push(`[info] ${msg}`),
    warn: (msg: string) => messages.push(`[warn] ${msg}`),
    messages,
  };
}

function initWithDefaults(overrides?: {
  stateDir?: string;
  config?: Record<string, unknown>;
}): { handle: AudioCaptureHandle | null; log: ReturnType<typeof makeLog>; stateDir: string } {
  const stateDir = overrides?.stateDir ?? makeTmpDir();
  const log = makeLog();
  const handle = initGatewayAudioCapture({
    audioCaptureConfig: {
      enabled: true,
      apiKey: API_KEY,
      ...(overrides?.config ?? {}),
    },
    stateDir,
    log,
  });
  if (handle) {
    cleanups.push(() => handle.close());
  }
  return { handle, log, stateDir };
}

/** Build a multipart/form-data body matching the Rust client's format. */
function buildMultipart(
  sessionId: string,
  sequence: number,
  audioData: Buffer,
): { body: Buffer; contentType: string } {
  const boundary = `----FormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];

  // session_id field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="session_id"\r\n\r\n${sessionId}\r\n`,
  ));

  // sequence field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sequence"\r\n\r\n${sequence}\r\n`,
  ));

  // audio file field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="chunk.wav"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ));
  parts.push(audioData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Make a minimal valid WAV buffer (44-byte header + PCM data). */
function makeWavChunk(sizeBytes = 256): Buffer {
  const dataSize = sizeBytes - 44;
  const buf = Buffer.alloc(sizeBytes);
  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(sizeBytes - 8, 4);
  buf.write("WAVE", 8);
  // fmt subchunk
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // subchunk size
  buf.writeUInt16LE(1, 20);  // PCM
  buf.writeUInt16LE(2, 22);  // stereo
  buf.writeUInt32LE(16000, 24); // sample rate
  buf.writeUInt32LE(64000, 28); // byte rate
  buf.writeUInt16LE(4, 32);    // block align
  buf.writeUInt16LE(16, 34);   // bits per sample
  // data subchunk
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/** Spin up a real HTTP server from the handler, make a request, shut down. */
async function httpRequest(
  handler: AudioCaptureHandle["handler"],
  opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Buffer;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const handled = await handler(req, res);
        if (!handled) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not handled" }));
        }
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(String(err));
        }
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const reqOpts: http.RequestOptions = {
        hostname: "127.0.0.1",
        port: addr.port,
        path: opts.path,
        method: opts.method,
        headers: opts.headers ?? {},
      };

      const req = http.request(reqOpts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          server.close();
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      });

      req.on("error", (err) => {
        server.close();
        reject(err);
      });

      if (opts.body) req.write(opts.body);
      req.end();
    });
  });
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try { fn(); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initGatewayAudioCapture", () => {
  // Test 1
  it("returns valid handle with enabled config", () => {
    const { handle } = initWithDefaults();

    expect(handle).not.toBeNull();
    expect(typeof handle!.handler).toBe("function");
    expect(handle!.config.enabled).toBe(true);
    expect(handle!.config.apiKey).toBe(API_KEY);

    // DB is open — can execute a query
    const result = handle!.db.prepare("SELECT 1 AS ok").get() as { ok: number };
    expect(result.ok).toBe(1);
  });

  // Test 2
  it("returns null when disabled", () => {
    const log = makeLog();
    const handle = initGatewayAudioCapture({
      audioCaptureConfig: { enabled: false },
      stateDir: makeTmpDir(),
      log,
    });

    expect(handle).toBeNull();
  });

  // Test 3
  it("returns null when apiKey is empty", () => {
    const log = makeLog();
    const handle = initGatewayAudioCapture({
      audioCaptureConfig: { enabled: true, apiKey: "" },
      stateDir: makeTmpDir(),
      log,
    });

    expect(handle).toBeNull();
    expect(log.messages.some((m) => m.includes("apiKey is empty"))).toBe(true);
  });

  // Test 4
  it("creates data directories", () => {
    const stateDir = makeTmpDir();
    const { handle } = initWithDefaults({ stateDir });
    expect(handle).not.toBeNull();

    const dataDir = handle!.config.dataDir;
    for (const sub of ["inbox", "processed", "transcripts"]) {
      expect(fs.existsSync(path.join(dataDir, sub))).toBe(true);
    }
  });

  // Test 5
  it("creates audio.sqlite with session table", () => {
    const stateDir = makeTmpDir();
    const { handle } = initWithDefaults({ stateDir });
    expect(handle).not.toBeNull();

    const dbPath = path.join(handle!.config.dataDir, "audio.sqlite");
    expect(fs.existsSync(dbPath)).toBe(true);

    // Verify audio_sessions table exists
    const row = handle!.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='audio_sessions'",
    ).get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("audio_sessions");
  });

  // Test 6 — THE critical test: bug #5 was that onIngest was never wired
  it("workerDeps includes onIngest callback", async () => {
    const { handle, log } = initWithDefaults();
    expect(handle).not.toBeNull();

    // workerDeps must exist and include onIngest
    expect(handle!.workerDeps).toBeDefined();
    expect(handle!.workerDeps.sessionDb).toBe(handle!.db);
    expect(typeof handle!.workerDeps.onIngest).toBe("function");

    // Calling onIngest without Cortex/Router singletons should throw —
    // ingestion failure must be visible, not silently swallowed
    await expect(
      handle!.workerDeps.onIngest!("test prompt", "test-session-id"),
    ).rejects.toThrow();

    // Warning is still logged before the throw
    expect(log.messages.some((m) => m.includes("[warn]") && m.includes("Librarian ingestion"))).toBe(true);
  }, 15_000);

  // Test 7
  it("handler accepts chunk upload via real HTTP", async () => {
    const { handle } = initWithDefaults();
    expect(handle).not.toBeNull();

    const sessionId = crypto.randomUUID();
    const wav = makeWavChunk();
    const { body, contentType } = buildMultipart(sessionId, 0, wav);

    const resp = await httpRequest(handle!.handler, {
      method: "POST",
      path: "/audio/chunk",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": contentType,
      },
      body,
    });

    expect(resp.status).toBe(200);
    const json = JSON.parse(resp.body);
    expect(json.ok).toBe(true);
    expect(json.session_id).toBe(sessionId);
    expect(json.sequence).toBe(0);

    // Verify chunk written to inbox
    const chunkPath = path.join(handle!.config.dataDir, "inbox", sessionId, "chunk-0000.wav");
    expect(fs.existsSync(chunkPath)).toBe(true);
    expect(fs.readFileSync(chunkPath).length).toBe(wav.length);
  });

  // Test 8
  it("close() cleans up database", () => {
    const { handle } = initWithDefaults();
    expect(handle).not.toBeNull();

    // DB works before close
    handle!.db.prepare("SELECT 1").get();

    handle!.close();

    // DB should be closed — subsequent queries throw
    expect(() => handle!.db.prepare("SELECT 1")).toThrow();
  });

  // Test 9
  it("relative dataDir resolved against stateDir", () => {
    const stateDir = makeTmpDir();
    const { handle } = initWithDefaults({
      stateDir,
      config: { dataDir: "data/audio" },
    });
    expect(handle).not.toBeNull();

    const expected = path.join(stateDir, "data", "audio");
    expect(path.normalize(handle!.config.dataDir)).toBe(path.normalize(expected));
    expect(fs.existsSync(path.join(expected, "inbox"))).toBe(true);
  });

  // Test 10
  it("absolute dataDir used as-is", () => {
    const stateDir = makeTmpDir();
    const absDataDir = path.join(makeTmpDir(), "abs-audio");
    const { handle } = initWithDefaults({
      stateDir,
      config: { dataDir: absDataDir },
    });
    expect(handle).not.toBeNull();

    expect(path.normalize(handle!.config.dataDir)).toBe(path.normalize(absDataDir));
    expect(fs.existsSync(path.join(absDataDir, "inbox"))).toBe(true);
    // Should NOT be under stateDir
    expect(handle!.config.dataDir.startsWith(stateDir)).toBe(false);
  });
});
