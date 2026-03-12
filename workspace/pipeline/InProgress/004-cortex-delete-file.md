---
id: "004"
title: "Cortex delete_file sync tool"
created: "2026-03-12"
author: "scaff"
executor: ""
branch: ""
pr: ""
priority: "medium"
status: "todo"
moved_at: "2026-03-12"
---

# Cortex `delete_file` Sync Tool

## Summary

Add `delete_file` as a sync tool so Cortex can remove files without spawning an executor. Files only — refuses to delete directories.

## Tool Definition (`tools.ts`)

```typescript
export const DELETE_FILE_TOOL = {
  name: "delete_file",
  description: `Delete a local file. Paths are resolved relative to the workspace directory. \
Files only — refuses to delete directories. Use with care — deletions are permanent.`,
  parameters: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "File path to delete",
      },
    },
    required: ["path"],
  },
};
```

## Executor (`tools.ts`)

```typescript
export function executeDeleteFile(
  args: { path: string },
  workspaceDir: string,
): string {
  // Resolve path
  let filePath = args.path;
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(workspaceDir, filePath);
  }

  // Security: block deletes outside project root
  const projectRoot = path.resolve(workspaceDir, "..");
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(projectRoot)) {
    return `Error: path "${args.path}" is outside the project directory.`;
  }

  // Must exist
  if (!fs.existsSync(resolved)) {
    return `Error: file not found: ${args.path}`;
  }

  // Must be a file, not directory
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return `Error: "${args.path}" is a directory. Only files can be deleted.`;
  }

  // Delete
  fs.unlinkSync(resolved);
  return `Deleted: ${args.path}`;
}
```

## Wiring

### 1. Register in SYNC_TOOL_NAMES (`tools.ts`)
Add `"delete_file"` to the Set.

### 2. Add to tool list (`llm-caller.ts`)
Import `DELETE_FILE_TOOL`, add alongside other file tools.

### 3. Handle in sync loop (`loop.ts`)
```typescript
} else if (tc.name === "delete_file") {
  const args = tc.arguments as Record<string, unknown>;
  result = executeDeleteFile(
    { path: args.path as string },
    workspaceDir,
  );
```

### 4. System prompt guidance (`llm-caller.ts`)
```
- **delete_file**: Delete a file. Files only, no directories. Use with care.
```

## Tests (`src/cortex/__tests__/delete-file.test.ts`)

1. Delete existing file — file gone, confirmation returned
2. Path traversal blocked — error
3. File not found — error
4. Directory path — refused with error
5. Relative path resolved correctly
6. Registered in SYNC_TOOL_NAMES
