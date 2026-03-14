---
id: "013"
title: "Cortex filesystem self-awareness — key paths in system prompt"
created: "2026-03-14"
author: "scaff"
priority: "medium"
status: "done"
pr: "pending"
branch: "feat/012-016-cortex-improvements"
moved_at: "2026-03-14"
---

# 013 — Cortex Self-Awareness

## Problem

Cortex doesn't know where key files live outside the workspace. It tried `config.yaml`, `config.json`, `cortex/config.json` — all workspace-relative, all failed. Actual path: `~/.openclaw/cortex/config.json`.

Also: `code_search` returns paths relative to the install root (`src/cortex/loop.ts`), but `read_file` resolves relative to workspace. Cortex loops trying wrong paths.

## Fix

Add a "Key Paths" section to the Cortex system prompt in `llm-caller.ts` → `contextToMessages()`:

```
## Key Paths
- Workspace (read_file root): <workspaceDir>
- Install root (code_search paths): <installRoot>
- Cortex config: <installRoot>/cortex/config.json
- To read source files from code_search, use the full install path.
```

Paths should be injected dynamically from actual runtime values, not hardcoded.

## Files

| File | Change |
|------|--------|
| `src/cortex/llm-caller.ts` | Add Key Paths section to system prompt in `contextToMessages()` |
| `src/cortex/context.ts` | Pass installRoot through AssembledContext if needed |
