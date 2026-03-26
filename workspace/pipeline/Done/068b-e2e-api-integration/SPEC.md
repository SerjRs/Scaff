# Task 068b: E2E Test — Orchestrator API Integration

## STATUS: COOKING

## Priority: P1
## Complexity: S

## Objective

Write integration tests that spin up the full orchestrator (REST API + MCP SSE + scheduler + monitor) with **mocked agents** and test every REST API endpoint against the live server with a real SQLite database and real filesystem. This validates the wiring between HTTP layer → business logic → DB → filesystem.

## Background

Existing unit tests for the API mock the DB module. This means wiring bugs between FastAPI endpoints and the real DB/filesystem are invisible. These tests use the real stack — only agent subprocess spawning is mocked.

## Architecture

```
pytest process
  │
  ├── Orchestrator (in-process, async tasks)
  │     ├── REST API (:random_port)
  │     ├── MCP SSE  (:random_port)
  │     ├── Scheduler (tick=2s)
  │     └── Monitor
  │
  ├── Mock subprocess (from conftest — agents are faked)
  │
  └── httpx.AsyncClient → REST API assertions
```

Same orchestrator fixture pattern as 068a but **keeps the parent conftest mock** — agents are faked. This makes tests fast and deterministic.

## Scope

### File: `tests/test_api_integration.py`

This lives in `tests/` (NOT `tests/e2e/`) so it inherits the parent conftest subprocess mock. No real agents.

### Fixture: `live_orchestrator`

Similar to 068a's fixture but simpler (no git repo needed since agents are mocked):
1. Create temp dir with pipeline stage directories
2. Create `pipeline/COOKING/integ-task-001/SPEC.md` (dummy)
3. Create `pipeline/COOKING/integ-task-002/SPEC.md` (for cancel test)
4. Init SQLite DB
5. Set configs, run reconciler
6. Start REST + MCP SSE + scheduler + monitor as async tasks
7. Wait for health
8. Yield `(config, rest_url, db)`
9. Teardown

### Pipeline Config

```yaml
tick_interval_seconds: 2
concurrency:
  ARCHITECTING: 1
  SPECKING: 1
  EXECUTION: 1
  REVIEW: 1
  TESTING: 1
sla_timeouts:
  ARCHITECTING: 300
  SPECKING: 300
  EXECUTION: 300
  REVIEW: 300
  TESTING: 300
```

### Tests

#### Health & Listing

**`test_health_returns_ok`**
- GET /health → 200, has "status": "ok"

**`test_list_tasks_empty`**
- GET /tasks → 200, `[]`

**`test_list_tasks_after_approve`**
- Approve integ-task-001
- GET /tasks → contains integ-task-001

**`test_list_tasks_by_stage`**
- Approve integ-task-001, wait for ARCHITECTING
- GET /tasks?stage=ARCHITECTING → contains integ-task-001
- GET /tasks?stage=EXECUTION → empty

**`test_get_task_by_id`**
- Approve integ-task-001
- GET /tasks/integ-task-001 → 200, correct fields (id, stage, status, priority)

**`test_get_task_404`**
- GET /tasks/nonexistent → 404

#### Approve & Promote

**`test_approve_moves_to_todo`**
- POST /tasks/integ-task-001/approve → 200
- GET /tasks/integ-task-001 → stage=TODO or ARCHITECTING (scheduler may have already promoted)

**`test_approve_creates_record`**
- POST /tasks/brand-new-task/approve → 200
- GET /tasks/brand-new-task → exists in DB

#### Scheduler Promotion

**`test_scheduler_promotes_todo_to_architecting`**
- Approve task → TODO
- Wait (scheduler tick) → task moves to ARCHITECTING/PENDING
- Wait (scheduler tick) → task becomes WIP (mock agent spawned)

#### Signal Done (via REST)

**`test_signal_done_advances_stage`**
- Approve task, wait for ARCHITECTING/WIP
- POST /tasks/integ-task-001/signal-done → 200
- GET /tasks/integ-task-001 → stage=SPECKING

#### Signal Back (via REST)

**`test_signal_back_increments_bounces`**
- Get task to SPECKING/WIP
- POST /tasks/integ-task-001/signal-back {target_stage: "ARCHITECTING", reason: "needs rework"}
- GET /tasks/integ-task-001 → stage=ARCHITECTING, lifetime_bounces=1

#### Cancel

**`test_cancel_writes_reason_file`**
- Approve integ-task-002, wait for ARCHITECTING
- POST /tasks/integ-task-002/cancel {reason: "integration test"}
- Assert: CANCEL-REASON.md exists in task folder
- Assert: contains `triggered_by: human`
- GET /tasks/integ-task-002 → stage=CANCEL

#### Reprioritize

**`test_reprioritize_valid`**
- Approve task
- POST /tasks/integ-task-001/reprioritize {priority: "P1"} → 200
- GET /tasks/integ-task-001 → priority=P1

**`test_reprioritize_invalid`**
- POST /tasks/integ-task-001/reprioritize {priority: "P99"} → 400

#### Retry

**`test_retry_failed_task`**
- Get task to WIP, directly set status=FAILED in DB
- POST /tasks/integ-task-001/retry → 200
- GET /tasks/integ-task-001 → status=PENDING, stage_attempts=0

**`test_retry_non_failed_400`**
- Task in PENDING → POST /tasks/integ-task-001/retry → 400

#### PIPELINE.log

**`test_pipeline_log_written_on_transitions`**
- Approve task, wait for ARCHITECTING, signal_done
- Read PIPELINE.log → valid JSON lines
- Assert `stage_transition` events present
- Assert each line has `ts`, `event`, `task_id`

## Acceptance Criteria

- [ ] All tests pass with mocked agents (fast, deterministic)
- [ ] Tests use real SQLite DB and real filesystem
- [ ] Every REST endpoint tested (health, list, get, approve, cancel, reprioritize, retry, signal-done, signal-back)
- [ ] PIPELINE.log and CANCEL-REASON.md verified on disk
- [ ] Tests complete in < 30 seconds
- [ ] All 120+ existing unit tests still pass
- [ ] Works on Windows (Python 3.12+)

## Dependencies

- 067a–067j (all merged)
- 068a (shares the fixture pattern — but can be built independently)

## Out of Scope

- Real agent testing (that's 068a)
- Notification webhook testing (mocked agents don't trigger real failures)
- SLA timeout testing (would need to wait for real timeouts — too slow)
- Loop detection testing (covered by unit tests)
