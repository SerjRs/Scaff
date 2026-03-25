# CLAUDE.md — 037 Gateway Init Integration Test

## Branch
`feat/037-gateway-init-test`

Create from `main`. All commits go here. Merge to `main` when done.

## Context

`initGatewayAudioCapture()` is THE function that wires the entire audio pipeline in production. Bug #5 (ingestion never wired) lived here. While 032 now exercises it in a server-side E2E context, there are no focused unit/integration tests for the init function itself — verifying config handling, DB creation, directory creation, handler construction, workerDeps wiring, onIngest callback, cleanup, and edge cases.

Read the full audit in TESTS-REVISION-REPORT.md before writing anything.

## Step 1 — Read everything

Read in this order:
1. `workspace/pipeline/InProgress/037-gateway-init-integration-test/TESTS-REVISION-REPORT.md` — full audit
2. `workspace/pipeline/InProgress/037-gateway-init-integration-test/SPEC.md` — spec
3. `src/gateway/server-audio.ts` — THE function to test: initGatewayAudioCapture
4. `src/audio/ingest.ts` — createGatewayAudioHandler, loadAudioCaptureConfig
5. `src/audio/session-store.ts` — initAudioSessionTable
6. `src/audio/worker.ts` — WorkerDeps, transcribeSession
7. `src/audio/types.ts` — AudioCaptureConfig
8. `src/audio/__tests__/gateway-wiring.test.ts` — existing gateway tests (test handler factory, NOT init function)
9. `src/audio/__tests__/real-e2e.test.ts` — 032 rewrite uses initGatewayAudioCapture in E2E context

## Step 2 — Write gateway-init.test.ts

Create `src/audio/__tests__/gateway-init.test.ts` — focused tests for `initGatewayAudioCapture()`.

### Rules:
- **Call initGatewayAudioCapture() directly** — that is what you are testing
- **Real SQLite databases** — no DB mocks
- **Real file I/O** — verify directories are created
- **Real config loading** — use loadAudioCaptureConfig with overrides
- **No environment patching**
- **Clean up temp dirs after each test**

### Tests to write:

#### Test 1: `returns valid handle with enabled config`
- Call initGatewayAudioCapture with enabled config, valid apiKey, temp stateDir
- Assert: returns non-null AudioCaptureHandle
- Assert: handle.handler is a function
- Assert: handle.db is an open DatabaseSync (can execute a query)
- Assert: handle.config.enabled === true
- Assert: handle.config.apiKey matches input

#### Test 2: `returns null when disabled`
- Call with audioCaptureConfig: { enabled: false }
- Assert: returns null

#### Test 3: `returns null when apiKey is empty`
- Call with audioCaptureConfig: { enabled: true, apiKey: "" }
- Assert: returns null

#### Test 4: `creates data directories`
- Call with temp stateDir
- Assert: inbox/, processed/, transcripts/ directories exist under dataDir

#### Test 5: `creates audio.sqlite with session table`
- Call with temp stateDir
- Assert: audio.sqlite exists in dataDir
- Query: SELECT name FROM sqlite_master WHERE type='table' AND name='audio_sessions'
- Assert: table exists

#### Test 6: `workerDeps includes onIngest callback`
- This is the critical test — bug #5 was that onIngest was never wired
- Call initGatewayAudioCapture
- Need to verify that the workerDeps passed to createGatewayAudioHandler includes onIngest
- Strategy: either inspect the handler internals, or upload a chunk + session-end and verify onIngest fires
- If the lazy Cortex/Router imports fail in test context, verify the failure is handled gracefully (try/catch logs warning, does not crash)

#### Test 7: `handler accepts chunk upload`
- Get handle from initGatewayAudioCapture
- Create a minimal HTTP server using the handle.handler
- Upload a valid chunk via multipart
- Assert: returns 200
- Assert: chunk file written to inbox

#### Test 8: `close() cleans up database`
- Get handle
- Call handle.close()
- Assert: subsequent DB operations throw (DB is closed)

#### Test 9: `relative dataDir resolved against stateDir`
- Call with audioCaptureConfig: { dataDir: "data/audio" } and a temp stateDir
- Assert: directories created under stateDir/data/audio/, not under cwd

#### Test 10: `absolute dataDir used as-is`
- Call with audioCaptureConfig: { dataDir: tempDir } (absolute path)
- Assert: directories created directly in tempDir

## Step 3 — Run all tests

```powershell
npx vitest run src/audio/ 2>&1
```

All tests must pass.

## Step 4 — Commit, merge, push

```powershell
git checkout -b feat/037-gateway-init-test
git add src/audio/__tests__/gateway-init.test.ts
# Add any source files you had to fix
git commit -m "037: gateway init integration tests — verify initGatewayAudioCapture wiring and lifecycle"
git checkout main
git merge feat/037-gateway-init-test --no-edit
git push
```

Do NOT `git add -A`.

## Step 5 — Create STATE.md

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT git add -A**
- **Do NOT patch environment variables**
- **DO fix source code if you find bugs** — document in STATE.md

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- gateway-init.test.ts with 10 tests covering init lifecycle
- initGatewayAudioCapture exercised directly in every test
- workerDeps.onIngest wiring verified
- Real SQLite, real file I/O, no mocks
- Config edge cases (disabled, empty key, relative/absolute dataDir)
- Cleanup (close) verified
- All tests pass
- Any bugs found fixed and documented
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
- If lazy Cortex/Router imports fail in test context, test that the failure is graceful (no crash, warning logged) — do NOT mock them
