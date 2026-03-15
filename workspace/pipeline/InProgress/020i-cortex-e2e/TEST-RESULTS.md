# Hippocampus E2E Test Results
Generated: 2026-03-15T15:47:39.324Z

## Summary
- Total: 3
- Passed: 3
- Failed: 0
- Duration: 1.7s

## J — Configuration & Modes

### J1. hippocampus disabled — no KG in floor ✅
**Expected:** no hippocampus, no KG in floor
**Result:** hippocampusEnabled=false, floorHasKG=false

### J2. shadow mode — LLM processes, output suppressed ✅
**Expected:** LLM called, session logged, shadow mode gates output
**Result:** llmCalled=true, processed=1, sessionHasMsg=true, modeCheck=shadow

### J3. config persistence across restart ✅
**Expected:** config persisted across stop/start, resolveChannelMode correct
**Result:** whatsapp=shadow, webchat=live, telegram=live

