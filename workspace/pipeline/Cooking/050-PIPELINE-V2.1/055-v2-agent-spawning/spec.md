---
id: 055
title: V2 Agent Spawning & Execution Wrapper
priority: P1
status: Cooking
branch: feat/055-v2-agent-spawning
epic: 050-PIPELINE-V2.1
---

# Specification: V2 Agent Spawning & Execution Wrapper

## Objective
Implement the actual subprocess invocation logic in `agents/base.py` to spawn AI agents, and build the `agents/execution_wrapper.py` script to handle git state sanitization for retry attempts.

## Architecture & Context
The Orchestrator invokes agents as detached async subprocesses. It passes critical context via environment variables (`PIPELINE_TASK_PATH`, `PIPELINE_TASK_ID`, `PIPELINE_MANIFEST`) and captures all `stdout` and `stderr` directly to an `AGENT.log` file inside the task folder. 

## Implementation Requirements

### 1. Agent Configuration (`core/config.py`)
- Expand `PipelineConfig` to parse the `agents` block from `pipeline.config.yaml` (harness, model, prompt_file, etc.).

### 2. Subprocess Management (`agents/base.py`)
Implement `async def spawn_agent(stage: str, task: TaskRecord, db, config)`:
- Look up the agent configuration for the given `stage`.
- Construct the CLI command (e.g., `claude -m <model> --system-prompt-file <prompt>`).
- Open `task.task_path / "AGENT.log"` in append mode (`"a"`).
- Use `asyncio.create_subprocess_exec` to launch the agent.
- Inject environment variables: `PIPELINE_TASK_PATH`, `PIPELINE_TASK_ID`, `PIPELINE_MANIFEST`, and `PIPELINE_TOKEN` (for MCP auth).
- Update the database: set `agent_pid` to the subprocess PID, `status` to `WIP`, and update `started_at`.

Implement `async def kill_agent(pid: int)`:
- Safely terminate the process group if an SLA timeout is reached.

### 3. Execution Wrapper (`agents/execution_wrapper.py`)
This is a standalone Python script invoked by `spawn_agent` specifically for the `EXECUTION` stage.
- Read `stage_attempts` (pass this in via env var or CLI arg).
- **Git Sanitization:** If `stage_attempts > 1`, use `subprocess.run` to execute:
  1. `git checkout feature/<task_id>`
  2. `git reset --hard HEAD`
  3. `git clean -fd`
- **Agent Invocation:** Spawn the actual underlying developer agent (CODEX or Claude, based on the fallback logic).
- Note: This script uses the Orchestrator's internal REST API to claim the task and signal completion, acting as a bridge since CODEX doesn't natively speak MCP.

## Testing Requirements
- Create `tests/test_agents.py`.
- Mock `asyncio.create_subprocess_exec` to verify correct CLI arguments and environment variables are constructed.
- Write a test for `execution_wrapper.py` mocking the `git` calls to ensure retries trigger the reset commands correctly.