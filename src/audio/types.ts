/**
 * Audio Ingest API — shared types.
 *
 * @see workspace/pipeline/InProgress/025d-audio-ingest-api/SPEC.md
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type AudioSessionStatus =
  | "receiving"
  | "pending_transcription"
  | "transcribing"
  | "done"
  | "failed";

export interface AudioSession {
  sessionId: string;
  status: AudioSessionStatus;
  chunksReceived: number;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Chunk metadata (in-memory, not persisted separately)
// ---------------------------------------------------------------------------

export interface ChunkMetadata {
  sessionId: string;
  sequence: number;
  sizeBytes: number;
  storedPath: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AudioCaptureConfig {
  enabled: boolean;
  apiKey: string;
  maxChunkSizeMB: number;
  dataDir: string;
  port: number | null;
  whisperBinary: string;
  whisperModel: string;
  whisperLanguage: string;
  whisperThreads: number;
  retentionDays: number;
}

export const DEFAULT_AUDIO_CAPTURE_CONFIG: AudioCaptureConfig = {
  enabled: false,
  apiKey: "",
  maxChunkSizeMB: 15,
  dataDir: "data/audio",
  port: null,
  whisperBinary: "whisper",
  whisperModel: "base.en",
  whisperLanguage: "en",
  whisperThreads: 4,
  retentionDays: 30,
};

/** @deprecated Use AudioCaptureConfig instead. Kept for backward compat with tests. */
export interface AudioConfig {
  enabled: boolean;
  apiKey: string;
  maxChunkSizeMB: number;
  dataDir: string;
  port: number;
}

/** @deprecated Use DEFAULT_AUDIO_CAPTURE_CONFIG instead. */
export const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  enabled: false,
  apiKey: "",
  maxChunkSizeMB: 15,
  dataDir: "data/audio",
  port: 9500,
};

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface Transcript {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  durationMinutes: number;
  language: string;
  segments: Array<{
    speaker: "user" | "others";
    start: number;
    end: number;
    text: string;
  }>;
  fullText: string;
}
