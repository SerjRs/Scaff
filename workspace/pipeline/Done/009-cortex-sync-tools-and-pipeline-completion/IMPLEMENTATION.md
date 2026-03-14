# 009 — Implementation Guide

Two changes. Read this fully before touching code.

---

## Change 1: Sync/async tool guidance in system prompt

**File:** `src/cortex/llm-caller.ts`

Find the `## Tool Guidance` section (~line 228). It currently has:

```typescript
systemParts.push(
  "## Tool Guidance\n" +
  "- **code_search**: ...\n" +
  ...
  "- **sessions_spawn executor param**: Pass `executor: \"coding\"` when the task requires...\n\n" +
  "## Library\n" + ...
);
```

**Replace** the `"## Tool Guidance\n" +` opening and everything up to (but NOT including) `"## Library\n"`) with the following expanded version:

```typescript
"## Tool Guidance\n" +
"- **code_search**: Use before spawning coding tasks to find relevant files and functions. " +
"Searches ~14,000 indexed source code chunks semantically. Returns file paths, line numbers, " +
"and snippets. Include results as context in sessions_spawn tasks so executors don't grep blind.\n" +
"- **fetch_chat_history**: Use when you need older messages not in the active window.\n" +
"- **memory_query**: Use when you need to recall facts from long-term memory.\n" +
"- **read_file**: Read local files (docs, configs, architecture specs). Paths relative to workspace. Use offset/limit for large files.\n" +
"- **write_file**: Write or append to local files. Creates parent dirs. Paths relative to workspace.\n" +
"- **move_file**: Move or rename files. Use for pipeline transitions. Paths relative to workspace.\n" +
"- **delete_file**: Delete a file. Files only, no directories. Use with care.\n" +
"- **pipeline_status**: Get pipeline overview — task counts and summaries per stage. Use read_file to drill into specific tasks.\n" +
"- **sessions_spawn executor param**: Pass `executor: \"coding\"` when the task requires multi-file code changes, " +
"running tests, creating branches/PRs, or any work best handled by Claude Code CLI. " +
"This routes to the coding_run template (opus tier, 15min timeout). Default (\"auto\") uses the standard LLM executor.\n\n" +
"## Sync vs Async Tools\n" +
"Sync tools execute instantly in the same LLM turn — use for all local operations:\n" +
"  read_file, write_file, move_file, delete_file, code_search, memory_query,\n" +
"  pipeline_status, get_task_status, fetch_chat_history\n\n" +
"sessions_spawn dispatches to an external executor (Router → Claude Code or LLM agent). " +
"Use ONLY for work that requires writing/modifying code, running tests, creating branches/PRs, " +
"or complex multi-step tasks needing their own agent. " +
"NEVER use sessions_spawn to move files, read files, or do anything a sync tool handles. " +
"A file move that takes 1 sync tool call should not become a 30-second async dispatch.\n\n" +
"## Pipeline Tasks\n" +
"When a pipeline task completes, a [PIPELINE REVIEW REQUIRED] checklist will be appended to the result. " +
"Follow every step before replying to the user. Do not leave tasks in InProgress after the executor reports success.\n\n" +
```

Keep everything that follows (the `"## Library\n"` section) unchanged.

---

## Change 2: Inject review checklist on pipeline task completion

**File:** `src/cortex/gateway-bridge.ts`

Find the `appendTaskResult` call for the **completed** case (~line 404):

```typescript
if (job.status === "completed") {
  const result = job.result ?? "Task completed.";
  appendTaskResult(instance.db, {
    taskId: jobId,
    description: taskDescription,
    status: "completed",
    channel: replyChannel,
    result,
    completedAt,
    issuer: cortexIssuer,
  });
}
```

**Replace** with:

```typescript
if (job.status === "completed") {
  const result = job.result ?? "Task completed.";

  // Detect pipeline tasks: description or result references pipeline paths or key files
  const isPipelineTask =
    taskDescription.includes("pipeline/InProgress/") ||
    taskDescription.includes("CLAUDE.md") ||
    taskDescription.includes("SPEC.md") ||
    taskDescription.includes("STATE.md") ||
    result.includes("pipeline/InProgress/") ||
    result.includes("CLAUDE.md") ||
    result.includes("feat/");  // branch names from coding executor PRs

  const reviewChecklist = isPipelineTask
    ? "\n\n[PIPELINE REVIEW REQUIRED]\n" +
      "The executor reports success. Before replying to the user, complete each step:\n" +
      "1. Review: did the build pass? Check result for errors.\n" +
      "2. Merge: if a PR was created, merge it (gh pr merge <number> --squash)\n" +
      "3. Move: move task folder from InProgress to Done (use move_file)\n" +
      "4. Update STATE.md with final status\n" +
      "5. Inform the user: what was done, PR link, merged status"
    : "";

  appendTaskResult(instance.db, {
    taskId: jobId,
    description: taskDescription,
    status: "completed",
    channel: replyChannel,
    result: result + reviewChecklist,
    completedAt,
    issuer: cortexIssuer,
  });
}
```

---

## Build & verify

```bash
pnpm build
```

Must pass with zero TypeScript errors.

---

## Commit & push

```bash
git add src/cortex/llm-caller.ts src/cortex/gateway-bridge.ts
git commit -m "feat(cortex): sync tool guidance + pipeline review checklist injection (009)"
git push origin feat/009-cortex-sync-tools-pipeline
```

## DO NOT modify

- session.ts, output.ts, loop.ts, adapters, router code, tests
