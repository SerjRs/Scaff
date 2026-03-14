---
id: "002"
title: "Cortex pipeline_status sync tool"
created: "2026-03-12"
author: "scaff"
executor: ""
branch: ""
pr: ""
priority: "high"
status: "cooking"
moved_at: "2026-03-12"
---

# Cortex `pipeline_status` Sync Tool

## Problem

When Serj asks "what's in the pipeline?" Cortex would need to list all folders, read each README, list files in each folder, and parse metadata headers. That's 10+ file reads and wasted tokens every time.

## Approach

Single sync tool that scans the pipeline folder structure and returns a compact summary. Cortex calls it when asked about pipeline status. Combines with `read_file` for drilling into specific tasks.

## Usage Pattern

```
Serj: "what's in the pipeline?"
Cortex: calls pipeline_status()
→ returns summary of all stages + task list

Serj: "tell me more about task 001"
Cortex: calls read_file("pipeline/InProgress/001-cortex-write-file.md")
→ returns full task details
```

## Rough Shape

```typescript
export const PIPELINE_STATUS_TOOL = {
  name: "pipeline_status",
  description: "Get the current state of the development pipeline. Returns task counts per stage and task summaries. Use when asked about pipeline status, active work, or task progress. Use read_file to drill into specific tasks.",
  parameters: {
    type: "object",
    properties: {
      folder: {
        type: "string",
        description: "Filter to a specific stage: Cooking, ToDo, InProgress, InReview, Done, Canceled (optional — omit for full overview)",
      },
    },
    required: [],
  },
};
```

## What It Returns

Scan each pipeline subfolder, for each `.md` file (excluding README.md):
- Parse YAML frontmatter for `id`, `title`, `priority`, `executor`, `branch`, `pr`, `moved_at`
- Return compact summary

Example output:
```
📋 Pipeline Status

Cooking (2):
  001 — Cortex write_file sync tool [high] (scaff, 2026-03-12)
  002 — Cortex pipeline_status tool [high] (scaff, 2026-03-12)

ToDo (0)
InProgress (0)
InReview (0)
Done (0)
Canceled (0)
```

When filtered to a folder, include slightly more detail (priority, executor, branch, PR).

## Implementation

- Reads `pipeline/` subfolders
- Skips `README.md` in each folder
- Parses YAML frontmatter between `---` markers
- No external deps — just `fs` + string parsing
- Path hardcoded to `{workspaceDir}/pipeline/`

## Files to Change

Same pattern as `read_file`:
1. `src/cortex/tools.ts` — tool definition + `executePipelineStatus()`
2. `src/cortex/loop.ts` — sync handler case
3. `src/cortex/llm-caller.ts` — tool array + system prompt guidance
4. `src/cortex/__tests__/pipeline-status.test.ts` — tests

## Notes

- Depends on pipeline folder structure (task 001 doesn't need to be done first — this tool just reads what's there)
- Pairs with `read_file` for the drill-down pattern
