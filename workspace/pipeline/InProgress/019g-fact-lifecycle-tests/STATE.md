# 019g State

## Status: done
## Last Action: Enabled sqlite-vec in freshDb, Category G tests — 13/13 passing with real Ollama embeddings
## Files Changed: src/cortex/__tests__/e2e-hippocampus-full.test.ts (added allowExtensionLoading: true)
## Tests Run: 61 passed, 0 failed (full suite — G fix also unblocked D/H/I/J vec tests)
## Next Step: none
## Errors: none

Fix: freshDb() was calling initBus() without allowExtensionLoading, so sqlite-vec couldn't load. G6, G8-G13 silently skipped via tryInitVec() guard. Now all 13 G tests run with real Ollama nomic-embed-text embeddings (100-330ms each).
