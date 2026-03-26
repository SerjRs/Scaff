# Task 067j: CANCEL-REASON.md triggered_by Field

## STATUS: COOKING

## Priority: P3
## Complexity: S

## Objective

Add `triggered_by` field to CANCEL-REASON.md to distinguish agent-initiated cancellations from human-initiated ones.

## Background

Architecture spec v2.2 §9.9: CANCEL-REASON.md should include "triggered_by (agent/human)".

Currently: CANCEL-REASON.md is written by both `api/rest.py` (human cancel) and `api/mcp.py` (agent cancel), but neither includes who triggered it.

## Scope

### In Scope
1. `api/rest.py` → `cancel_task()`: add `triggered_by: human` to CANCEL-REASON.md
2. `api/mcp.py` → `orchestrator_signal_cancel()`: add `triggered_by: agent` to CANCEL-REASON.md
3. Add `agent` parameter to MCP cancel tool (optional, defaults to "unknown")

### Out of Scope
- Tracking which specific agent cancelled

## Files to Modify

- `api/rest.py` — add triggered_by to cancel_task CANCEL-REASON.md
- `api/mcp.py` — add triggered_by to signal_cancel CANCEL-REASON.md

## Acceptance Criteria

- [ ] Human cancel writes `triggered_by: human`
- [ ] Agent cancel writes `triggered_by: agent`
- [ ] Existing tests pass

## Dependencies

- None
