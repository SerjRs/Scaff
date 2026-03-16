# Hippocampus E2E Test Results
Generated: 2026-03-16T14:11:24.721Z

## Summary
- Total: 6
- Passed: 6
- Failed: 0
- Duration: 3.6s

## E — Hippocampus Integration

### E1. hot memory facts in system floor ✅
**Expected:** facts in system floor
**Result:** floor contains both facts, has Knowledge Graph section

### E2. graph facts with edge breadcrumbs ✅
**Expected:** facts + edge breadcrumbs in floor
**Result:** floor shows facts with resulted_in edge

### E3. gardener extracts facts from conversation ✅
**Expected:** 2 facts + 1 edge extracted
**Result:** processed=2, facts=2, hasEdge=true

### E4. memory_query searches hot + cold ✅
**Expected:** memory_query executes with hot + cold results
**Result:** replies=1, callCount=2

### E5. eviction preserves edge stubs ✅
**Expected:** edge is stub after eviction, fact evicted with cold_vector_id
**Result:** is_stub=1, status=evicted, cold_vector_id=1

### E6. revival reconnects edges ✅
**Expected:** fact revived, edge reconnected, both in graph
**Result:** status=active, is_stub=0, facts=2

