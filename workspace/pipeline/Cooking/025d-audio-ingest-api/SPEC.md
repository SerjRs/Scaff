---
id: "025d"
title: "Audio Ingest API — HTTP Endpoint for Chunk Reception"
priority: high
assignee: scaff
status: cooking
created: 2026-03-16
updated: 2026-03-17
type: feature
parent: "025"
depends_on: null
tech: typescript
---

# Audio Ingest API — HTTP Endpoint for Chunk Reception

## Goal

Server-side HTTP service integrated into the OpenClaw gateway that receives audio chunks from the Rust client (025c), validates and stores them, and triggers transcription on session end.

## Tech Stack

- **Language:** TypeScript (Node.js) — same stack as OpenClaw
- **HTTP framework:** Express route mounted on the existing gateway, or standalone `http.createServer` if isolation preferred
- **Storage:** Local filesystem under `data/audio/`
- **Auth:** API key validation (shared secret from client config)
- **Project location:** `src/audio/ingest.ts` (inside OpenClaw source tree)

## Endpoints

### `POST /audio/chunk`

Receives a single audio chunk.

**Request:**
```
Content-Type: multipart/form-data
Authorization: Bearer <api_key>

Fields:
  session_id: string (UUID)
  sequence: number (0-indexed)
  file: binary (WAV)
```

**Response:**
- `200 OK` — chunk stored
- `400 Bad Request` — missing fields, invalid format
- `401 Unauthorized` — bad API key
- `413 Payload Too Large` — chunk exceeds max size (default 15 MB)

**Storage:** `data/audio/inbox/{session_id}/chunk-{sequence:04}.wav`

### `POST /audio/session-end`

Signals that all chunks for a session have been sent.

**Request:**
```json
{
  "session_id": "uuid"
}
Authorization: Bearer <api_key>
```

**Response:**
- `200 OK` — session marked complete, transcription queued
- `400 Bad Request` — unknown session_id or no chunks received
- `401 Unauthorized`

**Behavior:**
1. Verify at least 1 chunk exists for session_id
2. Verify chunk sequence is contiguous (no gaps)
3. Mark session as `pending_transcription`
4. Trigger transcription worker (025e) — either direct function call or event/queue
5. Return 200

### `GET /audio/session/:id/status`

Check session state (optional, for debugging).

**Response:**
```json
{
  "session_id": "uuid",
  "status": "receiving | pending_transcription | transcribing | done | failed",
  "chunks_received": 5,
  "created_at": "2026-03-17T10:00:00Z"
}
```

## Session Tracking

In-memory Map or SQLite table (in `bus.sqlite`):

```sql
CREATE TABLE audio_sessions (
  session_id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'receiving',  -- receiving | pending_transcription | transcribing | done | failed
  chunks_received INTEGER DEFAULT 0,
  created_at TEXT,
  completed_at TEXT,
  error TEXT
);
```

## Folder Structure

```
data/audio/
  inbox/{session_id}/          # chunks being received
  processed/{session_id}/      # audio after transcription (retention)
  transcripts/{session_id}.json  # transcription output (025e writes here)
```

## Configuration

In `openclaw.json` or `cortex/config.json`:

```json
{
  "audio": {
    "enabled": true,
    "apiKey": "...",
    "maxChunkSizeMB": 15,
    "dataDir": "data/audio",
    "retentionDays": 30
  }
}
```

## Unit Tests

- **Chunk upload**: valid multipart → 200, file written to correct path
- **Auth**: missing/wrong API key → 401
- **Validation**: missing session_id → 400, oversized chunk → 413
- **Session end**: valid session with chunks → 200, empty session → 400
- **Sequence gap detection**: chunks 0,1,3 (missing 2) → warning in session status
- **Config validation**: disabled audio → 404 on all endpoints

## E2E Tests

- **Full upload cycle**: upload 3 chunks → session-end → verify all files in inbox, session status = pending_transcription
- **Concurrent sessions**: two sessions uploading simultaneously → verify isolation
- **Large chunk**: upload 10MB WAV → verify accepted and stored correctly

## Integration Points

- Mounts on the OpenClaw gateway HTTP server (port 18789 or configurable)
- Triggers 025e transcription worker on session-end
- Session state stored in `bus.sqlite` for Cortex visibility

## Out of Scope

- Audio capture/shipping (025a-025c, Rust client)
- Transcription (025e)
- Knowledge graph ingestion (post-025e)
