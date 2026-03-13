# Task 006 — Router Weight-Based Timeout

## Instructions

1. **Read STATE.md first** — if it exists, resume from where the previous run stopped.
2. **Read SPEC.md** — full implementation spec with architecture, code changes, and test requirements.
3. **Branch:** `feat/router-weight-timeout` — create it if it doesn't exist, checkout if it does.
4. **Commit after each file** — small incremental commits preserve progress if you're interrupted.
5. **Update STATE.md after each milestone** — mark what's done, what's next.
6. **Run tests before final commit:** `npx vitest run src/router/`
7. **Push the branch** when all tests pass.
8. **Create PR** to `main` with a clear description.
9. **Merge the PR** after creation (auto-merge, no review required).

## Constraints

- Only modify files in `src/router/`
- `ExecutorOptions` param must be OPTIONAL (backward compat)
- Default weight when not provided: 5 (maps to 10min timeout)
- ALL existing tests must continue to pass

## Project Context

- Repo root is the parent of this pipeline folder (go up to `.openclaw`)
- Source files: `src/router/{types,gateway-integration,worker,dispatcher,loop,queue}.ts`
- Test files: `src/router/{worker,dispatcher,loop,gateway-integration}.test.ts`
- Build: `pnpm build` / Tests: `npx vitest run src/router/`
