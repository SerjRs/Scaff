# Pipeline

Development pipeline for Scaff + coding executors (Claude Code, Gemini, Codex).

Tasks are markdown files that move between folders as they progress through stages. Each folder has a `README.md` explaining its purpose and rules.

## Flow

```
Cooking → ToDo → InProgress → InReview → Done
                                      ↘ Canceled
```

## Roles

- **Scaff** — Architect. Writes specs, reviews code, orchestrates pipeline. Moves tasks between Cooking → ToDo → InProgress. Reviews in InReview and moves to Done.
- **Serj** — Owner. Contributes to Cooking. Final say on priorities and direction.
- **Executor** (Claude Code / Gemini / Codex) — Implements. Picks up from InProgress, codes, tests, pushes branch + PR, moves task to InReview.

## Task File Format

Every task is a `.md` file. Filename pattern: `NNN-short-name.md` (e.g. `008-cortex-read-file.md`).

### Required Metadata Header

```yaml
---
id: "008"
title: "Cortex read_file sync tool"
created: "2026-03-12"
author: "scaff"
executor: ""           # claude-code | gemini | codex (set when moved to InProgress)
branch: ""             # set by executor
pr: ""                 # set by executor
priority: "high"       # low | medium | high | critical
status: "cooking"      # cooking | todo | in-progress | in-review | done | canceled
moved_at: "2026-03-12" # last stage transition date
---
```

### Body

- **Cooking stage:** Raw thoughts, architecture notes, open questions. Can be messy.
- **ToDo stage:** Clean implementation spec. Everything the executor needs — no ambiguity.
- **InProgress/InReview:** Executor appends progress notes, blockers, test results at the bottom.
- **Done:** Scaff appends final summary (commit, PR link, what shipped).

## Numbering

Sequential, zero-padded to 3 digits. Check the highest number across ALL folders before creating a new task.
