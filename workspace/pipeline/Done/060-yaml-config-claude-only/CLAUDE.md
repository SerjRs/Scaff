# Claude Code Instructions — 060

Read `CODEBASE.md` in this folder first — it's the authoritative API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/060-yaml-config-claude-only` from main.
2. Commit frequently with format: `[060] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points
- Add `load_config(pipeline_root: Path) -> PipelineConfig` to `orchestrator/core/config.py`
- Loads `pipeline.config.yaml` from the pipeline root, merges with defaults
- All agent harnesses must be `claude-code` only — remove codex-cli and gemini-cli from `_build_command()`
- Update `main.py` to call `load_config()` instead of constructing PipelineConfig directly
- Create `orchestrator/tests/test_config.py` with 6 test cases (see SPEC.md)
- YAML `model_escalation` string keys must be converted to int keys
- Unknown YAML keys → warning log, not error
- Missing config file → use defaults silently

## Do NOT Modify
- db.py, filesystem.py, reconciler.py, scheduler.py, priority.py, mcp.py

## Tests
Run: `cd orchestrator && uv run pytest -v` — ALL tests must pass (existing 70 + new).

## Execution
Do NOT ask questions. Execute the full task end-to-end.
