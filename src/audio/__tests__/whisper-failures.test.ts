/**
 * Whisper failure mode tests — verify every failure path produces
 * clear, actionable error messages and the worker fails gracefully.
 *
 * Mocking execFile is legitimate here: we are testing error handling, not Whisper.
 *
 * @see workspace/pipeline/InProgress/038-whisper-failure-mode-tests/SPEC.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { initAudioSessionTable, upsertSession, getSession } from "../session-store.js";
import { buildWav } from "../wav-utils.js";
import type { WhisperConfig } from "../transcribe.js";
import type { WorkerConfig, WorkerDeps } from "../worker.js";

// ---------------------------------------------------------------------------
// Mock child_process.execFile — intercept Whisper CLI calls
// ---------------------------------------------------------------------------

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

const execFileMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return { ...orig, execFile: execFileMock };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

/** Create a minimal valid stereo WAV chunk in a session inbox. */
function createTestSession(dataDir: string, sessionId: string): string {
  const inboxDir = path.join(dataDir, "inbox", sessionId);
  fs.mkdirSync(inboxDir, { recursive: true });

  // Minimal stereo WAV — 100 frames, 16-bit, 44100 Hz
  const frames = 100;
  const pcm = Buffer.alloc(frames * 4, 0); // stereo 16-bit silence
  const wav = buildWav(pcm, 2, 44100, 16);
  fs.writeFileSync(path.join(inboxDir, "chunk-0000.wav"), wav);

  return inboxDir;
}

