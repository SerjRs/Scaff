# Task State: 055-v2-agent-spawning

**Current Status:** Not Started

## Milestones

- [ ] Branch `feat/055-v2-agent-spawning` created.
- [ ] `core/config.py` updated to support `agents` block.
- [ ] `agents/base.py` created.
- [ ] `spawn_agent` implemented (builds command, injects env vars, pipes to `AGENT.log`).
- [ ] `spawn_agent` correctly records PID and `started_at` in DB.
- [ ] `kill_agent` implemented for SLA enforcement.
- [ ] `agents/execution_wrapper.py` created.
- [ ] Wrapper executes `git reset --hard` and `git clean -fd` if attempts > 1.
- [ ] `tests/test_agents.py` written and passing.
- [ ] Branch pushed to remote.

## Executor Notes
*(Executor: Leave notes here if you encounter blockers or if the session is interrupted.)*