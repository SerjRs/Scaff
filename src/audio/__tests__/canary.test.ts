/**
 * Canary test — single WAV chunk → Whisper → transcript → real onIngest → DB side effects.
 *
 * Exercises the REAL production onIngest from initGatewayAudioCapture(), NOT a spy.
 * Verifies DB-level side effects: cortex_task_dispatch row + library_pending_tasks row.
 * Target: <20s.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { initGatewayAudioCapture, type AudioCaptureHandle } from "../../gateway/server-audio.js";
import { _setGatewayCortexForTest } from "../../cortex/gateway-bridge.js";
import { initSessionTables } from "../../cortex/session.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import type { DatabaseSync } from "node:sqlite";

// -- Skip guard ---------------------------------------------------------------

let whisperAvailable = false;
try {
  execFileSync("whisper", ["--help"], {
    timeout: 10_000,
    stdio: "pipe",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  whisperAvailable = true;
} catch { /* not found */ }

const isCI = process.env.CI === "true" || process.env.CI === "1";
if (!whisperAvailable && isCI) {
  throw new Error("FATAL: Whisper not found on CI — canary requires whisper on PATH.");
}
if (!whisperAvailable) {
  console.warn("[canary] Whisper not on PATH — skipping.");
}

const describeIf = whisperAvailable ? describe : describe.skip;

// -- Helpers ------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "../../../tools/cortex-audio/fixtures");
const API_KEY = "canary-key";

function buildMultipart(
  fields: Array<{ name: string; value: string }>,
  file: { name: string; filename: string; data: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = "----Canary" + Date.now();
  const parts: Buffer[] = [];
  for (const { name, value } of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(file.data, Buffer.from("\r\n"), Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function req(url: string, method: string, headers: Record<string, string>, body?: Buffer | string): Promise<{ status: number; json: () => any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) });
      });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

// -- Test ---------------------------------------------------------------------

describeIf("Audio pipeline canary", () => {
  let tmpDir: string;
  let baseUrl: string;
  let server: http.Server;
  let audioHandle: AudioCaptureHandle;
  let cortexDb: DatabaseSync;
  const enqueuedJobs: Array<{ type: string; payload: any; issuer: string; taskId: string }> = [];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-audio-"));
    const dataDir = path.join(tmpDir, "audio");

    // --- Cortex DB (minimal — just the tables onIngest writes to) ---
    const { DatabaseSync: DBSync } = requireNodeSqlite();
    cortexDb = new DBSync(path.join(tmpDir, "bus.sqlite"));
    cortexDb.exec("PRAGMA journal_mode = WAL");
    initSessionTables(cortexDb);

    // --- Inject Cortex singleton ---
    _setGatewayCortexForTest({
      instance: { db: cortexDb } as any,
      shadowHook: null,
      config: {} as any,
      getChannelMode: () => "off",
    });

    // --- Inject Router singleton ---
    const fakeRouter = {
      enqueue: (type: string, payload: any, issuer: string, taskId: string) => {
        const jobId = crypto.randomUUID();
        enqueuedJobs.push({ type, payload, issuer, taskId });
        return jobId;
      },
    };
    (globalThis as any).__openclaw_router_instance__ = fakeRouter;

    // --- Init audio capture (production path — real onIngest closure) ---
    audioHandle = initGatewayAudioCapture({
      audioCaptureConfig: {
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
      stateDir: tmpDir,
      log: { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) },
    })!;

    expect(audioHandle).not.toBeNull();

    // --- HTTP server ---
    server = http.createServer(async (rq, rs) => {
      try {
        if (!(await audioHandle.handler(rq, rs))) { rs.statusCode = 404; rs.end("{}"); }
      } catch (e) {
        if (!rs.headersSent) { rs.statusCode = 500; rs.end(JSON.stringify({ error: String(e) })); }
      }
    });
    server.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server?.close();
    audioHandle?.close();
    try { cortexDb?.close(); } catch { /* */ }
    _setGatewayCortexForTest(null);
    delete (globalThis as any).__openclaw_router_instance__;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1 chunk → Whisper → transcript → real onIngest → dispatch + library task in DB", async () => {
    const sessionId = crypto.randomUUID();
    const wav = fs.readFileSync(path.join(FIXTURE_DIR, "test-speech-chunk-00.wav"));

    // Upload chunk 0
    const { body, contentType } = buildMultipart(
      [{ name: "session_id", value: sessionId }, { name: "sequence", value: "0" }],
      { name: "audio", filename: `${sessionId}_chunk-0000_1710700000.wav`, data: wav },
    );
    const up = await req(`${baseUrl}/audio/chunk`, "POST", { Authorization: `Bearer ${API_KEY}`, "Content-Type": contentType }, body);
    expect(up.status).toBe(200);

    // Session-end
    const end = await req(`${baseUrl}/audio/session-end`, "POST",
      { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      JSON.stringify({ session_id: sessionId }));
    expect(end.status).toBe(200);

    // Poll for done (not "transcribed" — "done" means ingestion completed too)
    const deadline = Date.now() + 120_000;
    let status = "";
    while (Date.now() < deadline) {
      const s = await req(`${baseUrl}/audio/session/${sessionId}/status`, "GET", { Authorization: `Bearer ${API_KEY}` });
      status = (s.json() as any).status;
      if (status === "done" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(status).toBe("done");

    // Transcript exists on disk
    const tp = path.join(tmpDir, "audio", "transcripts", `${sessionId}.json`);
    expect(fs.existsSync(tp)).toBe(true);
    const t = JSON.parse(fs.readFileSync(tp, "utf-8"));
    expect(t.fullText.length).toBeGreaterThan(0);

    // --- DB-level side effects of the REAL onIngest ---

    // 1. cortex_task_dispatch row exists with channel="system"
    const dispatch = cortexDb.prepare(
      `SELECT * FROM cortex_task_dispatch WHERE task_summary LIKE ?`
    ).get(`%audio-capture://${sessionId}%`) as Record<string, unknown> | undefined;
    expect(dispatch).toBeDefined();
    expect(dispatch!.channel).toBe("system");
    expect(dispatch!.priority).toBe("normal");
    expect(dispatch!.task_id).toBeTruthy();

    // 2. library_pending_tasks row exists linking taskId → URL
    const taskId = dispatch!.task_id as string;
    const libraryTask = cortexDb.prepare(
      `SELECT * FROM library_pending_tasks WHERE task_id = ?`
    ).get(taskId) as Record<string, unknown> | undefined;
    expect(libraryTask).toBeDefined();
    expect(libraryTask!.url).toBe(`audio-capture://${sessionId}`);

    // 3. Router job was enqueued with correct args
    const job = enqueuedJobs.find((j) => j.taskId === taskId);
    expect(job).toBeDefined();
    expect(job!.type).toBe("agent_run");
    expect(job!.payload.message).toContain(`audio-capture://${sessionId}`);
    expect(job!.issuer).toBe("agent:main:cortex");
  }, 120_000);
});
