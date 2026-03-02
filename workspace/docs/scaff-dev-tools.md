# Scaff Developer Tools

*Author: Scaff — based on architectural discussion with Serj*
*Date: 2026-02-28*
*Purpose: Define tools to be built that accelerate software development quality and reduce integration failures*

---

## Problem Statement

AI coding assistants (Scaff, Claude Code) consistently fail at complex software development tasks in predictable ways:

1. **Wrong architecture** — design decisions made implicitly during code generation rather than upfront
2. **Unimplemented leftovers** — tasks partially done, missing pieces not caught
3. **Implemented but not hooked** — feature written correctly but not wired into the system (startup, events, config, exports)

The architecture doc → task list workflow brings delivery to ~80%. The remaining 20% is caused by:
- No persistent world model of the codebase
- Pattern completion without runtime feedback
- Context window limits — full codebase never in context simultaneously
- **Integration blindness** — wiring lives in a different file from the feature

The tools below target these failure modes directly.

---

## Tool Priority Order

| Priority | Tool | Gap Closed | Impact |
|----------|------|-----------|--------|
| 1 | Import & Dependency Graph | Integration blindness | Very high |
| 2 | Build + Test Runner (structured output) | No runtime feedback | High |
| 3 | Semantic Code Search | Context reconstruction cost | Medium |
| 4 | Architecture State Tracker | World model persistence | Medium |

---

## Tool 1: Import & Dependency Graph

### Problem it solves
"Implemented but not hooked" — the most common failure mode. A feature is written correctly but the wiring step (registering in `server-startup.ts`, subscribing to an event, exporting from an index, adding to a config schema) is missed because it lives in a different file.

### What it does
Given any file or module in the codebase, answers:
- What files import this module?
- What files does this module import?
- Where is the startup/initialization sequence and what's registered there?
- If I modify module X, what other files are likely affected?
- What is the registration pattern for this type of module? (e.g., "how are other tools registered at startup?")

### Implementation
Built on the **TypeScript Compiler API** (`tsc` programmatic API) — it already understands the full import graph, type relationships, and symbol references without needing to run the code. No new dependencies required beyond what's already in the repo.

Key queries to support:
```
findReferences(symbol)        → all files that use this symbol
findImporters(filePath)       → all files that import this file
findRegistrationPattern(kind) → where/how modules of this kind are registered
impactOf(filePaths[])         → what else likely needs to change
```

### Integration point
Exposed as a tool Scaff can call during implementation — before declaring a task done, query "what needs wiring for this module?" and verify all integration points are covered.

### Infrastructure already available
- TypeScript compiler API (already in the repo as a dev dependency)
- `.serena/` directory exists — Serena is a code intelligence tool that may already provide symbol lookup and cross-references; evaluate before building from scratch

---

## Tool 2: Build + Test Runner (Structured Output)

### Problem it solves
Code is generated without seeing it run. Build errors and test failures are discovered late (or not at all), and raw terminal output requires interpretation. Structured output lets Scaff act on failures precisely without guessing.

### What it does
Runs `pnpm build` and `npx vitest run` and returns **structured results** — not raw stdout:

```json
{
  "build": {
    "success": false,
    "errors": [
      {
        "file": "src/cortex/gateway-bridge.ts",
        "line": 42,
        "message": "Property 'onSpawn' does not exist on type 'CortexLoop'"
      }
    ]
  },
  "tests": {
    "passed": 261,
    "failed": 4,
    "failures": [
      {
        "file": "src/router/evaluator.test.ts",
        "test": "sends correct model to Anthropic API",
        "error": "Expected fetch to be called with Anthropic URL"
      }
    ]
  }
}
```

### Why structured matters
Raw stdout requires Scaff to parse terminal output, which is noisy and error-prone. Structured output means exact file + line + message — Scaff can go directly to the problem without interpretation overhead.

### Implementation
- Wrap `pnpm build` — parse TypeScript compiler JSON output (`tsc --pretty false`)
- Wrap `vitest run` — use Vitest's `--reporter json` flag for machine-readable test results
- Expose as a callable tool with optional scope (`{ scope: "src/cortex/" }` to run subset)

### Integration point
Called at the end of each task execution. Failures are fed back to Scaff as structured context for the next turn — close the loop that human developers get automatically by running the code.

