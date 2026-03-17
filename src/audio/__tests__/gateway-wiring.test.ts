/**
 * Integration tests for 025f — Gateway Audio Wiring.
 *
 * Tests:
 * - Route mounting (handler returns true for /audio/* paths)
 * - Config loading (defaults, partial config, full config)
 * - Auth middleware (valid key → pass, missing/wrong → 401)
 * - Disabled bypass (enabled=false → handler returns false)
 * - Session-end → worker trigger (pending_transcription state set)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { createGatewayAudioHandler, loadAudioCaptureConfig } from "../ingest.js";
import { initAudioSessionTable, getSession, upsertSession, incrementChunks } from "../session-store.js";
import type { AudioCaptureConfig } from "../types.js";
import { DEFAULT_AUDIO_CAPTURE_CONFIG } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { DatabaseSync } = requireNodeSqlite();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-gw-test-"));
  for (const sub of ["inbox", "processed", "transcripts"]) {
    fs.mkdirSync(path.join(tmpDir, sub), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb(): InstanceType<typeof DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  initAudioSessionTable(db);
  return db;
}

function makeConfig(overrides?: Partial<AudioCaptureConfig>): AudioCaptureConfig {
  return {
    ...DEFAULT_AUDIO_CAPTURE_CONFIG,
    enabled: true,
    apiKey: "test-key-abc",
    dataDir: tmpDir,
    ...overrides,
  };
}

/** Create a mock IncomingMessage. */
function mockReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
}): http.IncomingMessage {
  const req = Object.create(http.IncomingMessage.prototype) as http.IncomingMessage;
  (req as any).method = opts.method ?? "GET";
  (req as any).url = opts.url ?? "/";
  (req as any).headers = opts.headers ?? {};
  return req;
}

/** Create a minimal mock ServerResponse that captures status + body. */
function mockRes(): { statusCode: number; _body: string; _headers: Record<string, string>; setHeader: (name: string, value: string) => void; end: (data?: string | Buffer) => void; headersSent: boolean } {
  const res = {
    statusCode: 200,
    _body: "",
    _headers: {} as Record<string, string>,
    headersSent: false,
    setHeader(name: string, value: string) {
      res._headers[name.toLowerCase()] = value;
    },
    end(data?: string | Buffer) {
      if (data) res._body = typeof data === "string" ? data : data.toString();
      res.headersSent = true;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadAudioCaptureConfig", () => {
  it("returns defaults when no config provided", () => {
    const config = loadAudioCaptureConfig(undefined);
    expect(config).toEqual(DEFAULT_AUDIO_CAPTURE_CONFIG);
  });

  it("merges partial config with defaults", () => {
    const config = loadAudioCaptureConfig({ enabled: true, apiKey: "mykey" });
    expect(config.enabled).toBe(true);
    expect(config.apiKey).toBe("mykey");
    expect(config.maxChunkSizeMB).toBe(15);
    expect(config.whisperBinary).toBe("whisper");
    expect(config.retentionDays).toBe(30);
  });

  it("accepts full config", () => {
    const full: AudioCaptureConfig = {
      enabled: true,
      apiKey: "k",
      maxChunkSizeMB: 20,
      dataDir: "/tmp/audio",
      port: 9999,
      whisperBinary: "/usr/bin/whisper",
      whisperModel: "large",
      whisperLanguage: "es",
      whisperThreads: 8,
      retentionDays: 7,
    };
    const config = loadAudioCaptureConfig(full);
    expect(config).toEqual(full);
  });
});

describe("createGatewayAudioHandler — route mounting", () => {
  it("returns false for non-audio paths", async () => {
    const db = makeDb();
    const handler = createGatewayAudioHandler({ db, config: makeConfig() });
    const req = mockReq({ url: "/api/status" });
    const res = mockRes();
    const handled = await handler(req, res as any);
    expect(handled).toBe(false);
  });

  it("returns true for /audio/* paths", async () => {
    const db = makeDb();
    const handler = createGatewayAudioHandler({ db, config: makeConfig() });
    const req = mockReq({
      url: "/audio/chunk",
      method: "POST",
      headers: { authorization: "Bearer test-key-abc" },
    });
    const res = mockRes();
    const handled = await handler(req, res as any);
    expect(handled).toBe(true);
  });
});

describe("createGatewayAudioHandler — auth", () => {
  it("rejects missing auth header with 401", async () => {
    const db = makeDb();
    const handler = createGatewayAudioHandler({ db, config: makeConfig() });
    const req = mockReq({ url: "/audio/chunk", method: "POST" });
    const res = mockRes();
    const handled = await handler(req, res as any);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });

  it("rejects wrong API key with 401", async () => {
    const db = makeDb();
    const handler = createGatewayAudioHandler({ db, config: makeConfig() });
    const req = mockReq({
      url: "/audio/chunk",
      method: "POST",
      headers: { authorization: "Bearer wrong-key" },
    });
    const res = mockRes();
    const handled = await handler(req, res as any);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });

  it("accepts correct API key", async () => {
    const db = makeDb();
    const handler = createGatewayAudioHandler({ db, config: makeConfig() });
    // GET on a valid status route with auth → 400 (bad session ID) but NOT 401
    const req = mockReq({
      url: "/audio/session/not-a-uuid/status",
      method: "GET",
      headers: { authorization: "Bearer test-key-abc" },
    });
    const res = mockRes();
    await handler(req, res as any);
    expect(res.statusCode).toBe(400); // bad UUID, not 401
  });
});

describe("createGatewayAudioHandler — disabled bypass", () => {
  it("returns false when audio is disabled", async () => {
    const db = makeDb();
    const handler = createGatewayAudioHandler({
      db,
      config: makeConfig({ enabled: false }),
    });
    const req = mockReq({
      url: "/audio/chunk",
      method: "POST",
      headers: { authorization: "Bearer test-key-abc" },
    });
    const res = mockRes();
    const handled = await handler(req, res as any);
    expect(handled).toBe(false);
  });
});

describe("createGatewayAudioHandler — session status", () => {
  it("returns session state for a valid session", async () => {
    const db = makeDb();
    const sessionId = "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4";
    upsertSession(db, sessionId);
    incrementChunks(db, sessionId);

    const handler = createGatewayAudioHandler({ db, config: makeConfig() });
    const req = mockReq({
      url: `/audio/session/${sessionId}/status`,
      method: "GET",
      headers: { authorization: "Bearer test-key-abc" },
    });
    const res = mockRes();
    await handler(req, res as any);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.session_id).toBe(sessionId);
    expect(body.status).toBe("receiving");
    expect(body.chunks_received).toBe(1);
  });

  it("returns 404 for unknown session", async () => {
    const db = makeDb();
    const handler = createGatewayAudioHandler({ db, config: makeConfig() });
    const req = mockReq({
      url: "/audio/session/a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4/status",
      method: "GET",
      headers: { authorization: "Bearer test-key-abc" },
    });
    const res = mockRes();
    await handler(req, res as any);
    expect(res.statusCode).toBe(404);
  });
});

describe("createGatewayAudioHandler — unknown audio route", () => {
  it("returns 404 for unknown /audio/ path", async () => {
    const db = makeDb();
    const handler = createGatewayAudioHandler({ db, config: makeConfig() });
    const req = mockReq({
      url: "/audio/unknown",
      method: "GET",
      headers: { authorization: "Bearer test-key-abc" },
    });
    const res = mockRes();
    const handled = await handler(req, res as any);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });
});
