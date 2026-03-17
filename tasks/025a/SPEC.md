---
id: "025a"
title: "Audio Capture Engine — WASAPI Stereo Capture & Chunking"
priority: high
assignee: scaff
status: "in_progress"
created: 2026-03-16
type: feature
parent: "025"
depends_on: null
---

# Audio Capture Engine — WASAPI Stereo Capture & Chunking

## Goal

Core audio capture module that records both mic and speaker audio via WASAPI, mixes them into a stereo WAV stream (left = mic, right = speakers), and writes size-based chunks to a local outbox directory. This is the data source for the entire pipeline.

## Scope

- WASAPI loopback capture (speakers/system audio)
- WASAPI capture (microphone input)
- Stereo mixing: **left channel = mic (user)**, **right channel = speakers (others)**
- WAV chunk writing to local outbox directory
- Size-based chunking: close current file at X MB (configurable, default 10 MB)
- Silence detection: if audio below threshold for configurable duration (default 60s), emit session-end event
- File naming: `{sessionId}_chunk-{sequence}_{timestamp}.wav`
- Session lifecycle: generate sessionId on start, accumulate chunks, emit session-end on stop/silence
- Configuration: sample rate (44100 Hz), chunk size, silence threshold (-50 dB), silence timeout (60s), outbox directory

## Public Interface

```
AudioCaptureEngine:
  start(sessionId: string) → void     // Begin capture, write chunks to outbox
  stop() → void                       // Stop capture, signal session end
  onChunkReady(callback)              // Emitted when a chunk file is fully written
  onSessionEnd(callback)              // Emitted on manual stop or silence timeout
  isCapturing() → boolean
```

## Configuration

```json
{
  "maxChunkSizeMB": 10,
  "silenceTimeoutSeconds": 60,
  "silenceThresholdDb": -50,
  "sampleRate": 44100,
  "outboxDir": "%LOCALAPPDATA%\\CortexAudio\\outbox"
}
```

## Unit Tests

- **Stereo mixing**: given separate mic and speaker buffers, verify output is stereo with mic on left, speakers on right
- **Chunk size enforcement**: given continuous audio input, verify files are closed and new ones started at the size threshold
- **File naming**: verify chunk files follow `{sessionId}_chunk-{sequence}_{timestamp}.wav` format with incrementing sequence
- **Silence detection**: given audio below threshold for configured duration, verify session-end event fires
- **No false silence**: given audio with brief pauses (< timeout), verify session continues
- **Config validation**: verify invalid config values (negative chunk size, zero sample rate) are rejected
- **Session state**: verify `isCapturing()` returns correct state before/after start/stop
- **Outbox directory**: verify directory is created if it doesn't exist

## End-to-End Tests

- **Full capture cycle**: start capture → feed test audio → verify chunk files appear in outbox with correct WAV format, stereo layout, and naming
- **Silence auto-stop**: start capture → feed audio → feed silence for > timeout → verify session-end fires and no more chunks are written
- **Multi-chunk session**: feed enough audio to produce 3+ chunks → verify all chunks are sequential, no gaps, no overlaps
- **Resume after stop**: start → stop → start new session → verify new sessionId, sequence resets

## Out of Scope

- Network/shipping (that's 025c)
- UI/tray (that's 025b)
- Any server-side logic
