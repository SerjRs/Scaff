# Task 067i: COMPLETION.md Generation

## STATUS: COOKING

## Priority: P3
## Complexity: S

## Objective

Ensure the Testing agent writes `COMPLETION.md` in the task folder when a task passes testing and advances to DONE.

## Background

Architecture spec v2.2 §9.7: "On PASS: Write TEST-RESULTS.md (full evidence), Write COMPLETION.md (summary)."
Architecture spec v2.2 §9.8: "Testing Agent writes COMPLETION.md before calling signal_done."

Currently: the testing prompt mentions it but there's no enforcement or template.

## Scope

### In Scope
1. Add a COMPLETION.md template/section to `prompts/testing.md` with required format:
   ```markdown
   # Completion: <task-id>
   
   ## Summary
   What was delivered in one paragraph.
   
   ## Changes
   - List of files created/modified
   
   ## Tests
   - Unit: X passed
   - E2E: Y passed
   
   ## Merged
   Branch `feature/<task-id>` merged to main at commit <hash>
   ```
2. In `signal_done` handler for TESTING → DONE: verify COMPLETION.md exists. If missing, log a warning (don't block the transition).

### Out of Scope
- Auto-generating COMPLETION.md (that's the agent's job)
- Blocking transitions if COMPLETION.md is missing

## Files to Modify

- `orchestrator/prompts/testing.md` — add COMPLETION.md template
- `api/mcp.py` — optional warning if COMPLETION.md missing on TESTING → DONE

## Acceptance Criteria

- [ ] Testing prompt includes COMPLETION.md format
- [ ] Warning logged if COMPLETION.md missing on DONE transition
- [ ] Existing tests pass

## Dependencies

- 067a (MCP return channel) — signal_done must work for TESTING → DONE
