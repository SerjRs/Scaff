# CODEBASE.md — 068 Relevant Surface

## Orchestrator Entry Point: `main.py`

```python
MCP_SSE_PORT = 3100

def _write_mcp_agent_config(pipeline_root: Path) -> Path:
    """Write .mcp-agent-config.json for agents to connect back via SSE."""
    config_path = pipeline_root / ".mcp-agent-config.json"
    config_data = {"mcpServers": {"orchestrator": {"url": f"http://localhost:{MCP_SSE_PORT}/sse"}}}
    config_path.write_text(json.dumps(config_data, indent=2), encoding="utf-8")
    return config_path

async def _serve(root: str, db_path: str, rest_port: int) -> None:
    config = load_config(Path(root))
    await db.init_db(db_path)
    mcp_set_config(config)
    rest_set_config(config)
    await reconcile(db, config)
    _write_mcp_agent_config(config.pipeline_root)

    # REST on :3000
    uvi_config = uvicorn.Config(rest_app, host="0.0.0.0", port=rest_port, log_level="info")
    server = uvicorn.Server(uvi_config)

    # MCP SSE on :3100
    sse_app = get_sse_app()
    sse_config = uvicorn.Config(sse_app, host="0.0.0.0", port=MCP_SSE_PORT, log_level="info")
    sse_server = uvicorn.Server(sse_config)

    await asyncio.gather(
        server.serve(),
        sse_server.serve(),
        orchestrator_loop(db, config),
        monitor_agent_processes(db),
    )
```

**E2E fixture must replicate this startup** but with dynamic ports and yielding control.

---

## Config: `core/config.py`

```python
PIPELINE_STAGES = ["TODO", "ARCHITECTING", "SPECKING", "EXECUTION", "REVIEW", "TESTING", "DONE"]

@dataclass
class PipelineConfig:
    pipeline_root: Path
    max_context_bytes: int = 3_355_443
    tick_interval_seconds: int = 10
    max_lifetime_bounces: int = 8
    done_retention_days: int = 90
    concurrency: dict[str, int] = field(default_factory=lambda: {...})
    sla_timeouts: dict[str, int] = field(default_factory=lambda: {...})
    retry: dict[str, int] = field(default_factory=lambda: {...})
    agents: dict[str, AgentConfig] = field(default_factory=lambda: {...})
    notifications: NotificationConfig | None = None

@dataclass
class NotificationConfig:
    enabled: bool = False
    webhook_url: str = ""
    events: list[str] = field(default_factory=lambda: [
        "task_failed", "sla_timeout", "loop_detected", "agent_crashed"
    ])

def load_config(pipeline_root: Path) -> PipelineConfig:
    """Loads from pipeline.config.yaml, merges with defaults."""
```

---

## Agent Spawn: `agents/base.py`

```python
async def spawn_agent(stage, task, db, config) -> None:
    agent_name = STAGE_TO_AGENT[stage]  # e.g. "architect", "spec", "execution", ...
    agent_config = config.agents[agent_name]
    
    # Model escalation
    model = agent_config.model_escalation.get(attempt, agent_config.model)
    
    # Build prompt = task context + prompt file content
    prompt_content = _build_prompt_content(agent_config.prompt_file, task, manifest_path, repo_path)
    
    # Write PROMPT.md to task folder
    prompt_file = task_dir / "PROMPT.md"
    prompt_file.write_text(prompt_content)
    
    # Build command: claude --model <model> --permission-mode bypassPermissions --output-format text
    #                       [--mcp-config .mcp-agent-config.json] -p -
    cmd = _build_command_args(agent_config.harness, model, mcp_config_path)
    
    # Env vars: PIPELINE_TASK_PATH, PIPELINE_TASK_ID, PIPELINE_MANIFEST,
    #           PIPELINE_TOKEN, PIPELINE_REPO_PATH
    # For EXECUTION: also PIPELINE_STAGE_ATTEMPTS, PIPELINE_MODEL, PIPELINE_BRANCH
    
    # EXECUTION stage: create/checkout feature/<task_id> branch
    if stage == "EXECUTION":
        await _ensure_feature_branch(task.id, repo_path)
        env["PIPELINE_BRANCH"] = f"feature/{task.id}"
    
    # Protect SPEC.md (chmod read-only)
    
    # Spawn: asyncio.create_subprocess_exec(*cmd, stdin=prompt_file, stdout=log_file, ...)
    process = await asyncio.create_subprocess_exec(...)
    
    # Update DB: status=WIP, agent_pid=process.pid
```

---

## MCP Signal Tools: `api/mcp.py`

```python
@mcp_server.tool()
async def orchestrator_signal_done(task_id: str, notes: str = "") -> dict:
    """Advance task to next stage."""
    # If TESTING→DONE: merge feature/<task_id> to main
    # Warn if COMPLETION.md missing
    await filesystem.move_task(task_id, task.stage, next_stage, db, config)

@mcp_server.tool()
async def orchestrator_signal_back(task_id: str, target_stage: str, reason: str) -> dict:
    """Send task back. Increments lifetime_bounces."""

@mcp_server.tool()
async def orchestrator_signal_cancel(task_id: str, reason: str) -> dict:
    """Cancel task. Writes CANCEL-REASON.md with triggered_by: agent."""

@mcp_server.tool()
async def orchestrator_append_knowledge(section: str, content: str, task_id: str = "") -> dict:
    """Append to knowledge base."""

@mcp_server.tool()
async def orchestrator_patch_priority(task_id: str, action: str, value: str, reason: str) -> dict:
    """Queue priority change."""

def get_sse_app():
    """Returns Starlette ASGI app for MCP SSE transport."""
    return mcp_server.sse_app()
```

