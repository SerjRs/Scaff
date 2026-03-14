# TOOLS.md — Local Environment

## Infrastructure
- Memory-core: `%USERPROFILE%\.openclaw\memory\main.sqlite`
- Hot-cache: `_state/hot-cache/hot-cache.sqlite`
- Ollama: `127.0.0.1:11434` — serves `llama3.2:3b` (LLM) and `nomic-embed-text` (embeddings)
- Hot-memory plugin: `scaff-hot-memory` — native hooks replace PowerShell pipeline
- Gateway: `127.0.0.1:18789`

## Delegation
`scripts/delegate.ps1 -Task -Domain -Urgency` → spawns sub-agent.
Full protocol: `docs/delegation-protocol.md`

## Self-Rebuild & Restart
Script: `~/.openclaw/rebuild.ps1` — builds, kills gateway, restarts, wakes Scaff via cron.

**Usage (always detached — inline kills your session mid-exec):**
```powershell
Start-Process powershell -ArgumentList '-File "C:\Users\Temp User\.openclaw\rebuild.ps1" -Build' -WindowStyle Hidden -RedirectStandardOutput "C:\Users\Temp User\.openclaw\rebuild.log" -RedirectStandardError "C:\Users\Temp User\.openclaw\rebuild-err.log"
```
**Do NOT use `do-rebuild.cmd`** — it's a stale hardcoded script with a fixed PID. `rebuild.ps1` finds the gateway PID dynamically.
- `-Build` flag: run `pnpm build` before restart. Omit for restart-only.
- Wake-up: one-shot cron fires ~90s after restart with `REBUILD_WAKEUP` system event
- **When you receive `REBUILD_WAKEUP`**: send a WhatsApp message to Serj confirming you're back online
- `--message` does NOT work with `--session main` cron — must use `--system-event`
- **NEVER call rebuild.ps1 inline** — gateway kill takes you out before cron gets scheduled

## Code Search (`code_search` tool)
Semantic search over the OpenClaw codebase. Uses Ollama `nomic-embed-text` embeddings + sqlite-vec.

**What it does:** Finds relevant functions, classes, and code blocks by meaning — not just text matching. Returns file paths, line numbers, chunk names, and snippets ranked by similarity.

**When to use:**
- Before reading files during development — find the right code first, save tokens
- When debugging — "where is the auth retry logic?" instead of grepping
- Before spawning coding tasks — include relevant file paths as context for executors

**Who has it:**
- **Main agent (Scaff):** Native tool, call directly
- **Cortex:** Sync inline tool, executes within the same LLM turn
- **Router executors:** Available via exec (`node scripts/code-search.mjs "query" --top N`)

**Index:** `scaff-tools/code-index.sqlite` (~59MB, 2,351 files, 14,148 chunks)
**Nightly rebuild:** Windows Scheduled Task `OpenClaw-NightlyCodeIndex` at 3 AM (incremental, zero tokens)
**Manual reindex:** `node scripts/code-index.mjs` (incremental) or `--full` (complete)
**Log:** `workspace/memory/nightly-index.log`

## PowerShell escaping
Use `scripts/lib/exec-ps.ps1` or backticks. Details: `docs/powershell-escaping.md`
