# CLAUDE.md — 039 Rust Upload Body Assertion

## Branch
`feat/039-upload-body-assertion`

Create from `main`. All commits go here. Merge to `main` when done.

## Context

The 031 rewrite already added wiremock body assertions to `shipper/tests/field_contract.rs`. This task ensures the coverage is complete: every multipart field value, every sequence number, every content type — verified from the actual HTTP body the Rust client sends. The off-by-one bug (or_insert(1)) passed all tests because wiremock accepted any body.

Read the full audit in TESTS-REVISION-REPORT.md and the existing tests from the 031 rewrite to understand what is already covered and what gaps remain.

## Step 1 — Read everything

Read in this order:
1. `workspace/pipeline/InProgress/039-rust-upload-body-assertion/TESTS-REVISION-REPORT.md` — full audit
2. `workspace/pipeline/InProgress/039-rust-upload-body-assertion/SPEC.md` — spec
3. `tools/cortex-audio/shipper/tests/field_contract.rs` — existing contract tests (updated in 031 rewrite)
4. `tools/cortex-audio/shipper/src/upload.rs` — the actual upload code
5. `tools/cortex-audio/shipper/src/lib.rs` — ChunkShipper, next_seq, tests at bottom
6. `tools/cortex-audio/shipper/src/watcher.rs` — filename parsing
7. `tools/cortex-audio/capture/src/chunker.rs` — ChunkWriter, filename format
8. `tools/cortex-audio/tray/tests/shipper_integration.rs` — tray integration tests

## Step 2 — Audit existing coverage

After reading the 031 rewrite of field_contract.rs, determine:
- Are multipart body field VALUES verified (not just field names)?
- Is sequence=0 for the first chunk explicitly verified in the body?
- Is the session_id value in the body verified against what was passed?
- Is the audio content verified (WAV bytes round-trip)?
- Is the Content-Type of the audio part verified?
- Is the session-end body JSON verified?

Document what is already covered and what gaps remain.

## Step 3 — Fill the gaps

Add or update tests to cover any remaining gaps. Possible areas:

### In `shipper/tests/field_contract.rs`:

#### upload_chunk sends correct Content-Type for audio part
- Capture request body, parse multipart
- Assert: audio part has content-type `audio/wav` or `application/octet-stream`

#### upload_chunk WAV content round-trips correctly
- Create a known WAV file with specific bytes
- Upload via upload_chunk
- Capture the multipart body
- Extract the audio part content
- Assert: bytes match the original file exactly

#### session-end JSON body is well-formed
- Call signal_session_end with a known session_id
- Capture the request body
- Parse as JSON
- Assert: has session_id field with correct value
- Assert: no extra unexpected fields

#### Multiple chunks maintain correct sequence in body
- Upload chunks 0, 1, 2 via ChunkShipper
- Capture all 3 request bodies
- Parse each multipart
- Assert: sequence values in bodies are "0", "1", "2" respectively

### In `shipper/src/lib.rs` tests:

#### Verify next_seq starts at 0 (regression test for bug #1)
- Start shipper, upload one chunk
- Capture the request body
- Assert: sequence field value is "0"
- Add comment: regression test for or_insert(1) bug

### In `tray/tests/shipper_integration.rs`:

#### Verify upload body content in integration context
- If the integration tests use wiremock without body assertions, add body verification
- At minimum: verify sequence values in uploaded bodies

## Step 4 — Run all Rust tests

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd tools/cortex-audio
cargo test 2>&1
```

All tests must pass.

## Step 5 — Run TypeScript tests too (regression check)

```powershell
npx vitest run src/audio/ 2>&1
```

## Step 6 — Commit, merge, push

```powershell
git checkout -b feat/039-upload-body-assertion
git add tools/cortex-audio/shipper/tests/field_contract.rs
git add tools/cortex-audio/shipper/src/lib.rs
git add tools/cortex-audio/tray/tests/shipper_integration.rs
# Only add files you actually changed
git commit -m "039: complete upload body assertions — verify every multipart field value and sequence"
git checkout main
git merge feat/039-upload-body-assertion --no-edit
git push
```

Do NOT `git add -A`.

## Step 7 — Create STATE.md

Include: what was already covered by 031, what gaps you found, what you added.

## Constraints

- **Do NOT edit openclaw.json**
- **Do NOT git add -A**
- **Do NOT modify TypeScript source files** unless you find a bug
- **DO fix Rust source code if you find bugs** — document in STATE.md
- Cargo needs PATH: `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`

## Working Directory

`C:\Users\Temp User\.openclaw`

## Done Criteria

- Every multipart field value verified from actual HTTP body
- Sequence 0 explicitly verified as first upload (regression for bug #1)
- Session-end JSON body verified
- WAV content round-trip verified
- All Rust + TS tests pass
- Gaps from 031 documented and filled
- Any bugs found fixed and documented
- Clean commit, merged to main, pushed
- STATE.md created

## If Something Fails

- Document in STATE.md, try alternative, write BLOCKED after 2 attempts
- Do NOT ask questions. Debug and fix.
- If wiremock cannot parse multipart bodies, use received_requests() to get raw bytes and parse manually
