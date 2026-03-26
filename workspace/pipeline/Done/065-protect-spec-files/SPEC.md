# Task 065: Protect SPEC.md from Agent Modification

## STATUS: COOKING

## Priority: P1
## Complexity: S

## Objective

Ensure SPEC.md files in task folders are never modified or deleted by pipeline agents. SPEC.md is the human-authored contract — it must survive the entire pipeline journey intact.

## Problem

During the first E2E run, the architect agent (Claude Code with `--permission-mode bypassPermissions`) deleted or overwrote the SPEC.md file. Since agents run with full write access to the repo and task folders, nothing prevents them from destroying the specification they're supposed to implement.

## Solution

Two layers of protection:

### 1. File Permission (OS-level)
Before spawning an agent, set SPEC.md to read-only:

```python
# In spawn_agent(), before creating the subprocess:
spec_path = Path(task.task_path) / "SPEC.md"
if spec_path.exists():
    spec_path.chmod(stat.S_IREAD)  # read-only
```

After the agent completes (or on SLA timeout), restore write permission so `move_task()` can move the folder:

```python
# In move_task() or a cleanup step:
spec_path = Path(task_path) / "SPEC.md"
if spec_path.exists():
    spec_path.chmod(stat.S_IREAD | stat.S_IWRITE)
```

### 2. Prompt Instruction (agent-level)
Add to all 5 prompt files:

```
## IMPORTANT: Do NOT modify or delete SPEC.md
SPEC.md is the task specification written by humans. It is read-only.
Never edit, overwrite, move, or delete it. Read it for your instructions, then do your work elsewhere.
```

### 3. Post-Spawn Validation (optional, defense in depth)
After an agent finishes, verify SPEC.md still exists and matches a hash taken before spawn. Log a warning if tampered.

## Files to Modify

- `agents/base.py` — chmod SPEC.md to read-only before spawn
- `core/filesystem.py` — restore write permission in `move_task()` before moving
- `orchestrator/prompts/architect.md` — add do-not-modify instruction
- `orchestrator/prompts/spec.md` — add do-not-modify instruction
- `orchestrator/prompts/execution.md` — add do-not-modify instruction
- `orchestrator/prompts/review.md` — add do-not-modify instruction
- `orchestrator/prompts/testing.md` — add do-not-modify instruction

## Testing Requirements

- Test that SPEC.md is set read-only before agent spawn
- Test that SPEC.md write permission is restored during move_task
- Test that a read-only SPEC.md survives a simulated agent run

## Acceptance Criteria

- [ ] SPEC.md is set read-only before any agent spawns
- [ ] SPEC.md write permission is restored before folder moves
- [ ] All 5 prompts instruct agents not to modify SPEC.md
- [ ] Existing tests pass
