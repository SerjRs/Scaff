# Hippocampus E2E Test Results
Generated: 2026-03-15T15:35:55.344Z

## Summary
- Total: 2
- Passed: 2
- Failed: 0
- Duration: 1.6s

## I — Library Integration

### I1. library_ingest → onSpawn with Librarian prompt ✅
**Expected:** onSpawn called with Librarian prompt containing URL and content
**Result:** spawns=1, taskContainsLibrarian=true, taskContainsUrl=true, priority=normal

### I2. article → hippocampus graph ingestion ✅
**Expected:** 4 facts (1 source + 3), 5 edges (3 sourced_from + 2 inter-fact)
**Result:** facts=4, edges=5, sourcedFrom=3, interEdges=2

