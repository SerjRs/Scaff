---
id: 051
title: V2 Orchestrator Init & DB Layer
priority: P1
status: Cooking
branch: feat/051-v2-orchestrator-init-and-db
epic: 050-PIPELINE-V2.1
---

# Specification: V2 Orchestrator Init & SQLite Data Layer

## Objective
Initialize the Python 3.12 project for the new Autonomous Pipeline Orchestrator and build the async SQLite data access layer (`core/db.py`). This database is the authoritative source of truth for all task states in the v2.1 architecture.

## Architecture & Context
The Orchestrator is a Python daemon. It relies on `aiosqlite` for non-blocking database operations. The schema must exactly match the v2.1 specification to support stage tracking, dependency graphs, and infinite loop detection.

## Implementation Requirements

### 1. Project Initialization
- Initialize a Python 3.12 project using `uv` in a new `orchestrator/` directory at the repository root.
- Add dependencies: `aiosqlite`, `pytest`, `pytest-asyncio`, `structlog`.

### 2. Database Schema (`orchestrator/core/db.py`)
Implement the exact SQLite schema. Create an `init_db()` function that executes the following tables:
- `tasks`: id, stage, status, priority, complexity, task_path, parent_task_id, stage_attempts, lifetime_bounces, current_model, agent_pid, entered_stage_at, started_at, completed_at, created_at, updated_at.
- `dependencies`: task_id, depends_on.
- `priority_patches`: id, task_id, action, value, reason, agent, applied, created_at.
- `pipeline_events`: id, task_id, event_type, stage_from, stage_to, agent, model, details, created_at.
- `knowledge_appends`: id, section, content, agent, task_id, applied, created_at.

### 3. Data Access Methods (CRUD)
Implement async functions for the Orchestrator loop to use:
- `get_task(task_id: str)`
- `create_task(task_id: str, stage: str, task_path: str)`
- `update_task_state(task_id: str, stage: str, status: str)`
- `increment_stage_attempts(task_id: str)`
- `increment_lifetime_bounces(task_id: str)`
- `log_event(task_id: str, event_type: str, ...)`
- `transaction()` context manager for safe multi-table updates.

## Testing Requirements
- Create `orchestrator/tests/test_db.py`.
- Write `pytest` tests using an in-memory database (`:memory:`) to verify schema creation and CRUD operations.
- Ensure all tests pass.

## Out of Scope
- Building the MCP server or REST API (these come in later tasks).
- File system watchers or folder moves.