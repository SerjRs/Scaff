---
id: "015"
title: "pipeline_transition sync tool — enforced state machine for task stages"
created: "2026-03-14"
author: "scaff"
priority: "critical"
status: "done"
pr: "pending"
branch: "feat/012-016-cortex-improvements"
moved_at: "2026-03-14"
---

# 015 — pipeline_transition Sync Tool

## Problem

Cortex manages pipeline transitions by calling `move_file` — which is fragile:
1. Gets paths wrong (directories vs files, wrong stage names)
2. Skips InReview — moved PR #9 from InProgress straight to Done
3. Forgets to update SPEC frontmatter (status, moved_at)
4. Tells executors to merge+move in one shot, bypassing review

The pipeline README defines stages: Cooking → InProgress → InReview → Done (or Canceled). But nothing enforces this.

## Fix

New sync tool: `pipeline_transition`

### Parameters
- `task`: task ID or folder name (e.g. `"011"` or `"011-cortex-loop-silence-bugs"`)
- `to`: target stage — `"InProgress"` | `"InReview"` | `"Done"` | `"Canceled"`

### State Machine (enforced)

| From | Allowed To |
|------|------------|
| Cooking | InProgress |
| InProgress | InReview, Canceled |
| InReview | Done, InProgress (rework), Canceled |

**Blocked transitions:**
- Cooking → Done (must go through InProgress + InReview)
- Cooking → InReview (must go through InProgress)
- InProgress → Done (must go through InReview)
- Done → anything (final state)

### Behavior
1. Scan all stage directories for a folder matching the task ID (prefix match)
2. Determine current stage from parent directory name
3. Validate transition against state machine — reject illegal transitions with clear error
4. Move the entire folder to target stage directory
5. Update SPEC.md frontmatter: `status` field to match target, `moved_at` to current date
6. Return: `{ from, to, task, path }`

### System Prompt
- Replace move_file guidance for pipeline operations
- "Use `pipeline_transition` for all pipeline stage changes. Do NOT use move_file for pipeline tasks."
- "After a coding executor completes, move to InReview first. Review the diff, then move to Done."

## Files

| File | Change |
|------|--------|
| `src/cortex/tools.ts` | New `executePipelineTransition` function |
| `src/cortex/llm-caller.ts` | Tool definition + register + prompt update |
| `src/cortex/loop.ts` | Execution handler in sync tool switch |
| `src/cortex/__tests__/pipeline-transition.test.ts` | Tests for state machine enforcement |
