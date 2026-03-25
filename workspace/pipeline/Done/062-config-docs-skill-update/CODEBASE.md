# CODEBASE.md — Implementation State

> **Read this first.** This is the authoritative API surface of everything built so far.
> Updated after each task merge. Do not modify existing module signatures without spec authorization.

## Project Setup

- **Language:** Python 3.12+
- **Package manager:** `uv`
- **Project root:** `orchestrator/` (pyproject.toml lives here)
- **Dependencies:** `aiosqlite`, `structlog`, `pathspec`, `pytest`, `pytest-asyncio`
- **Run tests:** `cd orchestrator && uv run pytest -v`

## Conventions

- `aiosqlite` with `Row` factory for all DB access
- `structlog` for all logging (import as `log = structlog.get_logger()`)
- Fully typed function signatures (`: type` and `-> type`) everywhere
- `dataclasses` for records, never raw dicts
- `pathlib.Path` for all path handling
- Async-first (`async def`) for all DB and filesystem operations
- Global module-level `_db` connection, initialized via `init_db()`

## Module: `core/db.py`

SQLite data access layer. Authoritative state for all tasks.

### TaskRecord (dataclass)
```python
@dataclass
class TaskRecord:
    id: str
    stage: str
    status: str                    # PENDING | WIP | BLOCKED | BackFromReview | BackFromTest | BackFromCooking | FAILED | LOOP_DETECTED | DONE | CANCELLED
    priority: str                  # P1 | P2 | P3
    complexity: str | None         # S | M | L | XL
    task_path: str
    parent_task_id: str | None
    stage_attempts: int
    lifetime_bounces: int
    current_model: str | None
    agent_pid: int | None
    entered_stage_at: str | None
    started_at: str | None
    completed_at: str | None
    created_at: str
    updated_at: str
```

### Functions
```python
async def init_db(db_path: str) -> aiosqlite.Connection
    # Creates all 5 tables (tasks, dependencies, priority_patches, pipeline_events, knowledge_appends).
    # Sets row_factory to aiosqlite.Row. Stores connection in module-level _db.

async def get_task(task_id: str) -> TaskRecord | None

async def create_task(
    task_id: str, stage: str, task_path: str,
    priority: str = "P2", complexity: str | None = None
) -> TaskRecord

async def update_task_state(
    task_id: str, stage: str | None = None,
    status: str | None = None, **kwargs: str | int | None
) -> None
    # Accepts arbitrary column names in kwargs (e.g. agent_pid=1234, entered_stage_at="...")

async def increment_stage_attempts(task_id: str) -> int   # returns new value
async def increment_lifetime_bounces(task_id: str) -> int  # returns new value

async def log_event(
    task_id: str, event_type: str,
    stage_from: str | None = None, stage_to: str | None = None,
    agent: str | None = None, model: str | None = None,
    details: str | None = None
) -> None

async def fetch_pending(stage: str, limit: int = 1) -> list[TaskRecord]
    # Ordered by priority ASC (P1 first), then created_at ASC.

async def count_wip(stage: str) -> int

@contextlib.asynccontextmanager
async def transaction() -> AsyncIterator[aiosqlite.Connection]
    # BEGIN / commit / rollback. Yields the connection.
```

### SQLite Tables
- `tasks` — main task state (16 columns)
- `dependencies` — task_id → depends_on (composite PK)
- `priority_patches` — queued priority/status changes (applied by scheduler)
- `pipeline_events` — audit log of all state transitions
- `knowledge_appends` — queued knowledge base writes (applied by scheduler)

## Module: `core/config.py`

Pipeline configuration.

```python
ALLOWED_EXTENSIONS_DEFAULT: set[str] = {
    ".md", ".txt", ".rst", ".yaml", ".yml", ".toml", ".json",
    ".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".go", ".java",
    ".c", ".cpp", ".h", ".cs", ".rb", ".swift", ".kt",
    ".sql", ".graphql", ".proto",
    ".sh", ".bash",
}

@dataclass
class PipelineConfig:
    pipeline_root: Path
    max_context_bytes: int = 3_355_443  # ~800K tokens
    allowed_extensions: set[str] = field(default_factory=lambda: ALLOWED_EXTENSIONS_DEFAULT.copy())
```

