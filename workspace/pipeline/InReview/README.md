# InReview

**Who works here:** Scaff (reviewer)

**What this is:** Code is written, tests pass, branch is pushed, PR is open. Waiting for Scaff's review.

**What Scaff does here:**
1. Read the task file — check executor notes for branch/PR info.
2. Review the diff (`git diff main..origin/<branch>`).
3. Verify tests exist and cover the spec requirements.
4. If approved:
   - Post approval comment on the PR.
   - Merge the PR (or tell the executor to merge).
   - Update task metadata: `status` to `done`, `moved_at` to today.
   - Append final summary to the task file.
   - Move the file to `Done/`.
5. If changes needed:
   - Post review comments on the PR.
   - Move the file back to `InProgress/` with notes on what to fix.
   - Update `status` to `in-progress`, `moved_at` to today.

**Review checklist:**
- [ ] Code matches the spec
- [ ] No unrelated changes
- [ ] Tests cover the specified scenarios
- [ ] Security constraints respected (if applicable)
- [ ] No config/workspace files modified unless spec says so
