/**
 * Transcription Worker — orchestrator.
 *
 * Validates chunks → concatenates → splits stereo → transcribes L+R → merges → ingests.
 * Runs as an async function within the gateway process (not a daemon).
 *
 * @see workspace/pipeline/InProgress/025e-transcription-worker/SPEC.md
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { updateSessionStatus, getSession } from "./session-store.js";
import { concatenateWavFiles, splitStereoToMono } from "./wav-utils.js";
import { runWhisper, mergeSegments, buildFullText } from "./transcribe.js";
import type { TranscriptSegment, WhisperConfig } from "./transcribe.js";
import { ingestTranscript } from "./ingest-transcript.js";
import type { Transcript } from "./ingest-transcript.js";
import type { IngestionDeps, IngestionResult } from "./ingest-transcript.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerConfig {
  dataDir: string;
  whisper: WhisperConfig;
}

export interface WorkerDeps {
  /** Audio session database. */
  sessionDb: DatabaseSync;
  /** Ingestion dependencies (Library + Hippocampus DBs, optional LLM). */
  ingestion?: IngestionDeps;
}

export interface WorkerResult {
  sessionId: string;
  transcript: Transcript;
  ingestion?: IngestionResult;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full transcription pipeline for a session.
 *
 * 1. Validate all chunks exist
 * 2. Concatenate chunks into single stereo WAV
 * 3. Split stereo → left (user) + right (others) mono WAVs
 * 4. Run Whisper on each channel
 * 5. Merge segments by timestamp
 * 6. Write transcript JSON
 * 7. Move audio from inbox → processed
 * 8. Update session status
 * 9. Trigger ingestion (if deps provided)
 */
export async function transcribeSession(
  sessionId: string,
  config: WorkerConfig,
  deps: WorkerDeps,
): Promise<WorkerResult> {
  const inboxDir = path.join(config.dataDir, "inbox", sessionId);
  const transcriptsDir = path.join(config.dataDir, "transcripts");
  const processedDir = path.join(config.dataDir, "processed", sessionId);

  // Mark session as transcribing
  updateSessionStatus(deps.sessionDb, sessionId, "transcribing");

  try {
    // 1. Validate chunks
    const chunkPaths = getChunkPaths(inboxDir);
    if (chunkPaths.length === 0) {
      throw new Error(`No chunks found in ${inboxDir}`);
    }

    // Check for sequence gaps
    const gaps = detectGaps(chunkPaths);
    if (gaps.length > 0) {
      throw new Error(`Missing chunks in sequence: ${gaps.join(", ")}`);
    }

    // 2. Concatenate
    const combinedWav = concatenateWavFiles(chunkPaths);

    // 3. Split stereo → mono
    const { left: leftWav, right: rightWav } = splitStereoToMono(combinedWav);

    // Write temp mono WAVs for Whisper
    const tmpLeft = path.join(inboxDir, "_left.wav");
    const tmpRight = path.join(inboxDir, "_right.wav");
    fs.writeFileSync(tmpLeft, leftWav);
    fs.writeFileSync(tmpRight, rightWav);

    // 4. Transcribe each channel
    let userSegments: TranscriptSegment[];
    let othersSegments: TranscriptSegment[];

    try {
      [userSegments, othersSegments] = await Promise.all([
        runWhisper(tmpLeft, "user", config.whisper),
        runWhisper(tmpRight, "others", config.whisper),
      ]);
    } finally {
      // Clean up temp files
      for (const f of [tmpLeft, tmpRight]) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    }

    // 5. Merge segments by timestamp
    const segments = mergeSegments(userSegments, othersSegments);

    // 6. Build transcript
    const session = getSession(deps.sessionDb, sessionId);
    const startedAt = session?.createdAt ?? new Date().toISOString();
    const endedAt = new Date().toISOString();
    const durationSeconds = segments.length > 0
      ? Math.max(...segments.map((s) => s.end))
      : 0;

    const transcript: Transcript = {
      sessionId,
      startedAt,
      endedAt,
      durationMinutes: Math.round(durationSeconds / 60),
      language: config.whisper.language,
      segments,
      fullText: buildFullText(segments),
    };

    // 7. Write transcript JSON
    fs.mkdirSync(transcriptsDir, { recursive: true });
    const transcriptPath = path.join(transcriptsDir, `${sessionId}.json`);
    fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));

    // 8. Move audio inbox → processed
    fs.mkdirSync(processedDir, { recursive: true });
    for (const chunkPath of chunkPaths) {
      const dest = path.join(processedDir, path.basename(chunkPath));
      fs.renameSync(chunkPath, dest);
    }
    // Remove empty inbox dir
    try { fs.rmdirSync(inboxDir); } catch { /* may not be empty */ }

    // 9. Update session status
    updateSessionStatus(deps.sessionDb, sessionId, "done");

    // 10. Trigger ingestion (optional)
    let ingestionResult: IngestionResult | undefined;
    if (deps.ingestion) {
      ingestionResult = await ingestTranscript(transcript, deps.ingestion);
    }

    return { sessionId, transcript, ingestion: ingestionResult };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateSessionStatus(deps.sessionDb, sessionId, "failed", { error: message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get sorted chunk file paths from an inbox directory. */
function getChunkPaths(inboxDir: string): string[] {
  if (!fs.existsSync(inboxDir)) return [];

  return fs.readdirSync(inboxDir)
    .filter((f) => f.startsWith("chunk-") && f.endsWith(".wav"))
    .sort()
    .map((f) => path.join(inboxDir, f));
}

/** Detect gaps in chunk sequence (0-based). */
function detectGaps(chunkPaths: string[]): number[] {
  const gaps: number[] = [];
  for (let i = 0; i < chunkPaths.length; i++) {
    const expected = `chunk-${String(i).padStart(4, "0")}.wav`;
    const actual = path.basename(chunkPaths[i]);
    if (actual !== expected) {
      gaps.push(i);
    }
  }
  return gaps;
}
