# Action Plan: Bootstrapping Pipeline v2.1

## Phase 1: The Brain and the Skeleton
*These tasks build the Python foundation, the SQLite source of truth, and safe file-handling.*

### 051-v2-orchestrator-init-and-db
* **Goal:** Set up the Python project and the SQLite data layer.
* **Specs:** Initialize Python 3.12 with `uv`. Write `core/db.py` using `aiosqlite`. Implement the v2.1 SQLite schema (`tasks`, `dependencies`, `priority_patches`, `pipeline_events`, `knowledge_appends`). Add CRUD methods. Write in-memory SQLite tests.

### 052-v2-filesystem-and-manifest
* **Goal:** Build folder management and context hygiene.
* **Specs:** Write `core/filesystem.py`. Implement move-first/commit-second logic using `shutil`. Build `build_context_manifest` to apply the extension allowlist and `.pipelineignore` denylist, calculate byte sizes, and write `.context-manifest.txt`.

## Phase 2: The Central Nervous System
*This is where the Orchestrator learns to talk.*

### 053-v2-mcp-server
* **Goal:** Build the communication protocol.
* **Specs:** Write `api/mcp.py`. Expose the 6 specific tools (`orchestrator_claim_task`, `orchestrator_signal_done`, etc.) using the Anthropic MCP SDK over `stdio`. Connect these tools to the DB and filesystem functions from 051/052.

## Phase 3: The Engine
*Bringing the state machine to life and giving it the ability to spawn agents.*

### 054-v2-core-loop-and-reconciler
* **Goal:** Make the Orchestrator autonomous.
* **Specs:** Write `core/reconciler.py` to fix SQLite mismatches on startup. Write `core/scheduler.py` for the 10-second async loop: check concurrency, verify `DEPS.MD`, drain knowledge appends, write `PRIORITY.MD`. *Stub out the agent spawner.*

### 055-v2-agent-spawning
* **Goal:** Fire up subprocesses and handle git state.
* **Specs:** Write `agents/base.py` to replace the stub from 054. Use `asyncio.create_subprocess_exec` to launch models, inject environment variables (`PIPELINE_MANIFEST`), and pipe output to `AGENT.log`. Write `agents/execution_wrapper.py` to sanitize the git tree (`git reset --hard`) on retries.

## Phase 4: The Dashboard
*Building human override controls.*

### 056-v2-rest-api-and-cli
* **Goal:** Build the REST backend and Terminal UI.
* **Specs:** Write `api/rest.py` (FastAPI) for endpoints (`/health`, `/tasks/{id}/cancel`, `/tasks/{id}/approve`). Write `main.py` using Typer to create CLI commands (`pipeline status`, `pipeline serve`) that hit the API. Ensure `serve` starts the API, MCP, and Core Loop concurrently.

## Phase 5: The Agent Personas
*Adapting Claude Code to play all the roles temporarily.*

### 057-v2-claude-agent-prompts
* **Goal:** Create the brains for the v2 pipeline.
* **Specs:** Create `orchestrator/prompts/`. Draft system prompts for `architect.md`, `spec.md`, `execution.md`, `review.md`, and `testing.md`. Configure `.claude/mcp.json` so Claude Code knows how to spin up the Orchestrator's MCP server.

---

## Execution Strategy

1. Create `Cooking/051-v2-orchestrator-init-and-db`.
2. Write the `SPEC.md` based on the specs above, add `CLAUDE.md` and `STATE.md`.
3. Move it to `InProgress/` and spawn your v1 Claude Code executor.
4. Merge the branch, move 051 to `Done/`, and repeat sequentially through 057.
5. Once `057` is merged, run `uv run main.py serve`. The Orchestrator will boot up, reconcile the file system, spin up its API and MCP ports, and begin watching the queue.