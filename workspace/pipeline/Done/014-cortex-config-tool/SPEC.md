---
id: "014"
title: "cortex_config sync tool — self-management without path guessing"
created: "2026-03-14"
author: "scaff"
priority: "medium"
status: "done"
pr: "pending"
branch: "feat/012-016-cortex-improvements"
moved_at: "2026-03-14"
---

# 014 — cortex_config Sync Tool

## Problem

Cortex can't manage its own configuration. When asked to "switch off Cortex" or "switch to main," it searched for config files by guessing paths. The cortex config lives at `~/.openclaw/cortex/config.json` — outside the workspace sandbox.

`write_file` can't reach it (constrained to workspace). Cortex needs a dedicated tool.

## Fix

New sync tool: `cortex_config`

### Parameters
- `action`: `"read"` | `"set_channel"`
- `channel`: channel name (for set_channel) — e.g. `"whatsapp"`, `"webchat"`
- `mode`: `"off"` | `"live"` | `"shadow"` (for set_channel)

### Behavior
- `read`: Returns the full cortex config JSON
- `set_channel(channel, mode)`: Updates `channels.<channel>` to the given mode, saves config, returns confirmation

### Safety
- Only channel modes can be changed (not model, thinking level, etc.)
- Validates mode is one of: off, live, shadow
- Validates channel exists or is a known channel name

### System Prompt
Add to tool guidance: "Use `cortex_config` to read or change your own channel routing. Example: to hand off to the main agent, call `cortex_config({ action: 'set_channel', channel: 'whatsapp', mode: 'off' })`."

## Files

| File | Change |
|------|--------|
| `src/cortex/tools.ts` | New `executeCortexConfig` function |
| `src/cortex/llm-caller.ts` | Tool definition + register in tool list + prompt guidance |
| `src/cortex/loop.ts` | Execution handler in sync tool switch |