## Module: `core/filesystem.py`

Filesystem operations — folder moves and context manifest generation.

### ContextSizeExceededError (Exception)
```python
class ContextSizeExceededError(Exception):
    def __init__(self, total_bytes: int, max_bytes: int, file_count: int) -> None
    # Attributes: total_bytes, max_bytes, file_count
```

### Functions
```python
async def move_task(
    task_id: str, from_stage: str, to_stage: str,
    db: Any, config: PipelineConfig
) -> None
    # Move-first, commit-second. On DB failure: rolls folder back, re-raises.
    # Creates destination parent dir if needed.
    # Resets status to PENDING, stage_attempts to 0, updates entered_stage_at.
    # Logs stage_transition event.

def build_context_manifest(task_path: Path, config: PipelineConfig) -> Path
    # Hybrid allowlist (extensions) + denylist (.pipelineignore via pathspec).
    # Loads global .pipelineignore from pipeline_root + task-level from task_path.
    # Raises ContextSizeExceededError if total bytes exceed max_context_bytes.
    # Writes .context-manifest.txt (one relative path per line, posix format).
    # Returns path to the manifest file.
```

### Behavior Notes
- `move_task` accepts a `db` object duck-typed to have `transaction()`, `update_task_state()`, `log_event()` — i.e. import `core.db` as a module and pass it.
- `.pipelineignore` uses gitignore syntax, parsed by `pathspec` with `"gitignore"` pattern style.
- Manifest paths are relative to `task_path`, in posix format.

## Package Structure
```
orchestrator/
├── pyproject.toml
├── uv.lock
├── .python-version          # 3.12
├── core/
│   ├── __init__.py
│   ├── db.py                # 051
│   ├── config.py            # 052
│   └── filesystem.py        # 052
└── tests/
    ├── __init__.py
    ├── test_db.py            # 051 — 11 tests
    └── test_filesystem.py    # 052 — 7 tests
```

## Module: `core/config.py` — Full Config

```python
PIPELINE_STAGES: list[str] = [
    "TODO", "ARCHITECTING", "SPECKING", "EXECUTION", "REVIEW", "TESTING", "DONE"
]

@dataclass
class PipelineConfig:
    pipeline_root: Path
    max_context_bytes: int = 3_355_443
    allowed_extensions: set[str] = field(default_factory=...)  # see ALLOWED_EXTENSIONS_DEFAULT
    tick_interval_seconds: int = 10
    concurrency: dict[str, int] = field(default_factory=lambda: {
        "ARCHITECTING": 1, "SPECKING": 2, "EXECUTION": 3, "REVIEW": 1, "TESTING": 2,
    })
    sla_timeouts: dict[str, int] = field(default_factory=lambda: {
        "ARCHITECTING": 3600, "SPECKING": 1800, "EXECUTION": 14400, "REVIEW": 3600, "TESTING": 7200,
    })
    retry: dict[str, int] = field(default_factory=lambda: {
        "ARCHITECTING": 2, "SPECKING": 3, "EXECUTION": 4, "REVIEW": 2, "TESTING": 3,
    })
    max_lifetime_bounces: int = 8
```

## Module: `api/mcp.py`

MCP server using `FastMCP` from the Anthropic `mcp` SDK. Exposes exactly 6 tools — the complete agent↔orchestrator protocol.

### Server Setup
```python
mcp_server = FastMCP("orchestrator")

def set_config(config: PipelineConfig) -> None   # must be called before tools work
def _get_config() -> PipelineConfig               # raises RuntimeError if not set
def _append_to_agent_log(task_path: str, message: str) -> None  # appends timestamped line to AGENT.log
```

