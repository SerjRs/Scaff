# Instructions for Claude Code Executor

## Task Context
You are finalizing the V2 pipeline by generating the system prompts for the AI agents and configuring the MCP connection.

## Git Workflow
1. Branch name: `feat/057-v2-claude-agent-prompts`
2. Check out this branch based on `main` (ensure it includes all prior v2 tasks up to 056).
3. Commit frequently. Format: `[057] <description>`.

## Technical Constraints
- Read the provided `Architecture-PIPELINE-SPEC-v2.1.md` file (if available in the repo) or rely on your knowledge of the pipeline design to populate the prompt files.
- The prompts must explicitly mention the use of the `.context-manifest.txt` file.
- Ensure the JSON syntax in `.claude/mcp.json` is perfectly valid.

## Execution Steps
1. Read `STATE.md` to check current progress.
2. Create the directory `orchestrator/prompts/` if it does not exist.
3. Create and populate `architect.md`.
4. Create and populate `spec.md`.
5. Create and populate `execution.md`.
6. Create and populate `review.md`.
7. Create and populate `testing.md`.
8. Create/update `.claude/mcp.json` at the repo root.
9. Update `STATE.md`.
10. Push the branch.