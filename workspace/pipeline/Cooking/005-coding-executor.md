---
id: "005"
title: "Coding Executor — Claude Code integration via Router"
created: 2026-03-12
author: scaff
executor: TBD
branch: ""
pr: ""
priority: high
status: cooking
moved_at: 2026-03-12
---

# 005 — Coding Executor

## Problem

Cortex can delegate tasks via `sessions_spawn` → Router → LLM executor. But the Router only has API-based executors (Sonnet/Haiku/Opus making LLM calls). There's no way to run Claude Code — a CLI tool that needs a shell.

Today, only MAIN (Scaff) can orchestrate Claude Code because he has `exec` + `process` tools. Cortex has neither.

## Architecture

```
Cortex → sessions_spawn("implement task X")
  → Router (dispatch — stays dumb)
    → Coding Executor (Opus/Sonnet with exec+process tools)
      → reads spec via read_file
      → spawns Claude Code via exec(pty:true)
      → monitors via process(poll/log)
      → reviews the diff
      → reports back through existing ops-trigger pipeline
  → Cortex gets ops-trigger with results
```

### Key Principles

- **Router stays a dispatcher** — no new logic, no process management
- **Coding Executor is a new executor profile** — an isolated session with shell access
- **Non-blocking** — executor can take as long as needed; Router and Cortex don't block
- **Reuses existing pipeline** — results flow back via ops-trigger, same as today

## What's New

1. **Executor profile with shell access** — needs `exec` + `process` tools (PTY support)
   - Regular executors only have file tools
   - This one can spawn terminal processes
2. **Router executor type routing** — Router needs to know when to dispatch to a Coding Executor vs a regular LLM executor
3. **Output capture & reporting** — Coding Executor reviews Claude Code output, captures results, sends back structured report


## Related Docs

- **`docs/working/01_process-isolated-executors.md`** — Full 7-phase architecture for fork-per-job executor isolation. Covers timeout enforcement (SIGTERM → SIGKILL), process-isolated execution, token monitor bridging, config schema. Phase 1-3 are the critical path for this task.

## Resolved Questions

- **Router task routing:** Router needs a SKILL — if the task is code-related, spin up an Executor with shell access to Claude Code. Otherwise use standard LLM executor.
- **Executor profile config:** Grants/permissions/auth come from the local repo. Everything in the repo defines its own access.
- **Timeout strategy:** Covered in `01_process-isolated-executors.md` Phase 5 — two-stage kill (SIGTERM at `timeoutMs`, SIGKILL after `killGraceMs`). Configurable via `router.executors.timeoutMs` (default 300s).
- **Error handling:** LLM Executor figures out details and tries to help Claude Code. 3 iterations MAX before reporting failure.
- **Security boundary:** Disregarded for now.

## Dependencies

- ✅ Cortex file I/O tools (PR #3 merged — write_file, move_file, delete_file)
- ✅ Pipeline system (folders + task frontmatter)
- ⚠️ `01_process-isolated-executors.md` Phase 1-3 (executor process isolation) — prerequisite infrastructure
- Task 002 (pipeline_status) — nice to have but not blocking
