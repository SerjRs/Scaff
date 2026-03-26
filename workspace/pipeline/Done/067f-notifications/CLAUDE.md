# Claude Code Instructions — 067f

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/067f-notifications` from main.
2. Commit frequently with format: `[067f] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. Create `core/notify.py`
- `async def send_notification(config: PipelineConfig, event: str, task_id: str, **kwargs)`
- If `config.notifications` is None or not enabled, return immediately (no-op)
- HTTP POST to `config.notifications.webhook_url` with JSON payload
- Payload: `{"event": event, "task_id": task_id, "timestamp": <ISO 8601>, **kwargs}`
- Use `httpx.AsyncClient` for the POST (already a dependency)
- Wrap in try/except — failed webhook must NEVER crash the orchestrator
- Add a 5-second timeout on the HTTP request

### 2. Add NotificationConfig to `core/config.py`
```python
@dataclass
class NotificationConfig:
    enabled: bool = False
    webhook_url: str = ""
    events: list[str] = field(default_factory=lambda: [
        "task_failed", "sla_timeout", "loop_detected", "agent_crashed"
    ])
```
- Add `notifications: NotificationConfig | None = None` to PipelineConfig
- Parse from `pipeline.config.yaml` under `notifications:` key
- Support env var substitution for webhook_url: if value starts with `${` and ends with `}`, read from env

### 3. Hook Points
- `core/scheduler.py` → `_check_sla_timers()`: on FAILED → `send_notification(..., "task_failed", ...)`
- `core/scheduler.py` → `_check_sla_timers()`: on requeue → `send_notification(..., "sla_timeout", ...)`
- `core/scheduler.py` → `_schedule_agents()`: on LOOP_DETECTED (from 067b) → `send_notification(..., "loop_detected", ...)`
- `core/monitor.py` → `_monitor_tick()`: on dead agent → `send_notification(..., "agent_crashed", ...)`

### 4. Event Filtering
- Only send if the event type is in `config.notifications.events` list
- This lets users opt out of noisy events

## Do NOT Modify
- `core/db.py` — no schema changes
- `agents/base.py` — spawn notifications not needed
- `api/mcp.py` — agent signals don't trigger notifications directly

## Tests
- Add `tests/test_notify.py`
- Test: notification sent when enabled + event in list
- Test: notification NOT sent when disabled
- Test: notification NOT sent when event not in list
- Test: failed webhook doesn't raise (graceful degradation)
- Mock `httpx.AsyncClient.post` — do NOT make real HTTP calls
- Run full suite: `cd orchestrator && uv run pytest -v`

## Important
- This task depends on 067b (loop detection) being merged for the LOOP_DETECTED hook
- If 067b is not yet merged, add the LOOP_DETECTED hook point with a TODO comment
- The webhook_url env var substitution is important — secrets shouldn't be in YAML
- Keep it simple — one file, one function, ~40 lines

## Execution
Do NOT ask questions. Execute the full task end-to-end.
