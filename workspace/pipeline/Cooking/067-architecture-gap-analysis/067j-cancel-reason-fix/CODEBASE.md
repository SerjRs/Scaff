# CODEBASE.md — 067j Relevant Surface

## Module: `api/rest.py` — Human Cancel

```python
@app.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str, body: CancelBody) -> dict:
    config = _get_config()
    task = await db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")

    cancel_path = Path(task.task_path) / "CANCEL-REASON.md"
    timestamp = datetime.now(timezone.utc).isoformat()
    cancel_content = (
        f"# Cancel Reason\n\n"
        f"- **task_id:** {task_id}\n"
        f"- **timestamp:** {timestamp}\n"
        f"- **cancelled_from_stage:** {task.stage}\n"
        f"- **reason:** {body.reason}\n"
        # >>> ADD: f"- **triggered_by:** human\n"
    )
    cancel_path.parent.mkdir(parents=True, exist_ok=True)
    cancel_path.write_text(cancel_content, encoding="utf-8")

    await filesystem.move_task(task_id, task.stage, "CANCEL", db, config)
    return {"ok": True}
```

---

## Module: `api/mcp.py` — Agent Cancel

```python
@mcp_server.tool()
async def orchestrator_signal_cancel(task_id: str, reason: str) -> dict:
    """Cancel a task with a reason."""
    config = _get_config()
    task = await db.get_task(task_id)
    if task is None:
        raise ValueError(f"Task {task_id} not found")
    cancel_path = Path(task.task_path) / "CANCEL-REASON.md"
    timestamp = datetime.now(timezone.utc).isoformat()
    cancel_content = (
        f"# Cancel Reason\n\n"
        f"- **task_id:** {task_id}\n"
        f"- **timestamp:** {timestamp}\n"
        f"- **cancelled_from_stage:** {task.stage}\n"
        f"- **reason:** {reason}\n"
        # >>> ADD: f"- **triggered_by:** agent\n"
    )
    cancel_path.parent.mkdir(parents=True, exist_ok=True)
    cancel_path.write_text(cancel_content, encoding="utf-8")
    await filesystem.move_task(task_id, task.stage, "CANCEL", db, config)
    return {"ok": True}
```

---

## Existing Tests

### `tests/test_api.py` — Cancel test

```python
class TestCancelTask:
    def test_cancel_writes_reason_and_moves(self, ...):
        # POSTs to /tasks/{task_id}/cancel
        # Asserts CANCEL-REASON.md written
        # Asserts task moved to CANCEL stage
        # >>> ADD: assert "triggered_by" in cancel_content
        # >>> ADD: assert "human" in cancel_content
```

### `tests/test_mcp.py` — Cancel test

```python
def test_signal_cancel_writes_reason(self, ...):
    # Calls orchestrator_signal_cancel MCP tool
    # Asserts CANCEL-REASON.md written
    # >>> ADD: assert "triggered_by" in cancel_content
    # >>> ADD: assert "agent" in cancel_content
```

---

## Expected CANCEL-REASON.md Output (after fix)

### Human cancel:
```markdown
# Cancel Reason

- **task_id:** 063-code-review-graph
- **timestamp:** 2026-03-26T12:00:00+00:00
- **cancelled_from_stage:** EXECUTION
- **reason:** No longer needed
- **triggered_by:** human
```

### Agent cancel:
```markdown
# Cancel Reason

- **task_id:** 063-code-review-graph
- **timestamp:** 2026-03-26T12:00:00+00:00
- **cancelled_from_stage:** REVIEW
- **reason:** Task is fundamentally flawed
- **triggered_by:** agent
```

---

## Files Summary

| File | Action |
|------|--------|
| `api/rest.py` | ADD `triggered_by: human` line to cancel_content |
| `api/mcp.py` | ADD `triggered_by: agent` line to cancel_content |
| `tests/test_api.py` | UPDATE cancel test to verify `triggered_by: human` |
| `tests/test_mcp.py` | UPDATE cancel test to verify `triggered_by: agent` |
