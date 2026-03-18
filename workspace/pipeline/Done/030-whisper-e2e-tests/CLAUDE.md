# CLAUDE.md — 030 Whisper E2E Tests

## Branch
`feat/030-whisper-e2e-tests`

Create from `main`. All commits go here. Merge to `main` when done.

## What To Build

Real Whisper E2E tests — no mocks. Read SPEC.md for full details.

## Implementation Steps

### Step 1 — Generate speech fixture

Use PowerShell `System.Speech.Synthesis.SpeechSynthesizer` to create a WAV with clear English speech. Then write a small Node script to combine it into stereo (left=speech, right=silence) at 16kHz, 16-bit PCM.

Speech content: "The meeting is scheduled for Tuesday at three PM. Action item: review the quarterly report by Friday."

Output files:
- `tools/cortex-audio/fixtures/test-speech-10s.wav` (stereo)
- `tools/cortex-audio/fixtures/test-speech-10s.expected.txt` (expected text)
- `tools/cortex-audio/fixtures/generate-speech-fixture.ps1` (regeneration script)

**Verify the fixture works** by running whisper on it manually:
```powershell
$env:PYTHONIOENCODING = "utf-8"
whisper "tools/cortex-audio/fixtures/test-speech-10s.wav" --model base.en --language en --output_format json --output_dir tmp/whisper-test
```
Check the JSON output contains recognizable words.

### Step 2 — Write test file

Create `src/audio/__tests__/whisper-e2e.test.ts` with 4 tests as specified in SPEC.md. Include the skip guard for when whisper isn't available.

Important: The `runWhisper` function in `src/audio/transcribe.ts` shells out to whisper. On Windows with Python 3.14, stderr may contain encoding warnings — don't let that fail the tests. Set `PYTHONIOENCODING=utf-8` in the environment before calling whisper.

### Step 3 — Run tests

```powershell
$env:PYTHONIOENCODING = "utf-8"
npx vitest run src/audio/__tests__/whisper-e2e.test.ts
```

All 4 new tests must pass. Then verify existing tests still pass:
```powershell
npx vitest run src/audio/
```

### Step 4 — Commit, merge, push

```powershell
git checkout -b feat/030-whisper-e2e-tests
git add tools/cortex-audio/fixtures/test-speech-10s.wav tools/cortex-audio/fixtures/test-speech-10s.expected.txt tools/cortex-audio/fixtures/generate-speech-fixture.ps1 src/audio/__tests__/whisper-e2e.test.ts
git commit -m "030: real Whisper E2E tests — speech fixture + 4 integration tests"
git checkout main
git merge feat/030-whisper-e2e-tests --no-edit
git push
```

### Step 5 — Update STATE.md

Create `workspace/pipeline/InProgress/030-whisper-e2e-tests/STATE.md` with results.

## Constraints

- **Do NOT modify** any existing test files or source files
- **Do NOT edit openclaw.json** — gateway restarts on config changes
- **Only add new files**
- Whisper needs `$env:PYTHONIOENCODING = "utf-8"` on Windows to avoid encoding crashes
- First whisper run downloads base.en model (~150MB) — be patient
- The `runWhisper` function in transcribe.ts may need PYTHONIOENCODING set in the child process env — if tests fail on encoding, patch the execFile call to include `env: { ...process.env, PYTHONIOENCODING: "utf-8" }`
- **Only commit the files listed above.** Do NOT `git add -A`. Do NOT commit logs, config files, or unrelated changes.

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- Speech fixture produces reliable Whisper output
- 4 tests pass with real Whisper binary
- Tests skip gracefully when whisper not on PATH
- All 62 existing mocked tests still pass
- Clean commit with only new files, merged to main, pushed
- STATE.md created
