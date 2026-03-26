# CODEBASE.md — 067g Relevant Surface

## Module: `core/scheduler.py` — Where archival goes

```python
async def orchestrator_loop(db: ModuleType, config: PipelineConfig) -> None:
    """Main scheduler loop. Runs forever, one tick per interval."""
    while True:
        try:
            await _drain_knowledge_appends(db, config)
            await _drain_priority_patches(db)
            await _promote_todo(db, config)
            await _schedule_agents(db, config)
            await _check_sla_timers(db, config)
            await regenerate_priority_files(db, config)
            # >>> ADD: throttled _archive_done_tasks(db, config)
        except Exception:
            log.exception("orchestrator_tick_error")

        await asyncio.sleep(config.tick_interval_seconds)
```

**Throttling pattern:**
```python
_archive_tick_counter = 0
ARCHIVE_EVERY_N_TICKS = 360  # ~1 hour at 10s ticks

async def orchestrator_loop(db, config):
    global _archive_tick_counter
    while True:
        # ... existing steps ...
        _archive_tick_counter += 1
        if _archive_tick_counter >= ARCHIVE_EVERY_N_TICKS:
            _archive_tick_counter = 0
            await _archive_done_tasks(db, config)
        await asyncio.sleep(config.tick_interval_seconds)
```

---

## Module: `core/config.py` — Add retention config

```python
@dataclass
class PipelineConfig:
    pipeline_root: Path
    max_lifetime_bounces: int = 8
    tick_interval_seconds: int = 10
    # >>> ADD:
    # done_retention_days: int = 90
    concurrency: dict[str, int] = field(...)
    sla_timeouts: dict[str, int] = field(...)
    retry: dict[str, int] = field(...)
    agents: dict[str, AgentConfig] = field(...)

_SCALAR_KEYS: set[str] = {
    "tick_interval_seconds", "max_context_bytes", "max_lifetime_bounces",
    # >>> ADD: "done_retention_days",
}
```

---

## Module: `core/db.py` — Existing API (no changes)

```python
async def fetch_by_stage(stage: str) -> list[TaskRecord]:
    """Get all tasks in a stage. Use for DONE tasks."""

async def update_task_state(task_id: str, **kwargs) -> None:
    """Update task fields. Use: task_path=new_archive_path"""

@dataclass
class TaskRecord:
    completed_at: str | None    # ISO 8601 or None
    task_path: str              # Current filesystem path
    # ...
```

---

## Archival Function to Add

```python
async def _archive_done_tasks(db: ModuleType, config: PipelineConfig) -> None:
    """Move old DONE tasks to DONE/archive/."""
    done_tasks = await db.fetch_by_stage("DONE")
    now = datetime.now(timezone.utc)
    retention = timedelta(days=config.done_retention_days)
    archive_dir = config.pipeline_root / "DONE" / "archive"

    for task in done_tasks:
        if not task.completed_at:
            continue

        completed = datetime.fromisoformat(task.completed_at)
        if completed.tzinfo is None:
            completed = completed.replace(tzinfo=timezone.utc)

        if (now - completed) < retention:
            continue

        src = Path(task.task_path)
        if not src.exists():
            continue

        dst = archive_dir / task.id
        archive_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        await db.update_task_state(task.id, task_path=str(dst))
        log.info("task_archived", task_id=task.id, dst=str(dst))
```

---

## Existing Test Patterns (`tests/test_scheduler.py`)

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
```

**New test pattern:**
```python
@pytest.mark.asyncio
async def test_archive_done_old_task(setup_db, tmp_path):
    config = _make_config(tmp_path, done_retention_days=7)
    # Create DONE dir + task folder on disk
    done_dir = config.pipeline_root / "DONE" / "old-task"
    done_dir.mkdir(parents=True)
    (done_dir / "SPEC.md").write_text("test")
    # Create DB record with old completed_at
    old_time = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    await db.create_task("old-task", stage="DONE", task_path=str(done_dir))
    await db.update_task_state("old-task", completed_at=old_time)
    # Run archival
    await _archive_done_tasks(db, config)
    # Verify moved
    assert not done_dir.exists()
    assert (config.pipeline_root / "DONE" / "archive" / "old-task" / "SPEC.md").exists()
    task = await db.get_task("old-task")
    assert "archive" in task.task_path
```

---

## Files Summary

| File | Action |
|------|--------|
| `core/scheduler.py` | ADD `_archive_done_tasks()`, throttled call in loop |
| `core/config.py` | ADD `done_retention_days` to PipelineConfig + `_SCALAR_KEYS` |
| `tests/test_scheduler.py` | ADD archival test(s) |
