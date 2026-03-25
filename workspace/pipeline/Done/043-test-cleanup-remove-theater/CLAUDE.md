# CLAUDE.md — 043 Test Cleanup — Remove Theater

## Branch
`feat/043-test-cleanup`

Create from `main`. All commits go here. Merge to `main` when done.

## Context

After the 030-042 test rewrite marathon, most of the worst offenders have been fixed. This task is a final sweep across ALL audio test files (TS and Rust) to catch any residual issues: remaining env patches, misleading test descriptions, legacy filename formats, stale skip guards, or tautological tests that earlier passes missed.

Read the full audit in TESTS-REVISION-REPORT.md before doing anything.

## Step 1 — Read everything

Read in this order:
1. `workspace/pipeline/InProgress/043-test-cleanup-remove-theater/TESTS-REVISION-REPORT.md` — full audit
2. `workspace/pipeline/InProgress/043-test-cleanup-remove-theater/SPEC.md` — spec

Then read EVERY test file in the audio pipeline:

TypeScript:
3. `src/audio/__tests__/ingest.test.ts`
4. `src/audio/__tests__/transcribe.test.ts`
5. `src/audio/__tests__/wav-utils.test.ts`
6. `src/audio/__tests__/whisper-e2e.test.ts`
7. `src/audio/__tests__/real-e2e.test.ts`
8. `src/audio/__tests__/cross-stack.test.ts`
9. `src/audio/__tests__/gateway-wiring.test.ts`
10. `src/audio/__tests__/gateway-init.test.ts`
11. `src/audio/__tests__/librarian-ingestion.test.ts`
12. `src/audio/__tests__/whisper-failures.test.ts`
13. `src/audio/__tests__/deployment-readiness.test.ts`
14. `src/audio/__tests__/sequence-contract.test.ts`

Rust:
15. `tools/cortex-audio/shipper/src/lib.rs` (tests at bottom)
16. `tools/cortex-audio/shipper/src/watcher.rs` (tests at bottom)
17. `tools/cortex-audio/capture/src/chunker.rs` (tests at bottom)
18. `tools/cortex-audio/tray/tests/shipper_integration.rs`
19. `tools/cortex-audio/shipper/tests/field_contract.rs`
20. `tools/cortex-audio/capture/tests/sequence_contract.rs`

## Step 2 — Audit and fix

For each file, check for and fix:

### A. Environment patching
- Search for `process.env.PATH`, `process.env.PYTHONIOENCODING`, `FFMPEG_DIR` in test files
- If any test-scope patching remains, DELETE it
- The production code in `transcribe.ts` handles PATH/ffmpeg/PYTHONIOENCODING itself

### B. Misleading test descriptions
- Any `describe` or `it` that says "Real E2E", "no mocks", "end-to-end" when it actually mocks components — rename to be honest
- "cross-stack" tests that only run TypeScript — clarify in description
- Add accurate JSDoc comments to each test file explaining what it actually tests

### C. Legacy filename formats in Rust tests
- Search for `_chunk_0001` (legacy format) in Rust test files
- Replace with `_chunk-0001_12345` (capture engine format with timestamp) where appropriate
- Some tests may have been updated by 031/039/041 — only fix remaining ones

### D. Skip guards
- Search for `describe.skip` and `describeIf` patterns
- Verify all skip guards have visible warnings (console.warn) when skipping
- Verify CI-aware pattern is used (fail on CI, skip locally)
- No silent skips anywhere

### E. Tautological tests
- Tests that create data and assert their own created data (e.g., create an array, assert array[0] is what you put in)
- Tests that don't call any production code
- Delete them

### F. Stale imports and dead code
- Unused imports in test files
- Helper functions that are no longer called
- Commented-out test code

### G. Test file organization
- Each test file should have a clear JSDoc header explaining: what it tests, what is real vs mocked, what it depends on
- Group related tests with descriptive `describe` blocks

## Step 3 — Run all tests

```powershell
# TypeScript
npx vitest run src/audio/ 2>&1

# Rust
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd tools/cortex-audio
cargo test 2>&1
```

All tests must pass on both sides.

## Step 4 — Commit, merge, push

```powershell
git checkout -b feat/043-test-cleanup
# Add only files you changed
git add src/audio/__tests__/*.ts
git add tools/cortex-audio/shipper/src/lib.rs tools/cortex-audio/shipper/src/watcher.rs
git add tools/cortex-audio/capture/src/chunker.rs
git add tools/cortex-audio/tray/tests/shipper_integration.rs
git add tools/cortex-audio/shipper/tests/field_contract.rs
# Only add files you actually modified
git commit -m "043: test cleanup — remove env patches, fix descriptions, update filenames, delete tautologies"
git checkout main
git merge feat/043-test-cleanup --no-edit
git push
```

Do NOT `git add -A`.

## Step 5 — Create STATE.md

Include a summary table: file → what was changed → why.

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT git add -A**
- **Do NOT delete tests that are genuinely useful** — only remove theater
- **DO fix source code if you find bugs** — document in STATE.md
- Cargo needs PATH: `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- Zero env patches remaining in any test file
- Zero silent skip guards
- All test descriptions accurately reflect what they test
- Rust tests use capture engine filename format
- No tautological tests remain
- All test files have JSDoc headers
- All TS + Rust tests pass
- STATE.md with file-by-file summary
- Clean commit, merged to main, pushed

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
