# CLAUDE.md — 025g E2E Pipeline Test

## Branch
`feat/025g-e2e-pipeline-test`

Create from `main`. All commits go here. Merge to `main` when done.

## What To Build

End-to-end validation of the full audio capture → transcription → knowledge graph pipeline. Read `SPEC.md` in this folder for full details.

**Summary of deliverables:**

1. **Release build** — `cargo build --release` in `tools/cortex-audio/`. Verify binary exists and size is reasonable.

2. **E2E test script** — Create `scripts/test-audio-e2e.ts` that:
   - Generates a synthetic stereo WAV file (or uses a fixture)
   - Splits it into chunks (simulating what 025a capture engine produces)
   - POSTs chunks to `http://127.0.0.1:18789/audio/chunk`
   - POSTs session-end to `/audio/session-end`
   - Polls `/audio/session/:id/status` until done/failed
   - Verifies: transcript JSON exists, Library article created, Hippocampus facts created
   - Prints pass/fail for each checkpoint

3. **Test fixtures** — Create `tools/cortex-audio/fixtures/` with small test WAV files (can be generated programmatically — sine waves are fine, Whisper will just produce gibberish but the pipeline validates).

4. **USAGE.md** — Update or create `tools/cortex-audio/USAGE.md` with build, run, and manual test instructions.

## Important Context

- Gateway audio config key is `audioCapture` (NOT `audio`) — see `openclaw.json`
- Audio handler is already mounted on the gateway (025f done)
- Ingest API is at `src/audio/ingest.ts` — routes: `/audio/chunk`, `/audio/session-end`, `/audio/session/:id/status`
- Worker is at `src/audio/worker.ts`
- Whisper CLI is installed on this machine (`whisper` command available)
- Session DB is separate: `data/audio/audio.sqlite`
- Cargo workspace: `tools/cortex-audio/Cargo.toml` with members: capture, shipper, tray

## Constraints

- **Do NOT modify** any `src/audio/*.ts` or `src/gateway/*.ts` files — that code is done
- **Do NOT modify** any Rust source code — 025a/b/c are done
- The E2E test script should work standalone (not require the gateway to be running for the vitest parts — mock HTTP if needed, or make it a manual script)
- For the automated vitest: you can start the audio handler in-process and mock Whisper CLI
- For the manual test doc: assume real gateway + real Whisper
- WAV fixtures should be small (< 100KB each) — sine waves, not real speech
- **All work inside `C:\Users\Temp User\.openclaw`**

## Working Directory

`C:\Users\Temp User\.openclaw`

## Git Workflow

```powershell
git checkout -b feat/025g-e2e-pipeline-test
# ... make changes ...
git add -A
git commit -m "025g: <description>"
git checkout main
git merge feat/025g-e2e-pipeline-test --no-edit
git push
```

## Rust Build

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd tools/cortex-audio
cargo build --release
```

## Test Commands

```powershell
npx vitest run src/audio/
npx vitest run scripts/
```

Existing 62 audio tests must still pass. New E2E tests on top.

## State Updates

After each milestone, update `workspace/pipeline/InProgress/025g-e2e-pipeline-test/STATE.md`.

## Done Criteria

- `cargo build --release` succeeds
- E2E test script created and runs (at least the parts that don't need live Whisper)
- Test fixtures created
- USAGE.md with complete instructions
- All existing tests pass
- Committed, merged to main, pushed
- `STATE.md` shows `STATUS: COMPLETE`

## If Something Fails

- Document the failure in STATE.md
- Try an alternative approach
- If stuck after 2 attempts, write `STATUS: BLOCKED` in STATE.md with details
