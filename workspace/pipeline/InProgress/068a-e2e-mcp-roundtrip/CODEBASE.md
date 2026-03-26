# CODEBASE.md — 068a Relevant Surface

## Orchestrator Startup: `main.py`

```python
MCP_SSE_PORT = 3100

def _write_mcp_agent_config(pipeline_root: Path) -> Path:
    config_path = pipeline_root / ".mcp-agent-config.json"
    config_data = {"mcpServers": {"orchestrator": {"url": f"http://localhost:{MCP_SSE_PORT}/sse"}}}
    config_path.write_text(json.dumps(config_data, indent=2), encoding="utf-8")
    return config_path

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
        rest_server.serve(),
        sse_server.serve(),
        orchestrator_loop(db, config),
        monitor_agent_processes(db),
    )
```

**E2E fixture replicates this** with dynamic ports and `asyncio.create_task()` instead of `asyncio.gather()`.

---

## Config: `core/config.py`

```python
PIPELINE_STAGES = ["TODO", "ARCHITECTING", "SPECKING", "EXECUTION", "REVIEW", "TESTING", "DONE"]

@dataclass
class AgentConfig:
    harness: str           # "claude-code"
    model: str             # e.g. "claude-haiku-4-5"
    prompt_file: str       # e.g. "orchestrator/prompts/architect.md"
    effort: str = "standard"
    thinking: str = ""
    model_escalation: dict[int, str] = field(default_factory=dict)

STAGE_TO_AGENT = {
    "ARCHITECTING": "architect", "SPECKING": "spec", "EXECUTION": "execution",
    "REVIEW": "review", "TESTING": "testing",
}

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
    """Loads from pipeline.config.yaml, merges with defaults."""
```

---

## Agent Spawn: `agents/base.py`

```python
def _build_prompt_content(agent_config_prompt_file, task, manifest_path, repo_path) -> str:
    """Prepends task context (Task ID, Task Path, Repo Path, Context Manifest) to prompt file."""

def _resolve_claude_binary() -> str:
    """shutil.which("claude") — finds claude.cmd on Windows."""

def _build_command_args(harness, model, mcp_config_path=None) -> list[str]:
    """Returns: [claude, --model, <model>, --permission-mode, bypassPermissions,
                 --output-format, text, [--mcp-config, <path>], -p, -]"""

async def spawn_agent(stage, task, db, config):
    # Build prompt → write PROMPT.md → build cmd → set env vars
    # EXECUTION: create feature branch, set PIPELINE_BRANCH
    # Protect SPEC.md (chmod read-only)
    # asyncio.create_subprocess_exec(*cmd, stdin=prompt_file, stdout=log_file, cwd=repo_path)
    # Update DB: status=WIP, agent_pid=process.pid
```

**Key:** The agent reads prompt via stdin (`-p -`) and connects to MCP SSE via `--mcp-config .mcp-agent-config.json`. The fixture must ensure this config points to the correct dynamic SSE port.

---

## Scheduler: `core/scheduler.py`

```python
async def _promote_todo(db, config):
    """Moves PENDING tasks from TODO → ARCHITECTING."""

async def _schedule_agents(db, config):
    """For each active stage: if slots available and PENDING tasks exist, spawn agent."""
    # Checks concurrency, dependencies, loop detection
    # Calls spawn_agent(stage, task, db, config)

async def orchestrator_loop(db, config):
    while True:
        await _drain_knowledge_appends(db, config)
        await _drain_priority_patches(db)
        await _promote_todo(db, config)
        await _schedule_agents(db, config)
        await _check_sla_timers(db, config)
        await regenerate_priority_files(db, config)
        await asyncio.sleep(config.tick_interval_seconds)
```

**Flow for the test:**
1. Approve → task in TODO/PENDING
2. Tick → `_promote_todo` moves to ARCHITECTING/PENDING
3. Tick → `_schedule_agents` spawns agent → ARCHITECTING/WIP
4. Agent calls `signal_done` via MCP → filesystem.move_task → SPECKING/PENDING

---

## MCP Server: `api/mcp.py`

```python
mcp_server = FastMCP("orchestrator")

@mcp_server.tool()
async def orchestrator_signal_done(task_id: str, notes: str = "") -> dict:
    """Advance task to next stage."""
    config = _get_config()
    task = await db.get_task(task_id)
    current_idx = PIPELINE_STAGES.index(task.stage)
    next_stage = PIPELINE_STAGES[current_idx + 1]
    # TESTING→DONE: merge branch, warn if COMPLETION.md missing
    await filesystem.move_task(task_id, task.stage, next_stage, db, config)
    return {"ok": True}

def get_sse_app():
    """Returns Starlette ASGI app for MCP SSE transport."""
    return mcp_server.sse_app()
```

---

## REST API: `api/rest.py`

```python
GET  /health              → {"status": "ok", "tasks_active": N}
GET  /tasks/{task_id}     → TaskRecord dict or 404
POST /tasks/{id}/approve  → moves COOKING→TODO, creates DB record
```

---

## Filesystem: `core/filesystem.py`

```python
async def move_task(task_id, from_stage, to_stage, db, config):
    """shutil.move + DB update + PIPELINE.log append."""

def build_context_manifest(task_path, config) -> Path:
    """Lists files for agent to read. Reads .pipelineignore."""
```

---

## Pipeline Log: `core/pipeline_log.py`

```python
def append_log(pipeline_root, event, task_id, **kwargs):
    """Appends JSON line to PIPELINE.log."""
```

---

## Monitor: `core/monitor.py`

```python
async def monitor_agent_processes(db, config=None):
    """Polls every 15s for dead agent PIDs."""
```

---

## Reconciler: `core/reconciler.py`

```python
async def reconcile(db, config):
    """Startup: align DB with filesystem."""
```

---

## Existing conftest.py (must be overridden)

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

**E2E conftest overrides this with a no-op fixture of the same name.**

---

## Architect Prompt: `prompts/architect.md`

The architect agent receives a prompt starting with:
```
Task ID: e2e-dummy-001
Task Path: <tmp>/pipeline/ARCHITECTING/e2e-dummy-001
Repo Path: <tmp>
Context Manifest: <tmp>/pipeline/ARCHITECTING/e2e-dummy-001/.context-manifest.txt
```

Then the full architect.md content. For the dummy task, the agent should:
1. Read SPEC.md (trivial task)
2. Create SPEC-DETAILS/HLD.md (minimal)
3. Call `orchestrator_signal_done("e2e-dummy-001")`

---

## Files Summary

| File | Action |
|------|--------|
| `tests/e2e/__init__.py` | CREATE — empty |
| `tests/e2e/conftest.py` | CREATE — orchestrator fixture, mock override |
| `tests/e2e/test_mcp_roundtrip.py` | CREATE — the E2E test |
| `pyproject.toml` | ADD `pytest-timeout` to dev deps (if not present) |
