---
id: "009"
title: "Cortex sync tool awareness + pipeline completion"
created: "2026-03-14"
author: "scaff"
executor: ""
branch: ""
pr: ""
priority: "high"
status: "in-progress"
moved_at: "2026-03-14T13:20"
---

# 009 — Cortex Sync Tool Awareness + Pipeline Completion

Two related issues from Cortex's 2026-03-14 WhatsApp conversation. Both stem from the same root: Cortex doesn't have clear operational guidance on what it can do locally vs what needs an executor, and what "done" means for a pipeline task.

---

## Issue #39 — Cortex uses `sessions_spawn` for local file operations

### What happened

Serj asked Cortex to take task 002 from Cooking to execution. Cortex called `sessions_spawn` with:

> "Move the directory ... from Cooking to InProgress. Use: mv ..."

This dispatched through the Router → assigned an executor → executor ran `mv` → result came back 30 seconds later. Cortex has `move_file` as a sync tool — the operation should have been instant, in the same LLM turn.

### Why it matters

- Wasted ~30s of executor time + a full API call for a file move
- Added unnecessary latency to the conversation
- Confused the user ("Didn't you spawned already?" — Serj thought the coding task was running, but Cortex was still moving folders)

### Root cause

Cortex's system prompt and tool descriptions don't clearly distinguish:
- **Sync tools** (local, instant, same turn): `read_file`, `write_file`, `move_file`, `delete_file`, `code_search`, `memory_query`, `get_task_status`, `fetch_chat_history`, `pipeline_status`
- **Async tools** (executor, expensive, separate process): `sessions_spawn`, `library_ingest`

The LLM sees all tools equally and sometimes picks `sessions_spawn` for tasks that sync tools handle directly.

### Proposed fix

Add explicit guidance to Cortex's system prompt (in `llm-caller.ts` where the system message is built):

```
## Tool Usage

**Sync tools** execute instantly in the same turn — use for local operations:
- `read_file`, `write_file`, `move_file`, `delete_file` — file operations
- `code_search` — search the codebase
- `memory_query` — search memory
- `pipeline_status` — check pipeline state
- `get_task_status` — check a running task
- `fetch_chat_history` — read conversation history

**`sessions_spawn`** delegates to an external executor — use ONLY for work that requires:
- Writing/modifying code (coding tasks)
- Research that needs web access
- Complex multi-step tasks that need their own agent
- Work that takes minutes, not seconds

Never use `sessions_spawn` to move files, read files, or do simple operations that sync tools handle.
```

### Files to change

| File | Change |
|------|--------|
| `src/cortex/llm-caller.ts` | Add tool usage guidance to the system message |

---

## Issue #40 — Cortex doesn't complete pipeline end-to-end

### What happened

Cortex executed task 002 correctly:
1. ✅ Created CLAUDE.md + STATE.md
2. ✅ Moved to InProgress
3. ✅ Spawned coding executor
4. ✅ Executor completed, created PR #7

Then stopped. Never merged the PR. Never moved to Done. Left the task dangling in InProgress.

### Why it matters

- Serj had to discover the orphaned task later and ask Scaff (main agent) to clean up
- The pipeline README (step 6) says "When done: Claude Code pushes branch, creates PR, merges"
- Cortex knows the pipeline exists (it read the README) but didn't follow through

### Root cause

No checklist or completion protocol in Cortex's operational context. After the executor reports success, Cortex doesn't have a clear "what to do next" sequence. It reported the result and moved on.

### Proposed fix

Two layers:

**Layer 1 — System prompt guidance** (in `llm-caller.ts`):

General awareness that pipeline tasks have a completion protocol. Keeps it brief — the real enforcement is layer 2.

```
## Pipeline Tasks

When a pipeline task completes, a review checklist will be injected with the result. Follow it before replying to the user.
```

**Layer 2 — Injected review checklist** (in `loop.ts` or `gateway-bridge.ts`):

When an ops-trigger delivers a completed task result, detect if it's a pipeline task and append a mandatory checklist directly into the content Cortex sees:

```
[PIPELINE REVIEW REQUIRED]
The executor reports success. Before replying to the user, complete each step:
1. ☐ Review: did the build pass? Check result for errors.
2. ☐ Merge: if PR was created, merge it (gh pr merge <number> --squash)
3. ☐ Move: move task folder from InProgress → Done (use move_file)
4. ☐ Update STATE.md with final status
5. ☐ Inform the user: what was done, PR link, merged status
```

This is contextually immediate — right next to the result in the same LLM turn. Cortex can't forget it because it's the task it's responding to, not a system instruction buried 4000 tokens away.

**Detection:** A task is a pipeline task if:
- The `task_summary` in `cortex_task_dispatch` references a pipeline path (e.g., contains `pipeline/InProgress/`)
- Or the task prompt contains `CLAUDE.md` / `SPEC.md` / `STATE.md` references

**Injection point:** In `loop.ts` where `appendedContent` is built for ops-triggers, or in `gateway-bridge.ts` where `appendTaskResult` writes the result to `cortex_session`.

### Files to change

| File | Change |
|------|--------|
| `src/cortex/llm-caller.ts` | Add brief pipeline awareness to system message |
| `src/cortex/loop.ts` or `src/cortex/gateway-bridge.ts` | Detect pipeline tasks on completion, append review checklist to result content |

---

## Implementation approach

Both fixes are **system prompt changes** in `llm-caller.ts`. No schema changes, no new tables, no pipeline refactoring. The LLM just needs clearer instructions about:
1. Which tools are sync vs async
2. What to do after a pipeline task completes

### Notes

- **`gh` CLI** — `C:\Program Files\GitHub CLI` is on the system PATH. Current gateway process was started before it was added. Will work after next rebuild/restart.
