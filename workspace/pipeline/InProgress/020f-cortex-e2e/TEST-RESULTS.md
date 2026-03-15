# Hippocampus E2E Test Results
Generated: 2026-03-15T15:01:12.413Z

## Summary
- Total: 3
- Passed: 3
- Failed: 0
- Duration: 2.6s

## G — Foreground Sharding

### G1. messages assigned to shards ✅
**Expected:** >=1 shard, >=3 assigned messages
**Result:** shards=1, assignedMsgs=6, activeChannel=webchat

### G2. shard boundary on token overflow ✅
**Expected:** >=2 shards (>=1 closed, >=1 active)
**Result:** shards=2, closed=1, active=1

### G3. ops trigger assigned to correct shard ✅
**Expected:** ops trigger assigned to active webchat shard
**Result:** activeShard=dd8e4283, opsShard=dd8e4283

