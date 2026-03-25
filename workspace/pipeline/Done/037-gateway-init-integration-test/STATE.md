# STATE — 037 Gateway Init Integration Test

## Status: DONE

## Date: 2026-03-19

## What Was Done

### Test File Created
`src/audio/__tests__/gateway-init.test.ts` — 10 tests, all passing.

| # | Test | What It Verifies |
|---|------|-----------------|
| 1 | returns valid handle with enabled config | handler is function, DB open, config matches |
| 2 | returns null when disabled | `enabled: false` → null |
| 3 | returns null when apiKey is empty | empty apiKey → null + warning logged |
| 4 | creates data directories | inbox/, processed/, transcripts/ exist |
| 5 | creates audio.sqlite with session table | DB file on disk, audio_sessions table exists |
| 6 | workerDeps includes onIngest callback | **Bug #5 regression test** — onIngest is defined, callable, graceful on lazy import failure |
| 7 | handler accepts chunk upload via real HTTP | Real HTTP server, multipart upload, chunk written to inbox |
| 8 | close() cleans up database | DB operations throw after close |
| 9 | relative dataDir resolved against stateDir | `data/audio` → `stateDir/data/audio` |
| 10 | absolute dataDir used as-is | Absolute path not prefixed with stateDir |

### Source Fix
`src/gateway/server-audio.ts` — Added `workerDeps: WorkerDeps` to `AudioCaptureHandle` interface and return value. This exposes the worker deps for testability, allowing direct assertion that `onIngest` is wired (the property that bug #5 silently broke).

### Bugs Found
No new bugs in source code. The `onIngest` callback's try/catch around lazy Cortex/Router imports works correctly — logs a warning and does not crash when singletons are unavailable (test context).

## Test Results
```
✓ src/audio/__tests__/gateway-init.test.ts (10 tests) 194ms
✓ All 7 non-skipped test files pass (80 tests)
↓ 2 whisper-dependent files skipped (12 tests) — expected, whisper not on PATH
```

## Commit
`187cbacc1` — merged to main, pushed.
