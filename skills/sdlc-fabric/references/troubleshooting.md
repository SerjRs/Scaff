# Troubleshooting Guide

## Orchestrator Won't Start

**Symptom:** `serve.ps1` fails or the process exits immediately.

**Checks:**
1. Is Python 3.12+ installed? `python --version`
2. Is `uv` installed? `uv --version`
3. Are dependencies installed? `cd orchestrator && uv sync`
4. Is port 3000 already in use? `netstat -ano | findstr :3000`
5. Check the error log: `type orchestrator\orchestrator.err.log`

**Fix:** If port is in use, either stop the other process or use a different port:
```bash
pwsh -File skill/scripts/serve.ps1 -PipelineRoot <path> -Port 3001
```

## REST API Not Responding

**Symptom:** `curl http://localhost:3000/health` times out or connection refused.

**Checks:**
1. Is the process running? `pwsh -File skill/scripts/status.ps1`
2. Check logs: `type orchestrator\orchestrator.log`
3. The API may still be starting — wait a few seconds after launch

**Fix:** If the process is dead, restart:
```bash
pwsh -File skill/scripts/stop.ps1
pwsh -File skill/scripts/serve.ps1 -PipelineRoot <path>
```

## Tasks Stuck in WIP

**Symptom:** Tasks show status=WIP but no agent is working on them.

**Cause:** The agent process crashed or was killed without reporting back.

**Fix:** Restart the orchestrator. The reconciler runs on startup and:
- Detects dead WIP tasks (PID no longer alive)
- Resets them to PENDING
- Increments stage_attempts so the scheduler retries

```bash
pwsh -File skill/scripts/stop.ps1
pwsh -File skill/scripts/serve.ps1 -PipelineRoot <path>
```

## Tasks Stuck in BLOCKED

**Symptom:** Tasks remain in BLOCKED status indefinitely.

**Cause:** The task has dependencies (in DEPS.MD) that haven't reached DONE.

**Checks:**
1. Find the task: `curl http://localhost:3000/tasks/{task_id}`
2. Read the DEPS.MD in the task folder
3. Check each dependency's status

**Fix:** Either:
- Complete or unblock the dependency tasks
- Edit DEPS.MD to remove the dependency (if no longer needed)
- Cancel the blocked task if it's no longer relevant

## Tasks Marked FAILED

**Symptom:** Task status is FAILED.

**Cause:** The task exceeded its retry limit for the current stage.

**Checks:**
1. `curl http://localhost:3000/tasks/{task_id}` — check `stage_attempts`
2. Read AGENT.log in the task folder for error details

**Fix:**
- Investigate the failure in AGENT.log
- Fix the underlying issue (spec clarity, code bug, test flakiness)
- Retry: `curl -X POST http://localhost:3000/tasks/{task_id}/retry`

## Tasks Marked LOOP_DETECTED

**Symptom:** Task status is LOOP_DETECTED.

**Cause:** The task has bounced between stages 8+ times (lifetime_bounces >= max_lifetime_bounces).

**This requires human intervention.** The task is cycling between stages without converging.

**Checks:**
1. `curl http://localhost:3000/tasks/{task_id}` — check `lifetime_bounces`
2. Read AGENT.log for the pattern of bounces
3. Check pipeline_events in the DB for the full history

**Fix:**
- Analyze why the task keeps bouncing (usually spec issues or flaky tests)
- Rewrite the spec to be more precise
- Simplify the task scope
- Retry after fixing: `curl -X POST http://localhost:3000/tasks/{task_id}/retry`

## Database Issues

**Symptom:** Errors mentioning `pipeline.db` or `aiosqlite`.

**Checks:**
1. Does the DB file exist? `ls orchestrator/pipeline.db`
2. Is it corrupted? `sqlite3 orchestrator/pipeline.db "PRAGMA integrity_check;"`

**Fix:** If the DB is missing, the orchestrator creates it on startup. If corrupted:
1. Stop the orchestrator
2. Back up the corrupted DB: `cp orchestrator/pipeline.db orchestrator/pipeline.db.bak`
3. Delete and restart (loses history): `rm orchestrator/pipeline.db`
4. Restart — the reconciler will recreate records from existing task folders

## Agent Not Spawning

**Symptom:** Tasks stay PENDING even though concurrency limits aren't reached.

**Checks:**
1. Is the agent harness installed? (claude, codex, gemini CLI)
2. Check orchestrator logs for spawn errors
3. Verify `pipeline.config.yaml` has correct agent configurations

**Fix:** Ensure the required CLI tools are on PATH and properly configured.

## Wrong Stage Directory Structure

**Symptom:** Orchestrator can't find tasks or creates tasks in wrong locations.

**Expected structure in pipeline root:**
```
<pipeline-root>/
  COOKING/
    TASK-001/
      SPEC.md
  TODO/
    TASK-002/
  ARCHITECTING/
  SPECKING/
  EXECUTION/
  REVIEW/
  TESTING/
  DONE/
  CANCEL/
  KNOWLEDGE/
    ARCHITECTURE.md
```

**Fix:** Create missing stage directories. The orchestrator expects them to exist.
