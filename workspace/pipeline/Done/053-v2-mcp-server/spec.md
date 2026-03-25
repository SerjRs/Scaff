---
id: 053
title: V2 MCP Server Protocol
priority: P1
status: Cooking
branch: feat/053-v2-mcp-server
epic: 050-PIPELINE-V2.1
---

# Specification: V2 MCP Server Protocol

## Objective
Implement the Model Context Protocol (MCP) server for the Orchestrator (`api/mcp.py`). This exposes exactly 6 tools that agents (like Claude Code) will use to claim work and signal outcomes, replacing the old file-based signaling system.

## Architecture & Context
The MCP server uses the Anthropic `mcp` Python SDK. For this phase, we only need to configure the `stdio` transport so local Claude Code instances can connect as agents. The tool handlers must integrate tightly with `core/db.py` (state updates) and `core/filesystem.py` (folder moves and manifest generation).

## Implementation Requirements

### 1. Dependencies & Setup
- Add `mcp` dependency via `uv add mcp`.
- Update `core/config.py` to include the ordered list of stages: 
  `PIPELINE_STAGES = ["TODO", "ARCHITECTING", "SPECKING", "EXECUTION", "REVIEW", "TESTING", "DONE"]`.
- Initialize a `FastMCP` or standard `Server` instance in `api/mcp.py`.

### 2. Implement the 6 MCP Tools
Define the following tools (using typed Python parameters so the MCP SDK generates the correct JSON schema for the agents):

1. **`orchestrator_claim_task(stage: str)`**
   - *Logic:* Query DB for the highest priority `PENDING` task in the requested `stage`.
   - If none found, return `{"status": "no_tasks"}`.
   - If found: Update DB status to `WIP`, set `agent_pid` to current process (or placeholder for now).
   - **CRITICAL:** Call `build_context_manifest()` from `core/filesystem.py` to generate `.context-manifest.txt`.
   - *Return:* task_id, task_path, manifest path, priority, complexity, stage_attempts.

2. **`orchestrator_signal_done(task_id: str, notes: str = "")`**
   - *Logic:* Look up current stage. Find the *next* stage in `PIPELINE_STAGES`.
   - Call `move_task(task_id, current_stage, next_stage, db)` from `core/filesystem.py`.
   - Write `notes` to `AGENT.log` in the task folder if provided.
   - *Return:* `{"ok": True}`

3. **`orchestrator_signal_back(task_id: str, target_stage: str, reason: str)`**
   - *Logic:* Increment `lifetime_bounces` in DB. 
   - Write the `reason` to a new file `BACK-REASON.md` (or append to `AGENT.log`) in the task folder.
   - Call `move_task(task_id, current_stage, target_stage, db)`.
   - *Return:* `{"ok": True}`

4. **`orchestrator_signal_cancel(task_id: str, reason: str)`**
   - *Logic:* Write `CANCEL-REASON.md` inside the task folder.
   - Call `move_task(task_id, current_stage, "CANCEL", db)`.

5. **`orchestrator_patch_priority(task_id: str, action: str, value: str, reason: str)`**
   - *Logic:* Insert a new record into the `priority_patches` SQLite table. (The core loop will process this later).

6. **`orchestrator_append_knowledge(section: str, content: str, task_id: str = None)`**
   - *Logic:* Insert a new record into the `knowledge_appends` SQLite table. (The core loop will process this later to avoid concurrent write locks).

### 3. Server Entrypoint
- Create a `run_stdio_server()` async function to start the MCP server over standard input/output.

## Testing Requirements
- Create `tests/test_mcp.py`.
- Mock the database and filesystem functions to verify that calling the MCP tool endpoints routes the data correctly and triggers the right underlying Python functions.