# CLAUDE.md — 033 Fix Chunk #0 Race

## Branch
`fix/033-chunk0-race`

Create from `main`. All commits go here. Merge to `main` when done.

## What To Fix

The shipper's file watcher misses chunk #0 because it may already exist before the watcher is initialized. Read SPEC.md for full details.

## Implementation Steps

### Step 1 — Add `scan_existing_files()` to `shipper/src/watcher.rs`

Add a function that scans the outbox directory for existing `.wav` files, excludes `failed/` subdirectory, and returns them sorted by name (which ensures chunk ordering).

### Step 2 — Call scan on watcher startup

After the `notify::Watcher` is initialized but before entering the event loop, scan for pre-existing files and feed them into the upload queue. This ensures any chunks written before the watcher started are picked up.

### Step 3 — Deduplicate uploads

Track uploaded/queued file paths in a `HashSet<PathBuf>` to prevent double uploads when a file appears in both the initial scan and a subsequent watcher event.

### Step 4 — Tests

In `shipper/src/watcher.rs`:
- Unit test: `scan_existing_files` returns correct files, sorted, excludes `failed/`
- Unit test: `scan_existing_files` on empty dir returns empty vec

In `tray/tests/shipper_integration.rs`:
- Integration test: write chunk to outbox BEFORE starting shipper, verify it gets uploaded to mock server
- Integration test: write chunk before AND after shipper start, verify both uploaded in order, no duplicates

### Step 5 — Run all tests

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd tools/cortex-audio
cargo test
```

All existing 84 Rust tests + new tests must pass.

### Step 6 — Commit, merge, push

```powershell
git checkout -b fix/033-chunk0-race
git add tools/cortex-audio/shipper/src/watcher.rs tools/cortex-audio/tray/tests/shipper_integration.rs
git commit -m "033: fix chunk #0 race — scan outbox for pre-existing files on shipper startup"
git checkout main
git merge fix/033-chunk0-race --no-edit
git push
```

### Step 7 — Create STATE.md

Create `workspace/pipeline/InProgress/033-fix-chunk0-race/STATE.md`.

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT modify** any TypeScript files
- **Only modify** `shipper/src/watcher.rs` and `tray/tests/shipper_integration.rs`
- **Only commit those files.** Do NOT `git add -A`.
- Cargo needs PATH: `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- Chunk #0 reliably uploaded even when written before shipper starts
- No duplicate uploads
- All existing + new tests pass
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
