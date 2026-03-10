# Fix: Router Executor Read Tool Workspace Scope

## Problem
Router executor agents have their `read` tool rooted at `workspace-router-executor/` (via `resolveAgentWorkspaceDir` in `src/agents/agent-scope.ts` line ~270). This means they can't read source files or main workspace docs with the read tool. They CAN read anything via exec/shell commands, so the restriction is pointless and wastes tokens on failed read attempts.

## Semantic Code Search
You have access to a semantic code search tool. Use it BEFORE grepping:
```
node scripts/code-search.mjs "your query"
```
It searches 14,148 indexed source code chunks and returns file paths, line numbers, and snippets ranked by relevance.

## Key Files
- `src/agents/agent-scope.ts:255` - `resolveAgentWorkspaceDir()` returns `path.join(stateDir, "workspace-" + id)` for non-default agents
- `src/agents/pi-tools.ts:291` - `workspaceRoot = resolveWorkspaceRoot(options?.workspaceDir)` - read tool root
- `src/agents/pi-tools.ts:328` - `createReadTool(workspaceRoot)` - read tool is created with this root
- `src/agents/tool-fs-policy.ts` - `resolveToolFsConfig()` - `tools.fs.workspaceOnly` config
- `src/router/gateway-integration.ts:49` - executor runs under `router-executor` agent
- `openclaw.json` - config file, currently has NO `router-executor` agent entry

## Fix Approach
Change `resolveAgentWorkspaceDir()` so `router-executor`'s workspace resolves to the OpenClaw root (`~/.openclaw/`) instead of `workspace-router-executor/`. This way the read tool can access source, docs, workspace - everything needed for development tasks.

ALTERNATIVE: Add a `router-executor` entry to `openclaw.json` `agents.list` with `workspace` pointing to `~/.openclaw/`. Simpler config change, no code change.

Pick the cleanest approach.

## After Fixing
1. Verify with: `pnpm build` (must pass)
2. Run relevant tests if any exist
3. Git add and commit with descriptive message
4. Do NOT push to git
5. Do NOT restart the gateway
