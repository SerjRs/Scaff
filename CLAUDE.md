# Claude Code Instructions — 020i

## Branch
`feat/020i-cortex-e2e-config`

## Task
Create `src/cortex/__tests__/e2e-webchat-config.test.ts` — E2E tests for Cortex configuration and mode switching through webchat.

## What to Build

Read the SPEC: `workspace/pipeline/InProgress/020i-cortex-e2e/SPEC.md`

~3 tests in category J (Configuration & Modes):
- J1: Hippocampus disabled — no memory tools or Knowledge Graph section in floor
- J2: Shadow mode — LLM called but no output delivered to adapter
- J3: Cortex config persistence across restart

## Key Architecture

- **Hippocampus toggle**: `hippocampusEnabled` in startCortex config controls whether memory_query/graph_traverse tools are registered and whether Knowledge Graph section appears in system floor
- **Shadow mode**: per-channel mode stored in `cortex/config.json`. In shadow mode, Cortex processes messages (calls LLM) but does NOT send output to the adapter
- **Config persistence**: `cortex_config` tool writes to a JSON file; on restart, config is reloaded

Read:
- `src/cortex/index.ts` — hippocampusEnabled config
- `src/cortex/tools.ts` — conditional tool registration based on config
- `src/cortex/output.ts` or `src/cortex/loop.ts` — shadow mode output suppression
- `src/cortex/config.json` handling — check where cortex config is read/written

## Patterns

Follow `src/cortex/__tests__/e2e-webchat-flow.test.ts` for startCortex + adapter pattern.

For J2 (shadow mode), you may need to set the config before starting Cortex, or use the cortex_config tool within a test.

For J3 (persistence), start Cortex → set config → stop → start again → verify config retained.

## Test Results

Use `TestReporter` from `src/cortex/__tests__/helpers/hippo-test-utils.ts`.
Write to: `workspace/pipeline/InProgress/020i-cortex-e2e/TEST-RESULTS.md`

## Steps

1. Read SPEC.md, index.ts, tools.ts, loop.ts/output.ts for config/shadow handling
2. Create the test file
3. Run: `pnpm install && npx vitest run src/cortex/__tests__/e2e-webchat-config.test.ts --reporter=verbose`
4. Fix failures
5. Commit, push, create PR: `gh pr create --title "test(cortex): 020i — E2E webchat configuration & modes" --base main`
6. Signal: `openclaw system event --text "Done 020i"`

## Constraints
- Do NOT modify source files — test-only
- All deterministic, no network
