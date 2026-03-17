/**
 * E2E Pipeline Test — Audio Capture → Transcription → Knowledge Graph
 *
 * Usage:
 *   npx tsx scripts/test-audio-e2e.ts          # full pipeline (requires gateway + whisper)
 *   npx vitest run scripts/test-audio-e2e.test.ts  # in-process smoke test (mocked whisper)
 *
 * This script validates the complete audio pipeline by:
 *   1. Generating synthetic stereo WAV chunks
 *   2. POSTing them to the audio ingest API
 *   3. Signalling session-end
 *   4. Polling until transcription completes
 *   5. Verifying outputs (transcript, processed files, session status)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER_URL = process.env.AUDIO_SERVER_URL ?? "http://127.0.0.1:18789";
const API_KEY = process.env.AUDIO_API_KEY ?? "";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;
const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const CHUNK_DURATION_SECS = 10;

// ---------------------------------------------------------------------------
// WAV generation
// ---------------------------------------------------------------------------

/** Build a valid PCM WAV buffer with sine-wave content. */
function buildStereoWavChunk(durationSecs: number, freqLeft = 440, freqRight = 880): Buffer {
  const numFrames = SAMPLE_RATE * durationSecs;
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const pcmData = Buffer.alloc(numFrames * CHANNELS * bytesPerSample);

  for (let i = 0; i < numFrames; i++) {
    const t = i / SAMPLE_RATE;
    const leftSample = Math.round(Math.sin(2 * Math.PI * freqLeft * t) * 16000);
    const rightSample = Math.round(Math.sin(2 * Math.PI * freqRight * t) * 16000);
    pcmData.writeInt16LE(leftSample, i * 4);
    pcmData.writeInt16LE(rightSample, i * 4 + 2);
  }

  return buildWavBuffer(pcmData, CHANNELS, SAMPLE_RATE, BITS_PER_SAMPLE);
}

function buildWavBuffer(pcmData: Buffer, channels: number, sampleRate: number, bitsPerSample: number): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);       // fmt chunk size
  header.writeUInt16LE(1, 20);        // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpRequest(
  url: string,
  opts: { method: string; headers?: Record<string, string>; body?: Buffer | string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: opts.method, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function buildMultipartBody(
  fields: Record<string, string>,
  file: { name: string; filename: string; data: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = "----E2EBoundary" + Date.now();
  const parts: Buffer[] = [];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
    ));
  }

  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ));
  parts.push(file.data);
  parts.push(Buffer.from("\r\n"));
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function check(name: string, passed: boolean, detail = "") {
  results.push({ name, passed, detail });
  const icon = passed ? "PASS" : "FAIL";
  console.log(`  [${icon}] ${name}${detail ? " — " + detail : ""}`);
}

async function uploadChunk(sessionId: string, sequence: number, wavData: Buffer): Promise<boolean> {
  const { body, contentType } = buildMultipartBody(
    { session_id: sessionId, sequence: String(sequence) },
    { name: "file", filename: `chunk-${String(sequence).padStart(4, "0")}.wav`, data: wavData },
  );

  const resp = await httpRequest(`${SERVER_URL}/audio/chunk`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": contentType },
    body,
  });

  return resp.status === 200;
}

async function signalSessionEnd(sessionId: string): Promise<{ status: number; body: string }> {
  return httpRequest(`${SERVER_URL}/audio/session-end`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ session_id: sessionId }),
  });
}

