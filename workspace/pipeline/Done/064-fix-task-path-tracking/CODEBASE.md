# CODEBASE.md — 064 Relevant Surface

## Module: `core/filesystem.py`

```python
async def move_task(
    task_id: str, from_stage: str, to_stage: str,
    db: Any, config: PipelineConfig
) -> None:
    # 1. Computes src = pipeline_root / from_stage / task_id
    # 2. Computes dst = pipeline_root / to_stage / task_id
    # 3. shutil.move(src, dst)
    # 4. Inside transaction:
    #    - db.update_task_state(task_id, stage=to_stage, status="PENDING",
    #        stage_attempts=0, entered_stage_at=now)
    #    - db.log_event(task_id, "stage_transition", ...)
    # 5. On DB failure: rolls folder back to src
    #
    # BUG: task_path is NOT updated in step 4.
    # The dst path (str(dst)) is the correct new task_path.
```

## Module: `core/db.py`

```python
async def update_task_state(
    task_id: str, stage: str | None = None,
    status: str | None = None, **kwargs: str | int | None
) -> None
    # Accepts arbitrary column names in kwargs.
    # task_path is a valid column in the tasks table.
    # So: await db.update_task_state(task_id, task_path=str(dst)) works.
```

### TaskRecord columns (relevant):
- `task_path: str` — filesystem path to the task folder
- `stage: str` — current pipeline stage
- `status: str` — PENDING | WIP | BLOCKED | FAILED | DONE | etc.

## Existing Tests: `tests/test_filesystem.py`

7 tests covering move_task and build_context_manifest.
Tests use a real tmp directory and a mock db module.
