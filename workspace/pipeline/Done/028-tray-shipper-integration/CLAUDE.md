# CLAUDE.md — 028 Fix: Chunk Filename Mismatch

## Branch
`fix/028-chunk-filename-mismatch`

Create from `main`. All commits go here. Merge to `main` when done.

## What To Fix

The shipper's `parse_chunk_filename()` can't parse filenames produced by the capture engine. Read `SPEC-fix.md` for full details and exact code changes.

**Root cause:** Chunker writes `{session}_chunk-{seq}_{timestamp}.wav`, shipper expects `{session}_chunk_{seq}.wav`. Two mismatches: dash vs underscore separator, and extra timestamp suffix.

## Implementation Steps

### Step 1 — Fix parser (`shipper/src/watcher.rs`)

Replace `parse_chunk_filename()` with the version from SPEC-fix.md that handles both formats:
- Primary: `{session}_chunk-{seq}_{timestamp}.wav` (capture engine output)
- Fallback: `{session}_chunk_{seq}.wav` (legacy/test format)

### Step 2 — Add parser tests (`shipper/src/watcher.rs`)

Add tests for capture engine format (with timestamp) alongside existing legacy format tests. Both must parse correctly.

### Step 3 — Add cross-crate integration test (`tray/tests/shipper_integration.rs`)

Add a test that constructs filenames in the exact format the chunker produces and verifies `parse_chunk_filename()` can parse them. This prevents future regressions.

### Step 4 — Run all tests

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd tools/cortex-audio
cargo test
```

All 79 existing tests + new tests must pass.

### Step 5 — Commit, merge, push

```powershell
git checkout -b fix/028-chunk-filename-mismatch
git add -A
git commit -m "028-fix: align shipper filename parser with capture engine output format"
git checkout main
git merge fix/028-chunk-filename-mismatch --no-edit
git push
```

## Constraints

- **Rust only**
- **Do NOT modify** `capture/src/chunker.rs` — the chunker format is correct
- **Do NOT modify** `tray/src/main.rs` or `tray/src/config.rs` — no changes needed there
- **All work inside `C:\Users\Temp User\.openclaw`**
- Cargo needs PATH: `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`

## Working Directory

`C:\Users\Temp User\.openclaw`

## State Updates

After completion, update `workspace/pipeline/InProgress/028-tray-shipper-integration/STATE.md`:
- Add a "Fix" section noting the filename mismatch fix
- Keep STATUS: COMPLETE

## Done Criteria

- `parse_chunk_filename()` correctly parses `{session}_chunk-{seq}_{ts}.wav`
- Backward compatible: `{session}_chunk_{seq}.wav` still works
- All 79 existing tests + new tests pass
- Committed to `fix/028-chunk-filename-mismatch`, merged to main, pushed
- STATE.md updated

## If Something Fails

- Document the failure in STATE.md
- Try an alternative approach
- If stuck after 2 attempts, write `STATUS: BLOCKED` in STATE.md with details
