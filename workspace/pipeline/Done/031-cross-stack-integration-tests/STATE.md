# STATE — 031 Cross-Stack Integration Tests (Rewrite)

**Status:** DONE
**Branch:** `feat/031-cross-stack-rewrite` (merged to main)
**Commit:** `e0639df75` — merged via fast-forward
**Date:** 2026-03-19

## What Was Done

### TypeScript: `src/audio/__tests__/cross-stack.test.ts` — full rewrite (8 tests)

1. **server accepts multipart with field names matching Rust client** — verifies session_id, sequence, audio fields accepted, chunk stored, session created
2. **first chunk has sequence 0 — 0-based contract** — explicit 0-based test, verifies chunk-0000.wav exists and chunk-0001.wav does NOT
3. **chunks 0, 1, 2 uploaded and stored in order** — full sequence, session-end reports no gaps
4. **missing chunk 0 triggers gap detection** — uploads seq 1+2 only, asserts gap at 0
5. **session-end body format matches Rust client** — JSON `{"session_id":"..."}` format
6. **backward compat — "file" field name still accepted** — deprecated but works
7. **auth header format matches Rust client** — Bearer scheme, wrong scheme=401, missing=401, wrong key=401
8. **capture engine filename format is accepted by server** — `{session}_chunk-0000_{ts}.wav` accepted

### Rust: `tools/cortex-audio/shipper/tests/field_contract.rs` — 3 new body assertion tests

1. **upload_chunk_sends_sequence_0_for_first_chunk** — captures wiremock request, parses multipart, asserts sequence="0"
2. **upload_chunk_multipart_body_contains_correct_fields** — asserts session_id, sequence, audio fields with correct values in actual multipart body
3. **send_session_end_body_format** — asserts JSON body contains session_id, Content-Type is application/json

### Test Results

- **TypeScript audio tests:** 80/80 passed (8 files)
- **Rust tests:** 101/101 passed (capture 39 + shipper 33 + field_contract 5 + tray 16 + integration 8)

## Source Code Bugs Found

None — the off-by-one bug (`or_insert(1)`) was already fixed in commit `5b3725bd2`. The current `lib.rs` line 131 correctly uses `or_insert(0)`.

## Key Design Decisions

- All multipart field names, content types, and formats derived from reading `upload.rs` — documented with line numbers in comments
- Contract constants mirrored from Rust `FIELD_SESSION_ID`, `FIELD_SEQUENCE`, `FIELD_AUDIO`, `CHUNK_UPLOAD_PATH`, `SESSION_END_PATH`
- No environment patching
- Sequence numbering explicitly starts at 0 in every test
- Rust body assertion tests use `server.received_requests()` to capture and parse actual multipart bodies sent by `upload_chunk()`
