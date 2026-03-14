# STATE — 017d
## Status: Done
## Milestones
- [x] `hippocampus_facts_vec` table created + `initGraphVecTable()` function
- [x] `insertFact()` fixed to use `hippocampus_facts_vec` instead of `cortex_hot_memory_vec`
- [x] `searchGraphFacts()` function added
- [x] Extraction prompt rewritten for structured JSON (facts + edges + types)
- [x] `dedupAndInsertGraphFact()` function added
- [x] `runFactExtractor()` updated to use graph insertion
- [x] `initGraphVecTable()` called at startup in index.ts
- [x] Tests written and passing (25/25)
- [ ] Branch pushed, PR created
