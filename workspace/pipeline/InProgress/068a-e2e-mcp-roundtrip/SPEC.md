# Task 068a: E2E Test — MCP SSE Round-Trip

## STATUS: COOKING

## Priority: P1
## Complexity: S

## Objective

Write a single E2E test that spins up the full orchestrator, approves a trivially simple dummy task, and watches a **real Claude Code agent (Haiku)** receive the prompt, connect to MCP SSE, and call `orchestrator_signal_done` — advancing the task from ARCHITECTING to SPECKING. This proves the entire two-channel design works: stdin prompt delivery → agent comprehension → MCP SSE connection → tool invocation → state transition.

## Background

The orchestrator has 120+ unit tests, all mocking at least one boundary. Zero tests prove that a real agent can connect to the MCP SSE endpoint and call tools. This is the most critical untested path.

## Architecture

```
pytest process
  │
  ├── Orchestrator (in-process, async tasks)
  │     ├── REST API (:random_port)
  │     ├── MCP SSE  (:random_port)
  │     ├── Scheduler loop (tick=3s)
  │     └── Monitor loop
  │
  ├── Real Claude Code (Haiku) — spawned by scheduler
  │     ├── Reads prompt via stdin
  │     ├── Connects to MCP SSE
  │     └── Calls orchestrator_signal_done
  │
  └── Assertions (httpx client)
        └── Polls GET /tasks/{id} until stage=SPECKING
```

## Scope

### Directory: `tests/e2e/`

### Files to Create

1. `tests/e2e/__init__.py` — empty
2. `tests/e2e/conftest.py` — orchestrator fixture, disables parent subprocess mock
3. `tests/e2e/test_mcp_roundtrip.py` — the test

### Fixture: `e2e_orchestrator` (in conftest.py)

1. Create temp directory with:
   - Git repo (`git init` + initial commit + user.email/user.name config)
   - `pipeline/` with all stage dirs (COOKING, TODO, ARCHITECTING, SPECKING, EXECUTION, REVIEW, TESTING, DONE)
   - `pipeline/KNOWLEDGE/ARCHITECTURE.md` — minimal content ("# Architecture\nsdlc-fabric orchestrator")
   - `pipeline/KNOWLEDGE/TECH-STACK.md` — minimal ("# Tech Stack\nPython 3.12, FastAPI, SQLite")
   - `pipeline/KNOWLEDGE/CONVENTIONS.md` — minimal ("# Conventions\nsnake_case everywhere")
   - `pipeline/.pipelineignore` — basic excludes (`__pycache__/`, `.venv/`, `*.log`, `*.pyc`)
   - `pipeline/COOKING/e2e-dummy-001/SPEC.md` — the dummy task (see below)
   - `pipeline/pipeline.config.yaml` — Haiku config (see below)
2. Init SQLite DB at temp path
3. Set config on REST + MCP modules
4. Run reconciler
5. Write `.mcp-agent-config.json` (using dynamic SSE port)
6. Start REST + MCP SSE + scheduler + monitor as `asyncio.create_task()`
7. Wait for REST health endpoint to respond
8. Yield `(config, rest_base_url, db_module)`
9. Teardown: cancel all tasks, close DB

### The Dummy Task

`pipeline/COOKING/e2e-dummy-001/SPEC.md`:
```markdown
# Task: e2e-dummy-001

## Objective
Create a file called `hello.txt` in the repository root containing exactly `Hello, World!`.

## Acceptance Criteria
- [ ] File `hello.txt` exists in the repository root
- [ ] File contains exactly: Hello, World!
```

### Pipeline Config

```yaml
tick_interval_seconds: 3
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

### The Test: `test_mcp_roundtrip`

```python
@pytest.mark.asyncio
@pytest.mark.timeout(300)  # 5 minutes max
async def test_agent_signals_done_via_mcp(e2e_orchestrator):
    config, rest_url, db = e2e_orchestrator

    async with httpx.AsyncClient(base_url=rest_url) as client:
        # 1. Approve the task
        resp = await client.post("/tasks/e2e-dummy-001/approve",
                                  json={"priority": "P1", "complexity": "S"})
        assert resp.status_code == 200

        # 2. Wait for task to reach ARCHITECTING + WIP (agent spawned)
        task = await wait_for_status(client, "e2e-dummy-001", "WIP", timeout=30)
        assert task["stage"] == "ARCHITECTING"

        # 3. Wait for task to advance past ARCHITECTING (agent called signal_done)
        task = await wait_for_stage(client, "e2e-dummy-001", "SPECKING", timeout=120)
        assert task["status"] == "PENDING"  # just arrived, not yet spawned

    # 4. Verify PIPELINE.log has the transition
    log_path = config.pipeline_root / "PIPELINE.log"
    assert log_path.exists()
    lines = log_path.read_text().strip().split("\n")
    events = [json.loads(line) for line in lines]
    assert any(e["event"] == "agent_spawned" and e["task_id"] == "e2e-dummy-001" for e in events)
    assert any(e["event"] == "stage_transition" and e.get("to_stage") == "SPECKING" for e in events)
```

### Disabling Parent conftest Mock

In `tests/e2e/conftest.py`:
```python
@pytest.fixture(autouse=True)
def mock_subprocess_exec():
    """Override parent — do NOT mock subprocess for E2E tests."""
    yield None
```

### Dynamic Ports

```python
def get_free_port():
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]
```

Use for both REST and SSE servers. Write the SSE port into `.mcp-agent-config.json`.

### Wait Helpers

```python
async def wait_for_stage(client, task_id, stage, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        resp = await client.get(f"/tasks/{task_id}")
        if resp.status_code == 200 and resp.json()["stage"] == stage:
            return resp.json()
        await asyncio.sleep(2)
    raise TimeoutError(f"{task_id} did not reach stage {stage} within {timeout}s")

async def wait_for_status(client, task_id, status, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        resp = await client.get(f"/tasks/{task_id}")
        if resp.status_code == 200 and resp.json()["status"] == status:
            return resp.json()
        await asyncio.sleep(2)
    raise TimeoutError(f"{task_id} did not reach status {status} within {timeout}s")
```

## Acceptance Criteria

- [ ] Test spins up orchestrator with real ports and temp DB
- [ ] Real Claude Code (Haiku) agent spawns for ARCHITECTING stage
- [ ] Agent connects to MCP SSE and calls `orchestrator_signal_done`
- [ ] Task advances from ARCHITECTING to SPECKING
- [ ] PIPELINE.log has agent_spawned and stage_transition entries
- [ ] Test completes in < 5 minutes
- [ ] All 120+ existing unit tests still pass
- [ ] Works on Windows (Python 3.12+)

## Dependencies

- 067a–067j (all merged)
- Claude Code CLI installed and authenticated
- Anthropic API key with Haiku access

## Out of Scope

- Testing all 5 stages (one is enough to prove MCP works)
- API edge cases (that's 068b)
- Notification webhook testing (068b)
- Full lifecycle (unnecessary — same mechanism for all stages)
