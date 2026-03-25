# Claude Code Instructions — 062

Read `CODEBASE.md` in this folder first — it's the authoritative API surface.
Read `SPEC.md` for the full task specification.

## Git Workflow
1. Create branch `feat/062-config-docs-skill-update` from main.
2. Commit frequently with format: `[062] <description>`.
3. Push the branch when done. Do NOT merge to main.

## Key Points
- Expand README.md "Configuration" section with full YAML reference and model table
- Add "Agent Prerequisites" section to README (Claude CLI install + auth)
- Update `skill/SKILL.md` with config file location, common edits, examples
- Create `examples/pipeline.config.yaml` — fully commented example config
- Update `CODEBASE.md` with new signatures from 060 (`load_config`) and 061 (spawn changes)
- Remove any remaining references to codex-cli or gemini-cli from docs

## Do NOT Modify
- Any Python source code

## Tests
No code changes — just verify existing tests still pass: `cd orchestrator && uv run pytest -v`

## Execution
Do NOT ask questions. Execute the full task end-to-end.
