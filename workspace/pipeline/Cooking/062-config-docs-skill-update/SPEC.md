# Task 062: Configuration Documentation + Skill Update

## STATUS: AGREED

## Priority: P2
## Complexity: S

## Objective

Document the new YAML configuration system and agent setup in the README, SKILL.md, and provide an example config template. Ensure anyone cloning the repo knows how to configure agents, models, and pipeline behavior.

## Scope

### In Scope
- Add "Configuration" section to README with full YAML reference
- Update SKILL.md with config file instructions and examples
- Create example `pipeline.config.yaml` in the repo (template)
- Document agent prerequisites (Claude CLI installation and authentication)
- Update CODEBASE.md with new/changed function signatures from 060+061

### Out of Scope
- Config validation UI
- Config migration tooling
- Codex/Gemini setup docs (they're not supported yet)

## Files to Create / Modify

- `README.md` — **MODIFY**: expand Configuration section with full YAML reference, model list, agent prerequisites
- `skill/SKILL.md` — **MODIFY**: add "Configuration File" section explaining pipeline.config.yaml, where it lives, how to edit it, example
- `skill/references/cooking-workflow.md` — **MODIFY**: mention that config lives in pipeline/ folder alongside COOKING/
- `examples/pipeline.config.yaml` — **CREATE**: fully commented example config
- `CODEBASE.md` — **MODIFY**: update with new signatures from 060 (`load_config`) and 061 (spawn changes)

## Implementation Notes

1. The README Configuration section should include:
   - Where the config file lives (`<project>/pipeline/pipeline.config.yaml`)
   - Full annotated YAML example
   - Table of all settings with defaults
   - How to change models per stage
   - Agent prerequisites section: install Claude CLI, authenticate

2. The SKILL.md update should include:
   - Quick reference to config file location
   - How to create a config for a new project
   - Common configuration changes (change model, adjust concurrency, extend timeouts)

3. The example config should be heavily commented explaining each option.

4. Agent prerequisites:
   ```
   # Install Claude CLI
   npm install -g @anthropic-ai/claude-code

   # Authenticate
   claude auth login

   # Verify
   claude --version
   ```

## Acceptance Criteria

- [ ] README has a "Configuration" section with full YAML reference
- [ ] README has an "Agent Prerequisites" section
- [ ] SKILL.md documents config file location and common edits
- [ ] `examples/pipeline.config.yaml` exists with full comments
- [ ] CODEBASE.md reflects changes from 060 and 061
- [ ] No broken links or references to removed features (codex/gemini)

## Dependencies

- 060 (YAML config) — must be merged to document the actual schema
- 061 (spawn fixes) — must be merged to document repo_path and prompt delivery