### Tools
```python
@mcp_server.tool()
async def orchestrator_claim_task(stage: str) -> dict
    # Fetches highest-priority PENDING task via db.fetch_pending(stage).
    # Returns {"status": "no_tasks"} if none.
    # Otherwise: sets status to WIP, builds context manifest, returns task info dict:
    #   {task_id, task_path, context_manifest, priority, complexity, stage_attempts}

@mcp_server.tool()
async def orchestrator_signal_done(task_id: str, notes: str = "") -> dict
    # Looks up current stage, finds next in PIPELINE_STAGES.
    # Calls filesystem.move_task(). Appends notes to AGENT.log if provided.
    # Returns {"ok": True}

@mcp_server.tool()
async def orchestrator_signal_back(task_id: str, target_stage: str, reason: str) -> dict
    # Increments lifetime_bounces. Appends reason to AGENT.log.
    # Calls filesystem.move_task() to target_stage.
    # Returns {"ok": True}

@mcp_server.tool()
async def orchestrator_signal_cancel(task_id: str, reason: str) -> dict
    # Writes CANCEL-REASON.md in task folder (task_id, timestamp, stage, reason).
    # Moves to CANCEL stage.
    # Returns {"ok": True}

@mcp_server.tool()
async def orchestrator_patch_priority(task_id: str, action: str, value: str, reason: str) -> dict
    # Inserts into priority_patches table (queued for scheduler to apply).
    # Returns {"ok": True, "queued": True}

@mcp_server.tool()
async def orchestrator_append_knowledge(section: str, content: str, task_id: str = "") -> dict
    # Inserts into knowledge_appends table (queued for scheduler to drain).
    # Returns {"ok": True, "queued": True}
```

### Entrypoint
```python
def run_stdio_server() -> None   # starts MCP over stdio transport
# Also: python -m api.mcp  (via api/__main__.py)
```

## Module: `core/db.py` — Additional Helpers (added in 053, 054)

```python
# 053 — MCP insert helpers
async def insert_priority_patch(
    task_id: str, action: str, value: str, reason: str, agent: str = "agent"
) -> None

async def insert_knowledge_append(
    section: str, content: str, agent: str = "agent", task_id: str | None = None
) -> None

# 054 — Scheduler/reconciler helpers
async def fetch_by_stage(stage: str) -> list[TaskRecord]
    # All tasks in a stage, ordered by priority ASC, created_at ASC.

async def fetch_unapplied_knowledge_appends() -> list[dict]
    # Returns dicts with keys: id, section, content, agent, task_id

async def mark_knowledge_applied(row_id: int) -> None

async def fetch_unapplied_priority_patches() -> list[dict]
    # Returns dicts with keys: id, task_id, action, value

async def mark_priority_patch_applied(row_id: int) -> None

async def fetch_wip_tasks() -> list[TaskRecord]
    # All WIP tasks across all stages, ordered by started_at ASC.
```

## Module: `core/reconciler.py`

Startup crash recovery. Runs once before the orchestrator accepts connections.

```python
async def reconcile(db: ModuleType, config: PipelineConfig) -> None
    # Scans all stage directories (PIPELINE_STAGES + COOKING + CANCEL).
    # Fixes 3 scenarios:
    #   1. Orphan folder (no DB record) → creates DB record
    #   2. Stage mismatch (DB stage != folder location) → updates DB to match filesystem
    #   3. Dead WIP (status=WIP but PID dead/None) → resets to PENDING, increments stage_attempts
    # Uses os.kill(pid, 0) to check PID liveness.
```

## Module: `core/priority.py`

Human-readable PRIORITY.md generator.

```python
async def regenerate_priority_files(db: ModuleType, config: PipelineConfig) -> None
    # For each stage (except DONE): queries all tasks via db.fetch_by_stage(),
    # writes markdown table to <stage>/PRIORITY.md.
    # Only writes if stage directory exists.
    # Uses aiofiles for async writes.
```

## Module: `core/scheduler.py`

The autonomous engine. Infinite async loop, one tick per `config.tick_interval_seconds`.

```python
_knowledge_lock = asyncio.Lock()  # serializes knowledge append file writes

async def orchestrator_loop(db: ModuleType, config: PipelineConfig) -> None
    # Each tick (in order):
    #   Step 1: _drain_knowledge_appends() — writes to KNOWLEDGE/ARCHITECTURE.md, marks applied
    #   Step 2: _drain_priority_patches() — applies set_priority/set_status, marks applied
    #   Step 3: _schedule_agents() — per stage: check concurrency, check DEPS.MD, spawn stub
    #   Step 4: _check_sla_timers() — timeout WIP tasks, requeue or FAIL based on retry config
    #   Step 5: regenerate_priority_files()
    # Catches all exceptions per tick (never crashes the loop).

# Internal helpers:
async def _drain_knowledge_appends(db, config) -> None
async def _drain_priority_patches(db) -> None
async def _schedule_agents(db, config) -> None
async def _check_sla_timers(db, config) -> None
async def _check_deps_met(task_path: str, db) -> bool
    # Parses DEPS.MD (YAML) from task folder. Returns True if all depends_on are DONE.
```

