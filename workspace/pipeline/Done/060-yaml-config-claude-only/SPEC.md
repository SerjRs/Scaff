# Task 060: YAML Config + Claude-Only Agents

## STATUS: AGREED

## Priority: P1
## Complexity: M

## Objective

Replace the hardcoded Python dataclass defaults in `core/config.py` with a user-editable `pipeline.config.yaml` file. Simplify agent harnesses to Claude Code only (remove codex-cli and gemini-cli harnesses for now). Every stage should use the `claude-code` harness with a configurable model.

## Scope

### In Scope
- YAML config file schema and loader
- Override `PipelineConfig` defaults from YAML on startup
- All 5 agent stages default to `claude-code` harness
- Per-stage model configuration
- Per-stage concurrency, SLA timeout, and retry configuration
- Validation on load (unknown keys, invalid models, missing required fields)

### Out of Scope
- Codex CLI harness (future task)
- Gemini CLI harness (future task)
- Hot-reload of config (restart required)
- Web UI for config editing

## Config File Location

The `pipeline.config.yaml` lives in the project's `pipeline/` folder (the `--root` directory). The orchestrator reads it on startup. If the file doesn't exist, Python dataclass defaults are used.

## Config Schema

```yaml
# pipeline.config.yaml — lives in <project>/pipeline/

# Orchestrator settings
tick_interval_seconds: 10
max_context_bytes: 3355443
max_lifetime_bounces: 8

# Per-stage concurrency limits (max simultaneous WIP tasks)
concurrency:
  ARCHITECTING: 1
  SPECKING: 2
  EXECUTION: 3
  REVIEW: 1
  TESTING: 2

# Per-stage SLA timeouts in seconds
sla_timeouts:
  ARCHITECTING: 3600
  SPECKING: 1800
  EXECUTION: 14400
  REVIEW: 3600
  TESTING: 7200

# Per-stage retry limits (max stage_attempts before FAILED)
retry:
  ARCHITECTING: 2
  SPECKING: 3
  EXECUTION: 4
  REVIEW: 2
  TESTING: 3

# Agent configuration — all stages use claude-code harness
agents:
  architect:
    model: claude-opus-4-6
    prompt_file: orchestrator/prompts/architect.md
    effort: high
  spec:
    model: claude-sonnet-4-6
    prompt_file: orchestrator/prompts/spec.md
  execution:
    model: claude-sonnet-4-6
    prompt_file: orchestrator/prompts/execution.md
    model_escalation:
      3: claude-opus-4-6
      4: claude-opus-4-6
  review:
    model: claude-opus-4-6
    prompt_file: orchestrator/prompts/review.md
    effort: high
    thinking: extended
  testing:
    model: claude-sonnet-4-6
    prompt_file: orchestrator/prompts/testing.md
```

## Files to Create / Modify

- `orchestrator/core/config.py` — **MODIFY**: add `load_config(pipeline_root: Path) -> PipelineConfig` function. Remove codex/gemini defaults. All agents default to `harness: "claude-code"`.
- `orchestrator/main.py` — **MODIFY**: call `load_config()` on startup instead of constructing `PipelineConfig` manually.
- `orchestrator/agents/base.py` — **MODIFY**: remove `codex-cli` and `gemini-cli` branches from `_build_command()`. Only keep `claude-code`. Remove `execution_wrapper.py` import if present.
- `orchestrator/tests/test_config.py` — **CREATE**: tests for config loading.

## Implementation Notes

1. Use `pyyaml` (already a dependency) to load the YAML file.
2. The `load_config()` function should:
   - Construct a default `PipelineConfig`
   - Check if `pipeline_root / "pipeline.config.yaml"` exists
   - If yes: load YAML, merge with defaults (YAML values override defaults)
   - Validate: warn on unknown keys, error on invalid types
   - Return the merged `PipelineConfig`
3. For the `agents` section: YAML values create `AgentConfig` instances. The `harness` field should always be `"claude-code"` — if the YAML specifies it, accept it; if omitted, default to `"claude-code"`.
4. The `model_escalation` in YAML uses string keys (YAML doesn't support int keys). The loader must convert them to `dict[int, str]`.

## Acceptance Criteria

- [ ] `pipeline.config.yaml` is loaded from `--root` directory on startup
- [ ] Missing config file → defaults used, no error
- [ ] All 5 agent stages default to `claude-code` harness
- [ ] Per-stage model is configurable via YAML
- [ ] Per-stage concurrency, SLA, retry are configurable via YAML
- [ ] `model_escalation` YAML string keys are converted to int keys
- [ ] Unknown YAML keys produce a warning log (not an error)
- [ ] Invalid types produce an error and abort startup
- [ ] `_build_command()` only supports `claude-code` harness
- [ ] All existing tests still pass
- [ ] New config loading tests pass

## Dependencies

None — this is the first task.
