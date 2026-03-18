/**
 * Whisper E2E tests — real binary, real speech, no mocks.
 *
 * Requires `whisper` on PATH and `ffmpeg` on PATH.
 * Skips gracefully when whisper is not available.
 *
 * @see workspace/pipeline/InProgress/030-whisper-e2e-tests/SPEC.md
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { runWhisper, mergeSegments } from "../transcribe.js";
import type { TranscriptSegment, WhisperConfig } from "../transcribe.js";
import { splitStereoToMono } from "../wav-utils.js";
import { initAudioSessionTable, upsertSession, getSession } from "../session-store.js";
import { transcribeSession } from "../worker.js";
import type { WorkerConfig, WorkerDeps } from "../worker.js";

// ---------------------------------------------------------------------------
// Environment — ensure PYTHONIOENCODING + ffmpeg are available
// ---------------------------------------------------------------------------

const FFMPEG_DIR = path.join(
  os.homedir(),
  "AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin",
);

if (fs.existsSync(FFMPEG_DIR) && !process.env.PATH?.includes(FFMPEG_DIR)) {
  process.env.PATH = `${FFMPEG_DIR}${path.delimiter}${process.env.PATH}`;
}

process.env.PYTHONIOENCODING = "utf-8";

// ---------------------------------------------------------------------------
// Skip guard — skip if whisper binary not available
// ---------------------------------------------------------------------------

let whisperAvailable = false;
try {
  execFileSync("whisper", ["--help"], { timeout: 10_000, stdio: "pipe" });
  whisperAvailable = true;
} catch {
  // whisper not available — tests will be skipped
}

const describeIf = whisperAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "../../../tools/cortex-audio/fixtures");
const FIXTURE_WAV = path.join(FIXTURE_DIR, "test-speech-10s.wav");
const FIXTURE_EXPECTED = path.join(FIXTURE_DIR, "test-speech-10s.expected.txt");

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const whisperConfig: WhisperConfig = {
  whisperBinary: "whisper",
  whisperModel: "base.en",
  language: "en",
  threads: 4,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIf("Whisper E2E (real binary)", () => {
  // These tests are slow (10-30s each) — real Whisper transcription on CPU

  it("whisper produces valid JSON output from speech", async () => {
    // Extract left (speech) channel for mono input
    const stereoBuf = fs.readFileSync(FIXTURE_WAV);
    const { left } = splitStereoToMono(stereoBuf);

    // Write left channel to temp file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-e2e-1-"));
    const monoPath = path.join(tmpDir, "speech-mono.wav");
    fs.writeFileSync(monoPath, left);

    try {
      const segments = await runWhisper(monoPath, "user", whisperConfig);

      // Non-empty result
      expect(segments.length).toBeGreaterThan(0);

      // Expected keywords from the speech
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

  it("stereo split + whisper produces two-channel transcript", async () => {
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
      // Whisper may hallucinate on silence, so we just check it's less text
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

  it("full worker pipeline with real Whisper", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-e2e-3-"));
    const dataDir = path.join(tmpDir, "data", "audio");
    const sessionId = "e2e-test-" + Date.now();

    // Set up directory structure: inbox/<sessionId>/chunk-0000.wav
    const inboxDir = path.join(dataDir, "inbox", sessionId);
    fs.mkdirSync(inboxDir, { recursive: true });

    // Copy fixture as chunk-0000.wav
    fs.copyFileSync(FIXTURE_WAV, path.join(inboxDir, "chunk-0000.wav"));

    // Create in-memory session DB
    const { DatabaseSync } = requireNodeSqlite();
    const sessionDb = new DatabaseSync(":memory:");
    sessionDb.exec("PRAGMA journal_mode = WAL");
    initAudioSessionTable(sessionDb);
    upsertSession(sessionDb, sessionId);

    const workerConfig: WorkerConfig = {
      dataDir,
      whisper: whisperConfig,
    };

    const deps: WorkerDeps = {
      sessionDb,
    };

    try {
      const result = await transcribeSession(sessionId, workerConfig, deps);

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

  it("full pipeline calls onIngest with Librarian prompt", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-e2e-4-"));
    const dataDir = path.join(tmpDir, "data", "audio");
    const sessionId = "e2e-ingest-" + Date.now();

    const inboxDir = path.join(dataDir, "inbox", sessionId);
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.copyFileSync(FIXTURE_WAV, path.join(inboxDir, "chunk-0000.wav"));

    const { DatabaseSync } = requireNodeSqlite();

    // Session DB
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

    const deps: WorkerDeps = {
      sessionDb,
      onIngest,
    };

    try {
      const result = await transcribeSession(sessionId, workerConfig, deps);

      // Verify onIngest was called with correct params
      expect(ingestSessionId).toBe(sessionId);
      expect(ingestPrompt).toContain(`audio-capture://${sessionId}`);
      expect(ingestPrompt).toContain("Librarian");
      expect(result.transcript.fullText.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);
});
