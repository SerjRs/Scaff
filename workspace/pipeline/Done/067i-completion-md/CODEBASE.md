# CODEBASE.md — 067i Relevant Surface

## Module: `prompts/testing.md` — Current Content (to update)

```markdown
# Testing Agent — System Prompt

> **MANDATORY:** You MUST use the provided `orchestrator_*` MCP tools to signal your progress.

You are a Senior QA Engineer. You verify that implementations satisfy all acceptance criteria.

## Task Assignment
Your task has been pre-assigned. The details are provided above.

## Startup Sequence
1. Read files listed in `.context-manifest.txt`

## Testing Protocol — Execute in Order
### STEP 1: Unit Tests
### STEP 2: E2E Tests
### STEP 3: Browser/UI Testing (if applicable)
### STEP 4: Acceptance Criteria Verification

## On PASS
1. Write `TEST-RESULTS.md` with full evidence for every criterion.
2. Write `COMPLETION.md` summarizing what was delivered.        # <-- EXISTS but vague
3. Your working directory is the project repository. Run git merge commands directly:
   git checkout main && git merge feature/<task-id> && git push
4. Call `orchestrator_signal_done(task_id)`.

## On FAIL
1. Write `TEST-RESULTS.md` with per-criterion failure evidence.
2. Call `orchestrator_signal_back(...)`.
3. Call `orchestrator_patch_priority(...)`.

## Rules
- Test against real running services, not mocks.
- Every verdict must have evidence.
- Never skip a criterion.
```

**Changes needed:**
- Replace line "2. Write `COMPLETION.md` summarizing what was delivered." with a full template section
- Add explicit "You MUST write COMPLETION.md before calling signal_done" instruction

---

## Module: `api/mcp.py` — Signal Done (add warning)

```python
@mcp_server.tool()
async def orchestrator_signal_done(task_id: str, notes: str = "") -> dict:
    """Signal work complete; advance to next stage."""
    config = _get_config()
    task = await db.get_task(task_id)
    if task is None:
        raise ValueError(f"Task {task_id} not found")
    current_idx = PIPELINE_STAGES.index(task.stage)
    next_stage = PIPELINE_STAGES[current_idx + 1]

    # >>> ADD: warn if TESTING→DONE and COMPLETION.md missing
    # if task.stage == "TESTING":
    #     completion_path = Path(task.task_path) / "COMPLETION.md"
    #     if not completion_path.exists():
    #         log.warning("completion_md_missing", task_id=task_id)

    await filesystem.move_task(task_id, task.stage, next_stage, db, config)
    if notes:
        _append_to_agent_log(task.task_path, f"DONE: {notes}")
    return {"ok": True}
```

---

## Module: `api/rest.py` — Signal Done REST (same warning)

```python
@app.post("/tasks/{task_id}/signal-done")
async def signal_done(task_id: str, body: SignalDoneBody) -> dict:
    config = _get_config()
    task = await db.get_task(task_id)
    current_idx = PIPELINE_STAGES.index(task.stage)
    next_stage = PIPELINE_STAGES[current_idx + 1]

    # >>> ADD: same COMPLETION.md warning as mcp.py

    await filesystem.move_task(task_id, task.stage, next_stage, db, config)
    return {"ok": True}
```

---

## COMPLETION.md Template (to add to testing prompt)

```markdown
## COMPLETION.md Format

Before calling `signal_done`, you MUST write `COMPLETION.md` in the task folder:

\```markdown
# Completion: <task-id>

## Summary
One paragraph describing what was delivered.

## Changes
- `path/to/file.py` — description of change
- `path/to/new_file.py` — created, purpose

## Tests
- Unit: X passed, 0 failed
- E2E: Y passed, 0 failed

## Merged
Branch `feature/<task-id>` merged to main at commit `<hash>`
\```
```

---

## Files Summary

| File | Action |
|------|--------|
| `prompts/testing.md` | UPDATE — add COMPLETION.md template in On PASS section |
| `api/mcp.py` | ADD warning log when COMPLETION.md missing on TESTING→DONE |
| `api/rest.py` | ADD same warning log |
