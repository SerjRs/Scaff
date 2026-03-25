# Autonomous Software Production Pipeline
## Architecture Specification v2.1

**Author:** Serj Robu  
**Status:** Draft  
**Last Updated:** 2026-03-25  

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Build Language Decision](#2-build-language-decision)
3. [System Architecture Overview](#3-system-architecture-overview)
4. [Repository & Filesystem Structure](#4-repository--filesystem-structure)
5. [File Artifact Catalog](#5-file-artifact-catalog)
6. [Orchestrator](#6-orchestrator)
   - 6.1 Responsibilities
   - 6.2 SQLite Schema
   - 6.3 REST API
   - 6.4 MCP Server
   - 6.5 Startup Reconciliation
   - 6.6 Core Loop
7. [MCP Tool Surface](#7-mcp-tool-surface)
8. [CLI Harness Connections](#8-cli-harness-connections)
9. [Stage Definitions](#9-stage-definitions)
   - 9.1 COOKING
   - 9.2 TODO
   - 9.3 ARCHITECTING
   - 9.4 SPECKING
   - 9.5 EXECUTION
   - 9.6 REVIEW
   - 9.7 TESTING
   - 9.8 DONE
   - 9.9 CANCEL
10. [Agent Specifications](#10-agent-specifications)
    - 10.1 Main Agent (OpenClaw)
    - 10.2 Architect Agent
    - 10.3 Spec Agent
    - 10.4 Execution Agent
    - 10.5 Review Agent
    - 10.6 Testing Agent
11. [Knowledge Base](#11-knowledge-base)
12. [PRIORITY.MD Schema](#12-prioritymd-schema)
13. [DEPS.MD Schema](#13-depsmd-schema)
14. [Context Window Hygiene](#14-context-window-hygiene)
15. [Concurrency Configuration](#15-concurrency-configuration)
16. [Retry & Escalation Logic](#16-retry--escalation-logic)
17. [SLA Timeouts](#17-sla-timeouts)
18. [State Machine](#18-state-machine)
19. [Pipeline Configuration File](#19-pipeline-configuration-file)
20. [Appendices](#20-appendices)

---

## 1. Design Principles

**1. Filesystem for content. SQLite for state. MCP for signaling.**  
Task folders live on disk — agents read and write files naturally. The Orchestrator's authoritative state (task status, stage, retry counts, timestamps, agent PIDs) lives in SQLite. Agents communicate outcomes to the Orchestrator through MCP tool calls, never by writing signal files or touching PRIORITY.MD directly.

**2. Folders are atomic units.**  
A task is always a folder. It moves whole between stages. No agent moves folders directly. Folder moves are performed exclusively by the Orchestrator inside a SQLite transaction, with move-first/commit-second ordering and startup reconciliation to handle crash recovery.

**3. Orchestrator owns all state transitions.**  
No agent mutates pipeline state directly. Agents read task content from disk, do their work, and call Orchestrator MCP tools to report outcomes. The Orchestrator validates, updates SQLite, moves the folder, and schedules the next agent.

**4. Human controls COOKING exit only.**  
No task leaves COOKING without an explicit human command. Every other transition is fully autonomous.

**5. Single harness per stage, configurable concurrency.**  
Each stage has a `max_agents` setting (default: 1). Increase per stage as confidence grows. The Orchestrator never exceeds the configured limit.

**6. Two independent retry counters.**  
`stage_attempts` — resets on each new stage entry, drives model escalation within a visit. `lifetime_bounces` — never resets, catches infinite back-and-forth loops between stages.

**7. Context manifest before every agent spawn.**  
The Orchestrator builds a `.context-manifest.txt` for each task folder before invoking any agent. Agents read only listed files. Build artifacts, lockfiles, and logs are excluded globally. Total manifest size is checked against a configurable threshold before spawn.

**8. Fail loud, never silently.**  
Agent failures are written to SQLite, appended to `PIPELINE.log`, and trigger notifications. Tasks never disappear silently into a broken state.

**9. Every state transition is logged.**  
`PIPELINE.log` at the repo root receives a structured JSON line for every move, agent spawn, retry, failure, and cancellation.

---

## 2. Build Language Decision

### Verdict: Python for Orchestrator. Rust stays in openclaw-browser.

The Orchestrator's work is waiting — for MCP tool calls to arrive, for agent processes to exit, for SLA timers to fire. It is never CPU-bound. Python's `asyncio` handles all of this cleanly, and rapid iteration matters enormously in the first months of a new system.

**Python wins because:**
- `FastAPI` + `asyncio` for the REST API and MCP server
- `aiosqlite` for async SQLite access
- `watchdog` for filesystem event detection (startup reconciliation, COOKING watch)
- `typer` + `rich` for the `pipeline` CLI (`push`, `status`, `cancel`, `reprioritize`)
- Exception tracebacks are human-readable during early debugging
- Every structural change (new stage, new tool, new config key) takes minutes

**Rust stays where it already is:** the `openclaw-browser` replay engine. It is invoked by the Testing Agent as a subprocess. The Orchestrator calls it via CLI. The language boundary is clean.

**Future migration signal:** when you want agents on different machines. At that point, replace the local SQLite with Postgres, expose the MCP server over SSE publicly, and replace `fs.rename()` with an object store (S3/R2) prefix move. The folder-as-task-unit model ports over cleanly — only the storage backend changes.

---

## 3. System Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         Orchestrator                             │
│                                                                  │
│  ┌────────────────┐   ┌──────────────┐   ┌───────────────────┐  │
│  │  MCP Server    │   │  REST API    │   │  SQLite           │  │
│  │  :3100         │──▶│  :3000       │──▶│  pipeline.db      │  │
│  │  (stdio/SSE)   │   │  (internal)  │   │                   │  │
│  └────────────────┘   └──────────────┘   └───────────────────┘  │
│           ▲                  ▲                     │             │
│           │                  │              State reads/writes   │
│    MCP tool calls      Health, metrics,            │             │
│    from agents         admin commands     ┌────────▼──────────┐  │
│                                           │  Filesystem        │  │
└───────────────────────────────────────────│  /pipeline-root/   │  │
                                            │  (task folders)    │  │
                                            └────────────────────┘  │
            │
            │  MCP protocol
    ┌───────┼────────────────────────────────┐
    │       │                                │
    ▼       ▼                                ▼
Claude Code            CODEX CLI         Gemini CLI
(Architect,            (Execution +      (Testing)
 Spec, Review)          wrapper script)
```

**Data flow summary:**
- Task *content* (specs, notes, code references) lives on the filesystem in task folders.
- Task *state* (stage, status, retry counts, timestamps) lives in SQLite.
- Agent *signaling* (done, back, cancel, priority patch) happens through MCP tool calls to the Orchestrator.
- The Orchestrator is the only process that moves folders and writes PRIORITY.MD.

---

## 4. Repository & Filesystem Structure

```
pipeline-root/
│
├── PIPELINE.log                    # Orchestrator audit log (append-only JSON lines)
├── pipeline.config.yaml            # Master configuration
├── .pipelineignore                 # Global context exclusions (gitignore syntax)
│
├── KNOWLEDGE/
│   ├── ARCHITECTURE.md             # Living system architecture — mandatory agent context
│   ├── TECH-STACK.md               # Languages, frameworks, infrastructure
│   ├── CONVENTIONS.md              # Naming, structure, coding conventions
│   └── DECISIONS/
│       └── ADR-001-*.md            # Architecture Decision Records
│
├── COOKING/                        # Human + Main Agent workspace (Orchestrator does not watch)
│   └── <task-id>/
│       ├── SPEC.md                 # STATUS: DRAFT|REVIEW|AGREED|REJECTED|STALLED
│       └── [supporting files]
│
├── TODO/
│   ├── PRIORITY.md                 # Written by Orchestrator only
│   └── <task-id>/
│
├── ARCHITECTING/
│   ├── PRIORITY.md
│   └── <task-id>/
│
├── SPECKING/
│   ├── PRIORITY.md
│   └── <task-id>/
│
├── EXECUTION/
│   ├── PRIORITY.md
│   └── <task-id>/
│
├── REVIEW/
│   ├── PRIORITY.md
│   └── <task-id>/
│
├── TESTING/
│   ├── PRIORITY.md
│   └── <task-id>/
│
├── DONE/
│   ├── <task-id>/
│   │   └── COMPLETION.md
│   └── archive/
│
├── CANCEL/
│   └── <task-id>/
│       └── CANCEL-REASON.md
│
└── orchestrator/
    ├── main.py
    ├── api/
    │   ├── rest.py                 # FastAPI REST endpoints
    │   └── mcp.py                  # MCP server implementation
    ├── core/
    │   ├── db.py                   # SQLite access layer (aiosqlite)
    │   ├── scheduler.py            # Stage promotion, concurrency enforcement
    │   ├── filesystem.py           # Folder move, context manifest builder
    │   ├── priority.py             # PRIORITY.MD writer (SQLite → markdown)
    │   └── reconciler.py           # Startup crash recovery
    ├── agents/
    │   ├── base.py                 # Subprocess spawn, PID tracking
    │   ├── architect.py
    │   ├── spec.py
    │   ├── execution.py            # Includes CODEX wrapper script logic
    │   ├── review.py
    │   └── testing.py
    ├── prompts/
    │   ├── architect.md
    │   ├── spec.md
    │   ├── execution.md
    │   ├── review.md
    │   └── testing.md
    ├── pipeline.db                 # SQLite database
    └── pyproject.toml
```

---

## 5. File Artifact Catalog

Files written inside task folders, by whom, and when:

| File | Written By | Stage Created | Purpose |
|------|-----------|--------------|---------|
| `SPEC.md` | Main Agent + Human | COOKING | Task definition. Contains STATUS field. |
| `SPEC-DETAILS/HLD.md` | Architect Agent | ARCHITECTING | High-level design for single tasks. |
| `<subtask-N>/SPEC.md` | Architect Agent | ARCHITECTING | Scoped spec for each split subtask. |
| `DEPS.MD` | Architect Agent | ARCHITECTING | Dependency graph for split tasks. |
| `ARCHITECT-NOTES.md` | Architect Agent | ARCHITECTING | Reasoning when returning task to COOKING. |
| `<subtask-N>/TASK-SPEC.md` | Spec Agent | SPECKING | Granular developer-ready specification. |
| `EXECUTION-NOTES.md` | Execution Agent | EXECUTION | Implementation decisions, deviations from spec. |
| `REVIEW-NOTES.md` | Review Agent | REVIEW | Checklist results, PASS/FAIL verdict, issue list. |
| `TEST-RESULTS.md` | Testing Agent | TESTING | Full test run evidence, per-criterion verdict. |
| `COMPLETION.md` | Testing Agent | DONE | Summary of what was delivered. |
| `CANCEL-REASON.md` | Orchestrator | CANCEL | Reason, source stage, triggering agent. |
| `.context-manifest.txt` | Orchestrator | Any | List of files the agent is allowed to read. Written before every agent spawn. |
| `AGENT.log` | Orchestrator | Any | Captured stdout/stderr from the agent process. |

**No signal files.** There are no `DONE.signal`, `BACK.signal`, or `CANCEL.signal` files. Agents communicate outcomes exclusively through MCP tool calls (see §7).

**No PRIORITY-PATCH.md.** Priority updates are submitted through the `orchestrator_patch_priority` MCP tool call. The Orchestrator writes PRIORITY.MD from SQLite as a human-readable view — it is never an input.

---

## 6. Orchestrator

### 6.1 Responsibilities

1. **MCP server** — accepts tool calls from agents (claim task, signal outcome, patch priority, append knowledge)
2. **REST API** — internal endpoints for health, metrics, admin commands (`cancel`, `reprioritize`, `pause`, `resume`)
3. **SQLite state keeper** — authoritative source of truth for all task state
4. **Stage scheduler** — promotes tasks between stages respecting concurrency limits and dependency constraints
5. **Filesystem manager** — sole process that moves task folders; generates context manifests before agent spawn
6. **PRIORITY.MD writer** — regenerates human-readable PRIORITY.MD files from SQLite after every state change
7. **SLA enforcer** — tracks agent start timestamps; kills and requeues agents that exceed timeout
8. **Startup reconciler** — on restart, detects divergence between SQLite state and filesystem, corrects discrepancies
9. **Notifier** — sends webhook/Slack/email on task failure, loop detection, SLA breach
10. **Logger** — appends structured JSON lines to `PIPELINE.log` for every state transition

### 6.2 SQLite Schema

```sql
CREATE TABLE tasks (
    id                TEXT PRIMARY KEY,
    stage             TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'PENDING',
    -- PENDING | WIP | BLOCKED | BackFromReview | BackFromTest |
    -- BackFromCooking | FAILED | LOOP_DETECTED | DONE | CANCELLED
    priority          TEXT NOT NULL DEFAULT 'P2',  -- P1 | P2 | P3
    complexity        TEXT,                         -- S | M | L | XL
    task_path         TEXT NOT NULL,
    parent_task_id    TEXT REFERENCES tasks(id),    -- for subtasks
    stage_attempts    INTEGER NOT NULL DEFAULT 0,
    lifetime_bounces  INTEGER NOT NULL DEFAULT 0,
    current_model     TEXT,
    agent_pid         INTEGER,
    entered_stage_at  DATETIME,
    started_at        DATETIME,
    completed_at      DATETIME,
    created_at        DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at        DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE dependencies (
    task_id           TEXT NOT NULL REFERENCES tasks(id),
    depends_on        TEXT NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE priority_patches (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id           TEXT NOT NULL REFERENCES tasks(id),
    action            TEXT NOT NULL,  -- set_priority | set_status
    value             TEXT NOT NULL,
    reason            TEXT,
    agent             TEXT,
    applied           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pipeline_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id           TEXT,
    event_type        TEXT NOT NULL,
    stage_from        TEXT,
    stage_to          TEXT,
    agent             TEXT,
    model             TEXT,
    details           TEXT,           -- JSON blob
    created_at        DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE knowledge_appends (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    section           TEXT NOT NULL,
    content           TEXT NOT NULL,
    agent             TEXT,
    task_id           TEXT,
    applied           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        DATETIME NOT NULL DEFAULT (datetime('now'))
);
```

### 6.3 REST API

Internal endpoints, not exposed to agents. Used by the `pipeline` CLI and admin tooling.

```
GET  /health                        → { status, db_ok, tasks_active }
GET  /metrics                       → stage counts, throughput, avg latency
GET  /tasks                         → list all tasks with filters
GET  /tasks/{id}                    → full task record
POST /tasks/{id}/cancel             → cancel a task from any stage
POST /tasks/{id}/reprioritize       → change priority
POST /tasks/{id}/retry              → manually requeue a FAILED task
POST /pipeline/pause                → pause all agent spawning
POST /pipeline/resume               → resume
GET  /pipeline/log?tail=100         → last N log lines
```

### 6.4 MCP Server

Runs on `:3100`. Supports both stdio (for Claude Code local connections) and SSE (for Gemini CLI remote connections). Authenticates via bearer token (`PIPELINE_TOKEN` env var).

Tool definitions are in §7.

### 6.5 Startup Reconciliation

On every startup, the Orchestrator runs a reconciliation scan before accepting any connections:

```python
async def reconcile():
    """
    Compare SQLite state against filesystem reality.
    Filesystem is ground truth for folder location.
    SQLite is ground truth for status values.
    """
    for stage_dir in STAGE_DIRS:
        for task_folder in stage_dir.iterdir():
            task_id = task_folder.name
            db_record = await db.get_task(task_id)

            if db_record is None:
                # Folder exists, no DB record — orphaned folder
                log.warning("orphan_folder", task_id=task_id, stage=stage_dir.name)
                await db.insert_task_from_folder(task_folder, stage_dir.name)

            elif db_record.stage != stage_dir.name:
                # Folder is in different stage than DB says — crash mid-move
                # Filesystem wins: update DB to match folder location
                log.warning("stage_mismatch", task_id=task_id,
                           db_stage=db_record.stage, fs_stage=stage_dir.name)
                await db.set_stage(task_id, stage_dir.name)
                await db.set_status(task_id, 'PENDING')

            elif db_record.status == 'WIP' and db_record.agent_pid is None:
                # WIP with no PID — agent died without reporting.
                # Reset to PENDING for requeue. The execution wrapper will
                # run git reset --hard + git clean on the next attempt.
                log.warning("wip_no_pid", task_id=task_id)
                await db.set_status(task_id, 'PENDING')
                await db.increment_stage_attempts(task_id)
```

### 6.6 Core Loop

```python
# Module-level lock — ensures knowledge appends are never applied concurrently.
# Two ARCHITECTING agents completing simultaneously both INSERT into knowledge_appends
# via the MCP tool (safe — SQLite handles concurrent inserts). This lock serializes
# the drain loop so file writes happen one at a time in created_at order.
_knowledge_lock = asyncio.Lock()

async def process_knowledge_appends():
    """Drain pending knowledge_appends table → KNOWLEDGE/ARCHITECTURE.md sequentially."""
    async with _knowledge_lock:
        rows = await db.fetch_unapplied_knowledge_appends()  # ORDER BY created_at ASC
        for row in rows:
            target = pipeline_root / "KNOWLEDGE" / "ARCHITECTURE.md"
            async with aiofiles.open(target, "a") as f:
                await f.write(f"\n### {row.section}\n{row.content}\n")
            await db.mark_knowledge_applied(row.id)
            log.info("knowledge_appended", section=row.section, task_id=row.task_id)

async def orchestrator_loop():
    while True:
        await process_knowledge_appends()   # serialized — see lock above
        await process_priority_patches()    # apply pending priority updates

        for stage in PIPELINE_STAGES:
            active  = await db.count_wip(stage)
            slots   = config.max_agents[stage] - active
            pending = await db.fetch_pending(stage, limit=slots)

            for task in pending:
                deps_ok = await check_dependencies(task)
                if not deps_ok:
                    await db.set_status(task.id, 'BLOCKED')
                    continue
                await spawn_agent(stage, task)

        await check_sla_timers()
        await regenerate_priority_files()   # write PRIORITY.MD for each stage from SQLite
        await asyncio.sleep(config.tick_interval_seconds)
```

**Folder move protocol** (move-first, commit-second):

```python
async def move_task(task_id: str, from_stage: str, to_stage: str):
    src = pipeline_root / from_stage / task_id
    dst = pipeline_root / to_stage / task_id

    # 1. Move on filesystem first
    shutil.move(str(src), str(dst))

    try:
        # 2. Commit to SQLite
        async with db.transaction():
            await db.update(task_id, stage=to_stage, status='PENDING',
                           entered_stage_at=utcnow(), stage_attempts=0)
            await db.log_event(task_id, 'stage_transition',
                              stage_from=from_stage, stage_to=to_stage)
    except Exception:
        # Rollback: move folder back
        shutil.move(str(dst), str(src))
        raise
```

If the process crashes between the filesystem move and the SQLite commit, startup reconciliation (§6.5) detects and corrects the discrepancy on next start.

---

## 7. MCP Tool Surface

The Orchestrator exposes exactly six tools. This is the complete agent↔orchestrator protocol. No agent writes signal files, patches PRIORITY.MD, or moves folders.

```typescript
/**
 * Agent pulls its assigned task for a given stage.
 * Orchestrator marks task as WIP in SQLite.
 * Returns null if no task is available (agent should exit cleanly).
 */
orchestrator_claim_task(
    stage: string               // "ARCHITECTING" | "SPECKING" | etc.
) → {
    task_id: string,
    task_path: string,          // absolute path to task folder on disk
    context_manifest: string,   // path to .context-manifest.txt
    priority: string,
    complexity: string,
    stage_attempts: number,     // which attempt this is (drives model escalation)
} | null


/**
 * Agent reports successful completion of its stage work.
 * Orchestrator moves folder to next stage, updates SQLite.
 */
orchestrator_signal_done(
    task_id: string,
    notes?: string              // optional — written to AGENT.log
) → { ok: true }


/**
 * Agent reports that the task must return to a prior stage.
 * Orchestrator moves folder back, increments lifetime_bounces, updates SQLite.
 */
orchestrator_signal_back(
    task_id: string,
    target_stage: string,       // "COOKING" | "SPECKING" | "EXECUTION"
    reason: string              // mandatory — written to task folder log
) → { ok: true }


/**
 * Agent requests task cancellation.
 * Orchestrator moves folder to CANCEL, writes CANCEL-REASON.md.
 */
orchestrator_signal_cancel(
    task_id: string,
    reason: string
) → { ok: true }


/**
 * Agent submits a priority or status update.
 * Orchestrator queues the patch; applies it on next tick.
 */
orchestrator_patch_priority(
    task_id: string,
    action: "set_priority" | "set_status",
    value: string,
    reason: string
) → { ok: true }


/**
 * Agent appends an architecture decision or note to KNOWLEDGE/ARCHITECTURE.md.
 * Orchestrator queues the append; applies it on next tick with file locking.
 */
orchestrator_append_knowledge(
    section: string,            // e.g. "Decision: 2026-03-25 auth-refactor-003"
    content: string
) → { ok: true }
```

---

## 8. CLI Harness Connections

### Claude Code (Architect, Spec, Review agents)

MCP connection via stdio — the Orchestrator MCP server is launched as a subprocess by Claude Code using the project-level MCP config:

```json
// .claude/mcp.json  (committed to pipeline repo root)
{
  "mcpServers": {
    "orchestrator": {
      "command": "python",
      "args": ["-m", "orchestrator.mcp", "--transport", "stdio"],
      "env": {
        "ORCHESTRATOR_DB": "/path/to/pipeline.db",
        "PIPELINE_TOKEN": "${PIPELINE_TOKEN}"
      }
    }
  }
}
```

Agent session flow:
1. Claude Code starts, MCP handshake completes.
2. Agent calls `orchestrator_claim_task("<stage>")` — receives task path + context manifest.
3. Agent reads files from disk per manifest.
4. Agent does its work, writes output files to disk.
5. Agent calls `orchestrator_signal_done(task_id)` or `orchestrator_signal_back(...)`.
6. Session ends.

### Gemini CLI (Testing Agent)

MCP connection via SSE — Gemini CLI connects to the Orchestrator's SSE endpoint:

```json
// .gemini/settings.json
{
  "mcpServers": {
    "orchestrator": {
      "url": "http://localhost:3100/mcp/sse",
      "headers": {
        "Authorization": "Bearer ${PIPELINE_TOKEN}"
      }
    }
  }
}
```

Same six tools, same flow. SSE transport instead of stdio.

### CODEX CLI (Execution Agent)

CODEX CLI uses the OpenAI Responses API tool format, not MCP natively. A thin Python wrapper script bridges the gap:

```python
# orchestrator/agents/execution_wrapper.py
# The Orchestrator spawns THIS script, not CODEX directly.

async def main():
    # 1. Claim task via Orchestrator REST API (internal)
    task = await orchestrator_api.claim_task("EXECUTION")
    if not task:
        sys.exit(0)   # No work available, clean exit

    # 2. If this is a retry (stage_attempts > 1), sanitize git state before
    #    the agent touches anything. A crashed prior attempt may have left
    #    half-written files, staged hunks, merge conflicts, or a detached HEAD.
    if task.stage_attempts > 1:
        repo_root = await git_repo_root(task.task_path)
        await run([
            "git", "-C", repo_root,
            "checkout", f"feature/{task.task_id}"   # ensure on correct branch
        ])
        await run([
            "git", "-C", repo_root,
            "reset", "--hard", "HEAD"               # discard all staged/unstaged changes
        ])
        await run([
            "git", "-C", repo_root,
            "clean", "-fd"                          # remove untracked files and dirs
        ])
        log.info("git_clean_on_retry", task_id=task.task_id, attempt=task.stage_attempts)

    # 3. Spawn CODEX CLI as subprocess, injecting task context
    result = await run_codex(
        model=select_model(task.stage_attempts),
        system_prompt=load_prompt("execution.md"),
        env={
            "PIPELINE_TASK_PATH": task.task_path,
            "PIPELINE_TASK_ID":   task.task_id,
            "PIPELINE_MANIFEST":  task.context_manifest,
        }
    )

    # 3. Report outcome based on CODEX exit code + written EXECUTION-NOTES.md
    if result.success:
        await orchestrator_api.signal_done(task.task_id, result.notes)
    else:
        await orchestrator_api.signal_back(task.task_id, "SPECKING", result.error)

def select_model(attempt: int) -> str:
    return {1: "gpt-5.3-codex", 2: "gpt-5.3-codex",
            3: "claude-sonnet-4-6", 4: "claude-sonnet-4-6"}.get(attempt, "gpt-5.3-codex")
```

The wrapper uses the Orchestrator's internal REST API (not MCP) for task claim and signal — simpler than an MCP client for a script that lives inside the Orchestrator codebase. CODEX itself has no awareness of the pipeline; it receives a task path and writes files.

---

## 9. Stage Definitions

### 9.1 COOKING

**Purpose:** Human + Main Agent collaborative workspace.

**Entry:** Human creates `<task-id>/SPEC.md` manually inside COOKING/.

**Exit:** Human issues `/approve <task-id>` in OpenClaw. Main Agent writes `STATUS: AGREED` to SPEC.md and calls `orchestrator_patch_priority` with priority and complexity. Orchestrator moves folder to TODO and inserts into SQLite.

**The Orchestrator does not watch COOKING.** It only acts when the `/approve` command triggers the REST API `POST /tasks/{id}/approve`.

**SPEC.md STATUS lifecycle:**

| Status | Set By | Meaning |
|--------|--------|---------|
| `DRAFT` | Main Agent | Initial exploration |
| `REVIEW` | Main Agent | Ready for human decision |
| `AGREED` | Human (via /approve) | Approved for pipeline entry |
| `REJECTED` | Human | Rejected, stays in COOKING |
| `STALLED` | Main Agent (after N=10 iterations) | Surfaces to human for resolution |

---

### 9.2 TODO

**Purpose:** Ordered queue awaiting architectural review.

**No agent runs here.** Pure queue managed by the Orchestrator.

**Orchestrator behavior on task arrival:**
1. Inserts task into SQLite with stage=TODO, status=PENDING.
2. Writes PRIORITY.MD for the TODO folder.
3. On next tick: if ARCHITECTING slot available, promotes immediately.

---

### 9.3 ARCHITECTING

**Agent:** Architect Agent — Claude Code, `opusplan[1m]`, effort `high`

**Mandatory context (from manifest):**
- `KNOWLEDGE/ARCHITECTURE.md`
- `KNOWLEDGE/TECH-STACK.md`
- `KNOWLEDGE/CONVENTIONS.md`
- Full task folder (SPEC.md + supporting files)

**Decisions and actions:**

| Decision | Files Written | MCP Call |
|----------|--------------|----------|
| Approve — simple task | `SPEC-DETAILS/HLD.md` | `signal_done` |
| Approve — split task | `subtask-N/SPEC.md` for each, `DEPS.MD` | `signal_done` |
| Return to COOKING | `ARCHITECT-NOTES.md` | `signal_back(target: COOKING)` |

After approving, Architect Agent calls `orchestrator_append_knowledge` with any architecture decisions made.

---

### 9.4 SPECKING

**Agent:** Spec Agent — Claude Code, `claude-sonnet-4-6`

**Mandatory context (from manifest):**
- Full task folder recursively (SPEC.md, SPEC-DETAILS/HLD.md or subtask SPECs, DEPS.MD)
- `KNOWLEDGE/ARCHITECTURE.md`

**Behavior:** Writes `TASK-SPEC.md` inside each subtask folder (or at task root for simple tasks). When all files are written, calls `signal_done`.

**Required `TASK-SPEC.md` sections:**

```markdown
# Task Spec: <subtask-id>

## Objective
One paragraph.

## Files to Create / Modify
- `path/to/file` — create|modify — purpose

## Implementation Notes
Step-by-step technical guidance.

## Function Signatures / Data Schemas
Exact signatures, types, interfaces.

## Unit Tests Required
List with inputs and expected outputs.

## E2E Tests Required
List of scenarios. No behavioral mocks.
Contract-recorded stubs permitted for third-party APIs only.

## Acceptance Criteria
1. Binary-verifiable statement.
2. Binary-verifiable statement.

## Dependencies
depends_on: [subtask-A, subtask-B]
```

---

### 9.5 EXECUTION

**Agent:** Execution Agent  
**Harness (primary):** CODEX CLI, `gpt-5.3-codex` (orchestration) + `gpt-5.4-mini` (subagents)  
**Harness (fallback, attempt 3+):** Claude Code, `claude-sonnet-4-6`

**Dependency enforcement:** The Orchestrator will not promote a subtask to EXECUTION if any `depends_on` entries are not yet in DONE. Status set to BLOCKED until dependencies clear.

**Branch discipline:**
- Agent creates `feature/<task-id>` before any changes.
- All commits scoped to that branch.
- Commit format: `[<task-id>] <description>`

**Agent writes:**
- Implemented code on feature branch
- Unit tests (all passing)
- E2E tests (real instances; contract stubs for third-party APIs)
- `EXECUTION-NOTES.md`

**MCP calls:**
- On success: `signal_done(task_id)`
- On blocker: `signal_back(task_id, target: "SPECKING", reason)`

---

### 9.6 REVIEW

**Agent:** Review Agent — Claude Code, `claude-opus-4-6[1m]`, effort `high`, extended thinking

**Mandatory context (from manifest):**
- `KNOWLEDGE/ARCHITECTURE.md`, `KNOWLEDGE/CONVENTIONS.md`
- `TASK-SPEC.md`, `EXECUTION-NOTES.md`
- Git diff of `feature/<task-id>` vs `main`

**Review checklist (agent must address every item):**

```
[ ] 1. Every acceptance criterion in TASK-SPEC.md is satisfied
[ ] 2. No security issues (injection, auth bypass, secrets in code, insecure deps)
[ ] 3. Code conforms to KNOWLEDGE/CONVENTIONS.md
[ ] 4. Architecture aligns with KNOWLEDGE/ARCHITECTURE.md
[ ] 5. Unit tests meaningful — cover edge cases, not only happy path
[ ] 6. E2E tests present and non-mocked (behavioral mock = automatic FAIL)
[ ] 7. No performance red flags (N+1 queries, unbounded loops, missing indexes)
[ ] 8. No dead code, commented-out code, or debug artifacts
[ ] 9. Error handling explicit and appropriate
[ ] 10. No breaking changes to public APIs without spec authorization
```

**Review Agent never fixes code.** Judges and annotates only.

**MCP calls:**
- PASS: writes `REVIEW-NOTES.md` (verdict + advisory), calls `signal_done`
- FAIL: writes `REVIEW-NOTES.md` (verdict + numbered issues with file:line), calls `signal_back(target: "EXECUTION")`

---

### 9.7 TESTING

**Agent:** Testing Agent — Gemini CLI, `gemini-3.1-pro-preview` (auto-routing to `gemini-2.5-flash` for lightweight steps)

**Tools available:**
- Browser Agent (Gemini CLI) — UI testing, navigation, form interaction
- Terminal/shell — run test suites, build commands
- Git operations — read branch, verify commits
- API clients — hit real endpoints

**Testing protocol:**

1. Run unit test suite. Record counts. Any failure → FAIL.
2. Run E2E test suite against real instances. Any failure → FAIL.
3. Browser Agent: walk through every UI acceptance criterion from TASK-SPEC.md.
4. Verify each numbered acceptance criterion with explicit evidence.

**MCP calls:**
- PASS: writes `TEST-RESULTS.md` and `COMPLETION.md`, runs `git merge feature/<task-id> && git push`, calls `signal_done`
- FAIL: writes `TEST-RESULTS.md` with per-criterion evidence, calls `signal_back(target: "EXECUTION")`, calls `patch_priority(status: BackFromTest)`

---

### 9.8 DONE

All successfully completed tasks. Testing Agent writes `COMPLETION.md` before calling `signal_done`.

Orchestrator archives folders older than `done_retention_days` (default: 90) to `DONE/archive/` automatically.

---

### 9.9 CANCEL

Accumulates cancelled tasks. Any agent can trigger cancellation via `orchestrator_signal_cancel`. Human can trigger via `POST /tasks/{id}/cancel` REST endpoint.

Orchestrator writes `CANCEL-REASON.md`:

```markdown
# Cancellation Record
- task_id: <id>
- cancelled_at: <timestamp>
- cancelled_from_stage: <stage>
- triggered_by: <agent | human>
- reason: <text>
```

---

## 10. Agent Specifications

### 10.1 Main Agent — OpenClaw

**Model:** `claude-opus-4-6`, effort `high`

**System prompt core:**
```
You are the Main Agent of an autonomous software production pipeline.
Your role: work with the human to develop, debate, and formalize task ideas
in the COOKING folder before they enter the automated pipeline.

Always read KNOWLEDGE/ARCHITECTURE.md before discussing any technical task.

Responsibilities:
1. Help the human clarify vague ideas into precise SPEC.md documents.
2. Ask probing questions: scope, edge cases, dependencies, priority.
3. Evolve SPEC.md STATUS: DRAFT → REVIEW → AGREED.
4. When the human approves (/approve), call orchestrator_patch_priority with
   priority (P1/P2/P3) and complexity (S/M/L/XL).
5. After 10 iterations with no resolution, set STATUS: STALLED and
   notify the human explicitly.
6. You may NEVER move a task folder yourself. Only the human's /approve
   triggers the Orchestrator to move it.

SPEC.md required fields:
- STATUS: <value>
- Priority: P1|P2|P3
- Complexity: S|M|L|XL
- Description: what and why
- Acceptance Criteria: numbered, binary-verifiable
- Out of Scope: explicit exclusions
- Supporting Notes: anything the Architect should know
```

**MCP tools used:** `orchestrator_patch_priority`

---

### 10.2 Architect Agent — Claude Code

**Model:** `claude-opus-4-6` via `opusplan[1m]`, effort `high`

**System prompt core:**
```
You are the Architect Agent. You are the guardian of architectural integrity.

MANDATORY FIRST STEP:
Read every file listed in .context-manifest.txt. Read nothing else.
This includes: KNOWLEDGE/ARCHITECTURE.md, KNOWLEDGE/TECH-STACK.md,
KNOWLEDGE/CONVENTIONS.md, and the full task folder.

DECISION 1 — APPROVE (simple task):
- Create SPEC-DETAILS/ folder
- Write HLD.md covering: affected components, data flow changes,
  API contracts, security considerations, performance implications,
  migration steps if any
- Call orchestrator_signal_done

DECISION 2 — APPROVE (split into subtasks):
- Create subtask-01/, subtask-02/, ... folders
- Write SPEC.md in each (scoped, self-contained)
- Write DEPS.MD at task root defining dependency relationships
- Call orchestrator_signal_done

DECISION 3 — RETURN TO COOKING:
- Write ARCHITECT-NOTES.md: specific concerns (numbered),
  questions needing answers, alternative approaches
- Call orchestrator_signal_back with target_stage: COOKING

MANDATORY FINAL STEP (DECISION 1 or 2 only):
Call orchestrator_append_knowledge with any architecture decisions made.

Never write code. Your output is documentation and structure only.
```

**MCP tools used:** `orchestrator_claim_task`, `orchestrator_signal_done`, `orchestrator_signal_back`, `orchestrator_append_knowledge`

---

### 10.3 Spec Agent — Claude Code

**Model:** `claude-sonnet-4-6`

**System prompt core:**
```
You are the Spec Agent. You translate architectural designs into
precise, developer-ready TASK-SPEC.md documents.

MANDATORY FIRST STEP:
Read every file listed in .context-manifest.txt only.
Determine: simple task (has SPEC-DETAILS/HLD.md) or split task (has subtask-N/ folders)?

For SIMPLE TASKS: write TASK-SPEC.md at the task root.
For SPLIT TASKS: write TASK-SPEC.md inside EACH subtask-N/ folder.

Each TASK-SPEC.md must contain ALL required sections (see §9.4).
The spec must be complete enough that a developer with zero other context
can implement it correctly. Leave nothing ambiguous.

When all TASK-SPEC.md files are written:
Call orchestrator_signal_done.
```

**MCP tools used:** `orchestrator_claim_task`, `orchestrator_signal_done`, `orchestrator_signal_back`

---

### 10.4 Execution Agent — CODEX CLI (via wrapper)

**Primary model:** `gpt-5.3-codex` + `gpt-5.4-mini` subagents  
**Fallback model (attempt 3+):** `claude-sonnet-4-6` via Claude Code

**System prompt core:**
```
You are a Senior Software Developer. You implement tasks exactly
as specified in TASK-SPEC.md.

MANDATORY FIRST STEP:
1. Read KNOWLEDGE/ARCHITECTURE.md and KNOWLEDGE/CONVENTIONS.md.
2. Read TASK-SPEC.md in the task folder at $PIPELINE_TASK_PATH.
3. Verify you are on branch feature/<task-id>. Create if absent.
Read ONLY files listed in $PIPELINE_MANIFEST.

IMPLEMENTATION RULES:
- Follow TASK-SPEC.md exactly.
- Any deviation must be documented in EXECUTION-NOTES.md with justification.
- Every function/module must have a corresponding unit test.
- E2E tests must use real instances. Behavioral mocks are forbidden.
  For third-party APIs, use contract-recorded stubs (VCR/WireMock).
- Commit frequently: [<task-id>] <description>
- Never commit secrets, debug artifacts, or files outside spec scope.

WHEN DONE:
- Ensure all unit tests pass locally.
- Ensure E2E tests pass.
- Write EXECUTION-NOTES.md.
- Exit with code 0 (wrapper calls signal_done).

WHEN BLOCKED:
- Write EXECUTION-NOTES.md with blocker.
- Exit with code 1 (wrapper calls signal_back to SPECKING).
```

**Signaling:** Handled by wrapper script (§8), not by the agent directly.

---

### 10.5 Review Agent — Claude Code

**Model:** `claude-opus-4-6[1m]`, effort `high`, extended thinking

**System prompt core:**
```
You are a Senior Architect and Code Reviewer.
You review implementations for correctness, security, quality,
and architectural conformance. You NEVER modify code.

MANDATORY FIRST STEP:
Read every file listed in .context-manifest.txt.
This includes KNOWLEDGE files, TASK-SPEC.md, EXECUTION-NOTES.md,
and the full git diff of feature/<task-id> vs main.

Evaluate all 10 checklist items (see §9.6). Cite file:line evidence.

VERDICT RULES:
PASS: all 10 items pass. Write REVIEW-NOTES.md, call signal_done.
FAIL: any item fails. Write REVIEW-NOTES.md with numbered issues
      (file:line:issue format), call signal_back(target: EXECUTION).

Never fix code. Never leave a verdict ambiguous.
```

**MCP tools used:** `orchestrator_claim_task`, `orchestrator_signal_done`, `orchestrator_signal_back`

---

### 10.6 Testing Agent — Gemini CLI

**Model:** `gemini-3.1-pro-preview` (auto-routing)

**System prompt core:**
```
You are a Senior QA Engineer. You verify that implementations
satisfy all acceptance criteria in TASK-SPEC.md.

MANDATORY FIRST STEP:
Read files listed in .context-manifest.txt:
TASK-SPEC.md, EXECUTION-NOTES.md, REVIEW-NOTES.md,
KNOWLEDGE/ARCHITECTURE.md.

TESTING PROTOCOL — execute in order:
STEP 1: Run unit test suite. Any failure → FAIL verdict.
STEP 2: Run E2E suite against real instances. Any failure → FAIL verdict.
STEP 3: Browser Agent — walk each UI acceptance criterion.
         Record: criterion, steps, result, evidence.
STEP 4: Verify every acceptance criterion with explicit evidence.

ON PASS:
- Write TEST-RESULTS.md (full evidence)
- Write COMPLETION.md (summary of what was delivered)
- Run: git checkout main && git merge feature/<task-id> && git push
- Call orchestrator_signal_done

ON FAIL:
- Write TEST-RESULTS.md with per-criterion failure evidence
- Call orchestrator_signal_back(target: EXECUTION)
- Call orchestrator_patch_priority(status: BackFromTest)
```

**MCP tools used:** `orchestrator_claim_task`, `orchestrator_signal_done`, `orchestrator_signal_back`, `orchestrator_patch_priority`

---

## 11. Knowledge Base

`KNOWLEDGE/` is the institutional memory of the system. All agents that make architectural or implementation decisions must read it before acting. It is written by agents through `orchestrator_append_knowledge` — never by direct file write.

### KNOWLEDGE/ARCHITECTURE.md required structure:

```markdown
# System Architecture

## System Overview

## Module Map
| Module | Path | Responsibility |

## Data Models

## API Contracts

## Key Architectural Constraints
Hard rules that must never be violated.

## Infrastructure

## Open Decisions

## Decision Log
### Decision: <date> <task-id>
<what was decided and why>
```

### KNOWLEDGE/TECH-STACK.md required structure:

```markdown
# Technology Stack
- Language(s):
- Frameworks:
- Database(s):
- Message queue:
- Testing frameworks:
- CI/CD:
- Package manager:
- Linter/formatter:
```

### KNOWLEDGE/CONVENTIONS.md required structure:

```markdown
# Coding Conventions
- Naming: files, functions, variables, constants
- Folder structure rules
- Import ordering
- Error handling patterns
- Logging patterns
- Test file location and naming
- Commit message format: [<task-id>] <description>
- Branch naming: feature/<task-id>
```

---

## 12. PRIORITY.MD Schema

Written by the Orchestrator only, regenerated from SQLite after every state change. Human-readable view — never an input.

```markdown
# Priority Queue — <STAGE_NAME>
<!-- Orchestrator-managed. Source of truth is pipeline.db. Do not edit. -->

| # | Task ID | Priority | Status | Bounces | Entered |
|---|---------|----------|--------|---------|---------|
| 1 | auth-refactor-003 | P1 | WIP | 0 | 2026-03-19T10:00Z |
| 2 | gis-export-007    | P1 | PENDING | 0 | 2026-03-19T11:30Z |
| 3 | payroll-fix-012   | P2 | BLOCKED | 0 | 2026-03-19T09:00Z |
| 4 | news-feed-015     | P2 | BackFromTest | 2 | 2026-03-18T14:00Z |
| 5 | ui-cleanup-020    | P3 | PENDING | 0 | 2026-03-19T12:00Z |
```

**Status values:**

| Status | Meaning |
|--------|---------|
| `PENDING` | Waiting for an available agent slot |
| `WIP` | Currently being processed by an agent |
| `BLOCKED` | Dependencies not yet in DONE |
| `BackFromReview` | Returned from REVIEW for rework |
| `BackFromTest` | Returned from TESTING for rework |
| `BackFromCooking` | Architect returned it to COOKING |
| `FAILED` | Exceeded `max_attempts` for current stage, frozen |
| `LOOP_DETECTED` | Exceeded `max_lifetime_bounces`, frozen — human required |

---

## 13. DEPS.MD Schema

Written by Architect Agent inside the task folder root when splitting a task. Read by the Orchestrator before every EXECUTION slot allocation.

```yaml
# DEPS.MD
task_id: gis-export-007

subtasks:
  - id: subtask-01-data-model
    description: "Add export schema to database"
    depends_on: []

  - id: subtask-02-export-service
    description: "Implement export business logic"
    depends_on: [subtask-01-data-model]

  - id: subtask-03-api-endpoint
    description: "Expose export REST endpoint"
    depends_on: [subtask-02-export-service]

  - id: subtask-04-ui-trigger
    description: "Add export button to frontend"
    depends_on: [subtask-03-api-endpoint]
```

A subtask is not eligible for EXECUTION unless all entries in its `depends_on` list have `status = DONE` in SQLite.

---

## 14. Context Window Hygiene

### Context Manifest Generation

Before every agent spawn, the Orchestrator builds a context manifest using a **hybrid allowlist + denylist** strategy. A pure denylist (`.pipelineignore`) is fragile — any new tool that generates unexpected artifacts (`.coverage/`, `.mypy_cache/`, build outputs) will silently bloat agent context until the ignore file is updated. An allowlist is safer by default but too rigid if applied globally.

The hybrid approach: **allowlist by file extension first, then denylist by path pattern.**

```python
# Default allowlist — only these extensions are considered for inclusion
ALLOWED_EXTENSIONS = {
    # Specifications and documentation
    ".md", ".txt", ".rst", ".yaml", ".yml", ".toml", ".json",
    # Source code — extend per project in pipeline.config.yaml
    ".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".go", ".java",
    ".c", ".cpp", ".h", ".cs", ".rb", ".swift", ".kt",
    # Config and schema
    ".sql", ".graphql", ".proto", ".env.example",
    # Shell
    ".sh", ".bash",
}

def build_context_manifest(task_path: Path, config: Config) -> list[Path]:
    ignore = load_pipelineignore(task_path)   # global + task-level denylist
    allowed = []

    for f in task_path.rglob("*"):
        if not f.is_file():
            continue
        # Step 1: allowlist — must match an allowed extension
        if f.suffix.lower() not in config.allowed_extensions:
            continue
        # Step 2: denylist — must not match any ignore pattern
        if ignore.match(f.relative_to(task_path)):
            continue
        allowed.append(f)

    return allowed
```

The `allowed_extensions` set is configurable in `pipeline.config.yaml` under `context_hygiene.allowed_extensions`, so projects using less common extensions can extend it without modifying the Orchestrator source.

The denylist (`.pipelineignore`) remains in place as a **second filter** for cases where an allowed extension still shouldn't enter context — for example, auto-generated `.py` migration files in a `migrations/versions/` folder, or vendored `.rs` files in a `vendor/` directory.

### .pipelineignore

The denylist layer. Applies *after* the allowlist. Gitignore syntax.

```gitignore
# .pipelineignore — applied after extension allowlist
node_modules/
.venv/
__pycache__/
target/
dist/
build/
.git/
AGENT.log
*.log
*.lock
migrations/versions/       # example: exclude auto-generated migration files
vendor/
```

### Manifest Finalization

After the allowlist + denylist pass:

1. Compute total byte size of all allowed files.
2. If total exceeds `context_hygiene.max_context_bytes` (default: 3,355,443 bytes ≈ 800K tokens): log a warning, send a notification, pause the spawn. Human must acknowledge via `POST /tasks/{id}/retry` before the task proceeds.
3. Write the allowed file list to `.context-manifest.txt` in the task folder.
4. Pass the manifest path to the agent via env var `PIPELINE_MANIFEST`.

Agent system prompts explicitly instruct: *"Read ONLY the files listed in `.context-manifest.txt`. Do not traverse the folder freely."*

---

## 15. Concurrency Configuration

```yaml
concurrency:
  ARCHITECTING: 1      # Keep at 1 until architecture is stable
  SPECKING: 2
  EXECUTION: 3
  REVIEW: 1            # Sequential for quality
  TESTING: 2
```

Hot-reloaded on `SIGHUP` — no restart required to change concurrency limits.

---

## 16. Retry & Escalation Logic

### Two independent counters

| Counter | Scope | Resets? | Purpose |
|---------|-------|---------|---------|
| `stage_attempts` | Per-stage, per-visit | YES — on each new stage entry | Drives model escalation within a visit |
| `lifetime_bounces` | Entire task lifetime | NEVER | Detects infinite back-and-forth loops |

`stage_attempts` resets to 0 every time a task enters a stage — whether first visit or re-entry via `signal_back`. This ensures a full retry budget on every visit.

`lifetime_bounces` increments every time `orchestrator_signal_back` is called, regardless of source or target stage. When `lifetime_bounces >= max_lifetime_bounces` (default: 8), the Orchestrator sets status `LOOP_DETECTED`, freezes the task, and sends a notification. The task stays frozen until a human issues `POST /tasks/{id}/retry` with a manual override.

### Per-stage configuration

```yaml
retry:
  ARCHITECTING: { max_attempts: 2, on_exceed: notify }
  SPECKING:      { max_attempts: 3, on_exceed: notify }
  EXECUTION:     { max_attempts: 4, on_exceed: notify }
  REVIEW:        { max_attempts: 2, on_exceed: notify }
  TESTING:       { max_attempts: 3, on_exceed: notify }
  max_lifetime_bounces: 8
  on_loop_detected: notify
```

### EXECUTION model escalation (driven by `stage_attempts`)

```yaml
execution:
  model_escalation:
    attempt_1: gpt-5.3-codex       # CODEX CLI
    attempt_2: gpt-5.3-codex       # retry same
    attempt_3: claude-sonnet-4-6   # fallback: Claude Code
    attempt_4: claude-sonnet-4-6   # retry fallback
```

When a task re-enters EXECUTION from REVIEW (via `signal_back`), `stage_attempts` resets to 0 — model escalation restarts from `gpt-5.3-codex`. `lifetime_bounces` increments by 1.

---

## 17. SLA Timeouts

```yaml
sla_timeouts:
  ARCHITECTING: 3600    # 1 hour
  SPECKING: 1800        # 30 minutes
  EXECUTION: 14400      # 4 hours
  REVIEW: 3600          # 1 hour
  TESTING: 7200         # 2 hours
```

On timeout: kill agent process by PID, write `AGENT.log` entry (reason: timeout), increment `stage_attempts`, set status `PENDING` for requeue. If `stage_attempts >= max_attempts`: set status `FAILED`, notify.

---

## 18. State Machine

```
                    ┌──────────────────────────────┐
                    │           COOKING             │
                    │  Main Agent (OpenClaw)        │
                    │  Opus 4.6 / High              │
                    └─────────────┬────────────────┘
                    Human /approve + orchestrator_patch_priority
                                  │
                    ┌─────────────▼────────────────┐
                    │            TODO               │
                    │  Queue only — no agent        │
                    └─────────────┬────────────────┘
                    Orchestrator promotes (slot available)
                                  │
                    ┌─────────────▼────────────────┐
         ┌──────────│         ARCHITECTING          │
         │ signal_  │  Claude Code                  │
         │ back     │  Opus 4.6 opusplan[1m] / High │
         ▼          └─────────────┬────────────────┘
       COOKING       signal_done  │
                                  │
                    ┌─────────────▼────────────────┐
                    │           SPECKING            │
                    │  Claude Code                  │
                    │  Sonnet 4.6                   │
                    └─────────────┬────────────────┘
                     signal_done  │
                                  │
                    ┌─────────────▼────────────────┐
         ┌──────────│          EXECUTION            │◄──────────┐
         │ signal_  │  CODEX CLI                    │           │
         │ back     │  GPT-5.3-Codex (primary)      │           │
         ▼          │  Sonnet 4.6 (fallback)        │           │
       SPECKING      └─────────────┬────────────────┘      signal_back
                     signal_done   │                      (from REVIEW
                                   │                       or TESTING)
                    ┌──────────────▼───────────────┐           │
         ┌──────────│           REVIEW              │           │
         │ signal_  │  Claude Code                  │───────────┘
         │ back     │  Opus 4.6[1m] / High+Thinking │  signal_back
         ▼          └─────────────┬────────────────┘
       EXECUTION     signal_done  │
                                  │
                    ┌─────────────▼────────────────┐
         ┌──────────│           TESTING             │
         │ signal_  │  Gemini CLI                   │
         │ back     │  Gemini 3.1 Pro (auto-route)  │
         ▼          └─────────────┬────────────────┘
       EXECUTION     signal_done  │  (+ git merge + push)
                                  │
                    ┌─────────────▼────────────────┐
                    │             DONE              │
                    └──────────────────────────────┘

        orchestrator_signal_cancel from any stage → CANCEL
        lifetime_bounces >= 8 → LOOP_DETECTED (frozen, notify human)
```

---

## 19. Pipeline Configuration File

`pipeline.config.yaml` — single source of truth. Hot-reloaded on SIGHUP.

```yaml
pipeline:
  root: /path/to/pipeline-root
  log_file: PIPELINE.log
  tick_interval_seconds: 10
  db_path: orchestrator/pipeline.db

orchestrator:
  rest_port: 3000
  mcp_port: 3100
  pipeline_token: ${PIPELINE_TOKEN}  # env var

concurrency:
  ARCHITECTING: 1
  SPECKING: 2
  EXECUTION: 3
  REVIEW: 1
  TESTING: 2

sla_timeouts:
  ARCHITECTING: 3600
  SPECKING: 1800
  EXECUTION: 14400
  REVIEW: 3600
  TESTING: 7200

retry:
  ARCHITECTING: { max_attempts: 2, on_exceed: notify }
  SPECKING:      { max_attempts: 3, on_exceed: notify }
  EXECUTION:     { max_attempts: 4, on_exceed: notify }
  REVIEW:        { max_attempts: 2, on_exceed: notify }
  TESTING:       { max_attempts: 3, on_exceed: notify }
  max_lifetime_bounces: 8
  on_loop_detected: notify

agents:
  architect:
    harness: claude-code
    model: opusplan[1m]
    effort: high
    prompt_file: orchestrator/prompts/architect.md

  spec:
    harness: claude-code
    model: claude-sonnet-4-6
    prompt_file: orchestrator/prompts/spec.md

  execution:
    harness: codex-cli
    wrapper_script: orchestrator/agents/execution_wrapper.py
    model_escalation:
      1: gpt-5.3-codex
      2: gpt-5.3-codex
      3: claude-sonnet-4-6
      4: claude-sonnet-4-6
    prompt_file: orchestrator/prompts/execution.md

  review:
    harness: claude-code
    model: claude-opus-4-6[1m]
    effort: high
    thinking: extended
    prompt_file: orchestrator/prompts/review.md

  testing:
    harness: gemini-cli
    model: gemini-3.1-pro-preview
    routing: auto
    prompt_file: orchestrator/prompts/testing.md

context_hygiene:
  max_context_bytes: 3355443      # ~800K tokens
  global_ignore_file: .pipelineignore
  allowed_extensions:             # allowlist — only these extensions enter agent context
    - .md
    - .txt
    - .yaml
    - .yml
    - .toml
    - .json
    - .py
    - .rs
    - .ts
    - .tsx
    - .js
    - .jsx
    - .go
    - .sql
    - .graphql
    - .sh
    # Add project-specific extensions here

notifications:
  enabled: true
  webhook_url: ${PIPELINE_NOTIFY_WEBHOOK}
  events:
    - task_failed_max_attempts
    - agent_sla_timeout
    - loop_detected
    - context_size_exceeded
    - pipeline_error

git:
  main_branch: main
  feature_branch_prefix: feature/
  auto_merge_on_test_pass: true

done:
  retention_days: 90
  archive_path: DONE/archive/

cooking:
  max_iterations_before_stall: 10
```

---

## 20. Appendices

### Appendix A — Agent Quick Reference

| Stage | Agent | Harness | Model | Effort | Context |
|-------|-------|---------|-------|--------|---------|
| COOKING | Main Agent | OpenClaw | Opus 4.6 | High | — |
| ARCHITECTING | Architect | Claude Code | Opus 4.6 `opusplan[1m]` | High | 1M |
| SPECKING | Spec | Claude Code | Sonnet 4.6 | Standard | 200K |
| EXECUTION | Execution | CODEX CLI | GPT-5.3-Codex + 5.4-mini | — | Repo |
| EXECUTION fb | Execution | Claude Code | Sonnet 4.6 | Standard | 200K |
| REVIEW | Review | Claude Code | Opus 4.6[1m] | High + Extended Thinking | 1M |
| TESTING | Testing | Gemini CLI | Gemini 3.1 Pro (auto) | — | 1M |

---

### Appendix B — MCP Tool Summary

| Tool | Called By | Replaces |
|------|-----------|---------|
| `orchestrator_claim_task` | All agents | Orchestrator push / CRON scan |
| `orchestrator_signal_done` | All agents | `DONE.signal` file |
| `orchestrator_signal_back` | All agents | `BACK.signal` file |
| `orchestrator_signal_cancel` | All agents | `CANCEL.signal` file |
| `orchestrator_patch_priority` | All agents | `PRIORITY-PATCH.md` file |
| `orchestrator_append_knowledge` | Architect | Direct file append to KNOWLEDGE/ |

---

### Appendix C — Orchestrator Python Dependencies

```toml
[project]
name = "pipeline-orchestrator"
version = "2.0.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn>=0.30",
    "aiosqlite>=0.20",
    "watchdog>=4.0",
    "pyyaml>=6.0",
    "python-frontmatter>=1.1",
    "structlog>=24.0",
    "aiofiles>=23.0",
    "httpx>=0.27",
    "typer>=0.12",
    "rich>=13.0",
    "mcp>=1.0",            # Anthropic MCP Python SDK
]
```

---

### Appendix D — What Was Removed vs v1.0

| v1.0 Artifact | Status in v2.0 | Replaced By |
|---------------|---------------|-------------|
| `DONE.signal` | Removed | `orchestrator_signal_done` MCP call |
| `BACK.signal` | Removed | `orchestrator_signal_back` MCP call |
| `CANCEL.signal` | Removed | `orchestrator_signal_cancel` MCP call |
| `PRIORITY-PATCH.md` | Removed | `orchestrator_patch_priority` MCP call |
| Atomic rename protocol | Removed | Orchestrator internal move-first/commit-second |
| 10-second signal polling | Replaced | Instant — synchronous MCP tool call |
| PRIORITY.MD merge logic | Replaced | SQLite `UPDATE` with transaction |
| CRON | Replaced | Orchestrator async loop (10-second tick) |

---

*End of Specification — v2.0*
