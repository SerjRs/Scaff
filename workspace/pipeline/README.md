# Development Pipeline

Folder-based task pipeline for stateless AI agents (Scaff, Claude Code, Cortex).

## Stages

```
Cooking → InProgress → Done
                    ↘ Canceled
```

| Stage        | Meaning                                           |
|--------------|---------------------------------------------------|
| **Cooking**  | Ideas, rough specs, open questions                 |
| **InProgress** | Active work — Claude Code running, branch exists |
| **Done**     | Merged to main, complete                           |
| **Canceled** | Dropped                                            |

## Task Structure

Each task is a **folder** (not a single file). The folder contains everything an AI executor needs to work independently:

```
006-router-weight-timeout/
  SPEC.md      ← Implementation spec (what to build, why, how)
  CLAUDE.md    ← Instructions for Claude Code (how to work)
  STATE.md     ← Progress checkpoint (updated by executor after each milestone)
```

### Key Files

- **SPEC.md** — The full spec. Architecture, code changes, test requirements, risks.
- **CLAUDE.md** — Claude Code reads this on spawn. Contains branch name, constraints, workflow instructions.
- **STATE.md** — Executor updates this after each milestone. If interrupted, next spawn resumes from here.

## Workflow

1. **Scaff** creates task folder in `Cooking/` with SPEC.md (rough or detailed)
2. When ready, move folder to `InProgress/`, add CLAUDE.md + STATE.md
3. **Spawn Claude Code** with `workdir` pointing to the task folder
4. Claude Code reads CLAUDE.md → checks STATE.md → works on branch → commits incrementally → updates STATE.md
5. If interrupted: respawn in same folder, picks up from STATE.md + branch
6. When done: Claude Code pushes branch, creates PR, merges
7. **Scaff** moves folder to `Done/`

## Parallel Execution

Each task has its own branch + folder. Multiple Claude Code instances can run simultaneously on different tasks without conflicts.

## Branch Convention

Branch name matches task: `feat/router-weight-timeout` for `006-router-weight-timeout/`

## YAML Frontmatter (SPEC.md)

```yaml
---
id: "006"
title: "Router weight-based timeout"
created: 2026-03-12
author: scaff
priority: high
status: in_progress
branch: feat/router-weight-timeout
---
```
