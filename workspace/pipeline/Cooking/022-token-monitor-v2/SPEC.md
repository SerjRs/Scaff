---
id: "022"
title: TokenMonitor V2 — Context Visibility & Task Board
priority: medium
status: cooking
created: 2026-03-16
author: scaff
tags: [token-monitor, context-visibility, pipeline-board, developer-tooling]
---

# 022 — TokenMonitor V2: Context Visibility & Task Board

## Problem

TokenMonitor currently shows basic session info but has no visibility into:
- What context each agent/executor actually receives
- Live task execution state (Router queue)
- Pipeline task board (Cooking → Done)
- Token budget breakdown per agent per turn

Debugging "why did Scaff say that" or "why did the executor fail" requires digging through logs. The data exists internally but isn't surfaced.

## Goals

Turn TokenMonitor from a basic session viewer into a full observability dashboard for the Scaff system.

## Features

### 1. Executor Context Panel
For each running/completed task, show:
- Task prompt sent to executor
- Attached resources (SPEC.md, inline text, files)
- Model tier selected (Haiku/Sonnet/Opus) and why (complexity score)
- Input/output token counts
- Duration and status

### 2. Router Queue Board
Live view of the Router's job lifecycle:
- Queued → Evaluating → Running → Completed/Failed
- Current concurrency (2 max)
- Retry count per job
- Watchdog status (hung job detection)

### 3. Pipeline Kanban Board
Visual kanban for pipeline tasks:
- Columns: Cooking | InProgress | InReview | Done
- Task cards with: id, title, priority, assignee, created date
- Click to view SPEC.md contents
- Data source: existing `pipeline_status` tool output

### 4. Context Pressure Gauge (per agent)
Real-time donut/bar chart showing context window consumption:
- **System Floor**: system prompt, workspace files, skills, tool schemas
- **Foreground**: conversation history (shard-level breakdown)
- **Background**: compressed summaries, hot memory facts
- **Available**: remaining budget
- Threshold indicators: Healthy (<10%), Moderate (10-15%), Heavy (>15%)
- Inspired by OpenClaw Context Doctor (library items 34, 36)

### 5. Cortex Live Context Inspector
"Why did Scaff say that" debugger:
- Hot memory facts injected this turn
- Foreground shards included/excluded
- Library breadcrumbs surfaced
- Tool calls made and their results
- Total token count of assembled context

## Data Sources

| Feature | Source | Exists? |
|---------|--------|---------|
| Executor context | Router job records, executor sessions | ✅ on disk |
| Router queue | Router DB (in_queue, in_execution) | ✅ live |
| Pipeline board | pipeline/ folder structure + SPEC.md | ✅ via tool |
| Context pressure | context assembly in cortex loop | ⚠️ needs instrumentation |
| Live context | hippocampus output per turn | ⚠️ needs instrumentation |

## Inspiration / Library References

- **OpenClaw Context Doctor** (id:34, 36) — token budget visualization, bootstrap overhead categories
- **CrewAI Cognitive Memory** (id:39) — visibility into what agent learned/recalled per task
- **TypeAgent Memory** (id:29) — structured knowledge retrieval visibility
- **(S)AGE** (id:31) — multi-agent memory audit trail

## Open Questions

- Should this be a separate web app or extend the existing TokenMonitor?
- How to expose context assembly data without adding overhead to the hot path?
- WebSocket live updates vs polling?
- Auth model for the dashboard?

## Complexity Estimate

High — spans multiple subsystems (Router, Cortex, Hippocampus, Pipeline). Likely needs to be broken into sub-tasks.
