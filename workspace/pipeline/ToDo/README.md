# ToDo

**Who works here:** Scaff (prioritization), the tasks in this folder are approved by Serj. Only Scaff works here

**What this is:** The backlog. Tasks here have clean implementation specs — ready to be picked up by an executor.

**What belongs here:**
- Fully specified implementation docs
- Clear scope: which files to change, what the code should do, what tests to write
- No open questions — everything the executor needs is in the file

**What to do with a task here:**
- When Scaff (or Serj) decides to start work → Scaff picks the task, sets the `executor` field (claude-code / gemini / codex), updates `status` to `in-progress` and `moved_at`, then moves the file to `InProgress/`.
- Scaff spawns the executor with the task file as input.

**Priority order:** Critical > High > Medium > Low. Within same priority, oldest first.
