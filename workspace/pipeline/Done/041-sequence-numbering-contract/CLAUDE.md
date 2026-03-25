# CLAUDE.md — 041 Sequence Numbering Contract Test

## Branch
`feat/041-sequence-contract`

Create from `main`. All commits go here. Merge to `main` when done.

## Context

The off-by-one bug (or_insert(1) instead of or_insert(0)) proved the 0-based sequence numbering contract was never enforced across the full pipeline. Each component assumed the correct starting sequence but no test verified it end-to-end. Some tests now cover parts of this (031 rewrite, 039), but there is no single dedicated test that traces sequence numbering through every boundary: ChunkWriter -> filename -> watcher parse -> shipper upload body -> server storage -> gap detection.

Read the full audit in TESTS-REVISION-REPORT.md before writing anything.

## Step 1 — Read everything

Read in this order:
1. `workspace/pipeline/InProgress/041-sequence-numbering-contract/TESTS-REVISION-REPORT.md` — full audit
2. `workspace/pipeline/InProgress/041-sequence-numbering-contract/SPEC.md` — spec
3. `tools/cortex-audio/capture/src/chunker.rs` — ChunkWriter, sequence start, filename format
4. `tools/cortex-audio/shipper/src/watcher.rs` — parse_chunk_filename, sequence extraction
5. `tools/cortex-audio/shipper/src/lib.rs` — next_seq or_insert(0), upload ordering
6. `tools/cortex-audio/shipper/src/upload.rs` — sequence value in multipart body
7. `tools/cortex-audio/shipper/tests/field_contract.rs` — existing body assertions (from 031/039)
8. `src/audio/ingest.ts` — server stores chunk-NNNN.wav, gap detection
9. `src/audio/session-store.ts` — chunks_received tracking
10. `src/audio/__tests__/cross-stack.test.ts` — existing 0-based tests (from 031 rewrite)

## Step 2 — Audit existing coverage

Before writing new tests, check what already exists across 031, 039, 040 rewrites. Document in STATE.md what is already covered and what gaps remain for the sequence contract specifically.

## Step 3 — Write sequence-contract.test.ts (TypeScript side)

Create `src/audio/__tests__/sequence-contract.test.ts`.

### Tests:

#### Test 1: `server stores sequence 0 as chunk-0000.wav`
- Upload chunk with sequence=0
- Assert: file stored as chunk-0000.wav in inbox
- Assert: NOT chunk-0001.wav

#### Test 2: `server stores sequences 0,1,2 as chunk-0000, chunk-0001, chunk-0002`
- Upload 3 chunks with sequences 0, 1, 2
- Assert: all 3 files named correctly
- Send session-end
- Assert: no sequence gaps, session succeeds

#### Test 3: `gap detection catches missing sequence 0`
- Upload chunks 1 and 2 only
- Send session-end
- Assert: session fails with error explicitly mentioning sequence 0

#### Test 4: `gap detection catches missing middle sequence`
- Upload chunks 0 and 2 only (skip 1)
- Send session-end
- Assert: session fails with error mentioning missing sequence 1

#### Test 5: `single chunk at sequence 0 is valid session`
- Upload only chunk 0
- Send session-end
- Assert: session succeeds with chunks_received=1

## Step 4 — Write sequence contract tests (Rust side)

Add to `tools/cortex-audio/shipper/tests/field_contract.rs` or a new file `tools/cortex-audio/capture/tests/sequence_contract.rs`:

#### Test 6: `ChunkWriter first chunk is sequence 0`
- Create ChunkWriter
- Write enough data for one chunk rotation
- Assert: first filename contains `chunk-0000`

#### Test 7: `ChunkWriter sequences increment: 0, 1, 2`
- Write enough data for 3 chunk rotations
- Assert filenames contain `chunk-0000`, `chunk-0001`, `chunk-0002` in order

#### Test 8: `shipper next_seq starts at 0 (regression)`
- Start ChunkShipper
- Write one chunk-0000 file to outbox
- Capture upload body
- Assert: sequence field value is "0" (not "1")
- Comment: regression test for or_insert(1) bug

#### Test 9: `parsed sequence from filename matches upload body sequence`
- Write chunk files with sequences 0, 1, 2
- Capture all 3 upload bodies
- Assert: parsed sequence from filename == sequence value in multipart body for each

## Step 5 — Run all tests

```powershell
# TypeScript
npx vitest run src/audio/ 2>&1

# Rust
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd tools/cortex-audio
cargo test 2>&1
```

All tests must pass on both sides.

## Step 6 — Commit, merge, push

```powershell
git checkout -b feat/041-sequence-contract
git add src/audio/__tests__/sequence-contract.test.ts
git add tools/cortex-audio/capture/tests/sequence_contract.rs tools/cortex-audio/shipper/tests/field_contract.rs
# Only add files you actually changed or created
git commit -m "041: sequence numbering contract — 0-based indexing verified at every boundary"
git checkout main
git merge feat/041-sequence-contract --no-edit
git push
```

Do NOT `git add -A`.

## Step 7 — Create STATE.md

Include: what was already covered by other tasks, what gaps you found, what you added.

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT git add -A**
- **Do NOT patch environment variables**
- **DO fix source code if you find bugs** — document in STATE.md
- Cargo needs PATH: `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- 0-based sequence explicitly tested at: ChunkWriter, filename, watcher parse, shipper upload body, server storage, gap detection
- Changing starting sequence to 1 on any side would break at least one test
- Regression test for or_insert(1) bug with comment
- All TS + Rust tests pass
- Gaps documented
- Any bugs found fixed and documented
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
