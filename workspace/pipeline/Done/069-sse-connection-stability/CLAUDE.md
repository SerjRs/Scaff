# Claude Code Instructions — 069

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/069-sse-connection-stability` from main.
2. Commit frequently with format: `[069] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. Start with the Quick Fix — Uvicorn Timeout
In `main.py`, change the SSE uvicorn.Config to increase `timeout_keep_alive`:

```python
sse_config = uvicorn.Config(
    sse_app, host="0.0.0.0", port=MCP_SSE_PORT,
    log_level="info",
    timeout_keep_alive=300,  # 5 minutes — SSE connections need long keepalive
)
```

Also update the E2E conftest to match:
```python
sse_uvi_config = uvicorn.Config(
    sse_app, host="127.0.0.1", port=sse_port,
    log_level="warning",
    timeout_keep_alive=300,
)
```

### 2. Add SSE Keep-Alive Heartbeat (if timeout alone doesn't fix it)
Wrap or extend the SSE app to send periodic `:keep-alive\n\n` comments. Options:

**Option A: Middleware on the SSE Starlette app**
Create an ASGI middleware that intercepts the SSE `/sse` route and injects periodic comments.

**Option B: Custom SSE endpoint that wraps connect_sse**
Replace `mcp_server.sse_app()` with a custom Starlette app that wraps the transport's `connect_sse` and adds a heartbeat task.

### 3. Add Debug Logging
Add logging around the SSE connection lifecycle in `api/mcp.py`:
- When SSE connection is established (wrap `connect_sse`)
- When SSE connection is closed
- When a tool call arrives via POST /messages

### 4. Validate with E2E Test
After applying fixes, run the E2E test to verify:
```
cd orchestrator && uv run pytest tests/e2e/ -v -s -p no:timeout
```

The test must:
- Spawn a real Haiku agent
- Agent calls `orchestrator_signal_done` via MCP
- Task advances from ARCHITECTING to SPECKING

### 5. Also Fix E2E conftest Signal Issue
The E2E conftest already has `capture_signals = contextlib.nullcontext` and `CREATE_NEW_PROCESS_GROUP` fixes. Commit these as part of this task (they're currently only local edits).

## Investigation Order

1. Apply `timeout_keep_alive=300` → run E2E test
2. If still failing → add SSE heartbeat → run E2E test
3. If still failing → add debug logging → analyze SSE connection lifecycle
4. If still failing → test outside pytest (standalone orchestrator) to rule out event loop contention

## Do NOT Modify
- `core/db.py` — no schema changes
- `core/scheduler.py` — no changes
- `agents/base.py` — no changes (except maybe adding logging)
- Agent prompts — no prompt changes (this is an infrastructure fix)

## Tests
- Run E2E test: `cd orchestrator && uv run pytest tests/e2e/ -v -s -p no:timeout`
- Run unit tests: `cd orchestrator && uv run pytest tests/ --ignore=tests/e2e/ -v`
- Both must pass
- The E2E test is the primary validation — it must show a real agent calling signal_done

## Important
- The SSE server uses MCP SDK v1.26.0's `SseServerTransport` via `mcp_server.sse_app()`
- Claude Code connects as SSE client via `--mcp-config .mcp-agent-config.json`
- The `.mcp-agent-config.json` format: `{"mcpServers": {"orchestrator": {"type": "sse", "url": "http://localhost:<port>/sse"}}}`
- SSE has two endpoints: GET `/sse` (event stream) and POST `/messages/<session-id>` (tool calls)
- The agent DOES connect successfully (proven by append_knowledge working) — the issue is connection dropping during idle periods
- Windows uses ProactorEventLoop — may behave differently than Linux for long-lived HTTP connections
- Keep the fix minimal — don't rewrite the transport layer, just make it reliable

## Execution
Do NOT ask questions. Execute the full task end-to-end.
Run the E2E test after applying fixes to verify. Report pass/fail.
