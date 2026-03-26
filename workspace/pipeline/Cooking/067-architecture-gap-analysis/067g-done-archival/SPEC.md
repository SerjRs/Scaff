# Task 067g: DONE Archival

## STATUS: COOKING

## Priority: P3
## Complexity: S

## Objective

Auto-archive completed tasks older than `done_retention_days` (default: 90) from `DONE/` to `DONE/archive/`.

## Background

Architecture spec v2.2 §9.8: "Orchestrator archives folders older than done_retention_days to DONE/archive/ automatically."

Currently: DONE tasks accumulate forever.

## Scope

### In Scope
1. Add an archival step to the orchestrator loop (run once per tick or once per hour)
2. For each task in DONE/: check `completed_at` timestamp in DB
3. If older than `done_retention_days`: move folder to `DONE/archive/<task-id>`
4. Update `task_path` in DB
5. Configurable retention period in `pipeline.config.yaml`

### Out of Scope
- Deleting archived tasks
- Compressing archives

## Files to Modify

- `core/scheduler.py` — add archival check (low frequency, e.g., every 100 ticks)
- `core/config.py` — add `done_retention_days` to PipelineConfig (default: 90)

## Acceptance Criteria

- [ ] Tasks in DONE older than retention period are moved to DONE/archive/
- [ ] task_path updated in DB after archive
- [ ] Configurable retention period
- [ ] Archival doesn't run every tick (performance)
- [ ] Existing tests pass

## Dependencies

- None
