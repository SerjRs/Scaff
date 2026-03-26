# CODEBASE.md — 068b Relevant Surface

## Orchestrator Startup: `main.py`

```python
async def _serve(root, db_path, rest_port):
    config = load_config(Path(root))
    await db.init_db(db_path)
    mcp_set_config(config)
    rest_set_config(config)
    await reconcile(db, config)
    _write_mcp_agent_config(config.pipeline_root)

    rest_server = uvicorn.Server(uvicorn.Config(rest_app, host="0.0.0.0", port=rest_port))
    sse_server = uvicorn.Server(uvicorn.Config(get_sse_app(), host="0.0.0.0", port=MCP_SSE_PORT))

    await asyncio.gather(
        rest_server.serve(), sse_server.serve(),
        orchestrator_loop(db, config), monitor_agent_processes(db),
    )
```

**Fixture replicates this** with `asyncio.create_task()` and dynamic ports.

---

## REST API: `api/rest.py` — All Endpoints

```python
app = FastAPI(title="Pipeline Orchestrator API")

@app.get("/health")
async def health() -> dict:
    count = await db.count_active_tasks()
    return {"status": "ok", "tasks_active": count}

@app.get("/tasks")
async def list_tasks(stage: str | None = None, status: str | None = None) -> list[dict]:
    # Filters by stage and/or status

@app.get("/tasks/{task_id}")
async def get_task(task_id: str) -> dict:
    # Returns task or 404

@app.post("/tasks/{task_id}/approve")
async def approve_task(task_id: str, body: ApproveBody) -> dict:
    # Creates task if not exists, moves COOKING→TODO
    # Body: {"priority": "P2", "complexity": "M"}

@app.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str, body: CancelBody) -> dict:
    # Writes CANCEL-REASON.md with triggered_by: human, moves to CANCEL
    # Body: {"reason": "..."}

@app.post("/tasks/{task_id}/reprioritize")
async def reprioritize_task(task_id: str, body: ReprioritizeBody) -> dict:
    # Validates P1/P2/P3, updates DB
    # Body: {"priority": "P1"}

@app.post("/tasks/{task_id}/retry")
async def retry_task(task_id: str) -> dict:
    # Only FAILED or LOOP_DETECTED, resets to PENDING
    # No body needed

@app.post("/tasks/{task_id}/signal-done")
async def signal_done(task_id: str, body: SignalDoneBody) -> dict:
    # Advances to next stage, warns if COMPLETION.md missing on TESTING→DONE
    # Body: {"notes": ""}

@app.post("/tasks/{task_id}/signal-back")
async def signal_back(task_id: str, body: SignalBackBody) -> dict:
    # Increments lifetime_bounces, moves to target stage
    # Body: {"target_stage": "ARCHITECTING", "reason": "..."}
```

---

## Config: `core/config.py`

```python
PIPELINE_STAGES = ["TODO", "ARCHITECTING", "SPECKING", "EXECUTION", "REVIEW", "TESTING", "DONE"]

@dataclass
class PipelineConfig:
    pipeline_root: Path
    tick_interval_seconds: int = 10
    max_lifetime_bounces: int = 8
    concurrency: dict[str, int] = field(...)
    sla_timeouts: dict[str, int] = field(...)
    retry: dict[str, int] = field(...)
    agents: dict[str, AgentConfig] = field(...)
    notifications: NotificationConfig | None = None

def load_config(pipeline_root: Path) -> PipelineConfig:
```

---

## DB Module: `core/db.py`

```python
async def init_db(db_path: str) -> aiosqlite.Connection:
async def get_task(task_id: str) -> TaskRecord | None:
async def create_task(task_id, stage, task_path, priority="P2", complexity=None) -> TaskRecord:
async def update_task_state(task_id: str, **kwargs) -> None:
async def fetch_all_tasks() -> list[TaskRecord]:
async def fetch_by_stage(stage: str) -> list[TaskRecord]:
async def count_active_tasks() -> int:
async def increment_lifetime_bounces(task_id: str) -> int:

@dataclass
class TaskRecord:
    id: str; stage: str; status: str; priority: str; complexity: str | None
    task_path: str; parent_task_id: str | None; stage_attempts: int
    lifetime_bounces: int; current_model: str | None; agent_pid: int | None
    entered_stage_at: str | None; started_at: str | None; completed_at: str | None
    created_at: str; updated_at: str
```

---

## Scheduler: `core/scheduler.py`

```python
async def _promote_todo(db, config):
    """Moves PENDING TODO tasks → ARCHITECTING."""

async def _schedule_agents(db, config):
    """Spawns (mock) agents for PENDING tasks."""

async def orchestrator_loop(db, config):
    """Main loop: drain queues, promote, schedule, check SLA, every tick_interval_seconds."""
```

---

## Filesystem: `core/filesystem.py`

```python
async def move_task(task_id, from_stage, to_stage, db, config):
    """shutil.move + DB update + PIPELINE.log line."""
```

---

## Pipeline Log: `core/pipeline_log.py`

```python
def append_log(pipeline_root, event, task_id, **kwargs):
    """JSON line → PIPELINE.log."""
```

---

## Existing conftest.py (kept active for 068b)

```python
@pytest.fixture(autouse=True)
def mock_subprocess_exec(monkeypatch, tmp_path):
    mock_process = MagicMock()
    mock_process.pid = 99999
    mock_process.returncode = 0
    async def fake_exec(*args, **kwargs):
        return mock_process
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return mock_process
```

**This stays active for 068b** — agents are mocked, tests are fast.

---

## Imports Needed for Fixture

```python
import asyncio, json, socket, time
from pathlib import Path
import httpx, pytest, pytest_asyncio, uvicorn
from core import db
from core.config import load_config, PipelineConfig, PIPELINE_STAGES
from core.reconciler import reconcile
from core.scheduler import orchestrator_loop
from core.monitor import monitor_agent_processes
from api.mcp import set_config as mcp_set_config, get_sse_app
from api.rest import set_config as rest_set_config, app as rest_app
```

---

## Files Summary

| File | Action |
|------|--------|
| `tests/test_api_integration.py` | CREATE — fixture + all integration tests |
| `pyproject.toml` | ADD `pytest-timeout` to dev deps (if not present, shared with 068a) |
