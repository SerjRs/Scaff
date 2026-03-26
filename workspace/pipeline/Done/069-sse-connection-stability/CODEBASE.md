# CODEBASE.md — 069 Relevant Surface

## Module: `main.py` — SSE Server Startup (primary fix location)

```python
MCP_SSE_PORT = 3100

async def _serve(root: str, db_path: str, rest_port: int) -> None:
    config = load_config(Path(root))
    await db.init_db(db_path)
    mcp_set_config(config)
    rest_set_config(config)
    await reconcile(db, config)
    _write_mcp_agent_config(config.pipeline_root)

    # REST on :3000
    uvi_config = uvicorn.Config(rest_app, host="0.0.0.0", port=rest_port, log_level="info")
    server = uvicorn.Server(uvi_config)

    # MCP SSE on :3100
    sse_app = get_sse_app()
    sse_config = uvicorn.Config(sse_app, host="0.0.0.0", port=MCP_SSE_PORT, log_level="info")
    # >>> FIX: Add timeout_keep_alive=300 here
    # sse_config = uvicorn.Config(sse_app, host="0.0.0.0", port=MCP_SSE_PORT,
    #                             log_level="info", timeout_keep_alive=300)
    sse_server = uvicorn.Server(sse_config)

    await asyncio.gather(
        server.serve(),
        sse_server.serve(),
        orchestrator_loop(db, config),
        monitor_agent_processes(db),
    )
```

---

## Module: `api/mcp.py` — MCP Server & SSE App

```python
from mcp.server.fastmcp import FastMCP

mcp_server = FastMCP("orchestrator")

# Tools: orchestrator_signal_done, orchestrator_signal_back,
#         orchestrator_signal_cancel, orchestrator_patch_priority,
#         orchestrator_append_knowledge

def get_sse_app():
    """Return a Starlette ASGI app for MCP SSE transport."""
    return mcp_server.sse_app()
    # >>> This returns a Starlette app with:
    # >>>   GET  /sse          → SSE event stream (long-lived connection)
    # >>>   POST /messages/    → Client sends tool calls here
```

**`mcp_server.sse_app()` internals (MCP SDK v1.26.0):**
```python
# In mcp.server.fastmcp.FastMCP:
def sse_app(self) -> Starlette:
    sse = SseServerTransport("/messages/")
    app = Starlette(routes=[
        Route("/sse", endpoint=sse.connect_sse),    # GET — SSE stream
        Mount("/messages", app=sse.handle_post_message),  # POST — tool calls
    ])
    return app
```

---

## MCP SDK: `SseServerTransport` (v1.26.0)

```python
class SseServerTransport:
    """
    SSE server transport. Two ASGI applications:
    1. connect_sse() — GET /sse — establishes SSE stream to send server→client messages
    2. handle_post_message() — POST /messages/<session_id> — receives client→server tool calls
    """

    def __init__(self, endpoint: str, security_settings=None):
        self._endpoint = endpoint  # "/messages/"
        self._read_stream_writers = {}  # session_id → MemoryObjectSendStream
        self._security = TransportSecurityMiddleware(security_settings)

    async def connect_sse(self, scope, receive, send):
        """Handle GET /sse — long-lived SSE connection."""
        # 1. Generate session UUID
        # 2. Create anyio memory streams for bidirectional communication
        # 3. Send initial SSE event with POST endpoint URL
        # 4. Keep connection open, forward server messages as SSE events
        # 5. When connection closes, clean up session

    async def handle_post_message(self, scope, receive, send):
        """Handle POST /messages/<session_id> — client tool calls."""
        # 1. Extract session_id from path
        # 2. Parse JSON-RPC message from body
        # 3. Write to session's memory stream
        # 4. Return 202 Accepted
```

**Key: The SSE connection in `connect_sse` stays open for the entire agent session. If it drops, the agent loses its return channel.**

---

## Uvicorn Config Defaults (relevant to SSE)

```python
class Config:
    timeout_keep_alive: int = 5   # DEFAULT: 5 seconds!!
    # This is the HTTP Keep-Alive timeout — how long to keep idle connections open
    # For SSE, 5 seconds is WAY too short — agent idle periods are 10-60 seconds
    
    timeout_notify: int = 30
    # Grace period for in-progress connections during shutdown
    
    h11_max_incomplete_event_size: int | None = None
```

**Root cause hypothesis:** `timeout_keep_alive=5` (default) kills the SSE connection after 5 seconds of inactivity. The agent makes a tool call (append_knowledge), then spends 10-30 seconds generating text output, and when it tries the next tool call (signal_done), the connection is already dead.

---

## E2E Test Conftest: `tests/e2e/conftest.py` (also needs fix)

```python
    # --- MCP SSE server ---
    sse_app = get_sse_app()
    sse_uvi_config = uvicorn.Config(
        sse_app, host="127.0.0.1", port=sse_port, log_level="warning"
        # >>> FIX: Add timeout_keep_alive=300
    )
    sse_server = uvicorn.Server(sse_uvi_config)
    sse_server.capture_signals = contextlib.nullcontext  # Disable signal capture
```

**Current E2E fixes already applied (uncommitted):**
- `capture_signals = contextlib.nullcontext` — prevents uvicorn signal handler from crashing pytest
- `CREATE_NEW_PROCESS_GROUP` — isolates agent subprocess from parent console on Windows
- These must be committed as part of this task

---

## Evidence: Agent Log (from E2E test run)

```
## ✅ Architectural Analysis Complete
[...agent output showing successful HLD creation...]

**Status:**
- ✅ Specification analyzed
- ✅ HLD document created
- ✅ Decision recorded in ARCHITECTURE.md
- ⚠️ Orchestrator signal pending (MCP server connection issue)

*Note: The orchestrator MCP server at `http://localhost:58165` appears
to be unavailable. The architectural work is complete; you may need to
restart the orchestrator service or verify its connectivity for the
final signal to complete the task transition.*
```

**Orchestrator log confirms:** `knowledge_append_inserted` at 21:35:51 (tool call worked), then `agent_died_without_signal` at 21:37:04 (connection failed for signal_done).

---

## Optional: SSE Heartbeat (if timeout fix isn't enough)

```python
# Custom SSE app wrapper with keep-alive
from starlette.applications import Starlette
from starlette.routing import Route, Mount

def get_sse_app_with_heartbeat():
    """Wrap MCP SSE app with keep-alive heartbeat."""
    sse_transport = SseServerTransport("/messages/")
    
    async def sse_with_heartbeat(scope, receive, send):
        # Start heartbeat task that sends :keep-alive\n\n every 15s
        # Delegate to sse_transport.connect_sse
        pass
    
    return Starlette(routes=[
        Route("/sse", endpoint=sse_with_heartbeat),
        Mount("/messages", app=sse_transport.handle_post_message),
    ])
```

This is a fallback if `timeout_keep_alive` alone doesn't fix it. SSE keep-alive comments are part of the spec and prevent intermediate proxies/firewalls from killing idle connections.

---

## Files Summary

| File | Action |
|------|--------|
| `main.py` | FIX: Add `timeout_keep_alive=300` to SSE uvicorn.Config |
| `tests/e2e/conftest.py` | FIX: Add `timeout_keep_alive=300`, commit signal/process group fixes |
| `api/mcp.py` | OPTIONAL: Add debug logging around SSE connection lifecycle |
| `api/mcp.py` | OPTIONAL: Wrap `get_sse_app()` with heartbeat if timeout alone fails |
