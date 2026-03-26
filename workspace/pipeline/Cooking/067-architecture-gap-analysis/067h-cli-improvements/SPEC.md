# Task 067h: CLI Improvements

## STATUS: COOKING

## Priority: P2
## Complexity: S

## Objective

Make `cli.py status` useful. Currently it prints nothing on an empty pipeline and has no Rich table formatting.

## Background

The CLI exists (`cli.py`) but `status` outputs nothing when there are no tasks — no headers, no summary, no indication the pipeline is running. It should always show the pipeline state clearly.

## Scope

### In Scope
1. `cli.py status` shows a Rich table with:
   - Columns: Task ID | Stage | Status | Priority | Model | Time in Stage
   - Empty state: "No tasks in pipeline" message with stage summary (0/0/0/0/0)
2. `cli.py status --stage EXECUTION` filters by stage
3. Stage summary line: `TODO: 0 | ARCH: 1 | SPEC: 0 | EXEC: 2 | REV: 0 | TEST: 1 | DONE: 5`

### Out of Scope
- Interactive CLI (approve/cancel from CLI)
- Log tailing from CLI

## Files to Modify

- `cli.py` — rewrite status command with Rich tables

## Acceptance Criteria

- [ ] `cli.py status` shows a formatted Rich table
- [ ] Empty pipeline shows "No tasks" message with stage counts
- [ ] Stage filter works
- [ ] Stage summary line shown

## Dependencies

- None
