# STATE — 022b
## Status: Cooking
## Depends on: 022a
## Milestones
- [ ] Investigate root cause (memory? rate limit? format?)
- [ ] Streaming chunk processing (no full array in memory)
- [ ] Checkpoint file for large sources (>50 chunks)
- [ ] Batch size limit (50 chunks per run)
- [ ] Per-call timeout (30s)
- [ ] Global unhandled rejection handler
- [ ] Successfully process all 188 cortex_archive chunks
