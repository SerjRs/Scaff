# Claude Code Instructions — 068

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/068-e2e-test-suite` from main.
2. Commit frequently with format: `[068] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. Test Directory Structure
Create `tests/e2e/` with its own `conftest.py` that does NOT mock `create_subprocess_exec`. This isolates E2E tests from unit tests.

```
tests/
  conftest.py           # existing — mocks subprocess (autouse)
  e2e/
    __init__.py
    conftest.py         # E2E — NO subprocess mock, real agents
    test_e2e.py         # the E2E test suite
```

The E2E `conftest.py` must override/disable the parent's `mock_subprocess_exec` fixture.

### 2. E2E conftest.py — Orchestrator Fixture

The main fixture `e2e_orchestrator` must:
1. Create a temp directory with:
   - A git repo (`git init` + initial commit + `user.email`/`user.name` config)
   - `pipeline/` inside the repo with all stage directories
   - `pipeline/KNOWLEDGE/` with minimal files (ARCHITECTURE.md, TECH-STACK.md, CONVENTIONS.md)
   - `pipeline/COOKING/e2e-dummy-001/SPEC.md` — the trivial task
   - `pipeline/pipeline.config.yaml` — Haiku model for all agents, fast tick
   - `pipeline/.pipelineignore` — basic excludes
2. Initialize SQLite DB at a temp path
3. Set configs on REST + MCP modules
4. Run reconciler
5. Write `.mcp-agent-config.json`
6. Start REST API + MCP SSE + scheduler loop + monitor as `asyncio.create_task()`
7. Wait for servers to be ready (poll health endpoint)
8. Yield everything tests need: `(config, rest_url, sse_url, db_module, tmp_path, webhook_collector)`
9. On teardown: cancel all async tasks, close DB, cleanup

### 3. Dynamic Ports
Use `socket.bind(("", 0))` to get free ports for REST and SSE servers. Never hardcode 3000/3100 in tests.

### 4. Webhook Collector
A lightweight async HTTP server on a free port that stores received POST payloads in a list. Start it as part of the fixture. Tests assert against `webhook_collector.find("event_name")`.

### 5. The Dummy Task SPEC.md

```markdown
# Task: e2e-dummy-001

## Objective
Create a file called `hello.txt` in the repository root containing exactly `Hello, World!`.

## Acceptance Criteria
- [ ] File `hello.txt` exists in the repository root
- [ ] File contains exactly the text: Hello, World!
- [ ] No other files modified beyond what's needed for the pipeline
```

This must be simple enough that Haiku completes every stage in 10-30 seconds.

### 6. Wait Helpers
Implement polling helpers:
- `wait_for_stage(client, task_id, stage, timeout=120)` — polls GET /tasks/{id} until stage matches
- `wait_for_status(client, task_id, status, timeout=120)` — polls until status matches
- Poll interval: 2 seconds
- Raise `TimeoutError` with clear message on failure

### 7. Main Lifecycle Test
`test_full_lifecycle_with_real_agents`:
1. POST /tasks/e2e-dummy-001/approve
2. Wait for each stage transition: TODO → ARCH → SPEC → EXEC → REVIEW → TEST → DONE
3. At each stage, wait for WIP (agent spawned) then wait for next stage (agent called signal_done)
4. After DONE: verify `hello.txt` on main branch, PIPELINE.log completeness, task in DB as DONE
5. Total timeout: 10 minutes

### 8. API Tests
Run basic API tests against the live orchestrator:
- GET /health → 200
- GET /tasks → includes the task
- GET /tasks/{id} → correct fields
- GET /tasks/nonexistent → 404
- POST reprioritize with invalid priority → 400

### 9. Cancel Test
Approve a second task `e2e-dummy-002`, wait for it to reach ARCHITECTING (WIP), then cancel it. Verify CANCEL-REASON.md has `triggered_by: human`.

### 10. PIPELINE.log Verification
After lifecycle test, read and parse PIPELINE.log. Each line must be valid JSON with `ts`, `event`, `task_id`. Assert `stage_transition` and `agent_spawned` events are present.

### 11. Config for Tests

```yaml
tick_interval_seconds: 3
max_lifetime_bounces: 3
concurrency:
  ARCHITECTING: 1
  SPECKING: 1
  EXECUTION: 1
  REVIEW: 1
  TESTING: 1
agents:
  architect:
    model: claude-haiku-4-5
  spec:
    model: claude-haiku-4-5
  execution:
    model: claude-haiku-4-5
  review:
    model: claude-haiku-4-5
  testing:
    model: claude-haiku-4-5
```

### 12. Disabling Parent conftest Mock

The parent `conftest.py` has `autouse=True` on `mock_subprocess_exec`. To disable it for E2E:

**Option A** — In `tests/e2e/conftest.py`, override the fixture:
```python
@pytest.fixture(autouse=True)
def mock_subprocess_exec():
    """Override parent fixture — do NOT mock subprocess for E2E tests."""
    yield None
```

**Option B** — Modify parent `conftest.py` to check for a marker:
```python
@pytest.fixture(autouse=True)
def mock_subprocess_exec(request, monkeypatch, tmp_path):
    if "e2e" in request.node.keywords or "e2e" in str(request.node.fspath):
        yield None
        return
    # ... existing mock ...
```

Prefer Option A if it works. Option B as fallback. Test by running `uv run pytest tests/e2e/ -v` and verifying no mock is active.

## Do NOT Modify
- Existing test files (test_agents.py, test_api.py, etc.) — don't touch unit tests
- Production code — no changes to core/, api/, agents/

## Tests
- Run E2E tests: `cd orchestrator && uv run pytest tests/e2e/ -v --timeout=600`
- Run existing unit tests: `cd orchestrator && uv run pytest tests/ --ignore=tests/e2e/ -v`
- Both must pass independently

## Important
- Claude Code CLI must be available in PATH (it is: `claude.cmd` via npm)
- Anthropic API key must be set (it is: via environment)
- Haiku is cheap (~$0.004/run) but needs network access
- Git operations are REAL (in temp dir) — branch creation, merges
- Agent subprocess is REAL — actual `claude` process spawned
- Each stage agent needs 10-120 seconds — use generous timeouts
- If a stage agent fails/times out, the test should fail with a clear message showing which stage and what the agent output was (check AGENT.log in task folder)
- On Windows: be careful with path separators and process cleanup

## Execution
Do NOT ask questions. Execute the full task end-to-end.
