# Self-Improvement Loop — Architecture

*Version: 0.1 — Draft for discussion*
*Status: Pending review*
*Ref: `scaff-roadmap.md` (Milestone 0), `scaff-dev-tools.md`, `cortex-architecture.md`*

---

## 0. Safety Gate

All self-improvement activity is gated behind explicit human checkpoints. Scaff identifies gaps and proposes changes — it does not apply changes to its own architecture without Serj's approval at defined review points. The loop is autonomous in analysis and preparation; it requires approval before execution.

---

## 1. Overview

The self-improvement loop is a repeatable cycle that allows Scaff to identify its own architectural weaknesses, prioritize them, implement fixes, verify improvement, and judge convergence — with Serj as a checkpoint rather than the driver.

```
┌─────────────┐
│   Observe   │ ← structured data from logs, tests, session outcomes
└──────┬──────┘
       ↓
┌─────────────┐
│   Assess    │ ← evaluate against rubric, identify gaps
└──────┬──────┘
       ↓
┌─────────────┐
│  Prioritize │ ← rank by: frequency × severity ÷ fix complexity
└──────┬──────┘
       ↓
┌─────────────┐     ┌──────────────────┐
│   Propose   │────▶│  Serj Checkpoint │ ← review + approve/reject
└──────┬──────┘     └──────────────────┘
       ↓ (approved)
┌─────────────┐
│  Implement  │ ← Claude Code executes scoped tasks
└──────┬──────┘
       ↓
┌─────────────┐
│    Test     │ ← unit tests + behavioral scenarios
└──────┬──────┘
       ↓
┌─────────────┐
│   Converge? │ ← stop if good enough; loop if not
└─────────────┘
```

---

## 2. Components

### 2.1 Observability Layer

Scaff cannot improve what it cannot measure. The observability layer collects structured data from existing sources — no new instrumentation unless a gap exists.

**Primary data sources:**

| Source | What it provides | Format |
|--------|-----------------|--------|
| Router `queue.sqlite` | Task weights, tier assignments, completion status, timing | SQLite — already queryable |
| Cortex `bus.sqlite` | Message flow, pending ops, session activity | SQLite — already queryable |
| Hippocampus `cortex_hot_memory` | Fact retention, hit counts, eviction rate | SQLite — already queryable |
| Vitest JSON output | Test pass/fail, coverage, failure locations | JSON via `--reporter json` |
| TypeScript compiler output | Build errors, type violations, file/line | JSON via `tsc --pretty false` |
| Gateway stdout (structured) | Startup events, errors, channel status | Parsed log lines |

**Observability store:** `~/.openclaw/scaff-tools/observability.sqlite` (WAL mode)

**Schema:**

```sql
CREATE TABLE assessment_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  triggered_by TEXT NOT NULL,  -- 'manual' | 'scheduled' | 'post-task'
  summary TEXT                 -- brief outcome description
);

CREATE TABLE metrics (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES assessment_runs(id),
  dimension TEXT NOT NULL,     -- see rubric dimensions
  value REAL NOT NULL,         -- measured value
  unit TEXT NOT NULL,          -- 'rate' | 'count' | 'ms' | 'score'
  measured_at TEXT NOT NULL
);

CREATE TABLE gaps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES assessment_runs(id),
  dimension TEXT NOT NULL,
  description TEXT NOT NULL,
  root_cause TEXT,
  frequency TEXT NOT NULL,     -- 'high' | 'medium' | 'low'
  severity TEXT NOT NULL,      -- 'high' | 'medium' | 'low'
  fix_complexity TEXT NOT NULL,-- 'high' | 'medium' | 'low'
  priority_score REAL,         -- computed: frequency × severity ÷ complexity
  status TEXT NOT NULL DEFAULT 'open'  -- 'open' | 'proposed' | 'in-progress' | 'closed' | 'deferred'
);

CREATE TABLE improvement_tasks (
  id TEXT PRIMARY KEY,
  gap_id TEXT NOT NULL REFERENCES gaps(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  verification_criteria TEXT NOT NULL,  -- how we know it worked
  complexity_cost TEXT NOT NULL,        -- estimate of implementation cost
  approved_at TEXT,                     -- null until Serj approves
  completed_at TEXT,
  outcome TEXT                          -- what actually happened
);

CREATE TABLE cycle_log (
  id TEXT PRIMARY KEY,
  cycle_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  gaps_identified INTEGER,
  gaps_closed INTEGER,
  convergence_judgment TEXT,   -- 'continue' | 'stop'
  convergence_reasoning TEXT
);
```

---

