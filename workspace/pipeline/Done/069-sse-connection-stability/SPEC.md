# Task 069: SSE Connection Stability — MCP Return Channel Drops Under Real Agents

## STATUS: COOKING

## Priority: P1
## Complexity: M

## Objective

Investigate and fix the SSE connection instability that causes real Claude Code agents to lose their MCP connection mid-session. The agent successfully connects, makes one or more MCP tool calls, but the connection drops before `orchestrator_signal_done` can be called — leaving the task stuck in WIP until the monitor detects a dead agent.

## Background & Evidence

### Discovery (E2E test 068a, 2026-03-26)

A real Haiku agent was spawned for the ARCHITECTING stage of a trivially simple task. The agent:

1. ✅ Connected to MCP SSE at `http://localhost:58165/sse`
2. ✅ Called `orchestrator_append_knowledge` successfully (logged at 21:35:51)
3. ✅ Created `SPEC-DETAILS/HLD.md` with full architectural analysis
4. ❌ Failed to call `orchestrator_signal_done` — reported "MCP server at http://localhost:58165 appears to be unavailable"
5. ❌ Exited without signaling → monitor detected dead agent 100s later → respawned → same failure

The agent's AGENT.log explicitly states:
> *"The orchestrator MCP server at `http://localhost:58165` appears to be unavailable. The architectural work is complete; you may need to restart the orchestrator service or verify its connectivity."*

### Key Observation

`orchestrator_append_knowledge` worked (proven by `knowledge_append_inserted` log entry), meaning the SSE connection was functional at one point. It broke between the knowledge append and the signal_done call — approximately 10-30 seconds of gap while the agent was generating output text.

### Infrastructure Context

- MCP SDK: v1.26.0
- Transport: SSE via `SseServerTransport` (Starlette ASGI, served by uvicorn)
- Server: uvicorn on dynamic port, running as `asyncio.create_task()` inside pytest
- Client: Claude Code CLI (node.js), connecting via `--mcp-config` pointing to `.mcp-agent-config.json`
- OS: Windows 11, Python 3.12.13

## Possible Root Causes

### 1. SSE Idle Timeout (most likely)
The SSE transport may have an idle timeout. The agent establishes the SSE connection, calls a tool, then spends 10-30 seconds generating text output (not making tool calls). During this idle period, the SSE connection may timeout on the server side (uvicorn) or client side (Claude Code's MCP SDK). When the agent tries to call signal_done, the connection is dead.

**Investigation:** Check if uvicorn or Starlette has default HTTP keepalive/timeout settings that affect long-lived SSE connections. The SSE spec expects connections to stay open indefinitely.

### 2. Uvicorn HTTP Timeout
Uvicorn has `timeout_keep_alive` (default 5s) and `timeout_notify` settings. For SSE, the connection must be kept alive long enough for the entire agent session (30-120 seconds). The default keepalive of 5 seconds would kill the SSE connection during idle periods.

**Fix candidate:** Set `timeout_keep_alive=300` in uvicorn.Config for the SSE server.

### 3. Windows ProactorEventLoop + SSE
Windows uses `ProactorEventLoop` which handles I/O differently than the default `SelectorEventLoop` on Linux. Long-lived HTTP connections via SSE may behave differently — connections could be silently dropped without the server knowing.

### 4. pytest asyncio Event Loop Contention
The orchestrator, scheduler, monitor, REST API, AND SSE server all share one event loop. Heavy scheduler ticks (every 3s, writing priority files for 6 stages = 12 I/O operations per tick) might starve the SSE connection handler, causing it to miss keep-alive frames or fail to respond to client pings.

### 5. Claude Code MCP Client Reconnection
Claude Code's MCP client may not reconnect after an SSE disconnect. If the connection drops once, the agent should ideally reconnect — but it may not. This is a client-side issue we can't fix, but we can prevent the disconnect in the first place.

### 6. DNS Rebinding / Security Middleware
MCP SDK v1.26.0 has `TransportSecurityMiddleware` for DNS rebinding protection. On Windows with dynamic ports, the Host header validation might intermittently reject requests if the header doesn't match expectations.

## Investigation Steps

### Step 1: Reproduce with Logging
Add debug logging to the SSE transport layer:
- Log when SSE connection is established
- Log when SSE connection is closed (and why)
- Log when POST /messages is received
- Log when POST /messages fails

### Step 2: Check Uvicorn Timeout Config
Test with explicit `timeout_keep_alive=300` on the SSE uvicorn server. If this alone fixes it, we have our answer.

### Step 3: SSE Heartbeat / Keep-Alive
Add a periodic SSE heartbeat (send `:keep-alive\n\n` comment every 15 seconds) to prevent idle timeout. The SSE spec supports comment lines starting with `:` that clients ignore.

### Step 4: Test Outside pytest
Run the orchestrator standalone (`python main.py`) and manually approve a task. If the agent succeeds, the issue is pytest-specific (event loop contention). If it fails, it's a general SSE issue.

### Step 5: Network Trace
If steps 2-3 don't fix it, use Wireshark/netstat to see exactly when the TCP connection drops and what triggers it.

## Fix Directions

### A. Increase Uvicorn Timeout (quick fix)
```python
sse_config = uvicorn.Config(sse_app, host="0.0.0.0", port=MCP_SSE_PORT,
                            log_level="info", timeout_keep_alive=300)
```

### B. SSE Keep-Alive Heartbeat (robust fix)
Modify the MCP SSE server to send periodic keep-alive comments:
```python
# In the SSE stream handler, spawn a background task:
async def heartbeat(send):
    while True:
        await asyncio.sleep(15)
        await send(":keep-alive\n\n")
```

This may require patching or wrapping `SseServerTransport.connect_sse`.

### C. Agent Retry on MCP Failure (defense in depth)
Add retry logic in the agent prompt: "If MCP tool call fails, wait 5 seconds and retry up to 3 times." This is a prompt-level workaround, not a fix.

### D. Streamable HTTP Transport (future)
MCP SDK supports a newer `streamable-http` transport that may be more resilient than SSE. Consider migrating if SSE proves fundamentally unreliable on Windows.

## Acceptance Criteria

- [ ] Root cause identified with evidence (logs or network trace)
- [ ] Fix applied to orchestrator (uvicorn config, heartbeat, or transport change)
- [ ] E2E test 068a passes — real Haiku agent calls signal_done successfully
- [ ] Fix works on Windows (Python 3.12+)
- [ ] No regression in existing 120+ unit tests
- [ ] Document the fix and root cause in code comments

## Dependencies

- 067a (MCP SSE return channel — merged)
- 068a (E2E test — in progress, used for validation)

## Out of Scope

- Migrating to streamable-http transport (separate task if SSE can't be fixed)
- Claude Code client-side changes (we don't control the MCP client)
- Linux/macOS testing (Windows is the target platform)
