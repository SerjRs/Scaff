# Task 067b: Loop Detection Enforcement

## STATUS: COOKING

## Priority: P1
## Complexity: S

## Objective

Enforce the loop detection rule: when a task's `lifetime_bounces >= max_lifetime_bounces`, set its status to `LOOP_DETECTED` and freeze it. The DB fields exist but the scheduler never checks them.

## Background

`lifetime_bounces` increments every time `signal_back` is called. `max_lifetime_bounces` defaults to 8 in the config. But the scheduler happily keeps spawning agents for a task that has bounced 20 times. Without enforcement, tasks can loop infinitely between EXECUTION ↔ REVIEW.

## Scope

### In Scope
1. In `core/scheduler.py` → `_schedule_agents()`: before spawning, check if `task.lifetime_bounces >= config.max_lifetime_bounces`. If so, set status `LOOP_DETECTED` and skip.
2. Log the event with `db.log_event(task_id, "loop_detected", ...)`
3. Add test for loop detection in `tests/test_scheduler.py`

### Out of Scope
- Notifications on loop detection (067f)
- Auto-recovery from LOOP_DETECTED

## Files to Modify

- `core/scheduler.py` — add bounce check before spawn
- `core/config.py` — ensure `max_lifetime_bounces` is in PipelineConfig (verify it exists)
- `tests/test_scheduler.py` — add test

## Acceptance Criteria

- [ ] Task with `lifetime_bounces >= max_lifetime_bounces` gets status LOOP_DETECTED
- [ ] LOOP_DETECTED tasks are not spawned
- [ ] Event logged in pipeline_events
- [ ] Existing tests pass

## Dependencies

- None (can be implemented independently)
