# Task 067k: Fix test_monitor_detects_dead_agent Hang

## STATUS: COOKING

## Priority: P1
## Complexity: S

## Objective

Investigate and fix the `test_monitor_detects_dead_agent` test in `tests/test_monitor.py` which hangs indefinitely on Windows instead of completing. This test is critical — it validates the process exit monitor, our backup mechanism for detecting dead agents.

## Problem

The test is supposed to:
1. Create a mock WIP task with a dead PID (99999999)
2. Run `monitor_agent_processes()` for one iteration
3. Assert the task was reset to PENDING

It uses `patch("core.monitor.asyncio.sleep", side_effect=stop_after_one)` to break the infinite loop after one iteration by raising `asyncio.CancelledError`.

**What happens:** The test hangs forever. It never completes, never times out. The entire test suite gets stuck when this test runs.

**Observation:** Other tests using the same pattern (`test_monitor_skips_alive_agent`, `test_monitor_skips_no_pid`) seem to pass — or at least they passed when run before the hanging test. The hang may be caused by:

1. **Patch path mismatch** — `core.monitor.asyncio.sleep` might not be the correct patch target if `asyncio` is imported differently
2. **`asyncio.CancelledError` swallowed** — the `except Exception` in the monitor's try/except catches `CancelledError` on Python 3.12+ (where `CancelledError` inherits from `BaseException`, but behavior varies)
3. **Windows-specific asyncio issue** — `os.kill(pid, 0)` on Windows behaves differently than on Unix
4. **Event loop state** — prior test may leave the asyncio event loop in a broken state
5. **`fetch_wip_tasks` mock timing** — the mock might not resolve before `asyncio.sleep` is called

## Investigation Steps

1. **Verify the patch target:** Add a print/log inside the patched sleep to confirm it's actually being called
2. **Check CancelledError propagation:** On Python 3.12, `asyncio.CancelledError` is a `BaseException`, not `Exception`. The `except Exception` in the monitor should NOT catch it — but verify this on Windows.
3. **Run the test in isolation:** `uv run pytest tests/test_monitor.py::test_monitor_detects_dead_agent -v -s` — does it hang alone or only after other tests?
4. **Add timeout:** Use `asyncio.wait_for` in the test with a 5-second timeout to prevent infinite hang
5. **Check if the mock `fetch_wip_tasks` returns before or after sleep** — maybe the await ordering is different

## Fix Direction

Once root cause is identified, fix the test so it:
- Runs reliably on Windows
- Completes in under 2 seconds
- Does not use `asyncio.CancelledError` if that's the problem (use a counter + early return instead)

Alternative pattern if CancelledError is unreliable:

```python
# Instead of infinite loop with CancelledError, refactor monitor to accept max_iterations
async def monitor_agent_processes(db, max_iterations=None):
    iterations = 0
    while max_iterations is None or iterations < max_iterations:
        # ... existing logic ...
        iterations += 1
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
```

Or use `asyncio.wait_for` wrapper in the test:

```python
async def test_monitor_detects_dead_agent():
    with patch("core.monitor.asyncio.sleep", return_value=None) as mock_sleep:
        mock_sleep.side_effect = [None, asyncio.CancelledError()]
        try:
            await asyncio.wait_for(monitor_agent_processes(mock_db), timeout=5.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
    # assertions...
```

## Acceptance Criteria

- [ ] Root cause identified and documented
- [ ] `test_monitor_detects_dead_agent` passes on Windows
- [ ] Test completes in under 2 seconds
- [ ] Full test suite runs without hanging: `uv run pytest -v`
- [ ] All 93 tests pass
- [ ] No production code changes that weaken the monitor functionality

## Dependencies

- 067a (merged ✅) — the monitor code this test validates
