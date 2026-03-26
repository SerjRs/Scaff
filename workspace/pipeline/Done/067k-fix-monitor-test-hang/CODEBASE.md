# CODEBASE.md — 067k Relevant Surface

## Module: `core/monitor.py` (production code under test)

```python
import asyncio
import os

POLL_INTERVAL_SECONDS = 15

def is_pid_alive(pid: int) -> bool:
    """Check whether a process with the given PID is still running."""
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

async def monitor_agent_processes(db) -> None:
    """Poll WIP tasks and detect dead agent processes.
    Infinite loop with asyncio.sleep(POLL_INTERVAL_SECONDS).
    
    Key: the try/except inside the loop catches Exception (not BaseException).
    On Python 3.9+, asyncio.CancelledError inherits from BaseException,
    so it SHOULD propagate through the except Exception block.
    But this needs verification on Windows + Python 3.12.
    """
    while True:
        try:
            wip_tasks = await db.fetch_wip_tasks()
            for task in wip_tasks:
                if not task.agent_pid:
                    continue
                if is_pid_alive(task.agent_pid):
                    continue
                # Dead agent detected — reset to PENDING
                await db.update_task_state(task.id, status="PENDING", agent_pid=None)
                await db.increment_stage_attempts(task.id)
                await db.log_event(task.id, "agent_process_died", ...)
        except Exception:
            log.exception("monitor_tick_error")
        
        await asyncio.sleep(POLL_INTERVAL_SECONDS)  # <-- CancelledError raised here by test patch
```

---

## The Hanging Test: `tests/test_monitor.py::test_monitor_detects_dead_agent`

```python
@pytest.mark.asyncio
async def test_monitor_detects_dead_agent():
    """Monitor resets task to PENDING when agent PID is dead."""
    task = _make_task(agent_pid=99999999)  # dead PID

    mock_db = AsyncMock()
    mock_db.fetch_wip_tasks = AsyncMock(return_value=[task])
    mock_db.update_task_state = AsyncMock()
    mock_db.increment_stage_attempts = AsyncMock()
    mock_db.log_event = AsyncMock()

    call_count = 0
    async def stop_after_one(_):
        nonlocal call_count
        call_count += 1
        if call_count >= 1:
            raise asyncio.CancelledError()

    with patch("core.monitor.asyncio.sleep", side_effect=stop_after_one):
        with pytest.raises(asyncio.CancelledError):
            await monitor_agent_processes(mock_db)

    mock_db.update_task_state.assert_awaited_once_with(
        "TASK-001", status="PENDING", agent_pid=None
    )
    mock_db.increment_stage_attempts.assert_awaited_once_with("TASK-001")
    mock_db.log_event.assert_awaited_once()
```

### Tests That PASS Using Same Pattern:

```python
@pytest.mark.asyncio
async def test_monitor_skips_alive_agent():
    task = _make_task(agent_pid=os.getpid())  # alive PID
    mock_db = AsyncMock()
    mock_db.fetch_wip_tasks = AsyncMock(return_value=[task])

    async def stop_after_one(_):
        raise asyncio.CancelledError()  # immediate, no counter

    with patch("core.monitor.asyncio.sleep", side_effect=stop_after_one):
        with pytest.raises(asyncio.CancelledError):
            await monitor_agent_processes(mock_db)
    mock_db.update_task_state.assert_not_awaited()

@pytest.mark.asyncio
async def test_monitor_skips_no_pid():
    task = _make_task(agent_pid=None)
    # Same pattern — passes fine
```

### Key Difference:
- Passing tests: `stop_after_one` raises CancelledError immediately (no counter)
- Hanging test: `stop_after_one` uses a counter, raises on `call_count >= 1`
- The counter condition `>= 1` means it raises on the FIRST call — so it should behave the same. But the `nonlocal call_count` + increment BEFORE the check might matter.

---

## Test Configuration

```toml
# orchestrator/pyproject.toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
```

**Runtime:** Python 3.12.13, pytest 9.0.2, pytest-asyncio 1.3.0, Windows 10

---

## conftest.py

```python
@pytest.fixture(autouse=True)
def _mock_subprocess(monkeypatch):
    """Prevent real subprocesses from spawning during tests."""
    mock_proc = AsyncMock()
    mock_proc.pid = 99999
    monkeypatch.setattr(
        "asyncio.create_subprocess_exec",
        AsyncMock(return_value=mock_proc),
    )
```

This autouse fixture patches subprocess exec globally. Shouldn't affect monitor tests (no subprocess), but worth noting.
