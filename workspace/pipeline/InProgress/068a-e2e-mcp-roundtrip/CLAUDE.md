# Claude Code Instructions — 068a

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/068a-e2e-mcp-roundtrip` from main.
2. Commit frequently with format: `[068a] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. Create `tests/e2e/` Directory
```
tests/e2e/
  __init__.py       # empty
  conftest.py       # orchestrator fixture + subprocess mock override
  test_mcp_roundtrip.py  # the test
```

### 2. Override Parent Subprocess Mock
The parent `tests/conftest.py` has `autouse=True` mock on `create_subprocess_exec`. The E2E conftest MUST override it:

```python
@pytest.fixture(autouse=True)
def mock_subprocess_exec():
    """Override parent — real subprocess for E2E tests."""
    yield None
```

### 3. Orchestrator Fixture
The `e2e_orchestrator` fixture must:
- Create temp dir with git repo, pipeline dirs, knowledge files, dummy task, config YAML
- Use `get_free_port()` for REST and SSE — never hardcode ports
- Write `.mcp-agent-config.json` with the dynamic SSE port
- Start servers via `asyncio.create_task()` on uvicorn
- Wait for health endpoint before yielding
- Cancel all tasks + close DB on teardown

### 4. Critical: Dynamic MCP Config
The `.mcp-agent-config.json` must use the dynamic SSE port:
```python
config_data = {"mcpServers": {"orchestrator": {"url": f"http://localhost:{sse_port}/sse"}}}
```
Without this, agents can't connect back to the MCP server.

### 5. The Test
One test: `test_agent_signals_done_via_mcp`
- POST /tasks/e2e-dummy-001/approve
- Wait for WIP in ARCHITECTING (agent spawned)
- Wait for stage=SPECKING (agent called signal_done via MCP)
- Verify PIPELINE.log entries
- 5 minute timeout

### 6. pytest-timeout
Add `pytest-timeout` to dev dependencies in pyproject.toml if not already present. Use `@pytest.mark.timeout(300)` on the test.

## Do NOT Modify
- Existing test files (test_*.py in tests/)
- Production code (core/, api/, agents/)
- `tests/conftest.py` — do NOT edit the parent conftest, override in e2e/conftest.py

## Tests — YOU MUST RUN THESE
- Run E2E test: `cd orchestrator && uv run pytest tests/e2e/ -v -s --timeout=300`
  This spawns a REAL Haiku agent — it costs ~$0.001 and takes 1-3 minutes. RUN IT.
- Run unit tests: `cd orchestrator && uv run pytest tests/ --ignore=tests/e2e/ -v`
- Both must pass. If the E2E test fails, debug and fix it. Do not skip it.

## Important
- `claude` CLI must be in PATH (it is: `claude.cmd` via npm)
- Agent needs real network access to Anthropic API
- Use `127.0.0.1` not `0.0.0.0` for test servers
- Git repo needs user.email and user.name configured or commits fail
- On Windows: use `asyncio.create_subprocess_exec` for git commands, handle path separators
- If agent fails, check `AGENT.log` in the task folder for debugging
- The test is intentionally small — one stage, one agent, one assertion chain

## Execution
Do NOT ask questions. Execute the full task end-to-end.
