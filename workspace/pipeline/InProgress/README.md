# InProgress

**Who works here:** Executor (Claude Code / Gemini / Codex), orchestrated by Scaff

**What this is:** Active work. An executor is currently implementing the task.

**If you are the executor and you landed here:**
1. Read the task file in this folder — it contains your full implementation spec.
2. Implement exactly what it describes.
3. Write tests as specified.
4. Create a git branch (name it `fix/` or `feat/` + the task short name).
5. Commit with a clear message.
6. Push the branch to origin.
7. Open a PR (via `gh` CLI, GitHub API, or ask Scaff).
8. Append your progress to the bottom of the task file:
   ```
   ## Executor Notes
   - Branch: `fix/xxx`
   - PR: #N
   - Tests: N passing
   - Notes: (anything relevant)
   ```
9. Update the task metadata: set `branch`, `pr`, `status` to `in-review`, `moved_at` to today.
10. Move the task file to `InReview/`.

**If something is unclear:** Do NOT guess. Stop and flag it — Scaff will clarify.

**If you cannot complete the task:** Leave notes explaining what went wrong, set status to `cooking`, move back to `Cooking/`.