async function pollSessionStatus(sessionId: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp = await httpRequest(`${SERVER_URL}/audio/session/${sessionId}/status`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    if (resp.status === 200) {
      const data = JSON.parse(resp.body);
      const status: string = data.status;
      if (status === "done" || status === "failed") return status;
      console.log(`  ... session status: ${status}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return "timeout";
}

// ---------------------------------------------------------------------------
// Main E2E flow
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Audio E2E Pipeline Test ===\n");

  if (!API_KEY) {
    console.error("ERROR: Set AUDIO_API_KEY env var (matching audioCapture.apiKey in openclaw.json)");
    process.exit(1);
  }

  const sessionId = crypto.randomUUID();
  const numChunks = 3;

  console.log(`Session ID: ${sessionId}`);
  console.log(`Server:     ${SERVER_URL}`);
  console.log(`Chunks:     ${numChunks} x ${CHUNK_DURATION_SECS}s stereo WAV\n`);

  // --- Step 1: Generate and upload chunks ---
  console.log("Step 1: Uploading chunks...");
  for (let i = 0; i < numChunks; i++) {
    const freq = 300 + i * 200; // vary frequency per chunk
    const wavData = buildStereoWavChunk(CHUNK_DURATION_SECS, freq, freq + 100);
    const ok = await uploadChunk(sessionId, i, wavData);
    check(`Upload chunk ${i}`, ok, `${wavData.length} bytes`);
  }

  // --- Step 2: Signal session end ---
  console.log("\nStep 2: Signalling session-end...");
  const endResp = await signalSessionEnd(sessionId);
  const endOk = endResp.status === 200;
  check("Session-end accepted", endOk, `status=${endResp.status}`);

  if (endOk) {
    const endData = JSON.parse(endResp.body);
    check("Chunks count matches", endData.chunks_received === numChunks, `received=${endData.chunks_received}`);
    check("No sequence gaps", Array.isArray(endData.sequence_gaps) && endData.sequence_gaps.length === 0);
  }

  // --- Step 3: Poll for transcription ---
  console.log("\nStep 3: Waiting for transcription (timeout: 120s)...");
  const finalStatus = await pollSessionStatus(sessionId);
  check("Transcription completed", finalStatus === "done", `status=${finalStatus}`);

  // --- Step 4: Verify outputs ---
  console.log("\nStep 4: Verifying outputs...");

  // Read dataDir from env or default
  const dataDir = process.env.AUDIO_DATA_DIR ?? "data/audio";

  // Transcript file
  const transcriptPath = path.join(dataDir, "transcripts", `${sessionId}.json`);
  const transcriptExists = fs.existsSync(transcriptPath);
  check("Transcript JSON exists", transcriptExists, transcriptPath);

  if (transcriptExists) {
    const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
    check("Transcript has segments", Array.isArray(transcript.segments) && transcript.segments.length > 0,
      `segments=${transcript.segments?.length ?? 0}`);
    check("Transcript has fullText", typeof transcript.fullText === "string" && transcript.fullText.length > 0);
    check("Transcript sessionId matches", transcript.sessionId === sessionId);
  }

  // Processed dir (chunks moved from inbox)
  const processedDir = path.join(dataDir, "processed", sessionId);
  const processedExists = fs.existsSync(processedDir);
  check("Processed directory exists", processedExists, processedDir);

  if (processedExists) {
    const processedFiles = fs.readdirSync(processedDir).filter(f => f.startsWith("chunk-"));
    check("All chunks moved to processed", processedFiles.length === numChunks, `files=${processedFiles.length}`);
  }

  // Inbox should be empty/gone
  const inboxDir = path.join(dataDir, "inbox", sessionId);
  const inboxEmpty = !fs.existsSync(inboxDir) || fs.readdirSync(inboxDir).length === 0;
  check("Inbox cleared", inboxEmpty);

  // Final session status via API
  const statusResp = await httpRequest(`${SERVER_URL}/audio/session/${sessionId}/status`, {
    method: "GET",
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (statusResp.status === 200) {
    const statusData = JSON.parse(statusResp.body);
    check("Session status is 'done'", statusData.status === "done");
  }

  // --- Summary ---
  console.log("\n=== Results ===");
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${results.length}`);

  if (failed > 0) {
    console.log("\nFailed checks:");
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  - ${r.name}${r.detail ? ": " + r.detail : ""}`);
    }
    process.exit(1);
  } else {
    console.log("\nAll checks passed!");
  }
}

main().catch((err) => {
  console.error("E2E test crashed:", err);
  process.exit(1);
});
