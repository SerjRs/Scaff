# CODEBASE.md — 067b Relevant Surface

## Module: `core/scheduler.py` — Where the change goes

```python
_ACTIVE_STAGES = [s for s in PIPELINE_STAGES if s not in ("TODO", "DONE")]

async def _schedule_agents(db: ModuleType, config: PipelineConfig) -> None:
    """Step 3: spawn agents for pending tasks within concurrency limits."""
    for stage in _ACTIVE_STAGES:
        active = await db.count_wip(stage)
        slots = config.concurrency.get(stage, 1) - active
        if slots <= 0:
            continue

        pending = await db.fetch_pending(stage, limit=slots)
        for task in pending:
            if stage == "EXECUTION":
                if not await _check_deps_met(task.task_path, db):
                    await db.update_task_state(task.id, status="BLOCKED")
                    log.info("task_blocked_deps", task_id=task.id)
                    continue

            # >>> INSERT LOOP DETECTION CHECK HERE <<<
            # Before spawn_agent(), check task.lifetime_bounces >= config.max_lifetime_bounces

            await spawn_agent(stage, task, db, config)
```

---

## Module: `core/config.py` — Config (no changes needed)

```python
@dataclass
class PipelineConfig:
    pipeline_root: Path
    max_lifetime_bounces: int = 8          # <-- Already exists
    tick_interval_seconds: int = 10
    concurrency: dict[str, int] = field(...)
    sla_timeouts: dict[str, int] = field(...)
    retry: dict[str, int] = field(...)
    agents: dict[str, AgentConfig] = field(...)
```

---

## Module: `core/db.py` — DB API (no changes needed)

```python
@dataclass
class TaskRecord:
    id: str
    stage: str
    status: str                # "PENDING" | "WIP" | "BLOCKED" | "FAILED" | "LOOP_DETECTED" | ...
    priority: str
    complexity: str
    task_path: str
    parent_task_id: str | None
    stage_attempts: int
    lifetime_bounces: int      # <-- Incremented by signal_back
    current_model: str
    agent_pid: int | None
    entered_stage_at: str | None
    started_at: str | None
    completed_at: str | None
    created_at: str
    updated_at: str

async def update_task_state(task_id: str, **kwargs) -> None:
    """Update any task fields. Use: status="LOOP_DETECTED" """

async def log_event(task_id: str, event_type: str, stage_from: str = "", 
                    stage_to: str = "", details: str = "") -> None:
    """Insert into pipeline_events table."""

async def increment_lifetime_bounces(task_id: str) -> int:
    """Called by signal_back. Returns new count."""

async def fetch_pending(stage: str, limit: int = 1) -> list[TaskRecord]:
    """Returns PENDING tasks ordered by priority, created_at."""

async def create_task(task_id, stage, task_path, priority="P2", 
                      complexity="M", parent_task_id=None) -> TaskRecord:
    """Insert new task."""
```

---

## Module: `tests/test_scheduler.py` — Existing test patterns

```python
@pytest_asyncio.fixture
async def setup_db(tmp_path):
    db_path = str(tmp_path / "test.db")
    conn = await db.init_db(db_path)
    yield conn
    await conn.close()
    db._db = None

def _make_config(tmp_path, **kwargs):
    pipeline_root = tmp_path / "pipeline"
    pipeline_root.mkdir(exist_ok=True)
    return PipelineConfig(pipeline_root=pipeline_root, **kwargs)

# Example: test_sla_timeout_fail_on_max_attempts
@pytest.mark.asyncio
async def test_sla_timeout_fail_on_max_attempts(setup_db, tmp_path):
    config = _make_config(tmp_path, sla_timeouts={"TESTING": 60}, retry={"TESTING": 2})
    await db.create_task(task_id="fail-task", stage="TESTING", task_path="/t/fail")
    old_time = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()
    await db.update_task_state("fail-task", status="WIP", started_at=old_time, stage_attempts=2)
    await _check_sla_timers(db, config)
    task = await db.get_task("fail-task")
    assert task.status == "FAILED"
```

**Pattern for new loop detection test:**
1. Create task with `stage="REVIEW"` (or any active stage)
2. `update_task_state` to set `lifetime_bounces=8` (or use `increment_lifetime_bounces` 8 times)
3. Call `_schedule_agents(db, config)` with `max_lifetime_bounces=8`
4. Assert `task.status == "LOOP_DETECTED"`

**Note:** `update_task_state` accepts arbitrary kwargs — but `lifetime_bounces` may not be in its dynamic kwargs handling. Check if you need to call `increment_lifetime_bounces()` in a loop instead, or just use direct SQL in the test fixture.

---

## Module: `api/rest.py` — Retry endpoint (context only, no changes)

```python
@app.post("/tasks/{task_id}/retry")
async def retry_task(task_id: str):
    """Sets FAILED or LOOP_DETECTED task back to PENDING, resets stage_attempts."""
    task = await db.get_task(task_id)
    if task.status not in ("FAILED", "LOOP_DETECTED"):
        raise HTTPException(400, "only FAILED or LOOP_DETECTED tasks can be retried")
    ...
```

This already handles `LOOP_DETECTED` — added in an earlier task. No changes needed here.

---

## Files Summary

| File | Action |
|------|--------|
| `core/scheduler.py` | ADD bounce check in `_schedule_agents` |
| `tests/test_scheduler.py` | ADD `test_loop_detection_freezes_task` |
| `core/config.py` | VERIFY only — `max_lifetime_bounces` exists |
| `core/db.py` | NO CHANGE |
| `agents/base.py` | NO CHANGE |
| `core/monitor.py` | NO CHANGE |
