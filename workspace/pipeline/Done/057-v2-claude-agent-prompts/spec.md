---
id: 057
title: V2 Agent Prompts & MCP Config
priority: P1
status: Cooking
branch: feat/057-v2-claude-agent-prompts
epic: 050-PIPELINE-V2.1
---

# Specification: V2 Agent Prompts & MCP Config

## Objective
Extract the agent system prompts from the v2.1 Architecture Specification and save them as dedicated markdown files. Configure the project-level `.claude/mcp.json` so that any spawned Claude Code instance can communicate with the Orchestrator via the Model Context Protocol.

## Architecture & Context
The Orchestrator injects these prompt files into the agent subprocesses on startup. The agents use the MCP tools defined in the prompt to claim tasks, signal completion, and return tasks for rework. There are no more `.signal` files; it is 100% MCP.

## Implementation Requirements

### 1. System Prompts (`orchestrator/prompts/`)
Create the following files in the `orchestrator/prompts/` directory. Populate them using the exact "System prompt core directives" defined in Section 10 of the Architecture Spec:
- `architect.md` (Must include instructions for DECISION 1, 2, and 3, and `orchestrator_append_knowledge`).
- `spec.md` (Must include instructions for simple vs. split tasks, and required sections).
- `execution.md` (Must include the strict implementation rules and E2E test constraints).
- `review.md` (Must include the 10-point checklist and PASS/FAIL rules).
- `testing.md` (Must include the 4-step testing protocol and exact PASS/FAIL actions).

*Crucial addition to all prompts:* Add a prominent note at the top of every file stating: "You MUST use the provided `orchestrator_*` MCP tools to signal your progress. Do NOT write .signal files."

### 2. MCP Configuration (`.claude/mcp.json`)
Create or update `.claude/mcp.json` at the root of the repository to configure the stdio connection to the Orchestrator.

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "uv",
      "args": ["run", "python", "-m", "api.mcp"],
      "env": {
        "ORCHESTRATOR_DB": "orchestrator/pipeline.db",
        "PIPELINE_TOKEN": "local-dev-token"
      }
    }
  }
}