# STATE — 041 Sequence Numbering Contract

## Status: DONE

## Audit: Existing Coverage Before This Task

### Already covered by prior tasks (031, 039, 040):

**cross-stack.test.ts (031 rewrite):**
- Test 2: "first chunk has sequence 0" — uploads seq 0, verifies chunk-0000.wav exists, chunk-0001 does NOT
- Test 3: "chunks 0,1,2 uploaded and stored in order" — 3 chunks, session-end, no gaps
- Test 4: "missing chunk 0 triggers gap detection" — uploads 1,2 only, gap at 0

**field_contract.rs (039):**
- `upload_chunk_sends_sequence_0_for_first_chunk` — captures body, asserts sequence="0"
- `upload_chunk_multipart_body_contains_correct_fields` — full body assertion for session_id, sequence, audio

**chunker.rs (existing unit tests):**
- `test_writes_valid_wav` — asserts seq=0 on first finalize
- `test_file_naming_format` — asserts chunk-0000 in filename
- `test_chunk_rotation` — asserts chunk-0000 and chunk-0001 in sorted filenames

**lib.rs (existing):**
- `full_upload_flow` — asserts uploaded sequence vec is [0, 1]
- `multi_chunk_ordering` — asserts uploaded sequence vec is [0, 1, 2]
- Line 131: `or_insert(0)` — the bug fix is in place

### Gaps found:

1. **No dedicated sequence contract test file** — 0-based assertions were scattered across cross-stack, field_contract, and unit tests. No single place to verify the full contract.
2. **Missing middle sequence gap detection** — only gap-at-0 was tested, not gap-at-1 (skip middle chunk).
3. **Single chunk session** — no test verified that one chunk at seq 0 is a valid complete session.
4. **Parsed filename sequence → upload body round-trip** — no test verified that `parse_chunk_filename()` output matches the sequence value in the actual HTTP body.
5. **ChunkWriter dedicated 0-based assertion** — existing chunker tests implicitly tested seq=0 but didn't explicitly assert "must NOT be 1" (the off-by-one negative case).

## What Was Added

### TypeScript: `src/audio/__tests__/sequence-contract.test.ts` (5 tests)

| # | Test | What it asserts |
|---|------|----------------|
| 1 | server stores sequence 0 as chunk-0000.wav | chunk-0000 exists, chunk-0001 does NOT |
| 2 | sequences 0,1,2 stored as chunk-0000, 0001, 0002 | all 3 files, session-end no gaps |
| 3 | gap detection catches missing sequence 0 | upload 1,2 only → gap contains 0 |
| 4 | gap detection catches missing middle sequence | upload 0,2 only → gap contains 1, NOT 0 |
| 5 | single chunk at sequence 0 is valid session | 1 chunk → pending_transcription, no gaps |

### Rust: `capture/tests/sequence_contract.rs` (2 tests)

| # | Test | What it asserts |
|---|------|----------------|
| 6 | chunkwriter_first_chunk_is_sequence_0 | seq=0, filename contains chunk-0000, NOT chunk-0001 |
| 7 | chunkwriter_sequences_increment_0_1_2 | 3 rotations → seq 0,1,2 in order, filenames match |

### Rust: `shipper/tests/field_contract.rs` (2 tests added)

| # | Test | What it asserts |
|---|------|----------------|
| 8 | shipper_next_seq_starts_at_0_regression | upload body sequence="0" for first chunk (or_insert bug regression) |
| 9 | parsed_sequence_matches_upload_body_sequence | parse_chunk_filename seq matches upload body seq for 0,1,2 |

## Bugs Found

None. The `or_insert(0)` fix from the original bug is in place. All source code is correct.

## Test Results

- **TypeScript:** 95 passed, 12 skipped (whisper-dependent), 0 failed
- **Rust:** 110 passed, 0 failed (39 capture + 33 shipper unit + 9 field_contract + 11 shipper_integration + 16 tray + 2 sequence_contract)

## Breaking Guarantee

Changing the starting sequence to 1 on any side would break:
- TS: Tests 1, 2, 3, 5 (chunk-0000 assertions, gap detection)
- Rust: Tests 6, 7 (ChunkWriter seq=0 assertion), Tests 8, 9 (upload body seq="0")
- Plus existing tests in cross-stack.test.ts and field_contract.rs
