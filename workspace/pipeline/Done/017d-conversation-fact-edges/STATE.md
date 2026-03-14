# STATE — 017d
## Status: InProgress
## Milestones
- [ ] `hippocampus_facts_vec` table created + `initGraphVecTable()` function
- [ ] `insertFact()` fixed to use `hippocampus_facts_vec` instead of `cortex_hot_memory_vec`
- [ ] `searchGraphFacts()` function added
- [ ] Extraction prompt rewritten for structured JSON (facts + edges + types)
- [ ] `dedupAndInsertGraphFact()` function added
- [ ] `runFactExtractor()` updated to use graph insertion
- [ ] `initGraphVecTable()` called at startup in llm-caller.ts
- [ ] Tests written and passing
- [ ] Branch pushed, PR created
