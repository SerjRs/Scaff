# Task 067d: PIPELINE.log Audit Trail

## STATUS: COOKING

## Priority: P2
## Complexity: S

## Objective

Write structured JSON lines to `PIPELINE.log` at the pipeline root for every state transition. Currently events only go to SQLite `pipeline_events` table — there's no human-readable, greppable audit log on disk.

## Background

Architecture spec v2.2 §1 #10: "Every state transition is logged. PIPELINE.log at the pipeline root receives a structured JSON line for every move, agent spawn, retry, failure, and cancellation."

## Scope

### In Scope
1. Create a logging utility that appends JSON lines to `{pipeline_root}/PIPELINE.log`
2. Hook it into every state transition point:
   - `filesystem.move_task()` — stage transitions
   - `base.spawn_agent()` — agent spawns
   - `scheduler._check_sla_timers()` — SLA timeouts
   - `mcp.orchestrator_signal_back()` — bounces
   - `mcp.orchestrator_signal_cancel()` — cancellations
   - `rest.cancel_task()` — human cancellations

### Out of Scope
- Log rotation
- Log shipping to external systems
- REST endpoint to tail the log (067h or 066)

## JSON Line Format

```json
{"ts":"2026-03-26T12:00:00Z","event":"stage_transition","task_id":"063","from":"TODO","to":"ARCHITECTING"}
{"ts":"2026-03-26T12:00:01Z","event":"agent_spawned","task_id":"063","stage":"ARCHITECTING","model":"claude-opus-4-6","pid":12345}
{"ts":"2026-03-26T13:00:01Z","event":"sla_timeout","task_id":"063","stage":"ARCHITECTING","pid":12345}
{"ts":"2026-03-26T13:00:02Z","event":"signal_back","task_id":"063","from":"REVIEW","to":"EXECUTION","reason":"3 issues found"}
```

## Files to Modify

- `core/pipeline_log.py` — **CREATE**: append_log(event_type, task_id, **kwargs) utility
- `core/filesystem.py` — call append_log on move
- `agents/base.py` — call append_log on spawn
- `core/scheduler.py` — call append_log on SLA timeout
- `api/mcp.py` — call append_log on signal_back, signal_cancel

## Acceptance Criteria

- [ ] `PIPELINE.log` is created at pipeline root
- [ ] Every stage transition writes a JSON line
- [ ] Every agent spawn writes a JSON line
- [ ] Every SLA timeout writes a JSON line
- [ ] Log is append-only (never truncated)
- [ ] Existing tests pass

## Dependencies

- None (can be implemented independently)
