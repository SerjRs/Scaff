/**
 * Whisper CLI wrapper — runs speech-to-text on mono WAV files.
 *
 * Uses shell exec to local `whisper` CLI (Option A from SPEC).
 * Parses Whisper JSON output into typed segments.
 *
 * @see workspace/pipeline/InProgress/025e-transcription-worker/SPEC.md
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Ensure ffmpeg + whisper are on PATH (platform-specific install locations)
// ---------------------------------------------------------------------------
const FFMPEG_DIR = path.join(
  os.homedir(),
  "AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin",
);
if (fs.existsSync(FFMPEG_DIR) && !process.env.PATH?.includes(FFMPEG_DIR)) {
  process.env.PATH = `${FFMPEG_DIR}${path.delimiter}${process.env.PATH}`;
}

// Python Scripts dir (where pip-installed whisper lives)
const PYTHON_SCRIPTS_DIR = path.join(
  os.homedir(),
  "AppData/Local/Python/pythoncore-3.14-64/Scripts",
);
if (fs.existsSync(PYTHON_SCRIPTS_DIR) && !process.env.PATH?.includes(PYTHON_SCRIPTS_DIR)) {
  process.env.PATH = `${PYTHON_SCRIPTS_DIR}${path.delimiter}${process.env.PATH}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptSegment {
  speaker: "user" | "others";
  start: number;
  end: number;
  text: string;
}

/** Whisper JSON output format (per segment). */
export interface WhisperSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
}

/** Whisper JSON output (top-level). */
export interface WhisperOutput {
  text: string;
  segments: WhisperSegment[];
  language: string;
}

export interface WhisperConfig {
  whisperBinary: string;
  whisperModel: string;
  language: string;
  threads: number;
  /** Optional timeout in milliseconds for the Whisper process. */
  timeoutMs?: number;
}

export const DEFAULT_WHISPER_CONFIG: WhisperConfig = {
  whisperBinary: "whisper",
  whisperModel: "base.en",
  language: "en",
  threads: 4,
};

// ---------------------------------------------------------------------------
// Whisper CLI execution
// ---------------------------------------------------------------------------

/**
 * Run Whisper CLI on a mono WAV file and return parsed segments.
 *
 * @param wavPath Path to mono WAV file
 * @param speaker Speaker label for all segments from this file
 * @param config Whisper configuration
 * @returns Array of transcript segments
 */
export async function runWhisper(
  wavPath: string,
  speaker: "user" | "others",
  config: WhisperConfig = DEFAULT_WHISPER_CONFIG,
): Promise<TranscriptSegment[]> {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-out-"));

  try {
    const args = [
      wavPath,
      "--model", config.whisperModel,
      "--language", config.language,
      "--threads", String(config.threads),
      "--output_format", "json",
      "--output_dir", outputDir,
    ];

    await execFileAsync(config.whisperBinary, args, config.timeoutMs);

    // Whisper outputs {basename}.json in the output dir
    const basename = path.basename(wavPath, path.extname(wavPath));
    const jsonPath = path.join(outputDir, `${basename}.json`);

    if (!fs.existsSync(jsonPath)) {
      throw new Error(`Whisper output not found at ${jsonPath} — the process may have crashed before producing output`);
    }

    const raw = fs.readFileSync(jsonPath, "utf-8");
    let whisperOutput: WhisperOutput;
    try {
      whisperOutput = JSON.parse(raw) as WhisperOutput;
    } catch (parseErr) {
      throw new Error(`Whisper output is not valid JSON at ${jsonPath}: ${(parseErr as Error).message}`);
    }

    return whisperOutput.segments.map((seg) => ({
      speaker,
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
    }));
  } finally {
    // Clean up temp dir
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Segment merging
// ---------------------------------------------------------------------------

/**
 * Merge two arrays of timestamped segments, interleaving by start time.
 * Segments are sorted by start time; ties broken by speaker ("user" first).
 */
export function mergeSegments(
  userSegments: TranscriptSegment[],
  othersSegments: TranscriptSegment[],
): TranscriptSegment[] {
  const all = [...userSegments, ...othersSegments];
  all.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    // user first on ties
    if (a.speaker === "user" && b.speaker === "others") return -1;
    if (a.speaker === "others" && b.speaker === "user") return 1;
    return 0;
  });
  return all;
}

// ---------------------------------------------------------------------------
// Full-text generation
// ---------------------------------------------------------------------------

/**
 * Build readable full text from merged segments.
 */
export function buildFullText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => `${s.speaker === "user" ? "User" : "Others"}: ${s.text}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function execFileAsync(cmd: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    }, (err, stdout, stderr) => {
      if (err) {
        // Provide clear, actionable error messages for common failure modes
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(new Error(`Whisper binary not found: "${cmd}" is not installed or not on PATH`));
        } else if ((err as any).killed && (err as any).signal === "SIGTERM") {
          reject(new Error(`Whisper timed out after ${timeoutMs}ms`));
        } else {
          // Detect common sub-dependency failures in stderr
          const combined = `${err.message} ${stderr}`;
          if (combined.includes("ffmpeg") && (combined.includes("not found") || combined.includes("FileNotFoundError") || combined.includes("No such file"))) {
            reject(new Error(`ffmpeg not found — Whisper requires ffmpeg to be installed and on PATH\nstderr: ${stderr}`));
          } else {
            reject(new Error(`Whisper process failed (exit code ${(err as any).code ?? "unknown"}): ${err.message}${stderr ? `\nstderr: ${stderr}` : ""}`));
          }
        }
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
