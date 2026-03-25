# Task State: 054-v2-core-loop-and-reconciler

**Current Status:** Not Started

## Milestones

- [ ] Branch `feat/054-v2-core-loop-and-reconciler` created.
- [ ] `pyyaml` dependency added via `uv`.
- [ ] `core/config.py` updated with concurrency limits and SLAs.
- [ ] `core/reconciler.py` implemented (handles orphan, mismatch, dead WIP).
- [ ] `core/priority.py` implemented (`PRIORITY.MD` Markdown generator).
- [ ] `core/scheduler.py` implemented (`orchestrator_loop`).
- [ ] Knowledge appends and Priority patches drained correctly.
- [ ] Dependency checker parses `DEPS.MD` and blocks tasks correctly.
- [ ] Concurrency limits enforced during task fetching.
- [ ] `agents/base.py` created with stubbed `spawn_agent`.
- [ ] `tests/test_reconciler.py` written and passing.
- [ ] `tests/test_scheduler.py` written and passing.
- [ ] Branch pushed to remote.

## Executor Notes
*(Executor: Leave notes here if you encounter blockers or if the session is interrupted.)*