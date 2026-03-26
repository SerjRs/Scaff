# Task 068: End-to-End Integration Test Suite (Real Agents)

## STATUS: COOKING

## Priority: P1
## Complexity: M

## Objective

Build an integration test suite that spins up the full orchestrator infrastructure, pushes a trivially simple dummy task through the entire pipeline (TODO → ARCHITECTING → SPECKING → EXECUTION → REVIEW → TESTING → DONE), using **real Claude Code agents running Haiku** at every stage. This validates the complete system: prompt delivery, MCP SSE return channel, agent tool calls, scheduler, monitor, filesystem moves, PIPELINE.log, and API endpoints.

## Background

The orchestrator has 120+ unit tests — all mock at least one integration boundary. There is zero coverage of the system running with real agents. Key risks:

1. **Prompt→Agent→MCP loop untested** — agents receive prompts via stdin and signal back via MCP SSE tools, but no test proves this works
2. **Wiring bugs** — components work in isolation but fail when composed
3. **Agent comprehension** — do the prompts actually guide agents to call the right MCP tools?
4. **State machine gaps** — a task moving through all 7 stages may hit edge cases no unit test covers

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Test Runner (pytest)                                     │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ REST Client  │  │ Webhook      │  │ Assertions &   │  │
│  │ (httpx)      │  │ Collector    │  │ Wait Helpers   │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────────┘  │
│         │                 │                               │
│  ───────┼─────────────────┼───────── async boundary ──── │
│         │                 │                               │
│  ┌──────▼─────────────────▼──────────────────────────┐   │
│  │  Orchestrator (in-process)                         │   │
│  │  ┌─────────┐ ┌─────────┐ ┌──────┐ ┌────────┐     │   │
│  │  │ REST API│ │ MCP SSE │ │Sched.│ │Monitor │     │   │
│  │  │ :REST_P │ │ :SSE_P  │ │ loop │ │ loop   │     │   │
│  │  └────┬────┘ └────┬────┘ └──┬───┘ └───┬────┘     │   │
│  │       │           │         │          │          │   │
│  │       │     ┌─────▼────┐    │          │          │   │
│  │       │     │ Real     │    │          │          │   │
│  │       │     │ Claude   │◄───┘ (spawn)  │          │   │
│  │       │     │ Code     │               │          │   │
│  │       │     │ (Haiku)  │               │          │   │
│  │       │     └──────────┘               │          │   │
│  │       └─────┬───────────────┬──────────┘          │   │
│  │         ┌───▼───┐      ┌───▼──────────────────┐   │   │
│  │         │ SQLite│      │ Pipeline FS + Git    │   │   │
│  │         │ (temp)│      │ (tmp_path)           │   │   │
│  │         └───────┘      └──────────────────────┘   │   │
│  └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Real Claude Code agents with Haiku** — No mocked subprocess. Actual `claude` CLI processes spawned by the scheduler, reading prompts via stdin, connecting to MCP SSE, calling `orchestrator_signal_done`. Haiku is cheap (~$0.01/task) and fast (~10-30s per stage).

2. **Trivially simple dummy task** — The task is deliberately brain-dead simple so agents can complete every stage in seconds:
   - SPEC: "Create a file called `hello.txt` containing `Hello, World!`"
   - This is simple enough for Haiku to architect, spec, execute, review, and test without confusion

3. **In-process orchestrator** — REST + MCP SSE + scheduler as async tasks within the test process. Gives us deterministic startup/shutdown and direct DB access for assertions.

4. **Temporary git repo** — Initialize a fresh git repo in `tmp_path` so branch discipline (067c) works: feature branch creation, merge on TESTING→DONE.

5. **Dynamic ports** — OS-assigned ports for REST and SSE to avoid collisions.

6. **Generous timeouts** — Each stage gets up to 120s (Haiku is fast but API latency varies). Full suite target: < 10 minutes.

7. **No conftest mock** — The E2E test must **opt out** of the `conftest.py` `mock_subprocess_exec` fixture. Use a marker or separate conftest to disable it.

## Scope

### Test File: `tests/test_e2e.py`

### The Dummy Task

```
pipeline/COOKING/e2e-dummy-001/SPEC.md
```

```markdown
# Task: e2e-dummy-001 — Hello World

## Objective
Create a file called `hello.txt` in the repository root containing exactly `Hello, World!`.

## Acceptance Criteria
- [ ] File `hello.txt` exists in the repository root
- [ ] File contains exactly: `Hello, World!`
- [ ] No other files modified
```

