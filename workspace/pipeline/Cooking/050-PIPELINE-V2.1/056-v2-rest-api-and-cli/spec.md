---
id: 056
title: V2 REST API & CLI Dashboard
priority: P1
status: Cooking
branch: feat/056-v2-rest-api-and-cli
epic: 050-PIPELINE-V2.1
---

# Specification: V2 REST API & CLI Dashboard

## Objective
Implement the internal REST API (`api/rest.py`) using FastAPI and the command-line interface (`main.py`) using Typer. This allows the human operator to monitor the pipeline, manually retry failed tasks, cancel rogue agents, and reprioritize the queue.

## Architecture & Context
The REST API runs on port 3000 alongside the MCP server. It directly queries and mutates the SQLite database (`core/db.py`). The CLI acts as a thin wrapper, using `httpx` to make synchronous HTTP calls to the local REST API and rendering the results using `rich` for a clean terminal UI.

## Implementation Requirements

### 1. Dependencies
- Add `fastapi`, `uvicorn`, `typer`, `rich`, and `httpx` via `uv add`.

### 2. REST API (`api/rest.py`)
Create a FastAPI app with the following endpoints:
- `GET /health` -> Returns `{"status": "ok", "tasks_active": <count>}`
- `GET /tasks` -> Returns a list of all tasks. Support optional `?stage=` and `?status=` query params.
- `GET /tasks/{task_id}` -> Returns full task record from DB.
- `POST /tasks/{task_id}/cancel` -> Moves task to `CANCEL` via `core/filesystem.move_task` and writes `CANCEL-REASON.md`.
- `POST /tasks/{task_id}/reprioritize` -> Accepts JSON `{"priority": "P1|P2|P3"}`. Updates DB.
- `POST /tasks/{task_id}/retry` -> For tasks with status `FAILED` or `LOOP_DETECTED`. Resets status to `PENDING` and resets `stage_attempts` and `lifetime_bounces` to 0.
- `POST /tasks/{task_id}/approve` -> Moves task from `COOKING` to `TODO` and inserts it into the DB.

### 3. CLI Application (`main.py`)
Implement a Typer application with the following commands:
- `pipeline status` -> Fetches `/tasks`, uses `rich.table.Table` to print a color-coded board of active tasks.
- `pipeline approve <task_id>` -> Hits `POST /tasks/{task_id}/approve`.
- `pipeline cancel <task_id> <reason>` -> Hits `POST /tasks/{task_id}/cancel`.
- `pipeline reprioritize <task_id> <priority>` -> Hits `POST /tasks/{task_id}/reprioritize`.
- `pipeline retry <task_id>` -> Hits `POST /tasks/{task_id}/retry`.
- `pipeline serve` -> Starts both the FastAPI server (via `uvicorn`) and the MCP server (from task 053) concurrently using `asyncio.gather`, along with the core loop (from task 054).

## Testing Requirements
- Create `tests/test_api.py`. Use `fastapi.testclient.TestClient` to test the API endpoints (mock the DB/filesystem).
- Create `tests/test_cli.py`. Use `typer.testing.CliRunner` to test the CLI commands (mock `httpx`).