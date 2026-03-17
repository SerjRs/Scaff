---
id: "025"
title: "Meeting Transcription — Local Audio Agent & Server Pipeline"
priority: high
assignee: scaff
status: cooking
created: 2026-03-16
type: feature
depends_on: "024"
---

# Meeting Transcription — Local Audio Agent & Server Pipeline

## Overview

A local Windows tray app captures audio from the user's computer, chunks it by size, and ships it to a server-side Audio Service that transcribes and ingests into the knowledge graph.

**2 processes. That's it.**

### Tech Split (updated 2026-03-17)

| Component | Tech | Reason |
|-----------|------|--------|
| **Client (025a/b/c)** | Rust | Single binary (~3-5MB), no runtime, no .NET, WASAPI via `cpal` |
| **Server (025d/e)** | TypeScript/Node.js | Same stack as OpenClaw, direct integration with Library + Hippocampus |

Client = cargo workspace at `tools/cortex-audio/` with 3 crates: `capture`, `shipper`, `tray`.
Server = `src/audio/` inside OpenClaw source tree.

---

## Architecture

```
┌──────── User's Windows PC ────────┐            ┌──────── Cortex Server ──────────────────┐
│                                    │            │                                          │
│  Tray App (1 process)              │   HTTPS    │  Audio Service (1 process)               │
│                                    │            │                                          │
│  ┌─ Audio Capture Thread ────────┐ │            │  ┌─ HTTP Endpoint ───────────────────┐  │
│  │  WASAPI loopback (speakers)   │ │            │  │  POST /audio/chunk                │  │
│  │  WASAPI capture (mic)         │ │            │  │  POST /audio/session-end          │  │
│  │  Mix → stereo WAV chunks      │ │            │  │  - Receive chunks, validate, ACK  │  │
│  │  Left = mic, Right = speakers │ │  ────────→ │  │  - Store to inbox/{sessionId}/    │  │
│  └───────────────────────────────┘ │            │  └─────────────────────────────────────┘│
│                                    │            │                                          │
│  ┌─ Shipper Thread ─────────────┐ │            │  ┌─ Transcription Worker ──────────────┐│
│  │  Watch local outbox           │ │            │  │  Triggered on session-end            ││
│  │  Send to server IP:PORT       │ │            │  │  - Concatenate chunks in order       ││
│  │  Retry with backoff on fail   │ │            │  │  - Run STT (Whisper)                 ││
│  │  Delete local file on ACK     │ │            │  │  - Speaker diarization (L/R split)   ││
│  └───────────────────────────────┘ │            │  │  - Output transcript JSON            ││
│                                    │            │  └──────────────────────────────────────┘│
│  ┌─ UI ─────────────────────────┐ │            │                                          │
│  │  System tray icon             │ │            │  ┌─ Ingestion Worker ──────────────────┐│
│  │  Right-click: On / Off        │ │            │  │  Triggered on transcription done     ││
│  │  Green = On, Red = Off        │ │            │  │  - Create Library article            ││
│  └───────────────────────────────┘ │            │  │  - Extract facts → Hippocampus       ││
│                                    │            │  │  - Notify user (optional)             ││
└────────────────────────────────────┘            │  └──────────────────────────────────────┘│
                                                  └──────────────────────────────────────────┘
```

---

## Tray App (Client)

Single Windows process, three threads: capture, shipper, UI.

### Audio Capture Thread

- Captures **both** audio input (mic) and output (speakers) via WASAPI
- Mixes into stereo: **left channel = mic (user)**, **right channel = speakers (others)** — gives us cheap diarization downstream
- Writes to local outbox as `.wav` chunks
- **Chunking rule:** close current file and start a new one when it reaches **X MB** (configurable, default 10 MB)
- **Auto-off:** if silence (below threshold) for **60 seconds**, switch to Off and signal session end
- **File naming:** `{sessionId}_chunk-{sequence}_{timestamp}.wav`
- **Session lifecycle:**
  - User toggles On → new `sessionId` generated
  - Chunks accumulate while On
  - User toggles Off (or silence auto-off) → session ends

### Shipper Thread

- Watches local outbox folder
- Picks up completed `.wav` files (file size stable for 2s = write finished)
- Sends to server: `POST /audio/chunk` with sessionId, sequence, audio data
- On ACK → deletes local file
- On failure → exponential backoff retry (1s → 2s → 4s → ... max 60s)
- On session end → sends `POST /audio/session-end` with sessionId
- Outbox is just a retry buffer — not a contract between separate systems

