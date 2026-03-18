---
id: "025f"
title: "Gateway Audio Wiring — Mount Routes, Config & Hippocampus Integration"
priority: high
assignee: scaff
status: cooking
created: 2026-03-17
updated: 2026-03-17
type: feature
parent: "025"
depends_on: ["025d", "025e"]
tech: typescript
---

# Gateway Audio Wiring — Mount Routes, Config & Hippocampus Integration

## Goal

Wire the existing audio modules (025d ingest API, 025e transcription worker) into the running OpenClaw gateway so they actually serve HTTP traffic, and connect transcription output to the Hippocampus knowledge graph via `runFactExtractor`.

After this task, the server side is live: chunks can be received, transcribed, and facts appear in the graph. No new business logic — pure plumbing.

## What Already Exists

All application code is written and tested:

| File | Purpose | Tests |
|------|---------|-------|
| `src/audio/ingest.ts` | Standalone HTTP server — chunk upload, session-end, status | 21 |
| `src/audio/session-store.ts` | SQLite session tracking (`audio_sessions` table) | — |
| `src/audio/worker.ts` | Orchestrator: validate → concat → split → transcribe → ingest | — |
| `src/audio/transcribe.ts` | Whisper CLI wrapper + JSON parser | 13 |
| `src/audio/wav-utils.ts` | WAV concat + stereo→mono split (pure JS) | 16 |
| `src/audio/ingest-transcript.ts` | Library article + Hippocampus fact/edge insertion | — |
| `src/audio/types.ts` | Config types + defaults | — |

## What's Missing (This Task)

### 1. Mount Audio Routes on Gateway HTTP Server

`src/audio/ingest.ts` currently creates its own `http.createServer`. It needs to be mounted on the gateway's existing HTTP server instead.

**Approach — Handler function export:**

Refactor `ingest.ts` to export a request handler function (same pattern as `handleSlackHttpRequest`, `handlePluginRequest`, etc.):

```typescript
// src/audio/ingest.ts
export async function handleAudioHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AudioDeps,
): Promise<boolean> {
  // return true if request was handled (path starts with /audio/)
  // return false to let other handlers try
}
```

Then wire it into `src/gateway/server-http.ts` in the request handler chain, after plugin routes and before OpenAI/canvas routes:

```typescript
// In createGatewayHttpServer handler chain
if (audioEnabled) {
  if (await handleAudioHttpRequest(req, res, audioDeps)) {
    return;
  }
}
```

**Auth:** Use the existing `apiKey` field from audio config. Validate `Authorization: Bearer <apiKey>` on all `/audio/*` routes. No gateway auth needed — the audio API has its own key.

### 2. Add `audio` Config Block to `openclaw.json`

```json
{
  "audio": {
    "enabled": false,
    "apiKey": "",
    "maxChunkSizeMB": 15,
    "dataDir": "data/audio",
    "port": null,
    "whisperBinary": "whisper",
    "whisperModel": "base.en",
    "whisperLanguage": "en",
    "whisperThreads": 4,
    "retentionDays": 30
  }
}
```

- `enabled: false` by default — opt-in
- `port: null` means use the gateway port (no separate listener)
- Config is loaded at gateway startup via `loadAudioConfig()`
- Config reload should pick up changes (register with `config-reload.ts` if applicable)

### 3. Wire Session-End → Worker → Hippocampus

Currently `ingest.ts` handles `POST /audio/session-end` but the connection to `worker.ts` is incomplete. The session-end handler must:

1. Call `worker.runTranscriptionPipeline(sessionId, config, deps)` 
2. `worker.ts` already calls `ingestTranscript()` at the end
3. `ingestTranscript()` already calls `insertItem` (Library) + `insertFact`/`insertEdge` (Hippocampus)

**Missing piece:** `ingestTranscript()` imports `extractFactsFromTranscript` from `src/cortex/gardener.ts` but needs an `extractLLM` function passed in. This must be wired to the gateway's LLM client:

```typescript
// Build the extraction LLM from gateway context
const extractLLM: FactExtractorLLM = async (prompt) => {
  return complete({ prompt, model: 'haiku' }); // or sonnet for quality
};
```

The `IngestionDeps` must receive:
- `libraryDb` — from gateway's database pool
- `busDb` — the cortex `bus.sqlite` handle
- `extractLLM` — wired to `src/llm/simple-complete.ts`

### 4. Initialize Audio Session Table at Startup

Call `initAudioSessionTable(db)` during gateway boot (in `server-startup.ts` or similar) when `audio.enabled` is true.

### 5. Data Directories

Create `data/audio/{inbox,processed,transcripts}` at startup if they don't exist. Paths relative to OpenClaw root.

## Files to Modify

| File | Change |
|------|--------|
| `src/audio/ingest.ts` | Refactor to export handler function; keep standalone server as fallback |
| `src/gateway/server-http.ts` | Add audio handler to request chain |
| `src/gateway/server-startup.ts` | Init audio session table + create data dirs |
| `openclaw.json` | Add `audio` config block (disabled by default) |
| `src/audio/worker.ts` | Ensure `IngestionDeps` are properly threaded through |
| `src/audio/types.ts` | Add whisper config fields if not present |

## Files NOT to Modify

- `src/audio/wav-utils.ts` — pure utility, no wiring needed
- `src/audio/transcribe.ts` — Whisper wrapper is complete
- `src/audio/session-store.ts` — SQLite ops are complete

## Tests

### Unit Tests (new)
- **Route mounting**: mock HTTP request to `/audio/chunk` → handler returns true
- **Config loading**: `openclaw.json` with audio block → correct config object; without → defaults
- **Auth middleware**: valid API key → pass; missing/wrong → 401
- **Disabled bypass**: `enabled: false` → handler returns false (all routes 404)

### Integration Tests (new)
- **Session-end → worker trigger**: POST session-end with valid chunks on disk → worker called → transcript JSON written
- **Worker → Hippocampus**: after transcription → verify `hippocampus_facts` has new entries with `source_type = 'audio-capture'`
- **Worker → Library**: after transcription → verify `library_items` has new article with transcript text

### Existing Tests (must not break)
- `src/audio/__tests__/ingest.test.ts` (21 tests)
- `src/audio/__tests__/transcribe.test.ts` (13 tests)
- `src/audio/__tests__/wav-utils.test.ts` (16 tests)

## Out of Scope

- Rust client changes (025a-025c)
- Whisper installation (already done)
- New transcription logic
- E2E from client → server (that's 025g)
