# CODEBASE.md — 067d Relevant Surface

## NEW Module: `core/pipeline_log.py` — To Create

```python
import json
from datetime import datetime, timezone
from pathlib import Path
import structlog

log = structlog.get_logger()

def append_log(pipeline_root: Path, event: str, task_id: str, **kwargs) -> None:
    """Append a JSON line to PIPELINE.log at the pipeline root."""
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "task_id": task_id,
        **kwargs,
    }
    try:
        log_path = pipeline_root / "PIPELINE.log"
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        log.warning("pipeline_log_write_failed", event=event, task_id=task_id)
```

---

## Module: `core/filesystem.py` — Hook point: `move_task()`

```python
async def move_task(
    task_id: str, from_stage: str, to_stage: str, db: Any, config: PipelineConfig,
) -> None:
    src = config.pipeline_root / from_stage / task_id
    dst = config.pipeline_root / to_stage / task_id

    # Restore write permission on SPEC.md
    spec_path = src / "SPEC.md"
    if spec_path.exists():
        spec_path.chmod(stat.S_IREAD | stat.S_IWRITE)

    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))

    try:
        async with db.transaction():
            await db.update_task_state(task_id, stage=to_stage, status="PENDING",
                                       stage_attempts=0, entered_stage_at=..., task_path=str(dst))
            await db.log_event(task_id, "stage_transition", stage_from=from_stage, stage_to=to_stage)
    except Exception:
        shutil.move(str(dst), str(src))
        raise

    # >>> ADD: append_log(config.pipeline_root, "stage_transition", task_id,
    #          from_stage=from_stage, to_stage=to_stage)
```

---

## Module: `agents/base.py` — Hook point: `spawn_agent()`

```python
async def spawn_agent(stage, task, db, config) -> None:
    # ... build prompt, cmd, env ...

    process = await asyncio.create_subprocess_exec(*cmd, ...)

    await db.update_task_state(task.id, status="WIP", agent_pid=process.pid, ...)
    await db.log_event(task.id, "agent_spawned", stage_from=stage, ...)

    # >>> ADD: append_log(config.pipeline_root, "agent_spawned", task.id,
    #          stage=stage, model=model, pid=process.pid)
```

---

## Module: `core/scheduler.py` — Hook point: `_check_sla_timers()`

```python
async def _check_sla_timers(db, config) -> None:
    wip_tasks = await db.fetch_wip_tasks()
    for task in wip_tasks:
        # ... elapsed time check ...
        if task.stage_attempts >= max_attempts:
            await db.update_task_state(task.id, status="FAILED")
            await db.log_event(task.id, "sla_timeout_failed", ...)
            # >>> ADD: append_log(config.pipeline_root, "sla_timeout_failed", task.id,
            #          stage=task.stage)
        else:
            await db.update_task_state(task.id, status="PENDING")
            await db.log_event(task.id, "sla_timeout_requeued", ...)
            # >>> ADD: append_log(config.pipeline_root, "sla_timeout_requeued", task.id,
            #          stage=task.stage, attempt=task.stage_attempts + 1)
```

---

## Module: `api/mcp.py` — Hook points: signal_back, signal_cancel

```python
@mcp_server.tool()
async def orchestrator_signal_back(task_id, target_stage, reason) -> dict:
    config = _get_config()
    task = await db.get_task(task_id)
    await db.increment_lifetime_bounces(task_id)
    _append_to_agent_log(task.task_path, f"BACK to {target_stage}: {reason}")
    await filesystem.move_task(task_id, task.stage, target_stage, db, config)
    # >>> ADD: append_log(config.pipeline_root, "signal_back", task_id,
    #          from_stage=task.stage, to_stage=target_stage, reason=reason)
    return {"ok": True}

@mcp_server.tool()
async def orchestrator_signal_cancel(task_id, reason) -> dict:
    config = _get_config()
    task = await db.get_task(task_id)
    # ... write CANCEL-REASON.md ...
    await filesystem.move_task(task_id, task.stage, "CANCEL", db, config)
    # >>> ADD: append_log(config.pipeline_root, "signal_cancel", task_id,
    #          stage=task.stage, reason=reason)
    return {"ok": True}
```

---

## Module: `api/rest.py` — Hook point: cancel_task

```python
@app.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id, body) -> dict:
    config = _get_config()
    task = await db.get_task(task_id)
    # ... write CANCEL-REASON.md ...
    await filesystem.move_task(task_id, task.stage, "CANCEL", db, config)
    # >>> ADD: append_log(config.pipeline_root, "cancel", task_id,
    #          stage=task.stage, reason=body.reason)
    return {"ok": True}
```

---

## Files Summary

| File | Action |
|------|--------|
| `core/pipeline_log.py` | CREATE — `append_log()` utility |
| `core/filesystem.py` | ADD `append_log` call after move |
| `agents/base.py` | ADD `append_log` call after spawn |
| `core/scheduler.py` | ADD `append_log` calls in SLA timeout |
| `api/mcp.py` | ADD `append_log` calls in signal_back, signal_cancel |
| `api/rest.py` | ADD `append_log` call in cancel_task |
| `tests/test_pipeline_log.py` | CREATE — test JSON line output |