This is intentionally trivial. Every agent stage should handle it in seconds:
- **Architect**: Read spec, produce a one-line architecture note
- **Spec**: Read spec, confirm it's already detailed enough
- **Execution**: Create `hello.txt` with the content
- **Review**: Verify `hello.txt` exists and has correct content
- **Testing**: Run a check (or just verify file), write TEST-RESULTS.md, COMPLETION.md

### Pipeline Config Override

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
notifications:
  enabled: true
  webhook_url: "http://localhost:{webhook_port}/hook"
  events:
    - task_failed
    - sla_timeout
    - loop_detected
    - agent_crashed
```

### Fixture: `e2e_orchestrator`

Session-scoped async fixture that:
1. Creates `tmp_path` with:
   - `repo/` — initialized git repo (`git init`, initial commit)
   - `repo/pipeline/` — stage directories (COOKING, TODO, ARCHITECTING, SPECKING, EXECUTION, REVIEW, TESTING, DONE)
   - `repo/pipeline/KNOWLEDGE/` — minimal ARCHITECTURE.md, TECH-STACK.md, CONVENTIONS.md
   - `repo/pipeline/COOKING/e2e-dummy-001/SPEC.md` — the dummy task
   - `repo/pipeline/pipeline.config.yaml` — Haiku config
2. Initializes SQLite DB
3. Starts orchestrator (REST + MCP SSE + scheduler + monitor)
4. Starts webhook collector server
5. Yields `(config, rest_url, sse_url, db, webhook_collector)` to tests
6. On teardown: cancels all tasks, closes DB, cleans up

### Fixture: `webhook_collector`

Lightweight async HTTP server collecting POST payloads:

```python
class WebhookCollector:
    payloads: list[dict] = []
    
    def find(self, event: str) -> list[dict]:
        return [p for p in self.payloads if p.get("event") == event]
```

---

### Test Suite

#### 1. Infrastructure Smoke

**`test_health_endpoint`**
- GET /health → 200, `{"status": "ok"}`

**`test_tasks_initially_empty`**
- GET /tasks → 200, `[]` (before approve)

#### 2. Full Lifecycle: Real Agent Happy Path

**`test_full_lifecycle_with_real_agents`**

The main test. Approves the dummy task and watches it flow through every stage with real Haiku agents:

```
Step 1:  POST /tasks/e2e-dummy-001/approve
Step 2:  Wait for stage=TODO, status=PENDING
Step 3:  Wait for stage=ARCHITECTING, status=WIP (agent spawned)
Step 4:  Wait for stage=SPECKING (agent called signal_done)
         Assert: PIPELINE.log has stage_transition ARCHITECTING→SPECKING
Step 5:  Wait for stage=SPECKING, status=WIP
Step 6:  Wait for stage=EXECUTION
         Assert: PIPELINE.log has SPECKING→EXECUTION
Step 7:  Wait for stage=EXECUTION, status=WIP
         Assert: feature/e2e-dummy-001 branch exists (git branch --list)
Step 8:  Wait for stage=REVIEW
         Assert: hello.txt exists in repo
Step 9:  Wait for stage=REVIEW, status=WIP
Step 10: Wait for stage=TESTING
Step 11: Wait for stage=TESTING, status=WIP
Step 12: Wait for stage=DONE
         Assert: feature/e2e-dummy-001 merged to main
         Assert: hello.txt on main branch
         Assert: COMPLETION.md exists in task folder
```

Timeout: 10 minutes total (generous — expect ~2-5 min).

After completion, verify:
- GET /tasks/e2e-dummy-001 → stage=DONE
- PIPELINE.log has entries for all transitions + all agent spawns
- `hello.txt` contains "Hello, World!" on main branch
- Git log shows feature branch merge commit

#### 3. API Endpoint Tests (run against live orchestrator)

**`test_get_task_by_id`**
- After approve: GET /tasks/e2e-dummy-001 → 200 with correct fields

**`test_list_tasks_by_stage`**
- GET /tasks?stage=DONE → includes e2e-dummy-001 (after lifecycle completes)

**`test_get_nonexistent_task_404`**
- GET /tasks/nonexistent → 404

**`test_reprioritize_invalid_400`**
- POST /tasks/e2e-dummy-001/reprioritize {priority: "P99"} → 400

**`test_retry_non_failed_400`**
- POST /tasks/e2e-dummy-001/retry → 400 (task is DONE, not FAILED)

#### 4. Signal Back / Bounce Test

**`test_signal_back_creates_bounce`**

Second dummy task (`e2e-dummy-002`) with a SPEC designed to trigger a review bounce:

```markdown
# Task: e2e-dummy-002 — Intentional Bounce

