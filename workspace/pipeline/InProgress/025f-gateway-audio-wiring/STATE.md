# STATE — 025f Gateway Audio Wiring

## STATUS: COMPLETE
## Last Updated: 2026-03-17

## Decisions Made
- Used `audioCapture` as config key (not `audio`) because `audio` is already used for message-level transcription in `types.messages.ts`
- Audio sessions stored in separate `data/audio/audio.sqlite` (not in bus.sqlite) to avoid cluttering the cortex bus
- Worker integration is fire-and-forget: session-end responds immediately, then triggers `triggerPendingTranscriptions()` async
- LLM for fact extraction uses `claude-haiku-4-5` via `simple-complete.ts` (cost-efficient for extraction)
- When `audioCapture.enabled=false`, the handler returns `false` (silent skip), allowing other handlers to try
- Audio handler placed in request chain after plugin routes, before OpenAI/responses routes

## Progress
- [x] Added `AudioCaptureConfig` type with whisper fields to `src/audio/types.ts`
- [x] Added `audioCapture` to `OpenClawConfig` in `src/config/types.openclaw.ts`
- [x] Exported `loadAudioCaptureConfig()` and `createGatewayAudioHandler()` from `src/audio/ingest.ts`
- [x] Added `handleAudioRequest` to gateway HTTP server chain in `src/gateway/server-http.ts`
- [x] Passed `handleAudioRequest` through `src/gateway/server-runtime-state.ts`
- [x] Created `src/gateway/server-audio.ts` — init function that creates DB, data dirs, and handler
- [x] Wired `initGatewayAudioCapture()` into `src/gateway/server.impl.ts` before runtime state creation
- [x] Added cleanup to gateway close handler
- [x] Added `audioCapture` config block to `openclaw.json` (disabled by default)
- [x] Session-end → worker pipeline → hippocampus ingestion fully wired
- [x] 12 new integration tests pass (config loading, route mounting, auth, disabled bypass, session status)
- [x] All 62 audio tests pass (50 existing + 12 new)
- [x] Committed to `feat/025f-gateway-audio-wiring`

## Files Changed
| File | Change |
|------|--------|
| `src/audio/types.ts` | Added `AudioCaptureConfig` with whisper fields; kept `AudioConfig` for backward compat |
| `src/audio/ingest.ts` | Added `loadAudioCaptureConfig()`, `createGatewayAudioHandler()`, `triggerPendingTranscriptions()` |
| `src/config/types.openclaw.ts` | Added `audioCapture?: Partial<AudioCaptureConfig>` to `OpenClawConfig` |
| `src/gateway/server-http.ts` | Added `handleAudioRequest` to opts and request chain |
| `src/gateway/server-runtime-state.ts` | Passes `handleAudioRequest` through to HTTP server |
| `src/gateway/server-audio.ts` | **NEW** — `initGatewayAudioCapture()` init function |
| `src/gateway/server.impl.ts` | Creates audio handler before runtime state; cleanup on close |
| `openclaw.json` | Added `audioCapture` config block (disabled by default) |
| `src/audio/__tests__/gateway-wiring.test.ts` | **NEW** — 12 integration tests |

## Test Results
```
Test Files  4 passed (4)
Tests       62 passed (62)
```

## Errors
None
