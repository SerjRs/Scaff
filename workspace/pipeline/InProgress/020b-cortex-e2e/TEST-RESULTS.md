# Hippocampus E2E Test Results
Generated: 2026-03-15T13:34:56.627Z

## Summary
- Total: 4
- Passed: 4
- Failed: 0
- Duration: 4.6s

## C — Session & Context

### C1. session history persists across messages ✅
**Expected:** 3 user + 3 assistant messages in session
**Result:** users=3, assistants=3

### C2. system floor includes SOUL.md ✅
**Expected:** system floor has SOUL.md content
**Result:** found SOUL.md in system_floor, tokens=12

### C3. context token budget respected ✅
**Expected:** foreground truncated within token budget
**Result:** maxTokens=200, systemFloor=12, foreground=157, foregroundMsgs=10, totalHistory=20

### C4. background summaries from other channels ✅
**Expected:** whatsapp in background summaries when webchat is foreground
**Result:** foreground=webchat, bgSummaries=[whatsapp], bgLayer=0 tokens

