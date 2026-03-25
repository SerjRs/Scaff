# COOKING Workflow — Detailed Guide

The COOKING stage is where the human and agent collaborate to turn ideas into well-defined task specifications. This is the agent's primary interactive role in the pipeline.

## Overview

COOKING is the pre-pipeline stage. Tasks here are NOT yet in the automated pipeline. The agent helps the human refine ideas into SPEC.md documents that are clear enough for autonomous agents to execute.

```
Human has idea
    |
    v
COOKING (human + agent iterate on SPEC.md)
    |  STATUS: DRAFT > REVIEW > AGREED
    v
/approve <task-id>  -->  TODO (enters automated pipeline)
```

## SPEC.md Structure

Each task folder in COOKING should contain a SPEC.md with at minimum:

```markdown
# Task: <title>

## STATUS: DRAFT | REVIEW | AGREED | STALLED

## Objective
What this task accomplishes in 1-2 sentences.

## Scope
- What IS included
- What is NOT included

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Dependencies
Tasks that must complete before this one (if any).

## Edge Cases
Known edge cases and how to handle them.

## Notes
Any additional context for the executing agent.
```

## Agent Workflow

### Step 1: Understand the Idea

When the human describes a new task or idea:
- Ask clarifying questions about the goal
- Identify what part of the codebase is affected
- Determine if this overlaps with existing tasks

### Step 2: Draft the SPEC.md

Create an initial SPEC.md with STATUS: DRAFT. Include:
- Clear objective statement
- Initial scope boundaries
- Preliminary acceptance criteria
- Known dependencies

### Step 3: Iterate

Ask probing questions to refine the spec:
- **Scope:** "Should this also handle X?" / "Is Y out of scope?"
- **Edge cases:** "What happens when Z?" / "How should we handle empty input?"
- **Dependencies:** "This seems to depend on TASK-XXX. Should we wait for it?"
- **Acceptance criteria:** "How will we know this is done? What does 'working' look like?"
- **Complexity:** "This feels like a large task. Should we split it?"

### Step 4: Move to REVIEW

When the spec feels solid, update STATUS to REVIEW and present a summary:
- "Here's the final spec for your review. Key points: ..."
- Highlight any decisions that were made during iteration
- Call out remaining open questions (if any)

### Step 5: Reach Agreement

When the human confirms the spec:
- Update STATUS to AGREED
- Suggest priority and complexity
- Wait for the human to `/approve`

### Step 6: Approve

When the human says `/approve <task-id>`:

```bash
curl -X POST http://localhost:3000/tasks/{task_id}/approve \
  -H "Content-Type: application/json" \
  -d '{"priority": "P2", "complexity": "M"}'
```

The task moves from COOKING to TODO and enters the automated pipeline.

## Stall Detection

If a spec has been in DRAFT or REVIEW for 10+ iterations without resolution:

1. Update STATUS to STALLED
2. Notify the human: "This spec has been in progress for a while. Should we simplify, split, or shelve it?"
3. Suggest concrete actions:
   - Split into smaller tasks
   - Reduce scope to an MVP
   - Shelve and revisit later
   - Cancel

## Priority & Complexity Guide

### Priority

| Level | Meaning | Use When |
|-------|---------|----------|
| P1 | Critical | Blocking other work, production issue, deadline |
| P2 | Normal | Standard feature work, planned improvements |
| P3 | Low | Nice-to-have, tech debt, minor improvements |

### Complexity

| Level | Meaning | Rough Scope |
|-------|---------|-------------|
| S | Small | Single file, < 50 lines changed |
| M | Medium | Few files, clear scope, 50-200 lines |
| L | Large | Multiple files/modules, 200-500 lines |
| XL | Extra Large | Cross-cutting, architectural, 500+ lines |

## Tips

- **Be specific in acceptance criteria.** "Works correctly" is not a criterion. "Returns 404 for missing IDs" is.
- **Scope aggressively.** Smaller, focused tasks succeed more often in the automated pipeline.
- **Flag dependencies early.** Unmet dependencies cause tasks to BLOCK in the pipeline.
- **Consider the executing agent.** The spec should contain everything an autonomous agent needs to implement the task without asking questions.
