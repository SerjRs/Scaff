# CLAUDE.md — 025d Audio Ingest API

## What You're Building

A TypeScript HTTP service that receives audio chunks from the Rust client (025c), validates and stores them, and triggers transcription on session end. Integrates into the OpenClaw gateway.

## Project Location

Inside the OpenClaw source tree:

```
src/audio/
  ingest.ts           # Express routes or standalone HTTP handlers
  session-store.ts    # Session tracking (SQLite table in bus.sqlite)
  types.ts            # Shared types
src/audio/__tests__/
  ingest.test.ts      # Tests
```

## Key Constraints

- **TypeScript/Node.js only** — same stack as the rest of OpenClaw.
- **Do NOT modify existing OpenClaw files** unless absolutely necessary (e.g., registering routes).
- **SQLite** for session tracking — use the existing `bus.sqlite` via `node:sqlite` `DatabaseSync`.
- **Use `node:http`** or lightweight routing. Do NOT add Express as a new dependency.
- Work on branch `feat/025d-audio-ingest-api`.
- Tests use `node:test` (built-in Node.js test runner).

## Implementation Order

1. `types.ts` — `AudioSession`, `ChunkMetadata`, config types
2. `session-store.ts` — SQLite table `audio_sessions`, CRUD operations
3. `ingest.ts` — HTTP handlers:
   - `POST /audio/chunk` — multipart, receives WAV chunk, writes to `data/audio/inbox/{session_id}/`
   - `POST /audio/session-end` — marks session complete, validates chunk sequence
   - `GET /audio/session/:id/status` — session state query
4. Tests for each module
5. Integration test: upload chunks → session-end → verify files + DB state

## Data Layout

```
data/audio/
  inbox/{session_id}/chunk-0000.wav, chunk-0001.wav, ...
  processed/{session_id}/   (after transcription)
  transcripts/{session_id}.json
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS audio_sessions (
  session_id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'receiving',
  chunks_received INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  error TEXT
);
```

## Auth

Simple API key check: `Authorization: Bearer <key>` header matched against config.

## Config

Read from `openclaw.json` under an `audio` key:

```json
{
  "audio": {
    "enabled": true,
    "apiKey": "test-key-123",
    "maxChunkSizeMB": 15,
    "dataDir": "data/audio",
    "port": 9500
  }
}
```

If `audio` key is missing or `enabled: false`, the service does not start.

## Testing

Use `node:test` with `describe`/`it`. Create a test HTTP server, send actual HTTP requests with `fetch()`.

```
node --test src/audio/__tests__/ingest.test.ts
```

## Done Criteria

- All handlers implemented and working
- SQLite session tracking operational
- Tests pass with `node --test`
- No new npm dependencies (use built-in `node:http`, `node:fs`, `node:sqlite`)
- Update STATE.md with STATUS: COMPLETE when done
