# Gate 5 — Dev Tools

*Ref: `ROADMAP.md`, `scaff-dev-tools.md`*
*Started: 2026-03-07*

---

## Tool Priority
1. Import & Dependency Graph (highest impact)
2. **Build + Test Runner — structured output** ← starting here (quickest win)
3. Semantic Code Search
4. Architecture State Tracker

---

## Tool 2: Structured Build + Test Runner

### Step 1: Build the wrapper script
**Plan (2026-03-07 10:00):** Create a script that wraps `pnpm build` (tsc) and `npx vitest run` with `--reporter json`, parses output into structured JSON with file/line/message for errors and test failures. Expose as a callable script at `scripts/build-test.mjs`.

**Result:** *(pending)*

---

### Step 2: Test with real build + test run
**Plan:** Run the script against the actual codebase, verify structured output captures real errors and test results correctly.

**Result:** *(pending)*

---

### Step 3: Integration — make it available as a tool or alias
**Plan:** Wire into the workflow so Scaff/Claude Code can call it and get structured feedback. Consider making it a Cortex tool or a simple CLI alias.

**Result:** *(pending)*