### Dependency Check Behavior
- Reads `DEPS.MD` from task folder (YAML format).
- Iterates subtask entries, checks each `depends_on` list.
- If any dependency task is not in DONE stage → returns False → task set to BLOCKED.
- Missing or unparseable DEPS.MD → returns True (no blocking).

## Module: `agents/base.py`

Real subprocess spawning. Fire-and-forget — does NOT await the process.

```python
async def spawn_agent(stage: str, task: TaskRecord, db: ModuleType, config: PipelineConfig) -> None
    # 1. Resolves agent config via STAGE_TO_AGENT[stage] → config.agents[name]
    # 2. Model escalation: if agent_config.model_escalation has entry for (stage_attempts+1), use it
    # 3. Builds prompt content, writes PROMPT.md to task folder
    # 4. Builds CLI command (claude-code only):
    #    ["claude", "--model", model, "--permission-mode", "bypassPermissions", "--output-format", "text", "-p", "-"]
    # 5. Injects env vars: PIPELINE_TASK_PATH, PIPELINE_TASK_ID, PIPELINE_MANIFEST, PIPELINE_TOKEN, PIPELINE_REPO_PATH
    #    For EXECUTION stage also: PIPELINE_STAGE_ATTEMPTS, PIPELINE_MODEL, PIPELINE_PROMPT_FILE, ORCHESTRATOR_API
    # 6. Spawns via asyncio.create_subprocess_exec:
    #    - stdin=PROMPT.md (piped), stdout/stderr → AGENT.log
    #    - cwd=repo_path (pipeline_root.parent)
    # 7. Updates DB: status=WIP, agent_pid, started_at, current_model
    # 8. Logs agent_spawned event

async def kill_agent(pid: int) -> None
    # SIGTERM → wait 5s → check alive → SIGKILL (Windows: taskkill /F fallback)
```

### Internal Helpers
```python
def _build_prompt_content(prompt_file: str, task: TaskRecord, manifest_path: str, repo_path: str) -> str
    # Reads prompt file, prepends task context (task_id, task_path, repo_path, manifest)

def _build_command_args(harness: str, model: str) -> list[str]
    # Returns CLI args for claude-code harness. Raises ValueError for unsupported harnesses.
```

## ~~Module: `agents/execution_wrapper.py`~~ — DELETED (061b)

> Removed: codex-cli bridge no longer needed. All agents use claude-code harness since 060.

## Module: `core/config.py` — AgentConfig + YAML Loading (055, 060)

```python
@dataclass
class AgentConfig:
    harness: str              # "claude-code" | "codex-cli" | "gemini-cli"
    model: str                # e.g. "claude-sonnet-4-6"
    prompt_file: str          # e.g. "orchestrator/prompts/architect.md"
    effort: str = "standard"  # "standard" | "high"
    thinking: str = ""        # "" | "extended"
    model_escalation: dict[int, str] = field(default_factory=dict)

STAGE_TO_AGENT: dict[str, str] = {
    "ARCHITECTING": "architect", "SPECKING": "spec",
    "EXECUTION": "execution", "REVIEW": "review", "TESTING": "testing",
}

# PipelineConfig.agents: dict[str, AgentConfig] — defaults for all 5 agent roles

def load_config(pipeline_root: Path) -> PipelineConfig
    # Loads pipeline.config.yaml from pipeline_root, merges with defaults.
    # Supports: scalar overrides (tick_interval_seconds, max_context_bytes, max_lifetime_bounces),
    #   dict merges (concurrency, sla_timeouts, retry),
    #   agent overrides (per-agent harness, model, prompt_file, effort, thinking, model_escalation).
    # Warns on unknown keys. Returns default config if file missing or empty.
```

## Module: `api/rest.py`

FastAPI REST API for the human-facing control plane. All endpoints use `core/db` and `core/filesystem`.