### 2.2 Assessment Rubric

Five concrete dimensions. Each has a measurement method and a target threshold.

**Dimension 1: Reliability Rate**
- *Definition:* Tasks completed correctly without rework or correction from Serj
- *Measurement:* Router completed jobs ÷ (completed + failed + jobs that required a follow-up correction task within 30 minutes)
- *Target:* ≥ 90%
- *Current estimate:* ~60-70% (based on observed pattern)

**Dimension 2: Integration Failure Rate**
- *Definition:* Features implemented but not correctly wired into the system
- *Measurement:* Build pass rate immediately after implementation tasks. A build failure or missing hook counts as an integration failure.
- *Target:* ≤ 10% of implementation tasks
- *Current estimate:* ~30-40% (the "implemented but not hooked" pattern)

**Dimension 3: Memory Continuity**
- *Definition:* Scaff correctly carries relevant context across sessions
- *Measurement:* Hippocampus `hit_count` distribution — are facts being retrieved and used, or decaying unused? Also: Scaff self-reports whether it had the right context at session start.
- *Target:* Hot memory hit rate ≥ 70% on relevant facts
- *Current estimate:* Not yet measurable (Hippocampus not activated)

**Dimension 4: Token Cost Efficiency**
- *Definition:* Right model tier used for task weight — no Opus used for Haiku-weight tasks
- *Measurement:* Router queue — compare assigned tier vs. task complexity. Over-provisioned jobs (Opus for weight ≤ 3) = waste.
- *Target:* Tier assignment accuracy ≥ 85%
- *Current estimate:* Measurable from existing Router data

**Dimension 5: Task Completion Quality**
- *Definition:* Output meets the stated goal without silent failures or fabricated content
- *Measurement:* Behavioral test suite pass rate (see §2.4)
- *Target:* ≥ 85% on defined behavioral scenarios
- *Current estimate:* Not yet measurable — requires behavioral test suite

---

### 2.3 Self-Assessment Report

A structured document Scaff produces at the start of each improvement cycle. Repeatable format.

```markdown
# Self-Assessment Report — Cycle N
*Date: YYYY-MM-DD*

## Metrics
| Dimension | Value | Target | Status |
|-----------|-------|--------|--------|
| Reliability Rate | X% | ≥90% | 🔴/🟡/🟢 |
| Integration Failure Rate | X% | ≤10% | ... |
| Memory Continuity | X% | ≥70% | ... |
| Token Cost Efficiency | X% | ≥85% | ... |
| Task Completion Quality | X% | ≥85% | ... |

## Gaps Identified
### Gap 1: [Title]
- Dimension: ...
- Root cause: ...
- Frequency: high/medium/low
- Severity: high/medium/low
- Fix complexity: high/medium/low
- Priority score: N

## Proposed Improvement Tasks
[Ordered by priority score]

## Convergence Judgment
[Continue / Stop — with reasoning]
```

---

### 2.4 Behavioral Test Suite

Unit tests verify code correctness. Behavioral tests verify that Scaff actually performs better on real scenarios — not just that the code compiles.

**Scenario format:**
```
Name: [short identifier]
Category: [reliability | integration | memory | cost | quality]
Setup: [what state to establish before the test]
Task: [what Scaff is asked to do]
Expected outcome: [concrete, verifiable result]
Pass criteria: [how we determine pass vs. fail]
Known failure mode: [what went wrong historically]
```

**Initial scenario set** (derived from known failure modes):

*Scenario B-01: Module wiring*
- Task: Implement a new module and integrate it into the gateway startup sequence
- Expected: Module initializes at startup, log line confirms it, tests pass
- Pass criteria: `pnpm build` passes + module appears in startup log + no manual correction needed
- Known failure: Module implemented, startup wiring missed

*Scenario B-02: Router result delivery*
- Task: Spawn a Router job via `sessions_spawn`, receive result in Cortex
- Expected: Result arrives once, via `routerEvents`, no ghost messages
- Pass criteria: Single delivery, correct channel, no WhatsApp ghost messages
- Known failure: Double ingestion via `onDelivered` callback

*Scenario B-03: Memory retrieval*
- Task: Reference a fact from a previous session without being explicitly told it again
- Expected: Scaff surfaces the fact from Hippocampus without prompting
- Pass criteria: Correct fact cited, source is hot memory not session history
- Known failure: Memory not activated / fact evicted prematurely

*Scenario B-04: Multi-session task continuity*
- Task: Begin a task in one session, complete it in the next
- Expected: Second session has full context of first session's progress
- Pass criteria: No re-asking of already-answered questions, correct continuation
- Known failure: Session amnesia — Scaff starts from scratch

