---
id: "001"
title: "Cortex write_file sync tool"
created: "2026-03-12"
author: "scaff"
executor: ""
branch: ""
pr: ""
priority: "high"
status: "todo"
moved_at: "2026-03-12"
---

# Cortex `write_file` Sync Tool

## Summary

Add `write_file` as a sync tool so Cortex can write local files without spawning an executor.

## Tool Definition (`tools.ts`)

```typescript
export const WRITE_FILE_TOOL = {
  name: "write_file",
  description: `Write content to a local file. Creates parent directories if needed. \
Overwrites existing files by default. Use append mode to add to existing files. \
Paths are resolved relative to the workspace directory.`,
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "File path (relative to workspace, or absolute)",
      },
      content: {
        type: "string",
        description: "Content to write",
      },
      append: {
        type: "boolean",
        description: "Append to file instead of overwriting (optional, default false)",
      },
    },
    required: ["path", "content"],
  },
};
```

## Executor (`tools.ts`)

```typescript
export function executeWriteFile(
  args: { path: string; content: string; append?: boolean },
  workspaceDir: string,
): string {
  // Resolve path: relative paths resolve against workspace
  let filePath = args.path;
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(workspaceDir, filePath);
  }

  // Security: block writes outside the project directory
  const projectRoot = path.resolve(workspaceDir, "..");
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(projectRoot)) {
    return `Error: path "${args.path}" is outside the project directory.`;
  }

  // Create parent directories if needed
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write or append
  if (args.append) {
    fs.appendFileSync(resolved, args.content, "utf-8");
    return `Appended to: ${args.path} (${args.content.length} chars)`;
  } else {
    fs.writeFileSync(resolved, args.content, "utf-8");
    return `Wrote: ${args.path} (${args.content.length} chars)`;
  }
}
```

## Wiring

### 1. Register in SYNC_TOOL_NAMES (`tools.ts`)
Add `"write_file"` to the Set.

### 2. Add to tool list (`llm-caller.ts`)
Import `WRITE_FILE_TOOL`, add alongside `READ_FILE_TOOL`.

### 3. Handle in sync loop (`loop.ts`)
```typescript
} else if (tc.name === "write_file") {
  const args = tc.arguments as Record<string, unknown>;
  result = executeWriteFile(
    { path: args.path as string, content: args.content as string, append: args.append as boolean | undefined },
    workspaceDir,
  );
```

### 4. System prompt guidance (`llm-caller.ts`)
Add to the tools guidance string:
```
- **write_file**: Write or append to local files. Creates parent dirs. Paths relative to workspace.
```

## Tests (`src/cortex/__tests__/write-file.test.ts`)

1. Write new file — content written, confirmation returned
2. Overwrite existing file — old content replaced
3. Append mode — content added to end
4. Relative path resolved against workspace
5. Absolute path inside project — works
6. Path traversal blocked — error
7. Parent directories created automatically
8. Registered in SYNC_TOOL_NAMES
