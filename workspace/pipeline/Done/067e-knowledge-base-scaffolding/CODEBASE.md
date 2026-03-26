# CODEBASE.md — 067e Relevant Surface

## Context Manifest Builder (`core/filesystem.py`)

The `.pipelineignore` is already consumed by the context manifest builder:

```python
def build_context_manifest(task_path: Path, config: PipelineConfig) -> Path:
    ignore_patterns: list[str] = []

    global_ignore = config.pipeline_root / ".pipelineignore"   # <-- THIS is what we're creating
    if global_ignore.is_file():
        ignore_patterns.extend(global_ignore.read_text().splitlines())

    task_ignore = task_path / ".pipelineignore"
    if task_ignore.is_file():
        ignore_patterns.extend(task_ignore.read_text().splitlines())

    spec = pathspec.PathSpec.from_lines("gitignore", ignore_patterns)  # gitignore syntax

    # ... collects files, checks extensions, checks size, writes manifest
```

**Key:** Patterns use gitignore syntax via the `pathspec` library. Standard glob patterns work.

---

## Existing Pipeline Structure

```
pipeline/
├── COOKING/
│   ├── 063-code-review-graph/
│   │   └── SPEC.md
│   └── 066-kanban-dashboard/
│       └── SPEC.md
├── KNOWLEDGE/
│   └── ARCHITECTURE.md          # <-- exists, may have content from append_knowledge
├── pipeline.config.yaml
├── .mcp-agent-config.json       # auto-generated
└── pipeline.db                  # auto-generated
```

**Target structure after this task:**
```
pipeline/
├── .pipelineignore              # NEW
├── KNOWLEDGE/
│   ├── ARCHITECTURE.md          # UPDATED — add system overview
│   ├── TECH-STACK.md            # NEW
│   ├── CONVENTIONS.md           # NEW
│   └── DECISIONS/
│       └── _TEMPLATE.md         # NEW — ADR template
└── ... (existing files)
```

---

## Dependencies from `pyproject.toml` (for TECH-STACK.md accuracy)

```toml
[project]
requires-python = ">=3.12"
dependencies = [
    "aiofiles>=24.1.0",
    "aiosqlite>=0.21.0",
    "fastapi>=0.115.12",
    "httpx>=0.28.1",
    "mcp[cli]>=1.9.4",
    "pathspec>=0.12.1",
    "pyyaml>=6.0.2",
    "rich>=14.0.0",
    "structlog>=25.1.0",
    "typer>=0.15.4",
    "uvicorn>=0.34.2",
]

[dependency-groups]
dev = [
    "pytest>=8.3.5",
    "pytest-asyncio>=0.26.0",
]
```

---

## Agent Prompts (reference KNOWLEDGE files)

All 5 prompts in `orchestrator/prompts/` reference knowledge files in their startup sequence:

```markdown
## Startup Sequence
1. Read files listed in `.context-manifest.txt`:
   - TASK-SPEC.md, ...
   - KNOWLEDGE/ARCHITECTURE.md
```

The agents expect these files to exist. Currently only ARCHITECTURE.md exists (possibly empty or with appended content).

---

## Architecture Spec v2.2 §3 Overview (source for ARCHITECTURE.md)

Located at: `docs/050-PIPELINE-V2.1/Architecture-PIPELINE-SPEC-v2.2.md`

Key sections to distill:
- System overview diagram
- Component list (Orchestrator, Scheduler, MCP Server, REST API, Agents, Monitor)
- Data flow (COOKING→TODO→ARCH→SPEC→EXEC→REVIEW→TEST→DONE)
- Key principles (pre-assigned tasks, stdin+MCP two-channel, SSE transport)

---

## Files Summary

| File | Action |
|------|--------|
| `pipeline/.pipelineignore` | CREATE — gitignore-syntax exclusion patterns |
| `pipeline/KNOWLEDGE/ARCHITECTURE.md` | UPDATE — add system overview at top |
| `pipeline/KNOWLEDGE/TECH-STACK.md` | CREATE — from pyproject.toml + codebase |
| `pipeline/KNOWLEDGE/CONVENTIONS.md` | CREATE — from code patterns |
| `pipeline/KNOWLEDGE/DECISIONS/_TEMPLATE.md` | CREATE — ADR template |