---

## Tool 3: Semantic Code Search

### Problem it solves
Every session, Scaff re-reads the same files to reconstruct codebase understanding. This burns context window tokens on orientation rather than implementation. Semantic search lets Scaff query the codebase by intent rather than by filename.

### What it does
Natural language queries against an embedded codebase index:
- "Where is the router startup sequence?"
- "How are channel adapters registered?"
- "What handles inbound WhatsApp messages?"
- "Where is the session key format defined?"

Returns: relevant file paths + line ranges + code snippets.

### Implementation
Built on infrastructure already on the machine:
- **Ollama `nomic-embed-text`** — already running, generates 768-dim embeddings
- **sqlite-vec** — already working (just fixed), stores and queries vectors
- **Indexer** — chunks TypeScript source files by function/class/block, embeds each chunk, stores in sqlite-vec with file path + line range metadata
- **Query interface** — embeds the query string, runs vector similarity search, returns top-K results

### Index update strategy
Rebuild on `git commit` or on-demand. Index stored in `~/.openclaw/scaff-tools/code-index.sqlite`. Stale chunks (file modified since last index) are re-embedded automatically.

### Integration point
Called at session start to orient Scaff to relevant codebase areas for the current task. Also callable mid-task when Scaff needs to find a pattern or locate a symbol.

### Infrastructure already available
- Ollama + nomic-embed-text: `http://127.0.0.1:11434`
- sqlite-vec: integrated into Cortex DB layer (same pattern reusable)
- Serena (`.serena/cache/typescript/document_symbols.pkl` — 83MB symbol cache exists): evaluate overlap before building from scratch

---

## Tool 4: Architecture State Tracker

### Problem it solves
Codebase understanding resets every session. Scaff reconstructs the picture from files each time. For large, evolving codebases like this one (Router + Cortex + Hippocampus on top of OpenClaw), reconstruction is slow and incomplete.

### What it does
Maintains a **live summary of implementation state** — what's built, what's wired, what's pending — and injects it into Scaff's context at session start:

```markdown
## Codebase State (as of 2026-02-28)

### Router
- Status: Complete, all tests passing (177 tests)
- Entry: src/router/index.ts
- Wired: server-startup.ts (init), server-close.ts (shutdown), subagent-spawn.ts (routing)
- Known issues: gateway-integration.ts onDelivered bug (fix pending approval)

### Cortex
- Status: Phase 8 complete, 265 tests passing, uncommitted
- Mode: shadow (webchat: live)
- Pending: Phase 8 commit + push

### Hippocampus
- Status: All phases complete
- Gate: hippocampus.enabled: false (not yet activated)
```

### Implementation
- A markdown file (`~/.openclaw/scaff-tools/codebase-state.md`) maintained by Scaff during implementation sessions
- Updated at end of each task: what was done, what was wired, what was left pending
- Injected into Scaff's system prompt at session start (small, token-efficient)
- Scaff updates it — not auto-generated, curated

### Why not auto-generated
Auto-generation from code analysis would be complex and unreliable. The state tracker is most valuable as a **curated human+AI artifact** — Scaff writes what it knows after each task, Serj corrects when wrong. Accuracy comes from the process, not from static analysis.

### Integration point
Lives alongside `MEMORY.md` in the workspace. Read at session start alongside other workspace files. Updated whenever implementation state changes.

---

## Infrastructure Summary

Tools 1–3 can be built largely from components already on the machine:

| Component | Already available | Used by |
|-----------|------------------|---------|
| TypeScript Compiler API | Yes (dev dependency) | Tool 1 |
| Serena code intelligence | Possibly (`.serena/` exists) | Tools 1, 3 |
| Ollama `nomic-embed-text` | Yes (`127.0.0.1:11434`) | Tool 3 |
| sqlite-vec | Yes (just fixed) | Tool 3 |
| `pnpm build` + TypeScript JSON output | Yes | Tool 2 |
| Vitest JSON reporter | Yes | Tool 2 |

Before building Tools 1 and 3 from scratch, evaluate what Serena already provides — it has a 83MB TypeScript symbol cache which suggests it may already cover symbol lookup and cross-references.

---

## Known Limitations of AI Coding Assistants

