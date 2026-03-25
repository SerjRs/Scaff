# CLAUDE.md — 031 Cross-Stack Integration Tests (Rewrite)

## Branch
`feat/031-cross-stack-rewrite`

Create from `main`. All commits go here. Merge to `main` when done.

## Context

You are rewriting the cross-stack integration tests. The existing tests are garbage — they claim "Rust shipper → TypeScript server" but never run the Rust client. They construct multipart requests in TypeScript that "match what Rust sends" — a claim, not a verified fact. The off-by-one bug (`or_insert(1)`) passed all tests because both the test and the bug shared the same wrong assumption.

Read the full audit in `TESTS-REVISION-REPORT.md` in this folder before writing anything.

## Step 1 — Read everything

Read in this order:
1. `workspace/pipeline/InProgress/031-cross-stack-integration-tests/TESTS-REVISION-REPORT.md` — full audit
2. `workspace/pipeline/InProgress/031-cross-stack-integration-tests/SPEC.md` — spec with revision comments
3. `src/audio/__tests__/cross-stack.test.ts` — existing garbage tests
4. `src/audio/ingest.ts` — server-side chunk upload handler
5. `src/audio/session-store.ts` — session DB
6. `src/audio/types.ts` — types
7. `tools/cortex-audio/shipper/src/upload.rs` — the REAL Rust upload code (field names, multipart structure)
8. `tools/cortex-audio/shipper/src/lib.rs` — ChunkShipper, next_seq logic, tests at bottom
9. `tools/cortex-audio/shipper/src/watcher.rs` — filename parsing
10. `tools/cortex-audio/shipper/tests/field_contract.rs` — Rust contract tests
11. `tools/cortex-audio/capture/src/chunker.rs` — ChunkWriter, filename format, sequence start
12. `tools/cortex-audio/tray/tests/shipper_integration.rs` — Rust integration tests

## Step 2 — Rewrite cross-stack.test.ts

Delete the entire content and rewrite from scratch.

### Rules:
- **Tests must verify what the Rust client ACTUALLY sends**, not what the test author thinks it sends
- **Sequence numbering must start at 0** — match the capture engine, not assumptions
- **Use the real capture engine filename format**: `{session}_chunk-{seq:04}_{timestamp}.wav`
- **No environment patching**
- **The multipart format must be derived from reading the Rust source**, not from hand-crafting

### Tests to write:

#### Test 1: `server accepts multipart with field names matching Rust client`
- Read the Rust `upload.rs` to find the exact field names (`session_id`, `sequence`, `audio`)
- Build multipart matching the exact Rust format (field order, content types, part names)
- Upload to real TS ingest server
- Assert: 200, chunk stored correctly

#### Test 2: `first chunk has sequence 0 — 0-based contract`
- Upload chunk with sequence=0
- Assert: stored as `chunk-0000.wav`
- This explicitly tests the contract that both sides agree on 0-based indexing

#### Test 3: `chunks 0, 1, 2 uploaded and stored in order`
- Upload 3 chunks with sequences 0, 1, 2
- Assert: all 3 stored as `chunk-0000.wav`, `chunk-0001.wav`, `chunk-0002.wav`
- Send session-end
- Assert: no sequence gaps detected

#### Test 4: `missing chunk 0 triggers gap detection`
- Upload chunks 1 and 2 only (skip 0)
- Send session-end
- Assert: session fails with error about missing chunk 0

#### Test 5: `session-end body format matches Rust client`
- Read the Rust `upload.rs` to find session-end body format
- Send session-end matching exact Rust format
- Assert: 200, session status updated

#### Test 6: `backward compat — "file" field name still accepted`
- Upload with old field name "file" instead of "audio"
- Assert: still works (backward compat)
- Add comment: this is deprecated, Rust client uses "audio"

#### Test 7: `auth header format matches Rust client`
- Read the Rust `upload.rs` auth header format
- Send request with matching format
- Assert: accepted
- Send with wrong format
- Assert: 401

#### Test 8: `capture engine filename format is parseable by server`
- Use real capture engine filename `{session}_chunk-0000_{timestamp}.wav` as the multipart filename
- Upload to server
- Assert: server parses it correctly

### Rust-side tests to add or update:

#### In `shipper/tests/field_contract.rs`:

#### Test: `upload_chunk sends sequence 0 for first chunk`
Add a test that verifies the multipart body produced by `upload_chunk()` contains `sequence=0` when uploading the first chunk. Use wiremock request capture to inspect the body.

#### Test: `upload_chunk multipart body contains correct field values`
Capture the wiremock request body, parse the multipart, assert:
- `session_id` field present with correct value
- `sequence` field present with correct numeric value
- `audio` field present with WAV content

If wiremock can't capture/parse multipart bodies easily, use a custom mock server that logs the raw request body and parse it manually.

## Step 3 — Update Rust tests if needed

If you find bugs in the Rust code while writing tests, FIX THEM. You have full permission to modify:
- `tools/cortex-audio/shipper/src/*.rs`
- `tools/cortex-audio/shipper/tests/*.rs`
- `tools/cortex-audio/tray/tests/*.rs`

Cargo needs PATH: `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`

## Step 4 — Run all tests

```powershell
# TypeScript
npx vitest run src/audio/ 2>&1

# Rust
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd tools/cortex-audio
cargo test 2>&1
```

All tests must pass on both sides.

## Step 5 — Commit, merge, push

```powershell
git checkout -b feat/031-cross-stack-rewrite
git add src/audio/__tests__/cross-stack.test.ts
git add tools/cortex-audio/shipper/tests/field_contract.rs
# Add any other changed files — but only files you actually changed
git commit -m "031: rewrite cross-stack tests — verify real Rust multipart format, 0-based sequences"
git checkout main
git merge feat/031-cross-stack-rewrite --no-edit
git push
```

Do NOT `git add -A`.

## Step 6 — Create STATE.md

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT `git add -A`**
- **Do NOT use sequence 1 as the first chunk in any test**
- **Do NOT patch environment variables**
- **DO fix source code if you find bugs** — document what you fixed in STATE.md

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- cross-stack.test.ts rewritten with real multipart format derived from Rust source
- Sequence 0 explicitly tested as first chunk
- Gap detection tested for missing chunk 0
- Rust field_contract.rs updated with body content assertions
- All TS + Rust tests pass
- Any bugs found are fixed and documented
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
