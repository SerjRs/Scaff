# Claude Code Instructions — 067a

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/067a-mcp-sse-return-channel` from main.
2. Commit frequently with format: `[067a] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. SSE Transport (api/mcp.py)
- `FastMCP` already has `run_sse_async()` and `sse_app()` methods
- Use `sse_app()` to get a Starlette ASGI app, then mount it on uvicorn at port 3100
- The existing `mcp_server` instance (FastMCP) is reused — same tools, same config
- Do NOT create a second FastMCP instance

### 2. Start SSE in main.py
- Add a second uvicorn server for MCP SSE on port 3100
- Add it to `asyncio.gather` alongside REST and the core loop
- Also add the process exit monitor coroutine

### 3. MCP Config for Agents (agents/base.py)
- Write a JSON file at `{pipeline_root}/.mcp-agent-config.json` once at startup
- Content: `{"mcpServers": {"orchestrator": {"url": "http://localhost:3100/sse"}}}`
- Check the actual SSE endpoint path from `sse_app()` — it may be `/sse` not `/mcp/sse`
- In `_build_command_args`, add `"--mcp-config", str(mcp_config_path)` to the command

### 4. Remove claim_task
- Delete the `orchestrator_claim_task` function from `api/mcp.py`
- Remove its import/usage from `tests/test_mcp.py`

### 5. Update Prompts
- All 5 prompts in `orchestrator/prompts/` say "Call orchestrator_claim_task" as step 1
- Replace with: "Your task has been pre-assigned. Details are in the prompt above. Proceed directly."
- Keep all signal_done, signal_back, signal_cancel, append_knowledge, patch_priority instructions

### 6. Process Exit Monitor
- New async function in `core/scheduler.py` or a new file `core/monitor.py`
- Polls WIP tasks every 15 seconds, checks if agent_pid is alive
- Dead agent without MCP signal → set PENDING, increment stage_attempts
- Add to `asyncio.gather` in main.py

## Do NOT Modify
- `core/db.py` — no schema changes
- `core/filesystem.py` — no changes needed
- `core/config.py` — no config changes (SSE port can be hardcoded for now)

## Tests
- Update `tests/test_mcp.py` — remove claim_task tests, add SSE-related tests if feasible
- Add `tests/test_monitor.py` — test process exit detection logic
- Run full suite: `cd orchestrator && uv run pytest -v`

## Important
- The SSE endpoint path depends on the MCP SDK. Check `sse_app()` docs or source.
- Claude Code `--mcp-config` expects a JSON file path, NOT inline JSON.
- The MCP config JSON format for SSE clients may use `"url"` not `"command"`. Verify with Claude Code docs.
- If `sse_app()` returns a Starlette app, you can mount it on a separate uvicorn instance.

## Execution
Do NOT ask questions. Execute the full task end-to-end.
