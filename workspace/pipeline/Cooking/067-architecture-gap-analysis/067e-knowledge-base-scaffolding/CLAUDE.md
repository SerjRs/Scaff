# Claude Code Instructions — 067e

Read `CODEBASE.md` in this folder first — it's the relevant API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/067e-knowledge-base-scaffolding` from main.
2. Commit frequently with format: `[067e] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points

### 1. Create Knowledge Files
All files go under `pipeline/KNOWLEDGE/` in the sdlc-fabric repo:

- `TECH-STACK.md` — Python 3.12+, FastAPI, asyncio, SQLite/aiosqlite, YAML, Claude Code, MCP SDK, pytest, uv, structlog, typer+rich
- `CONVENTIONS.md` — snake_case, folder structure (core/api/agents/prompts), import ordering, error handling, logging, test location, commit format, branch naming
- `DECISIONS/` directory with a `_TEMPLATE.md` ADR file
- Update existing `ARCHITECTURE.md` with system overview from Architecture Spec v2.2 §3

### 2. Create `.pipelineignore`
At `pipeline/.pipelineignore` — patterns for the context manifest builder to exclude:
- `__pycache__/`, `.venv/`, `node_modules/`, `.git/`, `target/`, `dist/`, `build/`
- `*.log`, `*.lock`, `*.pyc`, `.pytest_cache/`, `.mypy_cache/`
- `AGENT.log`, `PROMPT.md`, `.context-manifest.txt`

### 3. Content Accuracy
- Read the actual codebase to verify tech stack claims
- Read `pyproject.toml` for dependencies
- Read existing code patterns for conventions
- Don't invent — document what IS

## Do NOT Modify
- `core/` — no code changes
- `agents/` — no code changes
- `api/` — no code changes
- Any `.py` files — this is a content-only task

## Tests
- No new tests needed (content files only)
- Run full suite to verify nothing broke: `cd orchestrator && uv run pytest -v`
- All 93 existing tests must still pass

## Important
- The `build_context_manifest()` function in `core/filesystem.py` already reads `.pipelineignore` — verify the patterns work with its `pathspec` library
- KNOWLEDGE/ARCHITECTURE.md may already have content from `append_knowledge` MCP calls — preserve existing content, add system overview at the top
- ADR template should follow standard format: Title, Status, Context, Decision, Consequences

## Execution
Do NOT ask questions. Execute the full task end-to-end.