*Scenario B-05: Tier assignment accuracy*
- Task: Submit tasks of varying complexity (simple lookup, research, code generation)
- Expected: Haiku for weight ≤ 3, Sonnet for 4-7, Opus for 8-10
- Pass criteria: Router assigns correct tier ≥ 85% of the time
- Known failure: Evaluator miscalibration

---

### 2.5 Improvement Task Format

Gaps become tasks in a standard structure. This format ensures every task has a clear definition of done before implementation starts.

```markdown
## Task: [Title]
**Gap:** [gap ID and description]
**Root cause:** [why this gap exists]
**Proposed fix:** [what to change]
**Scope:** [files/modules affected]
**Verification criteria:** [how we know it worked — specific, testable]
**Complexity cost:** [low/medium/high — estimate of implementation effort]
**Risk:** [what could go wrong during implementation]
**Claude Code prompt:** [the exact task description to hand to Claude Code]
```

---

### 2.6 Execution

Implementation of approved improvement tasks follows the development workflow from `scaff-dev-tools.md`:

1. **Scaff** produces the task in standard format and requests approval
2. **Serj** reviews and approves (or modifies)
3. **Scaff** feeds the task to Claude Code via the `coding-agent` skill in the correct `workdir`
4. **Tool 2** (structured build + test output) verifies the implementation
5. **Tool 1** (import graph) confirms all wiring is in place
6. **Behavioral test** for the relevant scenario runs to confirm real-world improvement
7. **Scaff** updates the observability store and produces a post-task outcome note

---

### 2.7 Convergence Judgment

After each cycle, Scaff evaluates whether to continue iterating or declare "good enough."

**Stop when:**
- All high-priority gaps (priority score > threshold) are closed
- Reliability Rate ≥ 90% sustained across ≥ 3 consecutive assessments
- The next proposed improvement adds architectural complexity without measurably improving any rubric dimension
- Remaining gaps have priority score below threshold and are deferred, not closed

**Continue when:**
- Any high-priority gap remains open
- Any rubric dimension is below target
- A new failure mode has emerged from the behavioral test suite

**The complexity cost check:**
Before proposing any improvement task, Scaff asks:
- How many new files/modules does this add?
- How many existing integration points does this touch?
- What is the measured improvement in the target rubric dimension?
- If complexity cost > value gain: defer, not implement.

---

## 3. Trigger Model

**When does a self-assessment cycle run?**

| Trigger | When | Scope |
|---------|------|-------|
| Manual | Serj explicitly requests it | Full assessment |
| Post-milestone | After each roadmap milestone completes | Full assessment |
| Post-incident | After a notable failure (ghost messages, task drift, etc.) | Targeted — affected dimension only |
| Scheduled | Periodic (frequency TBD after first cycle) | Full assessment |

**First cycle:** Manual trigger. Serj and Scaff run it together to calibrate the rubric and validate the process before automating it.

---

## 4. Scope of Self-Modification

Clear boundaries on what Scaff can and cannot change autonomously.

| Artifact | Scaff can propose | Scaff can apply | Requires approval |
|----------|------------------|----------------|-------------------|
| Source code (Router, Cortex, Hippocampus) | Yes | No — via Claude Code | Yes |
| Workspace files (SOUL.md, MEMORY.md, etc.) | Yes | Yes | Judgment call |
| `openclaw.json` config | Yes | No | Yes |
| `cortex/config.json` | Yes | Yes (low-risk flags) | For major changes |
| Observability store | Yes | Yes | No |
| Behavioral test suite | Yes | Yes | Light review |

**Hard limits:**
- Never modify auth credentials or auth profiles autonomously
- Never modify the gateway safety gates (exec approval, tool deny lists) without explicit approval
- Never apply source code changes without build + test verification first

---

## 5. Open Questions for Discussion

1. **Observability trigger for integration failures:** The current plan uses build pass rate as a proxy. Is this precise enough, or do we need a more direct signal?

2. **Behavioral test automation:** Scenarios B-01 through B-05 are defined, but running them requires setup/teardown. Do we build a test harness, or run them manually as a checklist at first?

3. **Assessment frequency:** First cycle is manual. After it proves out, what cadence makes sense — weekly, post-milestone, or event-driven only?

4. **Convergence threshold:** The rubric targets (90% reliability, 10% integration failure, etc.) are proposed estimates. Do these need calibration against actual baseline measurement before they're meaningful?

5. **Approval granularity:** Is per-task approval right, or is approving a batch of tasks for a cycle more practical?
