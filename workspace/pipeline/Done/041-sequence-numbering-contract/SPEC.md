---
id: "041"
title: "Sequence numbering contract test — 0-based indexing at every boundary"
priority: medium
created: 2026-03-19
author: scaff
type: test
branch: feat/041-sequence-contract
tech: rust, typescript
source: "TESTS-REVISION-REPORT.md R9"
---

# 041 — Sequence Numbering Contract Test

## Problem

The off-by-one bug (`or_insert(1)` instead of `or_insert(0)`) proved that the 0-based sequence numbering contract was never explicitly tested across the full pipeline. Each component assumed the correct starting sequence, but no test verified the assumption end-to-end.

## What To Test

### Rust side

#### Test 1: `ChunkWriter starts at sequence 0`
- Create a ChunkWriter
- Write enough data for 1 chunk rotation
- Assert: first file is `{session}_chunk-0000_{ts}.wav`
- Assert: second file is `{session}_chunk-0001_{ts}.wav`

#### Test 2: `ChunkShipper next_seq starts at 0`
- Start shipper, write `{session}_chunk-0000_{ts}.wav` to outbox
- Wait for upload event
- Assert: `ShipperEvent::ChunkUploaded { sequence: 0, .. }`

#### Test 3: `Shipper uploads sequence 0 before sequence 1`
- Write chunks 0 and 1 to outbox
- Capture upload order
- Assert: sequence 0 uploaded first

### TypeScript side

#### Test 4: `Server stores chunk-0000 for sequence 0`
- Upload multipart with `sequence: "0"`
- Assert: file stored as `chunk-0000.wav` in inbox

#### Test 5: `Gap detection starts at 0`
- Upload chunks 1 and 2 (skip 0), send session-end
- Assert: error "Missing chunks in sequence: 0"

#### Test 6: `0-based sequence through full server pipeline`
- Upload chunks 0, 1, 2 in order, send session-end
- Assert: session status is `pending_transcription` (no gaps)
- Assert: inbox has `chunk-0000.wav`, `chunk-0001.wav`, `chunk-0002.wav`

## Key Constraint

These tests must explicitly assert the number `0` (not just "first chunk"). The test must fail if someone changes the starting sequence to 1.

## Done Criteria

- 0-based sequence contract explicitly tested at: ChunkWriter, ChunkShipper, HTTP upload, server storage, gap detection
- A change to starting sequence on either side breaks at least one test
- All existing tests still pass
