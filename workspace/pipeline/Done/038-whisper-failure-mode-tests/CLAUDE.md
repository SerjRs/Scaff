# CLAUDE.md — 038 Whisper Failure Mode Tests

## Branch
`feat/038-whisper-failure-tests`

Create from `main`. All commits go here. Merge to `main` when done.

## Context

No test covers what happens when Whisper fails. When Whisper crashed in production (ENOENT, ffmpeg missing), errors surfaced as unhelpful raw exceptions. The worker and transcribe code need explicit error handling tests for every failure mode.

Note on mocking: this is ONE exception where mocking execFile is legitimate. You are testing ERROR HANDLING, not Whisper itself. The goal is to verify that each failure produces a clear, actionable error message and the session fails gracefully (status="failed" with useful error text, no crash).

Read the full audit in TESTS-REVISION-REPORT.md before writing anything.

## Step 1 — Read everything

Read in this order:
1. `workspace/pipeline/InProgress/038-whisper-failure-mode-tests/TESTS-REVISION-REPORT.md` — full audit
2. `workspace/pipeline/InProgress/038-whisper-failure-mode-tests/SPEC.md` — spec
3. `src/audio/transcribe.ts` — runWhisper, execFileAsync, PATH handling
4. `src/audio/worker.ts` — transcribeSession, error handling, session status updates
5. `src/audio/session-store.ts` — updateSessionStatus, error field
6. `src/audio/__tests__/transcribe.test.ts` — existing transcribe tests
7. `src/audio/__tests__/whisper-e2e.test.ts` — rewritten whisper E2E tests (030)

## Step 2 — Write whisper-failures.test.ts

Create `src/audio/__tests__/whisper-failures.test.ts`.

### Tests to write:

#### Test 1: `binary not found produces clear error`
- Mock execFile to emit ENOENT error (the exact error from production bug #3)
- Call runWhisper() with a valid WAV path
- Assert: throws with a message that includes the binary name and "not found" or similar
- Assert: does NOT throw raw ENOENT without context

#### Test 2: `non-zero exit code includes stderr`
- Mock execFile to callback with error code 1 and stderr "CUDA out of memory" or similar
- Call runWhisper()
- Assert: throws with message containing the stderr content
- Assert: error is actionable (tells you what went wrong)

#### Test 3: `malformed JSON output produces parse error`
- Mock execFile to succeed (callback with no error)
- Write invalid JSON (e.g., "not json {{{") to the expected output path
- Call runWhisper()
- Assert: throws with message about JSON parse failure
- Assert: includes the output file path in the error

#### Test 4: `output file missing produces clear error`
- Mock execFile to succeed but do NOT create the output JSON file
- Call runWhisper()
- Assert: throws with "Whisper output not found at {path}" or similar
- This is the exact error from production (ffmpeg crash left no output)

#### Test 5: `empty transcript (silence) returns empty segments without error`
- Mock execFile to succeed
- Write valid JSON: { "text": "", "segments": [], "language": "en" }
- Call runWhisper()
- Assert: returns empty TranscriptSegment array
- Assert: does NOT throw

#### Test 6: `worker handles whisper failure gracefully`
- Set up a real session with chunks in inbox
- Configure worker with a whisperBinary that does not exist (e.g., "/nonexistent/whisper")
- Call transcribeSession()
- Assert: session status = "failed" in the DB
- Assert: session error field contains useful message (not raw stack trace)
- Assert: function does not throw (fails gracefully)

#### Test 7: `worker handles whisper timeout`
- If runWhisper supports a timeout option, mock execFile to never resolve
- Call with a short timeout
- Assert: throws with timeout-related message
- If no timeout support exists, document this as a gap

#### Test 8: `ffmpeg missing produces clear error (not deep Python traceback)`
- This tests the real scenario from production: whisper runs but ffmpeg is missing
- If possible without mocking: temporarily set PATH to exclude ffmpeg, run real whisper on a WAV
- If not feasible: mock execFile to return the actual Python traceback from the production failure
- Assert: error message is clear about ffmpeg being missing

## Step 3 — Verify error handling in source code

While writing tests, check if transcribe.ts and worker.ts actually handle these errors well. If they dont:
- Fix the error handling to produce clear, actionable messages
- Wrap raw errors with context (binary name, file path, etc.)
- Ensure worker catches all errors and sets session status = "failed" with the error text

## Step 4 — Run all tests

```powershell
npx vitest run src/audio/ 2>&1
```

All tests must pass.

## Step 5 — Commit, merge, push

```powershell
git checkout -b feat/038-whisper-failure-tests
git add src/audio/__tests__/whisper-failures.test.ts
# Add any source files you fixed
git add src/audio/transcribe.ts src/audio/worker.ts
git commit -m "038: whisper failure mode tests — verify error handling for every failure path"
git checkout main
git merge feat/038-whisper-failure-tests --no-edit
git push
```

Do NOT `git add -A`.

## Step 6 — Create STATE.md

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT git add -A**
- **Do NOT patch environment variables in test scope** (except Test 8 if testing real ffmpeg-missing scenario)
- **Mocking execFile is allowed here** — you are testing error handling, not Whisper
- **DO fix source code error handling if it is inadequate** — document in STATE.md

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- 8 tests covering every Whisper failure mode
- Each failure produces a clear, actionable error message (not raw exceptions)
- Worker sets session status="failed" with useful error text
- Worker does not crash on Whisper failure
- Source code error handling improved if needed
- All tests pass
- Any source fixes documented
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
