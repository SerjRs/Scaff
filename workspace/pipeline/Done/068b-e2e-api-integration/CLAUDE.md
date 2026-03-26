# Claude Code Instructions — 068b

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/068b-e2e-api-integration` from main.
2. Commit frequently with format: `[068b] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. File Location
`tests/test_api_integration.py` — in the main `tests/` directory, NOT in `tests/e2e/`.

This ensures the parent `conftest.py` mock is active — agents are faked. Tests are fast and deterministic.

### 2. Orchestrator Fixture: `live_orchestrator`
Similar pattern to the E2E fixture but simpler:
- Create temp dir with pipeline stage dirs (COOKING, TODO, ARCHITECTING, SPECKING, EXECUTION, REVIEW, TESTING, DONE, CANCEL)
- Create dummy task folders in COOKING with SPEC.md
- Init real SQLite DB
- Set config on REST + MCP modules
- Run reconciler
- Start REST + MCP SSE + scheduler + monitor as `asyncio.create_task()`
- Use `get_free_port()` for servers — never hardcode
- Wait for health endpoint to respond
- Yield `(config, rest_url, db)`
- Teardown: cancel tasks, close DB

### 3. No Git Repo Needed
Since agents are mocked, no git operations happen. No need for `git init`.

### 4. Wait Helpers
```python
async def wait_for_stage(client, task_id, stage, timeout=30):
async def wait_for_status(client, task_id, status, timeout=30):
```
Short timeouts (30s) since scheduler tick is 2s and agents are instant (mocked).

### 5. Test Independence
Each test should work independently. Use the shared `live_orchestrator` fixture but create separate tasks if needed to avoid state bleeding. Use unique task IDs per test.

### 6. DB Direct Access
The fixture yields the `db` module — use it for setup/assertions that are awkward via REST:
- Setting status=FAILED directly for retry tests
- Checking field values not exposed by API

### 7. Dynamic Ports
```python
import socket
def get_free_port():
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]
```

### 8. Cleanup Between Tests
If using a module-scoped fixture (one orchestrator for all tests), be careful about state. Either:
- Use unique task IDs per test (recommended)
- Or use function-scoped fixture (slower but cleaner)

Recommend: session-scoped fixture + unique task IDs.

## Do NOT Modify
- Existing test files
- Production code (core/, api/, agents/)
- `tests/conftest.py`

## Tests
- Run integration tests: `cd orchestrator && uv run pytest tests/test_api_integration.py -v`
- Run all unit tests: `cd orchestrator && uv run pytest tests/ --ignore=tests/e2e/ -v`
- Both must pass

## Important
- The mock subprocess means agents "spawn" instantly (DB → WIP, pid=99999) but never actually do work
- To advance stages, use REST signal-done endpoint (simulating what a real agent would do via MCP)
- The scheduler runs in the background — `wait_for_stage` accounts for tick delay
- On Windows: use `127.0.0.1` for server binding

## Execution
Do NOT ask questions. Execute the full task end-to-end.
