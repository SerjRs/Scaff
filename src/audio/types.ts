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

export interface AudioConfig {
  enabled: boolean;
  apiKey: string;
  maxChunkSizeMB: number;
  dataDir: string;
  port: number;
}

export const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  enabled: false,
  apiKey: "",
  maxChunkSizeMB: 15,
  dataDir: "data/audio",
  port: 9500,
};
