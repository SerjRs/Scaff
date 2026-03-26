# CODEBASE.md — 065 Relevant Surface

## Module: `agents/base.py`

```python
async def spawn_agent(
    stage: str, task: TaskRecord, db: ModuleType, config: PipelineConfig
) -> None:
    # Key steps (in order):
    # 1. Resolve agent config and model
    # 2. Build manifest_path and repo_path (config.pipeline_root.parent)
    # 3. Build prompt content, write PROMPT.md to task folder
    # 4. Build command args (claude CLI)
    # 5. Set env vars
    # 6. Open AGENT.log and PROMPT.md for stdin
    # 7. asyncio.create_subprocess_exec(...)
    # 8. Update DB: status=WIP, agent_pid, started_at, current_model
    #
    # INSERT chmod SPEC.md read-only BEFORE step 7 (subprocess spawn).
    # task.task_path gives the task folder path.
```

## Module: `core/filesystem.py`

```python
async def move_task(
    task_id: str, from_stage: str, to_stage: str,
    db: Any, config: PipelineConfig
) -> None:
    # 1. Compute src and dst paths
    # 2. shutil.move(src, dst)
    # 3. DB transaction: update stage, status, task_path
    #
    # INSERT chmod SPEC.md back to read-write BEFORE step 2 (shutil.move).
    # src / "SPEC.md" is the path to check.
    # On Windows, read-only files can't be moved/deleted by shutil without write permission.
```

## Prompt Files (all 5)

Located at `orchestrator/prompts/`:
- `architect.md`
- `spec.md`
- `execution.md`
- `review.md`
- `testing.md`

Each needs a "Do NOT modify SPEC.md" instruction added.

## Python File Permissions

```python
import stat
from pathlib import Path

# Set read-only:
path.chmod(stat.S_IREAD)

# Restore read-write:
path.chmod(stat.S_IREAD | stat.S_IWRITE)
```

## Existing Tests

- `tests/test_agents.py` — 5 tests (codex tests removed in 061b), uses mocked subprocess
- `tests/test_filesystem.py` — 7 tests, uses real tmp dirs and mock db
- `tests/conftest.py` — autouse mock for `create_subprocess_exec`
