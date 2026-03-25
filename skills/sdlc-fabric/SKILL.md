---
name: sdlc-fabric
description: >
  Autonomous Software Development Lifecycle Pipeline Orchestrator.
  Activate when user mentions: software development, software design, system development, application development, pipeline, task pipeline, approve task, pipeline status,
  COOKING, SPECKING, EXECUTION, REVIEW, TESTING stages, or sdlc-fabric.
  Use for: starting/stopping the orchestrator, checking pipeline status, approving tasks
  from COOKING into the automated pipeline, monitoring task progress, handling pipeline
  notifications (failures, SLA breaches, loop detection), and collaborating with the
  human on SPEC.md files in the COOKING stage.
  NOT for: writing implementation code (that's what the pipeline agents do), direct
  git operations on target repos, or modifying the orchestrator source code.
---

# sdlc-fabric Pipeline Orchestrator

## Quick Reference

| Item | Value |
|------|-------|
| Orchestrator repo | `$SDLC_FABRIC_HOME` (set by install script) |
| Orchestrator dir | `$SDLC_FABRIC_HOME/orchestrator` |
| REST API | `http://localhost:3000` |
| MCP Server | stdio transport (via `.claude/mcp.json`) |
| Config | `orchestrator/core/config.py` (Python dataclass defaults) |
| DB | `<project>/pipeline/pipeline.db` (one per project) |
| Pipeline stages | TODO > ARCHITECTING > SPECKING > EXECUTION > REVIEW > TESTING > DONE |
| Pre-pipeline | COOKING (human + agent collaborate on specs) |
| Terminal states | DONE, CANCELLED, CANCEL |
| Env var | `SDLC_FABRIC_HOME` — path to the cloned sdlc-fabric repo (set by install script) |

## Project Structure Convention

All projects managed by sdlc-fabric live under a central `sdlc-fabric/` folder in the workspace.
When the human says "build project-X", create or open this structure:

```
~/.openclaw/workspace/sdlc-fabric/
└── project-X/
    ├── pipeline/              # Pipeline workspace (--root points here)
    │   ├── COOKING/           # Human + agent draft specs here
    │   ├── TODO/              # Approved, waiting for agents
    │   ├── ARCHITECTING/
    │   ├── SPECKING/
    │   ├── EXECUTION/
    │   ├── REVIEW/
    │   ├── TESTING/
    │   ├── DONE/
    │   ├── CANCEL/
    │   └── KNOWLEDGE/
    │       └── ARCHITECTURE.md
    └── repo/                  # Git repository — agents write code here
        ├── src/               # Source code
        ├── tests/             # Tests
        ├── dist/ or target/   # Build artifacts (per language convention)
        └── .git/
```

**Rules:**
- `pipeline/` = the conveyor belt. Task folders move between stage directories.
- `repo/` = the actual git repo. Agents create feature branches, commit code, run tests here.
- Build artifacts stay inside `repo/` — never create a separate output folder outside it.
- The orchestrator gets `--root project-X/pipeline/`.
- Agents get `PIPELINE_TASK_PATH` pointing into `pipeline/` and work inside `repo/`.
- Each project gets its own `pipeline.db` inside `pipeline/`.

**Creating a new project:**
```bash
# Create the structure
$project = "$HOME\.openclaw\workspace\sdlc-fabric\project-X"
mkdir -p "$project/repo"
foreach ($s in COOKING,TODO,ARCHITECTING,SPECKING,EXECUTION,REVIEW,TESTING,DONE,CANCEL,KNOWLEDGE) {
    mkdir -p "$project/pipeline/$s"
}
# Initialize the repo
cd "$project/repo" && git init

# Start the orchestrator for this project
pwsh -File <skill-dir>/scripts/serve.ps1 -PipelineRoot "$project/pipeline"
```

## Starting the Orchestrator

```bash
# Start (background daemon)
pwsh -File <skill-dir>/scripts/serve.ps1 -PipelineRoot <project>\pipeline -Port 3000

# Quick health check
pwsh -File <skill-dir>/scripts/status.ps1

# Stop
pwsh -File <skill-dir>/scripts/stop.ps1
```

Replace `<skill-dir>` with the absolute path to this skill's directory and `<path>` with the pipeline root directory containing task stage folders.

### Manual Start (if scripts unavailable)

```bash
cd "$SDLC_FABRIC_HOME/orchestrator"
uv run python main.py serve --root <project>/pipeline --db-path <project>/pipeline/pipeline.db --rest-port 3000
```

## Pipeline Status

### Via REST API

```bash
# Health check (is the orchestrator running?)
curl http://localhost:3000/health
# Response: {"status": "ok", "tasks_active": <count>}

# List all tasks
curl http://localhost:3000/tasks

# Filter by stage and/or status
curl "http://localhost:3000/tasks?stage=EXECUTION&status=WIP"

# Get a specific task
curl http://localhost:3000/tasks/{task_id}
```

### Via CLI

```bash
cd "$SDLC_FABRIC_HOME/orchestrator"
uv run python cli.py status
```

## COOKING Workflow (Main Agent Role)

This is the agent's primary role in the pipeline. The COOKING stage is where the human and agent collaborate to refine task specifications before they enter the automated pipeline.

**Detailed guide:** See `references/cooking-workflow.md`

### Summary

1. **Help human clarify ideas** into SPEC.md documents
2. **Iterate:** ask probing questions about scope, edge cases, dependencies, acceptance criteria
3. **Track SPEC.md STATUS:** DRAFT > REVIEW > AGREED
4. **When human says `/approve <task-id>`:** call `POST /tasks/{task_id}/approve`
5. **Stall detection:** after 10 iterations with no resolution, set STATUS: STALLED and notify human

### Approval Request

When the human approves a task, send:

```bash
curl -X POST http://localhost:3000/tasks/{task_id}/approve \
  -H "Content-Type: application/json" \
  -d '{"priority": "P2", "complexity": "M"}'
```

This moves the task from COOKING to TODO, where the scheduler picks it up.

## Task Management Commands

### Approve (COOKING > TODO)

```bash
POST /tasks/{task_id}/approve
Body: {"priority": "P2", "complexity": "M"}
```

Priority: P1 (critical), P2 (normal), P3 (low).
Complexity: S, M, L, XL.

### Cancel a Task

```bash
POST /tasks/{task_id}/cancel
Body: {"reason": "No longer needed — superseded by TASK-042"}
```

Writes `CANCEL-REASON.md` in the task folder and moves to CANCEL stage.

### Reprioritize

```bash
POST /tasks/{task_id}/reprioritize
Body: {"priority": "P1"}
```

### Retry a Failed/Looped Task

```bash
POST /tasks/{task_id}/retry
```

Resets FAILED or LOOP_DETECTED tasks back to PENDING so the scheduler retries them.

### Signal Done (Agent Use)

```bash
POST /tasks/{task_id}/signal-done
Body: {"notes": "Implementation complete, all tests pass"}
```

Advances the task to the next pipeline stage.

### Signal Back (Agent Use)

```bash
POST /tasks/{task_id}/signal-back
Body: {"target_stage": "SPECKING", "reason": "Spec is ambiguous on error handling"}
```

Sends a task backward to an earlier stage. Increments lifetime bounce counter.

## Monitoring & Notifications

### What to Watch For

| Condition | How to Detect | Action |
|-----------|--------------|--------|
| Failed tasks | `GET /tasks?status=FAILED` | Report to human with task ID, stage, attempt count |
| Loop detection | `GET /tasks?status=LOOP_DETECTED` | Task bounced 8+ times. Needs human intervention |
| SLA breach | Scheduler auto-detects | Report which agent timed out and on which task |
| Blocked tasks | `GET /tasks?status=BLOCKED` | Check DEPS.MD — dependency not yet DONE |

### Periodic Checks

Run these checks periodically (every few minutes or when the human asks for status):

```bash
# Check for problems
curl "http://localhost:3000/tasks?status=FAILED"
curl "http://localhost:3000/tasks?status=LOOP_DETECTED"
curl "http://localhost:3000/tasks?status=BLOCKED"
```

### SLA Timeouts (defaults)

| Stage | Timeout |
|-------|---------|
| ARCHITECTING | 1 hour |
| SPECKING | 30 min |
| EXECUTION | 4 hours |
| REVIEW | 1 hour |
| TESTING | 2 hours |

When an agent exceeds its SLA, the scheduler requeues the task (up to the retry limit), then marks it FAILED.

### Retry Limits (defaults)

| Stage | Max Retries |
|-------|-------------|
| ARCHITECTING | 2 |
| SPECKING | 3 |
| EXECUTION | 4 |
| REVIEW | 2 |
| TESTING | 3 |

### Lifetime Bounce Limit

A task that bounces between stages 8+ times is marked LOOP_DETECTED and halted.

## Concurrency Limits (defaults)

| Stage | Max WIP |
|-------|---------|
| ARCHITECTING | 1 |
| SPECKING | 2 |
| EXECUTION | 3 |
| REVIEW | 1 |
| TESTING | 2 |

The scheduler respects these limits. Extra PENDING tasks wait in queue.

## MCP Tools (Agent Protocol)

These are the MCP tools that pipeline agents use to communicate with the orchestrator. The main agent does NOT typically call these directly — they are for reference when debugging agent behavior.

| Tool | Purpose |
|------|---------|
| `orchestrator_claim_task(stage)` | Agent claims next pending task in a stage |
| `orchestrator_signal_done(task_id, notes)` | Agent reports task complete |
| `orchestrator_signal_back(task_id, target_stage, reason)` | Agent sends task backward |
| `orchestrator_signal_cancel(task_id, reason)` | Agent cancels a task |
| `orchestrator_patch_priority(task_id, action, value, reason)` | Queue priority/status change |
| `orchestrator_append_knowledge(section, content, task_id)` | Queue knowledge base entry |

## Troubleshooting

See `references/troubleshooting.md` for common issues and solutions.

Quick checks:
- **Orchestrator not responding:** Is the process running? Check `pwsh -File <skill-dir>/scripts/status.ps1`
- **Tasks stuck in WIP:** Agent process may have died. The reconciler resets dead WIP tasks on restart.
- **Tasks not progressing:** Check `DEPS.MD` for unmet dependencies, or concurrency limits.
