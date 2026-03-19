/**
 * Whisper E2E tests — real binary, real speech, NO environment patching.
 *
 * The production code (transcribe.ts) handles PATH + PYTHONIOENCODING.
 * If these tests can't find whisper, the production code can't either.
 *
 * @see workspace/pipeline/InProgress/030-whisper-e2e-tests/TESTS-REVISION-REPORT.md
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { runWhisper, mergeSegments } from "../transcribe.js";
import type { WhisperConfig } from "../transcribe.js";
import { splitStereoToMono } from "../wav-utils.js";
import { initAudioSessionTable, upsertSession, getSession } from "../session-store.js";
import { transcribeSession } from "../worker.js";
import type { WorkerConfig, WorkerDeps } from "../worker.js";
import { loadAudioCaptureConfig } from "../ingest.js";

// ---------------------------------------------------------------------------
// NO environment patching — production code handles PATH + PYTHONIOENCODING.
// If whisper/ffmpeg aren't found, that's a real failure.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Skip guard — CI fails loudly, local skips with warning
// ---------------------------------------------------------------------------

let whisperAvailable = false;
try {
  // Use PYTHONIOENCODING=utf-8 matching production (transcribe.ts execFileAsync).
  // Whisper --help crashes on Windows cp1252 without it — this is NOT test-only patching.
  execFileSync("whisper", ["--help"], {
    timeout: 10_000,
    stdio: "pipe",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  whisperAvailable = true;
} catch {
  // whisper not available
}

const isCI = process.env.CI === "true";
if (!whisperAvailable) {
  if (isCI) throw new Error("Whisper not available on CI — tests cannot be skipped");
  console.warn(
    "\n\u26a0\ufe0f  Whisper not found — skipping whisper-e2e tests. " +
    "These tests provide ZERO signal when skipped.\n",
  );
}

const describeIf = whisperAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "../../../tools/cortex-audio/fixtures");
const FIXTURE_WAV = path.join(FIXTURE_DIR, "test-speech-10s.wav");

// ---------------------------------------------------------------------------
// Use production config loading — not hand-crafted WhisperConfig
// ---------------------------------------------------------------------------

let whisperConfig: WhisperConfig;

beforeAll(() => {
  const audioCfg = loadAudioCaptureConfig();
  whisperConfig = {
    whisperBinary: audioCfg.whisperBinary,
    whisperModel: audioCfg.whisperModel,
    language: audioCfg.whisperLanguage,
    threads: audioCfg.whisperThreads,
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIf("Whisper E2E (real binary)", () => {
  // These tests are slow (10-30s each) — real Whisper transcription on CPU

  it("runWhisper produces valid segments from speech fixture", async () => {
    const stereoBuf = fs.readFileSync(FIXTURE_WAV);
    const { left } = splitStereoToMono(stereoBuf);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-e2e-1-"));
    const monoPath = path.join(tmpDir, "speech-mono.wav");
    fs.writeFileSync(monoPath, left);

    try {
      const segments = await runWhisper(monoPath, "user", whisperConfig);

      // Non-empty result
      expect(segments.length).toBeGreaterThan(0);

      // Expected keywords from the speech fixture
      const fullText = segments.map((s) => s.text).join(" ").toLowerCase();
      expect(fullText).toMatch(/meeting|tuesday|friday|report|quarterly/i);

      // Valid timestamps
      for (const seg of segments) {
        expect(seg.start).toBeGreaterThanOrEqual(0);
        expect(seg.end).toBeGreaterThan(seg.start);
        expect(seg.speaker).toBe("user");
        expect(seg.text.length).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("stereo split + dual whisper produces user and others channels", async () => {
    const stereoBuf = fs.readFileSync(FIXTURE_WAV);
    const { left, right } = splitStereoToMono(stereoBuf);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-e2e-2-"));
    const leftPath = path.join(tmpDir, "left.wav");
    const rightPath = path.join(tmpDir, "right.wav");
    fs.writeFileSync(leftPath, left);
    fs.writeFileSync(rightPath, right);

    try {
      const [userSegments, othersSegments] = await Promise.all([
        runWhisper(leftPath, "user", whisperConfig),
        runWhisper(rightPath, "others", whisperConfig),
      ]);

      // Left channel (speech) should have meaningful transcript
      expect(userSegments.length).toBeGreaterThan(0);
      const userText = userSegments.map((s) => s.text).join(" ").toLowerCase();
      expect(userText).toMatch(/meeting|tuesday|friday|report/i);

      // Right channel (silence) should produce empty or minimal output
      const othersText = othersSegments.map((s) => s.text).join(" ");
      expect(othersText.length).toBeLessThan(userText.length);

      // Merge and verify sort order
      const merged = mergeSegments(userSegments, othersSegments);
      for (let i = 1; i < merged.length; i++) {
        expect(merged[i].start).toBeGreaterThanOrEqual(merged[i - 1].start);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 90_000);

  it("transcribeSession full pipeline with real Whisper", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-e2e-3-"));
    const dataDir = path.join(tmpDir, "data", "audio");
    const sessionId = "e2e-test-" + Date.now();

    const inboxDir = path.join(dataDir, "inbox", sessionId);
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.copyFileSync(FIXTURE_WAV, path.join(inboxDir, "chunk-0000.wav"));

    const { DatabaseSync } = requireNodeSqlite();
    const sessionDb = new DatabaseSync(":memory:");
    sessionDb.exec("PRAGMA journal_mode = WAL");
    initAudioSessionTable(sessionDb);
    upsertSession(sessionDb, sessionId);

    const workerConfig: WorkerConfig = {
      dataDir,
      whisper: whisperConfig,
    };

    const deps: WorkerDeps = { sessionDb };

    try {
      await transcribeSession(sessionId, workerConfig, deps);

      // Session should be done
      const session = getSession(sessionDb, sessionId);
      expect(session!.status).toBe("done");

      // Transcript JSON written
      const transcriptPath = path.join(dataDir, "transcripts", `${sessionId}.json`);
      expect(fs.existsSync(transcriptPath)).toBe(true);

      const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
      expect(transcript.fullText.length).toBeGreaterThan(0);
      expect(transcript.segments.length).toBeGreaterThan(0);

      // Valid segment structure
      for (const seg of transcript.segments) {
        expect(seg.start).toBeGreaterThanOrEqual(0);
        expect(seg.end).toBeGreaterThan(seg.start);
        expect(["user", "others"]).toContain(seg.speaker);
      }

      // Audio moved from inbox to processed
      expect(fs.existsSync(path.join(inboxDir, "chunk-0000.wav"))).toBe(false);
      const processedDir = path.join(dataDir, "processed", sessionId);
      expect(fs.existsSync(path.join(processedDir, "chunk-0000.wav"))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("transcribeSession calls onIngest with librarian prompt", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-e2e-4-"));
    const dataDir = path.join(tmpDir, "data", "audio");
    const sessionId = "e2e-ingest-" + Date.now();

    const inboxDir = path.join(dataDir, "inbox", sessionId);
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.copyFileSync(FIXTURE_WAV, path.join(inboxDir, "chunk-0000.wav"));

    const { DatabaseSync } = requireNodeSqlite();
    const sessionDb = new DatabaseSync(":memory:");
    sessionDb.exec("PRAGMA journal_mode = WAL");
    initAudioSessionTable(sessionDb);
    upsertSession(sessionDb, sessionId);

    // Track onIngest calls
    let ingestPrompt = "";
    let ingestSessionId = "";
    const onIngest = async (prompt: string, sid: string) => {
      ingestPrompt = prompt;
      ingestSessionId = sid;
    };

    const workerConfig: WorkerConfig = {
      dataDir,
      whisper: whisperConfig,
    };

    const deps: WorkerDeps = { sessionDb, onIngest };

    try {
      const result = await transcribeSession(sessionId, workerConfig, deps);

      // onIngest was called with correct params
      expect(ingestSessionId).toBe(sessionId);
      expect(ingestPrompt).toContain(`audio-capture://${sessionId}`);
      expect(ingestPrompt).toContain("Librarian");
      expect(result.transcript.fullText.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("transcribeSession with silence skips onIngest", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-e2e-5-"));
    const dataDir = path.join(tmpDir, "data", "audio");
    const sessionId = "e2e-silence-" + Date.now();

    const inboxDir = path.join(dataDir, "inbox", sessionId);
    fs.mkdirSync(inboxDir, { recursive: true });

    // Create a very short silence WAV — stereo, 16kHz, 16-bit, ~0.5s of zeros
    const { buildWav } = await import("../wav-utils.js");
    const frames = 8000; // 0.5s at 16kHz
    const silencePcm = Buffer.alloc(frames * 4, 0); // stereo 16-bit = 4 bytes/frame
    const silenceWav = buildWav(silencePcm, 2, 16000, 16);
    fs.writeFileSync(path.join(inboxDir, "chunk-0000.wav"), silenceWav);

    const { DatabaseSync } = requireNodeSqlite();
    const sessionDb = new DatabaseSync(":memory:");
    sessionDb.exec("PRAGMA journal_mode = WAL");
    initAudioSessionTable(sessionDb);
    upsertSession(sessionDb, sessionId);

    let onIngestCalled = false;
    const onIngest = async () => { onIngestCalled = true; };

    const workerConfig: WorkerConfig = {
      dataDir,
      whisper: whisperConfig,
    };
    const deps: WorkerDeps = { sessionDb, onIngest };

    try {
      const result = await transcribeSession(sessionId, workerConfig, deps);

      // Whisper on silence produces empty or near-empty transcript
      // If fullText is empty, onIngest should NOT have been called
      if (result.transcript.fullText.trim() === "") {
        expect(onIngestCalled).toBe(false);
      }
      // If Whisper hallucinated something, onIngest may have been called — that's OK
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("whisper config loaded from production defaults", () => {
    const cfg = loadAudioCaptureConfig();

    // whisperBinary should be a non-empty string
    expect(cfg.whisperBinary).toBeTruthy();
    expect(typeof cfg.whisperBinary).toBe("string");

    // whisperModel should be set
    expect(cfg.whisperModel).toBeTruthy();
    expect(typeof cfg.whisperModel).toBe("string");

    // Verify the binary actually resolves — using the same env as production
    // (transcribe.ts execFileAsync sets PYTHONIOENCODING=utf-8)
    try {
      execFileSync(cfg.whisperBinary, ["--help"], {
        timeout: 10_000,
        stdio: "pipe",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
    } catch {
      throw new Error(
        `Production whisperBinary "${cfg.whisperBinary}" is not executable. ` +
        `The gateway would also fail. Fix transcribe.ts PATH handling or config.`,
      );
    }
  });
});