### Server Setup
```python
app = FastAPI(title="Pipeline Orchestrator API")

def set_config(config: PipelineConfig) -> None   # must be called before endpoints work
def _get_config() -> PipelineConfig               # raises RuntimeError if not set
```

### Endpoints
```python
GET  /health                        # {"status": "ok", "tasks_active": <count>}
GET  /tasks?stage=X&status=Y        # list of task dicts, filterable
GET  /tasks/{task_id}               # single task dict, 404 if missing
POST /tasks/{task_id}/cancel        # body: {"reason": "..."}, writes CANCEL-REASON.md, moves to CANCEL
POST /tasks/{task_id}/reprioritize  # body: {"priority": "P1|P2|P3"}, 400 on invalid
POST /tasks/{task_id}/retry         # resets FAILED/LOOP_DETECTED to PENDING, 400 if wrong status
POST /tasks/{task_id}/approve       # body: {"priority": "P2", "complexity": "M"}, moves COOKING→TODO
POST /tasks/{task_id}/signal-done   # body: {"notes": "..."}, advances to next pipeline stage
POST /tasks/{task_id}/signal-back   # body: {"target_stage": "...", "reason": "..."}, increments bounces
```

## Module: `cli.py`

Typer + Rich CLI that talks to the REST API via httpx.

```python
app = typer.Typer(name="pipeline")
API_BASE = "http://localhost:3000"

@app.command() def status()      # Rich table of all tasks
@app.command() def approve(task_id, priority="P2", complexity="M")
@app.command() def cancel(task_id, reason)
@app.command() def reprioritize(task_id, priority)
@app.command() def retry(task_id)
```

## Module: `main.py`

Typer entrypoint that starts REST API + MCP server + core loop concurrently.

```python
app = typer.Typer(name="orchestrator")

@app.command()
def serve(root, db_path="orchestrator/pipeline.db", rest_port=3000) -> None
    # asyncio.run(_serve(...))

async def _serve(root, db_path, rest_port) -> None
    # init_db, set_config for MCP+REST, reconcile, then asyncio.gather(uvicorn, orchestrator_loop)
```

## Module: `core/db.py` — Additional Helpers (added in 056)

```python
async def count_active_tasks() -> int
    # COUNT(*) WHERE status NOT IN ('DONE', 'CANCELLED')

async def fetch_all_tasks() -> list[TaskRecord]
    # All tasks ordered by priority ASC, created_at ASC
```

## Package Structure
```
orchestrator/
├── pyproject.toml
├── uv.lock
├── .python-version          # 3.12
├── main.py                  # 056 — typer CLI with serve command
├── cli.py                   # 056 — pipeline status/approve/cancel/retry commands
├── core/
│   ├── __init__.py
│   ├── db.py                # 051 + 053 + 054 + 056 (CRUD + insert helpers + fetch helpers + count/fetch_all)
│   ├── config.py            # 052 + 053 + 054 (PipelineConfig + PIPELINE_STAGES)
│   ├── filesystem.py        # 052
│   ├── reconciler.py        # 054
│   ├── priority.py          # 054
│   └── scheduler.py         # 054
├── agents/
│   ├── __init__.py          # 054
│   └── base.py              # 055+061 (subprocess spawning, stdin prompt, repo cwd)
├── api/
│   ├── __init__.py          # 053
│   ├── __main__.py          # 053
│   ├── mcp.py               # 053
│   └── rest.py              # 056 — FastAPI REST API
└── tests/
    ├── __init__.py
    ├── test_db.py            # 051 — 11 tests
    ├── test_filesystem.py    # 052 — 7 tests
    ├── test_mcp.py           # 053 — 7 tests
    ├── test_reconciler.py    # 054 — 3 tests
    ├── test_scheduler.py     # 054 — 7 tests
    ├── test_agents.py        # 055+061b — agent spawn tests (codex tests removed)
    ├── test_config.py        # 060 — YAML config loading tests
    ├── test_api.py           # 056 — 21 tests
    ├── test_cli.py           # 056 — 7 tests
    └── conftest.py           # 055 — autouse mock for create_subprocess_exec
```

## Test Count: ~70+ (all passing — verify with `cd orchestrator && uv run pytest -v`)
