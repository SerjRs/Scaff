# Hippocampus E2E Test Results
Generated: 2026-03-15T15:08:09.885Z

## Summary
- Total: 4
- Passed: 4
- Failed: 0
- Duration: 2.6s

## H — Recovery & Error Handling

### H1. LLM failure marks message failed ✅
**Expected:** state=failed, error logged
**Result:** state=failed, errors=1

### H2. adapter send failure, loop continues ✅
**Expected:** error logged, 2nd message processed
**Result:** errors=1, sent=1, processed=2

### H3. queue ordering preserved on failure ✅
**Expected:** msg1=failed, msg2+3=completed, 2 replies sent
**Result:** states=failed,completed,completed, sent=2

### H4. idempotent envelope_id ✅
**Expected:** duplicate rejected, 1 LLM call
**Result:** rejected=true, llmCalls=1

