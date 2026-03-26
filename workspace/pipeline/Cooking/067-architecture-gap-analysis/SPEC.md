# Task 067: Architecture Gap Analysis — v2.2 Spec vs Implementation

## STATUS: COOKING (living document — not a task to execute)

## Priority: P0
## Complexity: Reference

## Purpose

This document captures every gap between Architecture Specification **v2.2** (`docs/050-PIPELINE-V2.1/Architecture-PIPELINE-SPEC-v2.2.md`) and the current implementation as of 2026-03-26 (commit `9c2766b`).

Use this to plan and prioritize tasks. Each gap should become its own task in COOKING.

---

## The Critical Gap: MCP Return Channel

**This is the #1 blocker. The pipeline is non-functional without it.**

### What v2.2 Says
- Orchestrator runs an MCP server on `:3100` with **SSE transport** (§6.4)
- Agents connect to it via Claude Code's `--mcp-config` flag (§8)
- Agents call `signal_done`, `signal_back`, `signal_cancel`, `append_knowledge`, `patch_priority` (§7)
- This is the **return channel** — agents signal outcomes to the orchestrator

### What's Implemented
- MCP server exists in `api/mcp.py` with all 5 tools implemented (plus `claim_task` which is being removed)
- MCP server only supports **stdio transport** (used when launched as a subprocess)
- **No SSE transport** — no port 3100, no HTTP endpoint for agents to connect to
- **No `--mcp-config`** in the spawn command (`agents/base.py`)
- Agents are spawned with `claude -p -` — one-shot, no MCP connection
- Agents finish work but **cannot signal back** — orchestrator never knows they're done

### Evidence
Task 063 (first E2E run): architect agent completed all work, wrote AGENT.log, exited cleanly. Orchestrator still shows it as WIP in ARCHITECTING. Dead process detected only when we checked manually.

### What Needs to Happen
1. Add SSE transport to MCP server — listen on `:3100` alongside the REST API on `:3000`
2. Generate an MCP config file pointing to `http://localhost:3100/mcp/sse`
3. Add `--mcp-config <path>` to the spawn command in `agents/base.py`
4. Remove `claim_task` from MCP tools (orchestrator pre-assigns)
5. Verify Claude Code in `-p` mode can call MCP tools via SSE
6. Add process exit monitoring as backup (SLA timeout is too slow)

---

## Implemented and Aligned ✅

| Area | v2.2 Reference | Notes |
|------|---------------|-------|
| SQLite schema | §6.2 | All 5 tables match spec |
| 5 MCP tools defined | §7 | signal_done, signal_back, signal_cancel, patch_priority, append_knowledge |
| REST API core | §6.3 | health, tasks, cancel, reprioritize, retry, approve, signal-done, signal-back |
| Core loop | §6.6 | drain_knowledge → drain_priority → promote_todo → schedule_agents → check_sla → regenerate_priority |
| Reconciler (COOKING excluded) | §6.5 | Scans TODO through CANCEL only |
| Context manifest | §14 | Allowlist + denylist hybrid, byte limit |
| PRIORITY.MD writer | §12 | Regenerated from SQLite each tick |
| Move-first/commit-second | §6.6 | With rollback on DB failure |
| task_path updates on move | §6.6 | Fixed in 064 |
| SPEC.md read-only protection | §1 #8, §6.6 | Fixed in 065 — chmod before spawn, restore on move |
| Generic base.py spawn | §8, §10 | Single spawn function, stage differences via config |
| YAML config with deep merge | §19 | load_config() with defaults, per-agent overrides |
| TODO auto-promotion | §6.6, §9.2 | promote_todo() moves PENDING → ARCHITECTING |
| COOKING isolation | §1 #4, §9.1 | Reconciler excluded, only approve endpoint touches it |
| Push model (pre-assignment) | §1 #5, §8 | Orchestrator assigns via prompt injection, no claim_task |
| Claude-only harness | §8 | _resolve_claude_binary() handles Windows .cmd resolution |
| Prompt files (all 5) | §10 | architect.md, spec.md, execution.md, review.md, testing.md — correct role definitions |
| .claude/mcp.json | §6.4 | Exists in repo root (but currently stdio config, needs SSE) |

---

## Not Implemented ❌

### Phase 1: Agent Return Channel (blocks pipeline functionality)

