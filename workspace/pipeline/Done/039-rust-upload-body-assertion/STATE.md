# STATE — 039 Rust Upload Body Assertion

## Status: DONE

## What 031 Already Covered

The 031 rewrite of `field_contract.rs` already had solid body assertion coverage:

1. **`upload_chunk_sends_sequence_0_for_first_chunk`** — Captures request body, asserts `sequence=0` (regression for bug #1)
2. **`upload_chunk_multipart_body_contains_correct_fields`** — Verifies `session_id`, `sequence`, `audio` file field, RIFF header, auth header
3. **`send_session_end_body_format`** — Verifies JSON body with `session_id`, Content-Type `application/json`
4. **Constant value tests** — `field_names_match_server_contract`, `url_paths_match_server_contract`
5. **Helper functions** — `extract_multipart_text_field`, `has_multipart_file_field` for parsing raw multipart

## Gaps Found and Filled

### In `shipper/tests/field_contract.rs` (3 new tests + 1 assertion added):

| Gap | Test Added | What It Verifies |
|-----|-----------|-----------------|
| Audio part Content-Type not verified | `upload_chunk_audio_content_type_is_wav` | Content-Type header on audio part is `audio/wav` |
| WAV bytes not verified for exact match | `upload_chunk_wav_bytes_round_trip` | Uploaded bytes exactly match original file (byte-for-byte) |
| Session-end JSON could have extra fields | Added assertion to `send_session_end_body_format` | JSON object has exactly 1 field (`session_id`) |

New helpers added:
- `extract_multipart_file_content_type()` — Extracts Content-Type from a multipart file part's headers
- `extract_multipart_file_bytes()` — Extracts raw file bytes from multipart body (works on raw bytes to avoid UTF-8 lossy position drift)

### In `tray/tests/shipper_integration.rs` (3 new tests):

| Gap | Test Added | What It Verifies |
|-----|-----------|-----------------|
| Integration tests had zero body assertions | `upload_body_contains_correct_session_id_and_sequence` | Watcher → Shipper → upload pipeline produces correct `session_id` and `sequence=0` in body |
| Multi-chunk sequence values never verified in integration | `multi_chunk_upload_bodies_have_correct_sequences` | 3 chunks through full pipeline have sequences "0", "1", "2" in actual HTTP bodies |
| Session-end body not verified in integration | `session_end_body_contains_correct_session_id` | JSON body contains correct session_id through `signal_session_end()` |

## Bug Found During Implementation

**UTF-8 lossy position drift in byte extraction**: Initial `extract_multipart_file_bytes()` used `String::from_utf8_lossy()` to find positions, then indexed into raw `body` bytes. WAV headers contain bytes like `0x80` that are invalid UTF-8 and get replaced with U+FFFD (3 bytes), causing position offsets to diverge. Fixed by searching directly on raw byte slices using `windows()`.

## No Source Code Bugs Found

The Rust shipper source code (`upload.rs`, `lib.rs`, `watcher.rs`) is correct. The `or_insert(0)` fix from bug #1 is in place. All field names, paths, and multipart construction in `upload_chunk()` and `send_session_end()` are correct.

## Test Counts

| Location | Before | After | Delta |
|----------|--------|-------|-------|
| `field_contract.rs` | 5 tests | 8 tests | +3 |
| `shipper_integration.rs` | 8 tests | 11 tests | +3 |
| **Total Rust tests** | 100 | 106 | +6 |
| **TypeScript tests** | 92 | 92 | 0 (unchanged, all passing) |

## Commit

`cdfdc86fb` — `039: complete upload body assertions — verify every multipart field value and sequence`