---

## REST API: `api/rest.py`

```python
GET  /health                          → {"status": "ok", "tasks_active": N}
GET  /tasks                           → [TaskRecord, ...]
GET  /tasks?stage=X                   → filtered
GET  /tasks?status=X                  → filtered
GET  /tasks/{task_id}                 → TaskRecord or 404
POST /tasks/{task_id}/approve         → creates task, moves COOKING→TODO
POST /tasks/{task_id}/cancel          → writes CANCEL-REASON.md (triggered_by: human), moves to CANCEL
POST /tasks/{task_id}/reprioritize    → updates priority (P1/P2/P3)
POST /tasks/{task_id}/retry           → resets FAILED/LOOP_DETECTED to PENDING
POST /tasks/{task_id}/signal-done     → advance stage (same as MCP tool)
POST /tasks/{task_id}/signal-back     → send back (same as MCP tool)
```

---

## Scheduler: `core/scheduler.py`

```python
async def orchestrator_loop(db, config):
    while True:
        await _drain_knowledge_appends(db, config)
        await _drain_priority_patches(db)
        await _promote_todo(db, config)        # TODO→ARCHITECTING
        await _schedule_agents(db, config)      # spawn agents for PENDING tasks
        await _check_sla_timers(db, config)     # timeout WIP tasks
        await regenerate_priority_files(db, config)
        # Throttled: _archive_done_tasks every 360 ticks
        await asyncio.sleep(config.tick_interval_seconds)
```

Key: `_promote_todo` moves PENDING tasks from TODO to ARCHITECTING. `_schedule_agents` spawns agents for PENDING tasks in active stages (ARCHITECTING, SPECKING, EXECUTION, REVIEW, TESTING).

---

## Monitor: `core/monitor.py`

```python
async def monitor_agent_processes(db, config=None):
    """Polls every 15s. Dead agent PID → reset to PENDING, increment attempts, notify."""
```

---

## Filesystem: `core/filesystem.py`

```python
async def move_task(task_id, from_stage, to_stage, db, config):
    """Move task folder between stages. Updates DB. Writes PIPELINE.log."""
    # Restores SPEC.md write permission before move
    # shutil.move(src, dst)
    # DB: stage=to_stage, status=PENDING, stage_attempts=0
    # Logs: stage_transition event + PIPELINE.log JSON line

def build_context_manifest(task_path, config) -> Path:
    """Builds .context-manifest.txt — lists files for agent to read."""
    # Reads .pipelineignore, filters by allowed_extensions, checks size
```

---

## Pipeline Log: `core/pipeline_log.py`

```python
def append_log(pipeline_root: Path, event: str, task_id: str, **kwargs) -> None:
    """Appends one JSON line to PIPELINE.log."""
    # {"ts": "...", "event": "...", "task_id": "...", ...kwargs}
```

---

## Reconciler: `core/reconciler.py`

```python
async def reconcile(db, config):
    """Startup: align DB with filesystem. Fixes orphans, mismatches, dead WIPs."""
```

---

## Existing conftest.py (to work around)

```python
@pytest.fixture(autouse=True)
def mock_subprocess_exec(monkeypatch, tmp_path):
    """Prevent real subprocess spawning in ALL tests."""
    mock_process = MagicMock()
    mock_process.pid = 99999
    async def fake_exec(*args, **kwargs):
        return mock_process
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return mock_process
```

**E2E tests MUST override this** — the whole point is real subprocess spawning.

---

## Agent Prompts (what agents receive)

All at `orchestrator/prompts/`:
- `architect.md` — Read context manifest, write HLD.md or split into subtasks, call signal_done
- `spec.md` — Read HLD, write TASK-SPEC.md for each subtask, call signal_done
- `execution.md` — Checkout feature branch, implement per TASK-SPEC.md, call signal_done
- `review.md` — Review git diff, write REVIEW-NOTES.md, call signal_done (PASS) or signal_back (FAIL)
- `testing.md` — Run tests, write TEST-RESULTS.md + COMPLETION.md, merge branch, call signal_done

Each prompt begins with task context injected by `_build_prompt_content()`:
```
Task ID: e2e-dummy-001
Task Path: /tmp/xxx/pipeline/ARCHITECTING/e2e-dummy-001
Repo Path: /tmp/xxx
Context Manifest: /tmp/xxx/pipeline/ARCHITECTING/e2e-dummy-001/.context-manifest.txt
```

---

## Dependencies (pyproject.toml)

```toml
dependencies = [
    "aiofiles>=24.1.0", "aiosqlite>=0.21.0", "fastapi>=0.115.12",
    "httpx>=0.28.1", "mcp[cli]>=1.9.4", "pathspec>=0.12.1",
    "pyyaml>=6.0.2", "rich>=14.0.0", "structlog>=25.1.0",
    "typer>=0.15.4", "uvicorn>=0.34.2",
]
[dependency-groups]
dev = ["pytest>=8.3.5", "pytest-asyncio>=0.26.0"]
```

May need `pytest-timeout` for the 10-minute timeout. Add to dev deps if not present.

---

## Files Summary

| File | Action |
|------|--------|
| `tests/e2e/__init__.py` | CREATE — empty |
| `tests/e2e/conftest.py` | CREATE — orchestrator fixture, webhook collector, override subprocess mock |
| `tests/e2e/test_e2e.py` | CREATE — full lifecycle + API + cancel + PIPELINE.log tests |
| `tests/conftest.py` | MAYBE modify — add e2e path check to skip mock (if override doesn't work) |
