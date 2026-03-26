# CODEBASE.md — 067a Relevant Surface

## Module: `api/mcp.py` — MCP Server (6 tools, FastMCP)

```python
from mcp.server.fastmcp import FastMCP

mcp_server = FastMCP("orchestrator")

_config: PipelineConfig | None = None

def set_config(config: PipelineConfig) -> None: ...
def _get_config() -> PipelineConfig: ...
def _append_to_agent_log(task_path: str, message: str) -> None: ...

@mcp_server.tool()
async def orchestrator_claim_task(stage: str) -> dict:
    """DELETE THIS — agents don't pull, orchestrator pushes."""

@mcp_server.tool()
async def orchestrator_signal_done(task_id: str, notes: str = "") -> dict:
    """Advance task to next stage. KEEP."""

@mcp_server.tool()
async def orchestrator_signal_back(task_id: str, target_stage: str, reason: str) -> dict:
    """Send task back. Increments lifetime_bounces. KEEP."""

@mcp_server.tool()
async def orchestrator_signal_cancel(task_id: str, reason: str) -> dict:
    """Cancel task, write CANCEL-REASON.md. KEEP."""

@mcp_server.tool()
async def orchestrator_patch_priority(task_id: str, action: str, value: str, reason: str) -> dict:
    """Queue priority change. KEEP."""

@mcp_server.tool()
async def orchestrator_append_knowledge(section: str, content: str, task_id: str = "") -> dict:
    """Queue knowledge append. KEEP."""

def run_stdio_server() -> None:
    """Start MCP over stdio. Currently the only transport. KEEP for backwards compat."""
    mcp_server.run(transport="stdio")
```

### FastMCP SSE Methods (available on mcp_server):
```python
mcp_server.run_sse_async()           # Coroutine — runs SSE server
mcp_server.sse_app()                 # Returns Starlette ASGI app for SSE
mcp_server.run_streamable_http_async()  # Alternative transport (not needed)
```

Use `sse_app()` to get an ASGI app, mount on uvicorn for port 3100.

---

## Module: `agents/base.py` — Agent Spawn

```python
def _resolve_claude_binary() -> str:
    """Finds claude CLI (handles Windows .cmd). Returns full path."""

def _build_command_args(harness: str, model: str) -> list[str]:
    """Returns CLI args for claude-code harness.
    Currently returns:
        [claude_binary, "--model", model, "--permission-mode", "bypassPermissions",
         "--output-format", "text", "-p", "-"]
    
    CHANGE NEEDED: Add "--mcp-config", str(mcp_config_path) before "-p", "-"
    """

async def spawn_agent(stage, task, db, config) -> None:
    """Spawns claude -p - with prompt via stdin.
    Steps: resolve model → build prompt → write PROMPT.md → build cmd → set env →
           chmod SPEC.md read-only → create_subprocess_exec → update DB
    
    CHANGE NEEDED: pass mcp_config_path to _build_command_args or add --mcp-config here.
    The mcp config file path should be config.pipeline_root / ".mcp-agent-config.json"
    """

async def kill_agent(pid: int) -> None:
    """SIGTERM → wait 5s → check alive → SIGKILL. No changes needed."""
```

---

## Module: `main.py` — Orchestrator Entry Point

```python
async def _serve(root, db_path, rest_port):
    config = load_config(Path(root))
    await db.init_db(db_path)
    mcp_set_config(config)
    rest_set_config(config)
    await reconcile(db, config)

    # REST server on :3000
    uvi_config = uvicorn.Config(rest_app, host="0.0.0.0", port=rest_port)
    server = uvicorn.Server(uvi_config)

    await asyncio.gather(
        server.serve(),              # REST :3000
        orchestrator_loop(db, config),
        # ADD: MCP SSE server on :3100
        # ADD: process exit monitor
    )
```

**CHANGE NEEDED:**
1. Write `.mcp-agent-config.json` to pipeline_root before starting
2. Add MCP SSE server (uvicorn with `mcp_server.sse_app()`) on :3100 to asyncio.gather
3. Add process exit monitor coroutine to asyncio.gather

---

## Module: `core/scheduler.py` — Core Loop (relevant for monitor)

```python
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

The process exit monitor should be a SEPARATE coroutine (not inside the tick loop) since it has its own polling interval (15s).

---

## Prompt Files (all 5, need claim_task removal)

Located at `orchestrator/prompts/`:
- `architect.md` — line ~6: "Call `orchestrator_claim_task("ARCHITECTING")`"
- `spec.md` — line ~6: "Call `orchestrator_claim_task("SPECKING")`"
- `execution.md` — line ~4: references startup sequence with task assignment
- `review.md` — line ~6: "Call `orchestrator_claim_task("REVIEW")`"
- `testing.md` — line ~6: "Call `orchestrator_claim_task("TESTING")`"

Each prompt's "Startup Sequence" section needs rewriting to remove claim_task and state that the task is pre-assigned.

---

## Existing Tests

- `tests/test_mcp.py` — 7 tests, includes claim_task tests that need removal
- `tests/test_agents.py` — 7 tests, uses mocked subprocess. Will need update for --mcp-config in cmd args
- `tests/conftest.py` — autouse mock for create_subprocess_exec (pid=99999)

---

## Claude Code CLI Flags (relevant)

```
--mcp-config <configs...>    Load MCP servers from JSON files or strings (space-separated)
--strict-mcp-config          Only use MCP servers from --mcp-config, ignoring all other MCP configurations
-p, --print <prompt>         Non-interactive mode, reads prompt
-p -                         Non-interactive mode, reads prompt from stdin
```

Use `--mcp-config path/to/.mcp-agent-config.json` to load the SSE connection.

### MCP Config JSON Format for SSE

```json
{
  "mcpServers": {
    "orchestrator": {
      "url": "http://localhost:3100/sse"
    }
  }
}
```

**Note:** The exact SSE endpoint path depends on what `sse_app()` exposes. Common paths: `/sse`, `/mcp/sse`, or just `/`. Check the Starlette routes in the returned app.

---

## Python Dependencies (already installed)

- `mcp` — includes `mcp.server.fastmcp.FastMCP`, `mcp.server.sse.SseServerTransport`
- `uvicorn` — ASGI server (already used for REST)
- `starlette` — dependency of FastAPI (ASGI framework)
