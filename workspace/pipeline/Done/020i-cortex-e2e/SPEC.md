---
id: "020i"
title: "Cortex E2E — Configuration & Modes"
created: "2026-03-15"
author: "scaff"
priority: "medium"
status: "cooking"
depends_on: []
---

# 020i — Cortex E2E: Configuration & Modes

## Goal
Test Cortex configuration behavior: hippocampus toggle, shadow mode suppression, and config persistence across restarts.

## Category: J (Configuration & Modes)

## Test File
`src/cortex/__tests__/e2e-webchat-config.test.ts`

## Tests (~3)

### J. Configuration & Modes

**J1. Hippocampus disabled — no memory tools or floor section**
Start Cortex with `hippocampusEnabled: false` → send webchat message → capture context → verify:
- No "Knowledge Graph" section in system floor
- `memory_query` and `graph_traverse` tools not available in tool list

**J2. Shadow mode — no output delivered**
Configure cortex_config for shadow mode on webchat channel → send message → verify LLM is called (for logging/evaluation) but adapter.send() is NOT called (no user-visible output).

**J3. Cortex config persistence**
Set channel mode via `cortex_config` tool → stop and restart Cortex → verify mode persists from config.json.

## Notes
- Shadow mode is per-channel, stored in `cortex/config.json` under `channels.<channelId>.mode`
- Valid modes: off, live, shadow
- Hippocampus toggle affects tool registration and context assembly

## Test Results
`workspace/pipeline/Cooking/020i-cortex-e2e/TEST-RESULTS.md`
