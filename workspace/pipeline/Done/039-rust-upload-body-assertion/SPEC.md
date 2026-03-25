---
id: "039"
title: "Rust shipper upload body assertion — verify multipart content, not just call count"
priority: critical
created: 2026-03-19
author: scaff
type: test
branch: feat/039-upload-body-assertion
tech: rust
source: "TESTS-REVISION-REPORT.md R4"
---

# 039 — Rust Upload Body Assertion

## Problem

All Rust shipper tests use wiremock with `Mock::given(method("POST")).and(path("/audio/chunk")).respond_with(200)`. Wiremock accepts ANY body and returns 200. The tests check "did HTTP calls happen?" — not "did HTTP calls contain correct data?"

The off-by-one bug (`or_insert(1)` instead of `or_insert(0)`) passed all tests because wiremock returned 200 regardless of what sequence value was in the multipart body. Chunk #0 was never uploaded, but the test reported green.

## What To Test

### Test 1: `upload_chunk sends correct multipart field values`
- Set up wiremock to capture the request body
- Call `upload_chunk()` with session_id="test-sess", sequence=0, path to a WAV file
- Parse the captured multipart body
- Assert: field `session_id` has value `"test-sess"`
- Assert: field `sequence` has value `"0"`
- Assert: field `audio` contains the WAV file bytes
- Assert: field `audio` has content-type `audio/wav`

### Test 2: `first chunk has sequence 0`
- Start a ChunkShipper
- Write `test-sess_chunk-0000_12345.wav` to outbox
- Wait for upload event
- Capture the multipart body sent to wiremock
- Assert: `sequence` field value is `"0"` (not `"1"`)
- This is the specific test that would have caught bug #1.

### Test 3: `sequence values match filename sequence numbers`
- Write chunks 0, 1, 2 to outbox
- Capture all 3 multipart bodies
- Assert: sequence values are "0", "1", "2" respectively
- Assert: they arrive in order

### Test 4: `session-end body contains correct session_id`
- Call `signal_session_end("test-sess-123")`
- Capture request body
- Assert: JSON body has `session_id: "test-sess-123"`

## Implementation

### Option A: wiremock request capture
Use `wiremock::Request` recording:
```rust
let server = MockServer::start().await;
Mock::given(method("POST")).and(path("/audio/chunk"))
    .respond_with(ResponseTemplate::new(200))
    .mount(&server).await;
// ... run upload ...
let requests = server.received_requests().await.unwrap();
// Parse multipart from requests[0].body
```

### Option B: custom wiremock matcher
Implement a `Match` trait that parses multipart and asserts field values:
```rust
struct MultipartFieldMatcher { field: String, expected: String }
impl Match for MultipartFieldMatcher { ... }
```

Option A is simpler for initial implementation. Option B is reusable.

## Done Criteria

- Tests assert multipart body content, not just HTTP call count
- Sequence 0 is explicitly verified as the first upload
- Would have caught the `or_insert(1)` bug
- All existing tests still pass
