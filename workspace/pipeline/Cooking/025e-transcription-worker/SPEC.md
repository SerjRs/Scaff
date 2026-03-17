---
id: "025e"
title: "Transcription Worker — STT & Speaker Diarization"
priority: high
assignee: scaff
status: cooking
created: 2026-03-16
updated: 2026-03-17
type: feature
parent: "025"
depends_on: "025d"
tech: typescript
---

# Transcription Worker — STT & Speaker Diarization

## Goal

Server-side worker (TypeScript/Node.js) that takes completed audio sessions, runs speech-to-text with speaker diarization, produces structured transcripts, and ingests results into the OpenClaw knowledge graph (Library + Hippocampus).

## Tech Stack

- **Language:** TypeScript (Node.js) — same stack as OpenClaw
- **STT:** `whisper.cpp` via `whisper-node` binding, or shell exec to local `whisper` CLI
- **Diarization:** Channel-based (L=user, R=others from stereo WAV) — no ML diarization needed
- **Project location:** `src/audio/transcribe.ts` + `src/audio/ingest-transcript.ts`

## Architecture

Triggered by 025d when `POST /audio/session-end` is received.

```
025d (session-end) → transcribe(sessionId) → ingestTranscript(sessionId)
```

Not a long-running daemon. Runs as an async function within the gateway process.

## Transcription Flow

1. **Validate**: verify all chunks exist in `data/audio/inbox/{sessionId}/`
2. **Concatenate**: combine `chunk-0000.wav` ... `chunk-NNNN.wav` into single WAV (or process sequentially)
3. **Split channels**: extract left (mic/user) and right (speakers/others) as separate mono WAVs
4. **Transcribe each channel**: run Whisper on left and right separately
5. **Merge timelines**: interleave segments from both channels by timestamp
6. **Label speakers**: left channel → "user", right channel → "others"
7. **Write output**: `data/audio/transcripts/{sessionId}.json`
8. **Move audio**: `inbox/{sessionId}/` → `processed/{sessionId}/`
9. **Update session status**: `transcribing` → `done` (or `failed` on error)
10. **Trigger ingestion**: call `ingestTranscript(sessionId)`

## Transcript Format

```json
{
  "sessionId": "abc-123",
  "startedAt": "2026-03-17T14:30:00Z",
  "endedAt": "2026-03-17T15:15:00Z",
  "durationMinutes": 45,
  "language": "en",
  "segments": [
    {
      "speaker": "user",
      "start": 0.0,
      "end": 4.2,
      "text": "Let's start with the Q1 numbers."
    },
    {
      "speaker": "others",
      "start": 4.5,
      "end": 12.1,
      "text": "Sure. Revenue came in at 1.2 million, 15% above target."
    }
  ],
  "fullText": "User: Let's start with the Q1 numbers.\nOthers: Sure. Revenue came in at 1.2 million..."
}
```

## Knowledge Graph Ingestion

After transcription completes, `ingestTranscript()`:

1. **Create Library article:**
   - Title: `Meeting Transcript — {date} {time} ({duration}min)`
   - Full text: complete transcript (fullText field)
   - Tags: `meeting`, `transcript`, auto-detected topics
   - Source type: `audio-capture`

2. **Extract facts → Hippocampus** (via existing `runFactExtractor`):
   - Action items ("I'll send the proposal by Friday")
   - Decisions ("We agreed to go with Vendor B")
   - Key data points ("Revenue is 1.2M, 15% above target")
   - People mentioned + context
   - Deadlines with dates

3. **Create edges** in knowledge graph:
   - `transcript → sourced_from → audio_session`
   - `decision → resulted_in → action_item`
   - Facts link back to transcript via `source_ref`

4. **Notify user** (optional):
   - Send to user's active channel: "Meeting transcribed (45 min). 3 action items, 2 decisions found."

## Whisper Configuration

```json
{
  "audio": {
    "whisperModel": "base.en",
    "whisperBinary": "whisper",
    "language": "en",
    "threads": 4
  }
}
```

Options for Whisper integration:
- **Option A (recommended):** Shell exec `whisper` CLI — simplest, no native bindings
- **Option B:** `whisper-node` npm package — tighter integration but native compilation required
- **Option C:** HTTP API to a local whisper server (e.g. `faster-whisper-server`)

Decision: start with Option A, upgrade if latency is a problem.

## WAV Processing

Use `wav` or `wavefile` npm packages for:
- Reading WAV headers (verify format)
- Splitting stereo → two mono channels
- Concatenating multiple WAV files

No FFmpeg dependency. Pure JS WAV handling for the simple operations we need.

## Unit Tests

- **Channel splitting**: given stereo WAV buffer, extract correct L and R mono buffers
- **Segment merging**: given two timestamped segment arrays, verify correct interleaving by time
- **Speaker labeling**: left channel segments → "user", right → "others"
- **Transcript format**: verify output JSON matches schema
- **Chunk concatenation**: given 3 WAV files, verify single output has correct total duration
- **Missing chunk handling**: gap in sequence → graceful error with clear message

## E2E Tests

- **Full pipeline**: place test WAV chunks in inbox → trigger transcription → verify transcript JSON exists with valid segments
- **Ingestion**: after transcription → verify Library article created + Hippocampus facts extracted
- **Error recovery**: corrupt WAV file → session marked `failed`, error logged, no crash

## Out of Scope

- Audio capture/shipping (025a-025c, Rust client)
- HTTP endpoint (025d)
- Whisper model training or fine-tuning