Understanding where both Scaff and Claude Code fall short is necessary context for why the tools above are needed.

### Scaff (conversational, no filesystem access)

| Failure mode | Severity | Root cause |
|---|---|---|
| Integration blindness | High | Wiring steps live in files not in context |
| No runtime feedback | High | Cannot run code or see build/test output |
| Context limits | High | Large codebases don't fit in context window |
| Session amnesia | High | Codebase understanding resets every session |
| Architecture drift | High without spec | Makes implicit design decisions during generation |

### Claude Code (has filesystem access + can run commands)

Claude Code is meaningfully better than Scaff at implementation — it reads files directly, runs builds, sees test failures, and iterates. But it shares the same *class* of problems, just less severe.

**Reactive exploration, not a complete map.**
Claude Code reads files it *thinks* are relevant. It follows imports it notices, checks patterns it recognizes. If the wiring step lives in a file it didn't think to open — `server-startup.ts`, an event subscription three files away — it misses it. It has no pre-built graph of the codebase. Integration blindness persists.

**Context limits still apply.**
A codebase like ours (250+ source files across OpenClaw + Router + Cortex + Hippocampus) does not fit in Claude Code's context window. It reads a subset. The subset is usually good enough, but the gaps are exactly where integration failures happen.

**Session amnesia.**
Each Claude Code session starts cold. It doesn't remember what it implemented last session, what was wired, what was left pending. It reconstructs from files — faster than Scaff because it can read directly, but still incomplete.

**Architecture blindness without a spec.**
Without an architecture document, Claude Code makes local design decisions that seem reasonable in isolation but don't fit the broader system. It implements correctly at file level, incorrectly at system level. This is why the architecture doc → task list workflow matters even when using Claude Code.

### Comparative summary

| Failure mode | Scaff | Claude Code |
|---|---|---|
| Integration blindness | High | Medium — still present |
| No runtime feedback | High | Low — runs code, sees output |
| Context limits | High | Medium — reads more but still limited |
| Session amnesia | High | High — same problem |
| Architecture drift | High without spec | Medium without spec |

### What the tools in this document address

The tools defined here target the gaps that *neither* assistant closes on its own:
- **Tool 1 (Import graph)** → closes integration blindness for both
- **Tool 2 (Structured build/test output)** → already partially addressed by Claude Code; structured format makes it actionable for Scaff too
- **Tool 3 (Semantic code search)** → reduces context reconstruction cost for both
- **Tool 4 (Architecture state tracker)** → closes session amnesia for both

---

## Existing Capability: Claude Code Access

Before building any of the tools above, note that Scaff already has access to **Claude Code** via the `coding-agent` skill (`~/.openclaw/skills/coding-agent/SKILL.md`).

This means Scaff can spawn Claude Code as a background PTY process in any directory, monitor its progress, steer it, and receive completion notifications. Claude Code has full filesystem access, runs builds, and sees test failures — it closes the runtime feedback loop that Scaff alone lacks.

**How this fits the workflow:**
1. Architecture doc + task list produced collaboratively with Serj
2. Each task fed to Claude Code in the correct `workdir`
3. Claude Code implements with full build/test feedback
4. Scaff monitors, steers when it drifts, verifies output

This already addresses a significant portion of Gap 2 (no runtime feedback) without building anything new. The tools defined in this document are **complementary** — they give Claude Code (and Scaff) better codebase intelligence to work with, not a replacement for this existing capability.

**Constraint:** Never spawn Claude Code in `~/.openclaw/` directly — that is the live OpenClaw instance. Always target the source directory with a specific task scope.

---

## Expected Impact on Delivery Quality

With all four tools active:

| Failure mode | Current state | With tools |
|-------------|--------------|-----------|
| Wrong architecture | Solved by arch doc workflow | No change needed |
| Unimplemented leftovers | Caught by task list + tests | Tool 2 catches at build time |
| Implemented but not hooked | Caught manually or not at all | Tool 1 catches before task close |
| Context reconstruction | ~20% of session burned on orientation | Tool 3 + Tool 4 reduce to near zero |
| Runtime surprises | Discovered in production | Tool 2 closes feedback loop |

Target: move from 80% delivery to 95%+. The remaining gap is design decisions too subtle for static analysis — those still require the architecture doc + debate workflow.
