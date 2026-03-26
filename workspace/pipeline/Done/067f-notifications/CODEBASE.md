# CODEBASE.md — 067f Relevant Surface

## NEW Module: `core/notify.py` — To Create

```python
import httpx
import structlog
from datetime import datetime, timezone
from core.config import PipelineConfig

log = structlog.get_logger()

async def send_notification(config: PipelineConfig, event: str, task_id: str, **kwargs) -> None:
    """Send webhook notification. No-op if disabled or event not in filter list."""
    if not config.notifications or not config.notifications.enabled:
        return
    if event not in config.notifications.events:
        return

    payload = {
        "event": event,
        "task_id": task_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **kwargs,
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(config.notifications.webhook_url, json=payload)
    except Exception:
        log.warning("notification_failed", event=event, task_id=task_id)
```

---

## Module: `core/config.py` — Add NotificationConfig

```python
@dataclass
class PipelineConfig:
    pipeline_root: Path
    max_lifetime_bounces: int = 8
    tick_interval_seconds: int = 10
    concurrency: dict[str, int] = field(...)
    sla_timeouts: dict[str, int] = field(...)
    retry: dict[str, int] = field(...)
    max_lifetime_bounces: int = 8
    agents: dict[str, AgentConfig] = field(...)
    # >>> ADD:
    # notifications: NotificationConfig | None = None

# >>> ADD:
# @dataclass
# class NotificationConfig:
#     enabled: bool = False
#     webhook_url: str = ""
#     events: list[str] = field(default_factory=lambda: [
#         "task_failed", "sla_timeout", "loop_detected", "agent_crashed"
#     ])
```

**Config parsing in `load_config()`:**
```python
# In load_config(), after existing parsing:
if "notifications" in raw:
    n = raw["notifications"]
    url = n.get("webhook_url", "")
    # Env var substitution: "${PIPELINE_NOTIFY_WEBHOOK}" → os.environ[...]
    if url.startswith("${") and url.endswith("}"):
        env_key = url[2:-1]
        url = os.environ.get(env_key, "")
    config.notifications = NotificationConfig(
        enabled=n.get("enabled", False),
        webhook_url=url,
        events=n.get("events", NotificationConfig().events),
    )
```

---

## Module: `core/scheduler.py` — Hook points

```python
async def _check_sla_timers(db, config) -> None:
    wip_tasks = await db.fetch_wip_tasks()
    for task in wip_tasks:
        # ... elapsed check ...
        if task.stage_attempts >= max_attempts:
            await db.update_task_state(task.id, status="FAILED")
            # >>> ADD: await send_notification(config, "task_failed", task.id,
            #          stage=task.stage, details=f"Max attempts ({max_attempts}) exceeded")
        else:
            await db.update_task_state(task.id, status="PENDING")
            # >>> ADD: await send_notification(config, "sla_timeout", task.id,
            #          stage=task.stage, attempt=task.stage_attempts + 1)

async def _schedule_agents(db, config) -> None:
    for stage in _ACTIVE_STAGES:
        # ...
        for task in pending:
            # After 067b loop detection check:
            # >>> ADD: await send_notification(config, "loop_detected", task.id,
            #          stage=stage, bounces=task.lifetime_bounces)
```

---

## Module: `core/monitor.py` — Hook point

```python
async def _monitor_tick(db) -> None:
    wip_tasks = await db.fetch_wip_tasks()
    for task in wip_tasks:
        if not task.agent_pid:
            continue
        if is_pid_alive(task.agent_pid):
            continue

        log.warning("agent_died_without_signal", task_id=task.id, pid=task.agent_pid)
        await db.update_task_state(task.id, status="PENDING", agent_pid=None)
        await db.increment_stage_attempts(task.id)
        await db.log_event(task.id, "agent_process_died", ...)
        # >>> ADD: Need config access here for notifications
        # Option A: pass config to _monitor_tick and monitor_agent_processes
        # Option B: use a module-level config reference (like mcp.py pattern)
```

**Note:** `_monitor_tick` currently only receives `db`. To send notifications, it needs `config`. Options:
1. Add `config` parameter to `_monitor_tick()` and `monitor_agent_processes()` — cleanest
2. Module-level `_config` like mcp.py — works but inconsistent with current pattern

Recommend option 1: change signatures to `_monitor_tick(db, config)` and `monitor_agent_processes(db, config)`. Update `main.py` to pass config.

---

## Module: `main.py` — May need update for monitor config

```python
await asyncio.gather(
    server.serve(),
    sse_server.serve(),
    orchestrator_loop(db, config),
    monitor_agent_processes(db),        # >>> May need: monitor_agent_processes(db, config)
)
```

---

## Existing Dependencies (`pyproject.toml`)

```toml
dependencies = [
    "httpx>=0.28.1",       # <-- Already available for webhook POST
    # ...
]
```

---

## Files Summary

| File | Action |
|------|--------|
| `core/notify.py` | CREATE — `send_notification()` |
| `core/config.py` | ADD `NotificationConfig`, parse in `load_config()` |
| `core/scheduler.py` | ADD notification calls in SLA timeout + loop detection |
| `core/monitor.py` | ADD notification call on dead agent, add `config` param |
| `main.py` | UPDATE `monitor_agent_processes(db)` → `monitor_agent_processes(db, config)` |
| `tests/test_notify.py` | CREATE — test enabled/disabled/filtered/failure cases |
| `tests/test_monitor.py` | UPDATE — pass config in test calls if signature changes |
