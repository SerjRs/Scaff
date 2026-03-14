# Cortex `read_file` Sync Tool — Spec

> **Status:** Ready for implementation  
> **Priority:** High  
> **Effort:** Small (~50 lines across 3 files)  
> **Trigger:** 2026-03-12 — Cortex couldn't read `docs/library-architecture.md` because it has no file read tool. Had to spawn an executor (sessions_spawn) just to cat a file. Executor failed twice due to Anthropic rate limits.

---

## Problem

Cortex has no way to read local files. When it needs file content, its only option is `sessions_spawn` — which:

1. Requires an available LLM (Sonnet/Haiku) to run the executor
2. Takes 10-30 seconds for a task that should take 0ms
3. Fails entirely when rate-limited
4. Burns tokens on a zero-intelligence operation (reading bytes from disk)

Current sync tools: `fetch_chat_history`, `memory_query`, `get_task_status`, `code_search`, `library_get`, `library_search`, `library_stats`.

None of them read arbitrary files.

---

## Solution

Add `read_file` as a sync tool — executed inline within the Cortex loop, no LLM delegation needed.

---

## Tool Definition (`tools.ts`)

```typescript
export const READ_FILE_TOOL = {
  name: "read_file",
  description: `Read the contents of a local file by path. Use for workspace documents, \
architecture specs, config files, or any file you need to reference. Paths are resolved \
relative to the workspace directory. Returns the file contents as text. \
For large files, use offset and limit to read specific line ranges.`,
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "File path (relative to workspace, or absolute)",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-indexed, optional)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read (optional, default 200)",
      },
    },
    required: ["path"],
  },
};
```

---

## Executor (`tools.ts`)

```typescript
export function executeReadFile(
  args: { path: string; offset?: number; limit?: number },
  workspaceDir: string,
): string {
  const MAX_LINES = 500;
  const DEFAULT_LINES = 200;
  const MAX_BYTES = 100_000; // 100KB cap

  // Resolve path: relative paths resolve against workspace
  let filePath = args.path;
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(workspaceDir, filePath);
  }

  // Security: block reads outside the project directory
  const projectRoot = path.resolve(workspaceDir, "..");
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(projectRoot)) {
    return `Error: path "${args.path}" is outside the project directory.`;
  }

  // Check existence
  if (!fs.existsSync(resolved)) {
    return `Error: file not found: ${args.path}`;
  }

  // Check size
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    // Return directory listing instead
    const entries = fs.readdirSync(resolved);
    return `Directory: ${args.path}\n${entries.join("\n")}`;
  }
  if (stat.size > MAX_BYTES * 5) {
    return `Error: file too large (${(stat.size / 1024).toFixed(0)}KB). Use offset/limit to read in chunks.`;
  }

  // Read file
  const content = fs.readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  // Apply offset/limit
  const offset = Math.max(1, args.offset ?? 1);
  const limit = Math.min(args.limit ?? DEFAULT_LINES, MAX_LINES);
  const startIdx = offset - 1; // 0-indexed
  const slice = lines.slice(startIdx, startIdx + limit);

  // Truncate if content exceeds byte cap
  let result = slice.join("\n");
  if (result.length > MAX_BYTES) {
    result = result.substring(0, MAX_BYTES) + "\n\n[TRUNCATED — content exceeds 100KB]";
  }

  // Header with metadata
  const header = `File: ${args.path} (${totalLines} lines, ${(stat.size / 1024).toFixed(1)}KB)`;
  if (slice.length < totalLines) {
    return `${header}\nShowing lines ${offset}-${offset + slice.length - 1} of ${totalLines}:\n\n${result}`;
  }
  return `${header}\n\n${result}`;
}
```

---

## Wiring

### 1. Register in SYNC_TOOL_NAMES (`tools.ts`)

```typescript
export const SYNC_TOOL_NAMES = new Set([
  "fetch_chat_history", "memory_query", "get_task_status", "code_search",
  "library_get", "library_search", "library_stats",
  "read_file",  // ← add
]);
```

### 2. Add to tool list (`llm-caller.ts`)

```typescript
import { ..., READ_FILE_TOOL } from "./tools.js";

// In the tools array:
const tools = context.hippocampusEnabled
  ? [SESSIONS_SPAWN_TOOL, ...CORTEX_TOOLS, ...HIPPOCAMPUS_TOOLS, ...LIBRARY_TOOLS, READ_FILE_TOOL]
  : [SESSIONS_SPAWN_TOOL, ...CORTEX_TOOLS, ...LIBRARY_TOOLS, READ_FILE_TOOL];
```

### 3. Handle in sync loop (`loop.ts`)

```typescript
} else if (tc.name === "read_file") {
  const args = tc.arguments as Record<string, unknown>;
  result = executeReadFile(
    { path: args.path as string, offset: args.offset as number | undefined, limit: args.limit as number | undefined },
    workspaceDir,
  );
```

### 4. Add to system prompt guidance (`llm-caller.ts`)

In the tools guidance string, add:

```
- **read_file**: Read local files (docs, configs, architecture specs). Paths relative to workspace. Use offset/limit for large files.
```

---

## Security Constraints

1. **Path confinement:** All reads must resolve inside the project root (`workspaceDir/..`). Blocks `../../etc/passwd` style traversal.
2. **Size cap:** Files over 500KB return an error with a hint to use offset/limit. Content over 100KB is truncated.
3. **No binary files:** Reads as UTF-8. Binary files will return garbled text (acceptable — Cortex won't ask for binaries).
4. **Directory handling:** If path is a directory, returns a listing instead of an error.

---

## What This Fixes

| Scenario | Before | After |
|----------|--------|-------|
| Read `docs/library-architecture.md` | Spawn executor → 15s + LLM tokens (or fail if rate-limited) | Inline read → 0ms, no tokens |
| Read `cortex/config.json` | Same | Same improvement |
| Check a spec during conversation | Fragile delegation | Instant, reliable |
| Rate-limited state | Can't read anything | File reads still work |

---

## Files to Change

1. **`src/cortex/tools.ts`** — Add `READ_FILE_TOOL` definition, `executeReadFile` function, add to `SYNC_TOOL_NAMES`
2. **`src/cortex/loop.ts`** — Add `read_file` case in sync tool handler
3. **`src/cortex/llm-caller.ts`** — Add `READ_FILE_TOOL` to tool array, add guidance to system prompt

---

## Test Cases

1. **Happy path:** Read a known file → returns content with line count header
2. **Relative path:** `docs/library-architecture.md` resolves to `{workspaceDir}/docs/library-architecture.md`
3. **Absolute path inside project:** Works normally
4. **Path traversal blocked:** `../../etc/passwd` → error
5. **File not found:** Returns clear error message
6. **Large file with offset/limit:** Returns correct line range with "Showing lines X-Y of Z"
7. **Directory path:** Returns listing
8. **Oversized file without offset:** Returns error with hint