const FAKE_CONFIG: WhisperConfig = {
  whisperBinary: "whisper",
  whisperModel: "base.en",
  language: "en",
  threads: 1,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-fail-"));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Whisper failure modes", () => {
  // -------------------------------------------------------------------------
  // Test 1: binary not found → clear error message
  // -------------------------------------------------------------------------
  it("binary not found produces clear error (not raw ENOENT)", async () => {
    // Mock execFile to emit ENOENT — the exact production bug #3
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: ExecFileCallback) => {
      const err = new Error("spawn whisper ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      cb(err, "", "");
    });

    const { runWhisper } = await import("../transcribe.js");
    const wavPath = path.join(tmpDir, "test.wav");
    fs.writeFileSync(wavPath, Buffer.alloc(100));

    await expect(runWhisper(wavPath, "user", FAKE_CONFIG)).rejects.toThrow(
      /binary not found.*not installed or not on PATH/i,
    );

    // Must NOT surface raw ENOENT
    await expect(runWhisper(wavPath, "user", FAKE_CONFIG)).rejects.not.toThrow(
      /^spawn whisper ENOENT$/,
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: non-zero exit code includes stderr
  // -------------------------------------------------------------------------
  it("non-zero exit code includes stderr in error", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: ExecFileCallback) => {
      const err = new Error("Command failed: whisper") as any;
      err.code = 1;
      cb(err, "", "CUDA out of memory\nTraceback (most recent call last):");
    });

    const { runWhisper } = await import("../transcribe.js");
    const wavPath = path.join(tmpDir, "test.wav");
    fs.writeFileSync(wavPath, Buffer.alloc(100));

    await expect(runWhisper(wavPath, "user", FAKE_CONFIG)).rejects.toThrow(
      /CUDA out of memory/,
    );
    await expect(runWhisper(wavPath, "user", FAKE_CONFIG)).rejects.toThrow(
      /Whisper process failed/,
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: malformed JSON output → parse error with path
  // -------------------------------------------------------------------------
  it("malformed JSON output produces parse error with file path", async () => {
    // Mock execFile to "succeed" but we write bad JSON to the output path
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: ExecFileCallback) => {
      // Find --output_dir in args and write garbage JSON there
      const outDirIdx = args.indexOf("--output_dir");
      if (outDirIdx >= 0) {
        const outDir = args[outDirIdx + 1];
        // Find the wav path (first arg) and derive the expected json filename
        const wavBase = path.basename(args[0], path.extname(args[0]));
        fs.writeFileSync(path.join(outDir, `${wavBase}.json`), "not json {{{");
      }
      cb(null, "", "");
    });

    const { runWhisper } = await import("../transcribe.js");
    const wavPath = path.join(tmpDir, "audio.wav");
    fs.writeFileSync(wavPath, Buffer.alloc(100));

    await expect(runWhisper(wavPath, "user", FAKE_CONFIG)).rejects.toThrow(
      /not valid JSON/i,
    );
    // Error should include the file path for debugging
    await expect(runWhisper(wavPath, "user", FAKE_CONFIG)).rejects.toThrow(
      /audio\.json/,
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: output file missing → clear error
  // -------------------------------------------------------------------------
  it("output file missing produces clear error", async () => {
    // Mock execFile to succeed but don't create the output file
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: ExecFileCallback) => {
      cb(null, "", "");
    });

    const { runWhisper } = await import("../transcribe.js");
    const wavPath = path.join(tmpDir, "speech.wav");
    fs.writeFileSync(wavPath, Buffer.alloc(100));

    await expect(runWhisper(wavPath, "user", FAKE_CONFIG)).rejects.toThrow(
      /Whisper output not found/,
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: empty transcript (silence) → empty segments, no error
  // -------------------------------------------------------------------------
  it("empty transcript (silence) returns empty segments without error", async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: ExecFileCallback) => {
      const outDirIdx = args.indexOf("--output_dir");
      if (outDirIdx >= 0) {
        const outDir = args[outDirIdx + 1];
        const wavBase = path.basename(args[0], path.extname(args[0]));
        fs.writeFileSync(
          path.join(outDir, `${wavBase}.json`),
          JSON.stringify({ text: "", segments: [], language: "en" }),
        );
      }
      cb(null, "", "");
    });

    const { runWhisper } = await import("../transcribe.js");
    const wavPath = path.join(tmpDir, "silence.wav");
    fs.writeFileSync(wavPath, Buffer.alloc(100));

    const segments = await runWhisper(wavPath, "user", FAKE_CONFIG);
    expect(segments).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 6: worker handles whisper failure gracefully
  // -------------------------------------------------------------------------
  it("worker sets session status=failed with useful error on whisper failure", async () => {
    // Mock execFile to emit ENOENT
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: ExecFileCallback) => {
      const err = new Error("spawn whisper ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      cb(err, "", "");
    });

    const dataDir = path.join(tmpDir, "data", "audio");
    const sessionId = "fail-test-" + Date.now();
    createTestSession(dataDir, sessionId);

    const { DatabaseSync } = requireNodeSqlite();
    const sessionDb = new DatabaseSync(":memory:");
    sessionDb.exec("PRAGMA journal_mode = WAL");
    initAudioSessionTable(sessionDb);
    upsertSession(sessionDb, sessionId);

    const workerConfig: WorkerConfig = { dataDir, whisper: FAKE_CONFIG };
    const deps: WorkerDeps = { sessionDb };

    const { transcribeSession } = await import("../worker.js");

    // transcribeSession should throw but set session to "failed" first
    await expect(transcribeSession(sessionId, workerConfig, deps)).rejects.toThrow();

    const session = getSession(sessionDb, sessionId);
    expect(session!.status).toBe("failed");
    expect(session!.error).toBeTruthy();
    expect(session!.error).toMatch(/binary not found|not installed/i);
    // Must not contain raw stack trace
    expect(session!.error).not.toMatch(/^\s+at\s+/m);
  });

  // -------------------------------------------------------------------------
  // Test 7: timeout produces clear error
  // -------------------------------------------------------------------------
  it("whisper timeout produces clear error message", async () => {
    // Mock execFile to simulate a killed process (timeout behavior)
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: ExecFileCallback) => {
      const err = new Error("Command timed out") as any;
      err.killed = true;
      err.signal = "SIGTERM";
      cb(err, "", "");
    });

    const { runWhisper } = await import("../transcribe.js");
    const wavPath = path.join(tmpDir, "long.wav");
    fs.writeFileSync(wavPath, Buffer.alloc(100));

    const configWithTimeout: WhisperConfig = { ...FAKE_CONFIG, timeoutMs: 1000 };

    await expect(runWhisper(wavPath, "user", configWithTimeout)).rejects.toThrow(
      /timed out/i,
    );
  });

  // -------------------------------------------------------------------------
  // Test 8: ffmpeg missing → clear error (not deep Python traceback)
  // -------------------------------------------------------------------------
  it("ffmpeg missing produces clear error about ffmpeg", async () => {
    // Simulate the actual production failure: whisper runs but ffmpeg is missing
    const pythonTraceback = [
      "Traceback (most recent call last):",
      '  File "C:\\Python\\Lib\\whisper\\audio.py", line 42, in load_audio',
      "    ffmpeg -nostdin -threads 0 -i file.wav ...",
      "FileNotFoundError: [WinError 2] The system cannot find the file specified: 'ffmpeg'",
    ].join("\n");

    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: ExecFileCallback) => {
      const err = new Error("Command failed: whisper") as any;
      err.code = 1;
      cb(err, "", pythonTraceback);
    });

    const { runWhisper } = await import("../transcribe.js");
    const wavPath = path.join(tmpDir, "test.wav");
    fs.writeFileSync(wavPath, Buffer.alloc(100));

    await expect(runWhisper(wavPath, "user", FAKE_CONFIG)).rejects.toThrow(
      /ffmpeg not found/i,
    );
    // Should mention ffmpeg needs to be installed
    await expect(runWhisper(wavPath, "user", FAKE_CONFIG)).rejects.toThrow(
      /installed/i,
    );
  });
});
