# CLAUDE.md — 035 Session-End After All Uploads Complete

## Branch
`fix/035-session-end-after-uploads`

Create from `main`. All commits go here. Merge to `main` when done.

## What To Fix

Session-end is sent immediately when capture stops, racing ahead of pending chunk uploads. The server rejects late-arriving chunks. Read SPEC.md for full details.

## Implementation Steps

### Step 1 — Read existing code

Read these files to understand the current architecture:
- `tools/cortex-audio/shipper/src/lib.rs` — ChunkShipper, signal_session_end
- `tools/cortex-audio/shipper/src/watcher.rs` — file watcher, pending tracking
- `tools/cortex-audio/shipper/src/upload.rs` — upload logic
- `tools/cortex-audio/tray/src/main.rs` — ShipperBridge, stop flow, AppController

### Step 2 — Add `pending_for_session()` to watcher

In `shipper/src/watcher.rs`, add a method that counts pending/in-flight files for a given session_id by matching the session prefix in tracked filenames.

### Step 3 — Add `drain_session()` to `ChunkShipper`

In `shipper/src/lib.rs`, add:
```rust
pub async fn drain_session(&self, session_id: &str, timeout: Duration) -> Result<u32, ShipperError>
```
- Poll pending_for_session() until it returns 0
- Use a short poll interval (250ms)
- Timeout after the given duration (default 30s)
- Return count of successfully uploaded chunks for this session
- Failed chunks (moved to `failed/`) count as "done", not pending

### Step 4 — Add `drain_and_end()` to ShipperBridge

In `tray/src/main.rs`, add a new ShipperBridge method:
```rust
pub fn drain_and_end(&self, session_id: String, timeout: Duration)
```
- Sends a message through the async channel to the tokio runtime
- Runtime calls drain_session(), then signal_session_end()
- Uses the same mpsc pattern as existing shipper bridge methods

### Step 5 — Update stop flow

In `tray/src/main.rs`, change the stop path in AppController:
- Replace direct `signal_session_end()` call with `drain_and_end(session_id, 30s)`
- For quit/close flow, use `drain_and_end(session_id, 5s)` (shorter timeout)
- If capture produced zero chunks, skip drain_and_end entirely

### Step 6 — Tests

Unit tests in shipper:
- `drain_session` returns immediately when no pending chunks
- `drain_session` waits for in-flight upload to complete
- `drain_session` times out correctly and still returns

Integration tests in `tray/tests/`:
- Upload 3 chunks + drain_and_end → verify server receives all chunks BEFORE session-end
- Verify chunk ordering on server matches upload order

### Step 7 — Run all tests

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd tools/cortex-audio
cargo test
```

All existing 92 Rust tests + new tests must pass.

### Step 8 — Commit, merge, push

```powershell
git checkout -b fix/035-session-end-after-uploads
git add tools/cortex-audio/shipper/src/lib.rs tools/cortex-audio/shipper/src/watcher.rs tools/cortex-audio/tray/src/main.rs
# Add any new test files
git add tools/cortex-audio/shipper/tests/ tools/cortex-audio/tray/tests/
git commit -m "035: drain pending uploads before session-end — no more rejected chunks"
git checkout main
git merge fix/035-session-end-after-uploads --no-edit
git push
```

### Step 9 — Create STATE.md

Create `workspace/pipeline/InProgress/035-session-end-after-uploads/STATE.md` with status and summary.

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT modify** any TypeScript files
- **Do NOT modify** `capture/src/*.rs` — this is shipper + tray side only
- **Only commit changed/new files in `tools/cortex-audio/shipper/` and `tools/cortex-audio/tray/`.** Do NOT `git add -A`.
- Cargo needs PATH: `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- Session-end never sent before all chunks uploaded (or timed out)
- 30s timeout prevents tray app from hanging
- Failed chunks don't block drain
- Zero-chunk sessions skip session-end
- All existing + new tests pass
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
