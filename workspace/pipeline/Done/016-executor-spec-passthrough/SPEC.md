---
id: "016"
title: "Executor spec passthrough — always include SPEC.md as resource"
created: "2026-03-14"
author: "scaff"
priority: "medium"
status: "done"
pr: "pending"
branch: "feat/012-016-cortex-improvements"
moved_at: "2026-03-14"
---

# 016 — Executor Spec Passthrough

## Problem

When Cortex spawns a coding executor for a pipeline task, the executor doesn't always get the full SPEC.md. In task 011, the executor wrote its own 67-line SPEC instead of following the 234-line original. The task prompt mentioned "implement all 4 fixes from the SPEC" but didn't include the SPEC content.

## Fix

Two changes:

### 1. System prompt guidance
Add to sessions_spawn tool description:
"When spawning a coding task for a pipeline item, ALWAYS include the SPEC.md as a resource:
```
resources: [{ type: 'file', name: 'SPEC', path: 'pipeline/<Stage>/<taskFolder>/SPEC.md' }]
```
The executor cannot read your conversation — the SPEC is the only context it gets."

### 2. Auto-attach SPEC (code-level)
In `loop.ts` async handler for `sessions_spawn`: if the task text mentions a pipeline task ID pattern (3-digit number like "011"), auto-scan pipeline directories for a matching SPEC.md and append it as a resource if not already included.

This is a safety net — even if Cortex forgets to include the resource, the loop adds it.

## Files

| File | Change |
|------|--------|
| `src/cortex/llm-caller.ts` | System prompt guidance for sessions_spawn |
| `src/cortex/loop.ts` | Auto-detect pipeline task ID in spawn task text, auto-attach SPEC.md |
