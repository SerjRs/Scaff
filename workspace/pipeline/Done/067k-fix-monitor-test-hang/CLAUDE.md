# Claude Code Instructions — 067k

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/067k-fix-monitor-test-hang` from main.
2. Commit frequently with format: `[067k] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Investigation First, Fix Second

This is a debugging task. Do NOT jump to a fix without understanding the root cause.

1. First, run the hanging test in isolation with `-s` flag to see output:
   `cd orchestrator && uv run pytest tests/test_monitor.py::test_monitor_detects_dead_agent -v -s`
2. Add temporary debug prints to understand what's happening
3. Document the root cause in a comment in the test
4. Then apply the fix

## Key Points
- The test hangs on Windows (Python 3.12, pytest-asyncio)
- Other monitor tests pass with the same CancelledError pattern — understand WHY this one differs
- The production code in `core/monitor.py` should NOT be weakened
- If the fix requires a small production change (e.g., adding `max_iterations` parameter), that's acceptable as long as the default behavior (infinite loop) is preserved
- `asyncio.CancelledError` is a `BaseException` since Python 3.9 — verify the `except Exception` in monitor.py does NOT catch it

## Tests
Run the full suite to confirm nothing hangs:
`cd orchestrator && uv run pytest -v`

All 93 tests must pass without any hanging.

## Execution
Do NOT ask questions. Investigate, identify root cause, fix, verify.
