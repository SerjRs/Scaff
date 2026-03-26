# Task 067a: MCP SSE Return Channel

## STATUS: COOKING

## Priority: P0
## Complexity: L

## Objective

Enable agents to signal outcomes back to the orchestrator by adding SSE transport to the MCP server and wiring it into the agent spawn mechanism. This is the single blocker — the pipeline is non-functional without it.

## Background

Agents are spawned via `claude -p -` (one-shot, stdin prompt). They do their work and exit, but have no way to call `signal_done`, `signal_back`, or any other MCP tool. The orchestrator never knows an agent finished.

Claude Code supports `--mcp-config` which loads MCP server connections even in `-p` mode. The MCP server must use SSE transport (HTTP endpoint) so agents connect to the already-running orchestrator — not spawn their own subprocess.

## Scope

### In Scope
1. Add SSE transport to the MCP server — listen on `:3100`
2. Start the SSE server alongside REST (:3000) in `main.py`
3. Generate an MCP config JSON file pointing to `http://localhost:3100/mcp/sse`
4. Add `--mcp-config <path>` to spawn command in `agents/base.py`
5. Remove `orchestrator_claim_task` from MCP tools (orchestrator pre-assigns tasks)
6. Update prompts: remove `claim_task` startup step, keep `signal_done`/`signal_back` instructions
7. Add process exit monitoring — detect agent exit (code 0 or 1) faster than SLA timeout as backup
8. Test the full round-trip: spawn → work → signal_done → stage advance

### Out of Scope
- Authentication/tokens for MCP SSE (use later)
- Multi-harness support
- MCP over network (agents on different machines)

## Implementation Details

### 1. SSE Transport (`api/mcp.py`)

The `mcp` Python SDK supports SSE transport. Add an SSE server that exposes the same tools:

```python
# In api/mcp.py — add SSE server startup
from mcp.server.sse import SseServerTransport

async def start_sse_server(host="0.0.0.0", port=3100):
    """Start MCP server with SSE transport on :3100."""
    # Use the existing mcp_server (FastMCP) instance
    # Mount SSE transport on an ASGI app
    ...
```

### 2. Start SSE in `main.py`

Add the SSE server to `asyncio.gather` alongside REST and the core loop:

```python
await asyncio.gather(
    rest_server.serve(),        # :3000
    mcp_sse_server.serve(),     # :3100
    orchestrator_loop(db, config),
)
```

### 3. MCP Config for Agents (`agents/base.py`)

Generate a JSON config file that agents receive via `--mcp-config`:

```json
{
  "mcpServers": {
    "orchestrator": {
      "url": "http://localhost:3100/mcp/sse"
    }
  }
}
```

Write this file once at orchestrator startup (e.g., `pipeline/.mcp-agent-config.json`). Pass it in spawn:

```python
cmd = [
    resolve_claude_binary(),
    "--model", model,
    "--permission-mode", "bypassPermissions",
    "--output-format", "text",
    "--mcp-config", str(mcp_config_path),
    "-p", "-",
]
```

### 4. Remove `claim_task`

Delete `orchestrator_claim_task` from `api/mcp.py`. Agents don't pull — they receive task assignment in the prompt.

### 5. Update Prompts

All 5 prompts currently say "Call `orchestrator_claim_task`" as step 1. Replace with:

```
## Task Assignment
Your task has been pre-assigned. The details are provided above:
- Task ID, Task Path, Repo Path, Context Manifest

You do NOT need to call claim_task. Proceed directly with your work.
```

Keep all `signal_done` and `signal_back` instructions as-is.

### 6. Process Exit Monitoring

Add a background task that polls agent PIDs:

```python
async def monitor_agent_processes(db, config):
    """Detect dead agent processes and handle accordingly."""
    while True:
        wip_tasks = await db.fetch_by_status("WIP")
        for task in wip_tasks:
            if task.agent_pid and not is_pid_alive(task.agent_pid):
                # Agent exited without signaling — treat as failure
                log.warning("agent_died_without_signal", task_id=task.id, pid=task.agent_pid)
                await db.update_task_state(task.id, status="PENDING")
                await db.increment_stage_attempts(task.id)
        await asyncio.sleep(15)  # check every 15 seconds
```

Add to `asyncio.gather` in `main.py`.

## Testing Requirements

1. SSE server starts and accepts connections on :3100
2. MCP tools are accessible via SSE transport
3. `signal_done` via SSE advances a task to the next stage
4. `signal_back` via SSE moves a task back with lifetime_bounces increment
5. `--mcp-config` is included in the spawn command
6. `claim_task` is no longer in the MCP tool list
7. Process exit monitor detects dead agents
8. Full round-trip: approve → TODO → ARCHITECTING → agent signals done → SPECKING

## Acceptance Criteria

- [ ] MCP SSE server runs on :3100
- [ ] Agents connect to it via `--mcp-config`
- [ ] `signal_done` advances task to next stage
- [ ] `signal_back` returns task to specified stage
- [ ] `claim_task` removed
- [ ] All 5 prompts updated (no claim_task reference)
- [ ] Process exit monitor catches dead agents within 15 seconds
- [ ] Existing tests pass
- [ ] Full E2E: task goes COOKING → TODO → ARCHITECTING → (agent signals done) → SPECKING

## Dependencies

- 064 (task_path fix) — merged ✅
- 065 (SPEC protection) — merged ✅

## Risks

- Claude Code `-p` mode may not initialize MCP connections before processing the prompt — needs early testing
- SSE transport may have different behavior than stdio for tool call timing
- If MCP connection fails, agent should still work (graceful degradation) — just can't signal back
