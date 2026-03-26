# Task 067e: Knowledge Base Scaffolding

## STATUS: COOKING

## Priority: P1
## Complexity: S

## Objective

Create the KNOWLEDGE/ directory structure and initial files that agents expect to read. Also create `.pipelineignore` for context exclusion. Without these, agents reading the context manifest find no KNOWLEDGE files — a gap in every agent prompt.

## Background

Architecture spec v2.2 §11: All agents that make architectural or implementation decisions must read KNOWLEDGE files before acting. The prompts reference `KNOWLEDGE/ARCHITECTURE.md`, `KNOWLEDGE/TECH-STACK.md`, and `KNOWLEDGE/CONVENTIONS.md`.

Currently: only an empty `KNOWLEDGE/ARCHITECTURE.md` exists. The other files are missing.

## Scope

### In Scope
1. Create `pipeline/KNOWLEDGE/TECH-STACK.md` with sdlc-fabric's tech stack
2. Create `pipeline/KNOWLEDGE/CONVENTIONS.md` with coding conventions
3. Create `pipeline/KNOWLEDGE/DECISIONS/` directory with a template ADR
4. Create `pipeline/.pipelineignore` with sensible defaults
5. Populate ARCHITECTURE.md with the actual system architecture (from v2.2 §3 overview)

### Out of Scope
- Agent-driven knowledge updates (that's what `append_knowledge` MCP tool is for)

## Files to Create

### `pipeline/KNOWLEDGE/TECH-STACK.md`
```markdown
# Technology Stack
- Language: Python 3.12+
- Framework: FastAPI + asyncio
- Database: SQLite (aiosqlite)
- Configuration: YAML (pyyaml)
- Agent CLI: Claude Code (claude)
- MCP: Anthropic MCP Python SDK
- Testing: pytest + pytest-asyncio
- Package Manager: uv
- Logging: structlog
- CLI: typer + rich
```

### `pipeline/KNOWLEDGE/CONVENTIONS.md`
```markdown
# Coding Conventions
- Naming: snake_case for files, functions, variables
- Folder structure: core/ (internals), api/ (endpoints), agents/ (spawn), prompts/ (per-stage)
- Import ordering: stdlib → third-party → local
- Error handling: log + raise, never silently swallow
- Logging: structlog with key=value format
- Test file location: tests/test_<module>.py
- Commit message format: [<task-id>] <description>
- Branch naming: feature/<task-id>
```

### `pipeline/.pipelineignore`
```gitignore
__pycache__/
.venv/
node_modules/
.git/
target/
dist/
build/
*.log
*.lock
*.pyc
.pytest_cache/
.mypy_cache/
AGENT.log
PROMPT.md
.context-manifest.txt
```

## Acceptance Criteria

- [ ] TECH-STACK.md exists with accurate content
- [ ] CONVENTIONS.md exists with project conventions
- [ ] DECISIONS/ directory exists
- [ ] .pipelineignore exists with sensible defaults
- [ ] ARCHITECTURE.md populated with system overview
- [ ] Context manifest correctly excludes .pipelineignore patterns

## Dependencies

- None (can be implemented independently)