### UI Thread

- System tray icon: **green** (On) / **red** (Off)
- Right-click menu: `Turn On` / `Turn Off` / `Settings` / `Quit`
- Optional: small audio level indicator so user knows capture is working

### Configuration (`config.json`)

```json
{
  "maxChunkSizeMB": 10,
  "silenceTimeoutSeconds": 60,
  "silenceThresholdDb": -50,
  "sampleRate": 44100,
  "serverUrl": "https://cortex.internal:9500",
  "apiKey": "...",
  "outboxDir": "%LOCALAPPDATA%\\CortexAudio\\outbox"
}
```

---

## Audio Service (Server)

Single process. HTTP endpoint + internal workers triggered by events, not cron.

### HTTP Endpoint

**`POST /audio/chunk`**
- Receives: sessionId, sequence number, audio data
- Validates: format, size, auth (API key)
- Stores: `/data/cortex/audio/inbox/{sessionId}/chunk-{sequence}.wav`
- Returns: `200 OK` (ACK)

**`POST /audio/session-end`**
- Receives: sessionId
- Triggers transcription worker for that session
- Returns: `200 OK`

### Transcription Worker

Triggered internally when session-end is received.

1. Verify all chunks present (sequence 001..N, no gaps)
2. Concatenate chunks in order
3. Run STT with speaker diarization:
   - Left channel → label as "user"
   - Right channel → label as "others"
   - Timestamps per segment
4. Output transcript:
   ```json
   {
     "sessionId": "abc123",
     "startedAt": "2026-03-16T14:30:00Z",
     "endedAt": "2026-03-16T15:15:00Z",
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
     "fullText": "User: Let's start with the Q1 numbers.\nOthers: Sure..."
   }
   ```
5. Save to `/data/cortex/audio/transcripts/{sessionId}.json`
6. Move audio from `inbox/` to `processed/`
7. Trigger ingestion worker

### Ingestion Worker

Triggered internally when transcription completes.

1. **Create Library article:**
   - Title: `Meeting Transcript — {date} {time} ({duration}min)`
   - Full text: complete transcript
   - Tags: `meeting`, `transcript`, detected topics
   - Source: `audio-capture`

2. **Extract facts → Hippocampus:**
   - Action items ("I'll send the proposal by Friday")
   - Decisions ("We agreed to go with Vendor B")
   - Key data points ("Revenue is 1.2M, 15% above target")
   - People mentioned + context
   - Deadlines

3. **Create edges** in knowledge graph:
   - Transcript → mentions → Person
   - Transcript → contains → Decision / Action Item
   - Action Item → has_deadline → Date

4. **Notify user** (optional):
   - Push to user's channel: "Meeting transcribed (45 min). 3 action items, 2 decisions."

### Server Folder Structure

```
/data/cortex/audio/
  ├─ inbox/{sessionId}/        ← chunks received, waiting
  ├─ processed/{sessionId}/    ← audio done, kept for retention
  └─ transcripts/{sessionId}.json  ← transcript output
```

---

## Security

- **Transport:** HTTPS between client and server. Audio in transit is sensitive.
- **Auth:** API key in shipper config. Server rejects unknown clients.
- **Storage:** encrypted volumes on both client and server.
- **Retention:** processed audio deleted after 30 days (configurable). Transcripts kept longer.
- **No web exposure:** Audio Service is internal only, not public-facing.

---

## Configuration Summary

| Parameter | Default | Where |
|---|---|---|
| Max chunk size | 10 MB | Client |
| Silence timeout | 60 seconds | Client |
| Silence threshold | -50 dB | Client |
| Audio format | WAV, 44100 Hz, stereo | Client |
| Server URL | (required) | Client |
| API key | (required) | Client + Server |
| Session timeout (missing chunks) | 5 minutes | Server |
| Audio retention | 30 days | Server |
| Transcript retention | 90 days | Server |

---

## Open Questions

- Chunk size vs. format: 10 MB uncompressed WAV ≈ ~1 min. Use OPUS for ~10x compression? Tradeoff: more audio per chunk, but transcoder dependency.
- WASAPI loopback vs. virtual audio driver: WASAPI needs no install but some apps may bypass it. Decide per testing.
- STT: self-hosted Whisper vs. cloud API? Latency vs. cost.
- Multi-user: if multiple users ship to same server, add userId to sessionId and folder structure.
- Should the tray app also show a live audio level meter?
