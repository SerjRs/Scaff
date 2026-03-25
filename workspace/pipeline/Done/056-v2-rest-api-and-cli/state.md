# Task State: 056-v2-rest-api-and-cli

**Current Status:** Not Started

## Milestones

- [ ] Branch `feat/056-v2-rest-api-and-cli` created.
- [ ] Dependencies added (`fastapi`, `uvicorn`, `typer`, `rich`, `httpx`).
- [ ] `api/rest.py` created and FastAPI app instantiated.
- [ ] Endpoint: `GET /health` implemented.
- [ ] Endpoint: `GET /tasks` (with filters) implemented.
- [ ] Endpoint: `POST /tasks/{task_id}/cancel` implemented.
- [ ] Endpoint: `POST /tasks/{task_id}/reprioritize` implemented.
- [ ] Endpoint: `POST /tasks/{task_id}/retry` implemented.
- [ ] Endpoint: `POST /tasks/{task_id}/approve` implemented.
- [ ] `main.py` created with Typer.
- [ ] CLI command: `status` (renders Rich table) implemented.
- [ ] CLI commands: `approve`, `cancel`, `reprioritize`, `retry` implemented.
- [ ] CLI command: `serve` (starts API, MCP, and Core Loop concurrently) implemented.
- [ ] `tests/test_api.py` written and passing.
- [ ] `tests/test_cli.py` written and passing.
- [ ] Branch pushed to remote.

## Executor Notes
*(Executor: Leave notes here if you encounter blockers or if the session is interrupted.)*