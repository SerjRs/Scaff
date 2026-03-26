# Task 067f: Notifications

## STATUS: COOKING

## Priority: P2
## Complexity: M

## Objective

Send notifications when important pipeline events occur: task failure (max attempts exceeded), SLA timeout, loop detection. Without notifications, the human only discovers problems by manually checking.

## Background

Architecture spec v2.2 §6.1 #9: "Agent failures are written to SQLite, appended to PIPELINE.log, and trigger notifications."

Currently: events go to SQLite and structlog. No external notification.

## Scope

### In Scope
1. Add a notification dispatcher that supports webhook (HTTP POST)
2. Hook into:
   - Task FAILED (max_attempts exceeded)
   - SLA timeout
   - LOOP_DETECTED
   - Agent crash (process exit monitor detects dead agent)
3. Configurable via `pipeline.config.yaml`:
   ```yaml
   notifications:
     enabled: true
     webhook_url: ${PIPELINE_NOTIFY_WEBHOOK}
     events:
       - task_failed
       - sla_timeout
       - loop_detected
       - agent_crashed
   ```

### Out of Scope
- Slack/Discord/email integrations (webhook covers these via Zapier/n8n)
- Notification for successful completions
- Notification UI in the dashboard

## Webhook Payload

```json
{
  "event": "task_failed",
  "task_id": "063-code-review-graph",
  "stage": "EXECUTION",
  "details": "Max attempts (4) exceeded",
  "timestamp": "2026-03-26T12:00:00Z"
}
```

## Files to Modify

- `core/notify.py` — **CREATE**: notification dispatcher
- `core/scheduler.py` — call notify on SLA timeout, loop detection
- `api/mcp.py` — call notify on signal failures
- `core/config.py` — add notification config to PipelineConfig

## Acceptance Criteria

- [ ] Webhook fires on task FAILED
- [ ] Webhook fires on SLA timeout
- [ ] Webhook fires on LOOP_DETECTED
- [ ] Notifications can be disabled via config
- [ ] Failed webhook doesn't crash the orchestrator
- [ ] Existing tests pass

## Dependencies

- 067b (loop detection) — LOOP_DETECTED must be implemented first