| Task | Gap | v2.2 Ref | Complexity |
|------|-----|----------|------------|
| **068** | **SSE transport for MCP server** — add SSE endpoint on :3100. Currently stdio only. | §6.4 | M |
| **068** | **`--mcp-config` in spawn** — pass MCP config to Claude Code so agents connect to SSE endpoint. | §8 | S (part of 068) |
| **068** | **Remove `claim_task`** — agents don't pull work, orchestrator pushes. | §7 | S (part of 068) |
| **068** | **Process exit monitoring** — detect dead agents faster than SLA timeout. Backup for MCP signaling. | §6.6 | M (part of 068 or separate) |

### Phase 2: Pipeline Integrity

| Task | Gap | v2.2 Ref | Complexity |
|------|-----|----------|------------|
| **070** | **Loop detection enforcement** — scheduler must check `lifetime_bounces >= max_lifetime_bounces` and set LOOP_DETECTED. DB fields exist but check is missing. | §16 | S |
| **071** | **Git branch discipline** — agents must create `feature/<task-id>` before EXECUTION, merge after TESTING. Currently agents work on whatever branch is current. | §9.5, §9.7 | M |
| **072** | **PIPELINE.log** — structured JSON append for every state transition. Currently events only go to SQLite `pipeline_events`. | §1 #10, §6.1 | S |
| **073** | **Knowledge base scaffolding** — create TECH-STACK.md, CONVENTIONS.md, DECISIONS/ directory, and .pipelineignore. Empty ARCHITECTURE.md already exists. | §11, §14 | S |

### Phase 3: Operational

| Task | Gap | v2.2 Ref | Complexity |
|------|-----|----------|------------|
| **074** | **Notifications** — webhook on failure, SLA timeout, loop detection. Config exists in spec but not implemented. | §6.1 #9 | M |
| **075** | **DONE archival** — auto-archive DONE tasks older than `done_retention_days`. | §9.8 | S |
| **076** | **CLI improvements** — `cli.py status` prints nothing on empty pipeline. Needs Rich table with headers, stage summary. | §6.3 | S |
| **066** | **Kanban web dashboard** — already in COOKING with full spec. | §6.3 | L |

### Phase 4: Completeness

| Task | Gap | v2.2 Ref | Complexity |
|------|-----|----------|------------|
| **077** | **COMPLETION.md** — Testing agent should write this on PASS. Currently not generated. | §9.8 | S |
| **078** | **CANCEL-REASON.md triggered_by** — missing "agent" vs "human" attribution field. | §9.9 | S |
| **079** | **REST endpoints** — /pipeline/info, /pipeline/cooking, /tasks/{id}/files, /tasks/{id}/files/{name} (needed for dashboard). | §6.3 | M (part of 066) |

---

## Already in COOKING

| Task | Description | Depends On |
|------|------------|------------|
| 063 | Code Review Graph integration | 068 (needs working pipeline) |
| 066 | Kanban web dashboard | 079 (REST endpoints) |
| 067 | This gap analysis | — |

---

## Suggested Execution Order

```
068 — MCP SSE + agent return channel     ← UNBLOCKS THE PIPELINE
  ↓
070 — Loop detection                     ← quick win, prevents infinite loops
071 — Git branch discipline              ← agents need proper branch workflow
072 — PIPELINE.log                       ← audit trail
073 — Knowledge base files               ← agents need KNOWLEDGE/ content
  ↓
063 — Code Review Graph                  ← first real task through the fixed pipeline
  ↓
074 — Notifications
075 — DONE archival
076 — CLI improvements
066 — Kanban dashboard
077 — COMPLETION.md
078 — CANCEL-REASON.md fix
```

**068 is the single gate.** Nothing else matters until agents can signal back.

---

## Dirty State: Task 063

The architect agent from the first E2E run made uncommitted changes to the working tree that were included in the v2.2 docs commit:
- `orchestrator/core/graph.py` (new — from 063's architect agent)
- `orchestrator/tests/test_graph.py` (new — from 063's architect agent)
- `orchestrator/uv.lock` (modified — dependency changes)

These files were committed to main as part of `9c2766b` (the v2.2 docs commit). They represent work done by the architect agent that was NOT reviewed or approved through the pipeline. 

**Decision needed:** keep them (they look correct per the 063 spec) or revert them and let the pipeline handle 063 properly once 068 is done.

---

*Analysis performed: 2026-03-26 by Scaff*
*Based on: Architecture Spec v2.2 vs implementation at commit 9c2766b*