## Objective
Create `bounce.txt` containing `fixed`. 

## Review Criteria
The REVIEW agent MUST send this task back to EXECUTION with reason 
"needs improvement" on the first review. On second review, pass it.
```

- Approve task, wait for REVIEW stage
- Assert: signal_back sends task to EXECUTION
- Assert: lifetime_bounces incremented
- Wait for REVIEW again, then TESTING, then DONE
- Assert: lifetime_bounces = 1 in final state

*(Note: this test depends on Haiku following the "send back on first review" instruction. If unreliable, can be made optional/skipped.)*

#### 5. Cancel Test

**`test_cancel_task`**
- Approve `e2e-dummy-003`, wait for it to reach ARCHITECTING
- POST /tasks/e2e-dummy-003/cancel {reason: "e2e test cancel"}
- Assert: CANCEL-REASON.md written with `triggered_by: human`
- Assert: task not in active stages

#### 6. PIPELINE.log Completeness

**`test_pipeline_log_valid_json_lines`**
- After lifecycle test: read PIPELINE.log
- Parse each line as JSON
- Assert every line has `ts`, `event`, `task_id`
- Assert at least these events present: `stage_transition`, `agent_spawned`

---

## Implementation Notes

### Opting Out of conftest Mock

The existing `conftest.py` has an `autouse=True` fixture that mocks `create_subprocess_exec`. E2E tests need real subprocesses. Options:

**Option A: Marker-based skip**
```python
# conftest.py — update existing fixture
@pytest.fixture(autouse=True)
def mock_subprocess_exec(request, monkeypatch, tmp_path):
    if "e2e" in request.node.keywords:
        yield None  # Don't mock for E2E tests
        return
    # ... existing mock logic ...
```

**Option B: Separate conftest in e2e directory**
```
tests/
  conftest.py          # existing — mocks subprocess
  test_*.py            # existing unit tests
  e2e/
    conftest.py        # overrides — no mock
    test_e2e.py
```

Recommend Option B — cleaner separation.

### Wait Helpers

```python
async def wait_for_stage(client, task_id, stage, timeout=120):
    """Poll until task reaches expected stage."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        resp = await client.get(f"/tasks/{task_id}")
        if resp.status_code == 200:
            task = resp.json()
            if task["stage"] == stage:
                return task
        await asyncio.sleep(2)
    raise TimeoutError(f"{task_id} did not reach {stage} within {timeout}s")

async def wait_for_status(client, task_id, status, timeout=120):
    """Poll until task reaches expected status."""
    ...
```

### Port Allocation

```python
def get_free_port():
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]
```

### Git Repo Setup

```python
async def init_test_repo(repo_path):
    """Initialize a git repo with an initial commit."""
    await run("git", "init", cwd=repo_path)
    await run("git", "config", "user.email", "test@test.com", cwd=repo_path)
    await run("git", "config", "user.name", "Test", cwd=repo_path)
    # Create initial file so we have a commit
    (repo_path / "README.md").write_text("# E2E Test Repo\n")
    await run("git", "add", ".", cwd=repo_path)
    await run("git", "commit", "-m", "initial", cwd=repo_path)
```

### Cost Estimate

- 5 stages × ~500 tokens input + ~200 tokens output per agent = ~3,500 tokens
- Haiku pricing: ~$0.001/1K tokens
- **~$0.004 per full test run** — essentially free

## Acceptance Criteria

- [ ] Orchestrator starts cleanly with real ports and temp DB
- [ ] Real Claude Code (Haiku) agents spawn at each stage
- [ ] Agents read prompts, connect via MCP SSE, call signal_done
- [ ] Dummy task completes the full lifecycle: TODO → DONE
- [ ] `hello.txt` exists on main branch after completion
- [ ] Feature branch created during EXECUTION, merged during TESTING→DONE
- [ ] PIPELINE.log has complete audit trail
- [ ] API endpoints return correct responses
- [ ] Cancel test produces CANCEL-REASON.md with triggered_by
- [ ] All 120+ existing unit tests still pass (E2E tests don't interfere)
- [ ] E2E suite completes in < 10 minutes
- [ ] Tests work on Windows (Python 3.12+)

## Dependencies

- 067a–067j (all merged)
- Claude Code CLI installed and authenticated
- Anthropic API key with Haiku access

## Out of Scope

- Testing agent failure recovery (SLA timeout with real agents — too slow/expensive)
- Loop detection with real agents (would need agent that deliberately bounces)
- Performance testing
- MCP SSE client library tests
- Dashboard (066)
