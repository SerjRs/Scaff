/**
 * Canary test — single WAV chunk → Whisper → transcript → onIngest.
 * Fast smoke test for the entire audio pipeline glue. Target: <15s.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createGatewayAudioHandler } from "../ingest.js";
import { initAudioSessionTable } from "../session-store.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import type { WorkerDeps } from "../worker.js";

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
  let sessionDb: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;
  const ingestCalls: Array<{ prompt: string; sessionId: string }> = [];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-audio-"));
    const dataDir = path.join(tmpDir, "audio");
    for (const sub of ["inbox", "processed", "transcripts"]) {
      fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
    }

    const { DatabaseSync } = requireNodeSqlite();
    sessionDb = new DatabaseSync(path.join(dataDir, "audio.sqlite"));
    sessionDb.exec("PRAGMA journal_mode = WAL");
    initAudioSessionTable(sessionDb);

    const workerDeps: WorkerDeps = {
      sessionDb,
      onIngest: async (prompt, sid) => { ingestCalls.push({ prompt, sessionId: sid }); },
    };

    const handler = createGatewayAudioHandler({
      db: sessionDb,
      config: {
        enabled: true, apiKey: API_KEY, maxChunkSizeMB: 15, dataDir, port: null,
        whisperBinary: "whisper", whisperModel: "base.en", whisperLanguage: "en",
        whisperThreads: 4, retentionDays: 30,
      },
      workerDeps,
      log: { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) },
    });

    server = http.createServer(async (rq, rs) => {
      try {
        if (!(await handler(rq, rs))) { rs.statusCode = 404; rs.end("{}"); }
      } catch (e) {
        if (!rs.headersSent) { rs.statusCode = 500; rs.end(JSON.stringify({ error: String(e) })); }
      }
    });
    server.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server?.close();
    try { sessionDb?.close(); } catch { /* */ }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1 chunk → Whisper → transcript on disk → onIngest fires", async () => {
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

    // Poll for done
    const deadline = Date.now() + 120_000;
    let status = "";
    while (Date.now() < deadline) {
      const s = await req(`${baseUrl}/audio/session/${sessionId}/status`, "GET", { Authorization: `Bearer ${API_KEY}` });
      status = (s.json() as any).status;
      if (status === "done" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(status).toBe("done");

    // Transcript exists
    const tp = path.join(tmpDir, "audio", "transcripts", `${sessionId}.json`);
    expect(fs.existsSync(tp)).toBe(true);
    const t = JSON.parse(fs.readFileSync(tp, "utf-8"));
    expect(t.fullText.length).toBeGreaterThan(0);

    // onIngest was called
    const call = ingestCalls.find((c) => c.sessionId === sessionId);
    expect(call).toBeDefined();
    expect(call!.prompt).toContain(`audio-capture://${sessionId}`);
  }, 120_000);
});
