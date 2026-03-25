# CLAUDE.md — 034 Flush Partial Chunk on Stop

## Branch
`fix/034-flush-partial-chunk`

Create from `main`. All commits go here. Merge to `main` when done.

## What To Fix

When capture stops, the current in-progress chunk is discarded if it hasn't reached `maxChunkSizeMB`. Any audio accumulated since the last chunk rotation is lost. Read SPEC.md for full details.

## Implementation Steps

### Step 1 — Read existing code

Read `tools/cortex-audio/capture/src/chunker.rs` and `tools/cortex-audio/capture/src/lib.rs` to understand the current `ChunkWriter` structure and how `stop()` works.

### Step 2 — Add `flush()` to `ChunkWriter` in `capture/src/chunker.rs`

Add a `flush()` method that:
1. Takes whatever PCM data has been accumulated since the last chunk rotation
2. Skips if buffer is empty OR has less than 0.5 seconds of audio (`sample_rate * channels * 2 bytes * 0.5`)
3. Writes a valid WAV file with correct headers (data length matching actual PCM data)
4. Uses the same filename format: `{sessionId}_chunk-{seq:04}_{timestamp}.wav`
5. Increments the sequence counter
6. Returns the path of the written file (or None if skipped)

### Step 3 — Call `flush()` from `CaptureEngine::stop()` in `capture/src/lib.rs`

Before shutting down the audio stream:
1. Call `flush()` on the `ChunkWriter`
2. If a partial chunk was written, emit `CaptureEvent::ChunkReady` through the event channel
3. Ensure the event is sent before the channel is closed/dropped

### Step 4 — Tests

In `capture/src/chunker.rs` or appropriate test file:
- Unit test: `flush()` writes valid WAV with correct header for partial data
- Unit test: `flush()` with empty buffer produces no file
- Unit test: `flush()` with <0.5s of audio produces no file
- Unit test: partial chunk has correct WAV headers (parseable, correct sample count)

In integration tests (if applicable):
- Start capture, feed ~2 seconds of audio (less than chunk rotation threshold), stop — verify one partial chunk exists and is valid

### Step 5 — Run all tests

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd tools/cortex-audio
cargo test
```

All existing 88 Rust tests + new tests must pass.

### Step 6 — Commit, merge, push

```powershell
git checkout -b fix/034-flush-partial-chunk
git add tools/cortex-audio/capture/src/chunker.rs tools/cortex-audio/capture/src/lib.rs
# Add any new test files too
git add tools/cortex-audio/capture/tests/
git commit -m "034: flush partial chunk on capture stop — no more lost audio"
git checkout main
git merge fix/034-flush-partial-chunk --no-edit
git push
```

### Step 7 — Create STATE.md

Create `workspace/pipeline/InProgress/034-flush-partial-chunk-on-stop/STATE.md` with status and summary.

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT modify** any TypeScript files
- **Do NOT modify** `shipper/src/*.rs` — this is capture-side only
- **Only commit changed/new files in `tools/cortex-audio/capture/`.** Do NOT `git add -A`.
- Cargo needs PATH: `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- Stopping capture flushes partial chunk to disk as valid WAV
- Partial chunk triggers `ChunkReady` event
- No empty or sub-0.5s chunks produced
- WAV headers correct (data length matches actual PCM)
- All existing + new tests pass
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
