# Task 061: Fix Agent Spawn Mechanics

## STATUS: AGREED

## Priority: P1
## Complexity: M

## Objective

Fix three critical issues in `agents/base.py` that prevent real agent execution: prompt delivery via CLI argument (hits OS limits), missing working directory (agents can't find the repo), and missing repo path in agent context.

## Scope

### In Scope
- Prompt delivery via temp file instead of CLI argument
- Set `cwd=` on subprocess to the project's `repo/` directory
- Derive `repo_path` from project structure (sibling of pipeline root)
- Inject `PIPELINE_REPO_PATH` env var into agent subprocess
- Update prompt files to reference repo path
- Clean up unused `execution_wrapper.py` (codex bridge — deferred to future)

### Out of Scope
- Codex/Gemini harness support (deferred)
- Agent process monitoring (SLA timer already handles this)
- MCP transport changes

## Problem Analysis

### Problem 1: Prompt as CLI argument
Current code in `_build_command()`:
```python
["claude", "-p", prompt_content, "--model", model, ...]
```
The `prompt_content` includes the full prompt file + task context. For large prompts, this exceeds the OS command-line limit (32,767 chars on Windows). Claude Code supports reading prompts from stdin or files.

**Fix:** Write prompt to a temp file, pass via stdin pipe or `--prompt-file` flag. Clean up temp file after process starts.

### Problem 2: No working directory
Current code in `spawn_agent()`:
```python
process = await asyncio.create_subprocess_exec(*cmd, stdout=log_file, stderr=log_file, env=env)
```
No `cwd=` parameter. The agent process inherits the orchestrator's working directory (`orchestrator/`), NOT the project's `repo/` directory. Agents need to be in `repo/` to run git commands, execute tests, and write code.

**Fix:** Derive `repo_path` from the pipeline root. Convention: `repo/` is a sibling of `pipeline/` in the project folder. Pass `cwd=repo_path` to `create_subprocess_exec`.

### Problem 3: Agents don't know where the repo is
The prompt files tell agents to work in a repo, but don't specify the path. The env vars include `PIPELINE_TASK_PATH` (inside pipeline/) but not the repo location.

**Fix:** Add `PIPELINE_REPO_PATH` env var. Update the task context prepended to prompts.

## Files to Create / Modify

- `orchestrator/agents/base.py` — **MODIFY**: 
  - `_build_command()`: remove prompt from CLI args, return command without prompt
  - `spawn_agent()`: write prompt to temp file, pipe to stdin or use file flag, set `cwd=repo_path`, add `PIPELINE_REPO_PATH` env var
  - `_build_prompt_content()`: add repo_path to task context header
- `orchestrator/core/config.py` — **MODIFY**: add `repo_path` property or helper that derives `repo/` from `pipeline_root` parent
- `orchestrator/prompts/*.md` — **MODIFY**: update all 5 prompts to reference `$PIPELINE_REPO_PATH` for git operations
- `orchestrator/agents/execution_wrapper.py` — **DELETE** or mark as deprecated (codex bridge, not needed for claude-only)
- `orchestrator/tests/test_agents.py` — **MODIFY**: update tests for new spawn mechanics
- `orchestrator/tests/test_spawn.py` — **CREATE**: tests for temp file prompt delivery, cwd setting, repo path derivation

## Implementation Notes

1. **Prompt delivery approach:** Write prompt content to a temp file in the task folder (`<task_path>/.prompt.md`). Use `claude -p "$(cat .prompt.md)"` won't work either (same limit). Instead, pipe via stdin:
   ```python
   process = await asyncio.create_subprocess_exec(
       "claude", "--model", model, "--permission-mode", "bypassPermissions", "--output-format", "text",
       stdin=asyncio.subprocess.PIPE, stdout=log_file, stderr=log_file, cwd=repo_path, env=env
   )
   process.stdin.write(prompt_content.encode())
   await process.stdin.drain()
   process.stdin.close()
   ```
   Or write to file and use: `claude -p @.prompt.md` if supported. Verify which approach Claude Code accepts.

2. **Repo path derivation:** Convention is `<project>/pipeline/` and `<project>/repo/`. So:
   ```python
   repo_path = config.pipeline_root.parent / "repo"
   ```
   If `repo/` doesn't exist, log a warning but don't crash — some stages (ARCHITECTING, SPECKING) may not need it.

3. **Prompt context update:** The task context header becomes:
   ```
   Task ID: {task.id}
   Task Path: {task.task_path}
   Context Manifest: {manifest_path}
   Repo Path: {repo_path}
   ```

## Acceptance Criteria

- [ ] Prompts are NOT passed as CLI arguments (no command-line length issues)
- [ ] Agent subprocess `cwd` is set to `<project>/repo/`
- [ ] `PIPELINE_REPO_PATH` env var is set for all agent subprocesses
- [ ] Prompt context includes repo path
- [ ] All 5 prompt files reference `$PIPELINE_REPO_PATH` for git/code operations
- [ ] `execution_wrapper.py` is removed or deprecated
- [ ] All existing tests still pass (with necessary mocking updates)
- [ ] New tests verify temp file prompt delivery and cwd setting

## Dependencies

- 060 (YAML config + claude-only agents) — must be merged first so we're working with claude-only harness
