---
id: "003"
title: "Cortex move_file sync tool"
created: "2026-03-12"
author: "scaff"
executor: ""
branch: ""
pr: ""
priority: "high"
status: "todo"
moved_at: "2026-03-12"
---

# Cortex `move_file` Sync Tool

## Summary

Add `move_file` as a sync tool so Cortex can move/rename files without spawning an executor. Critical for pipeline task transitions.

## Tool Definition (`tools.ts`)

```typescript
export const MOVE_FILE_TOOL = {
  name: "move_file",
  description: `Move or rename a local file. Creates destination directories if needed. \
Paths are resolved relative to the workspace directory. \
Use for pipeline task transitions and file organization.`,
  parameters: {
    type: "object" as const,
    properties: {
      from: {
        type: "string",
        description: "Source file path",
      },
      to: {
        type: "string",
        description: "Destination file path",
      },
    },
    required: ["from", "to"],
  },
};
```

## Executor (`tools.ts`)

```typescript
export function executeMoveFile(
  args: { from: string; to: string },
  workspaceDir: string,
): string {
  // Resolve both paths
  let fromPath = args.from;
  let toPath = args.to;
  if (!path.isAbsolute(fromPath)) {
    fromPath = path.join(workspaceDir, fromPath);
  }
  if (!path.isAbsolute(toPath)) {
    toPath = path.join(workspaceDir, toPath);
  }

  // Security: both paths must be inside project root
  const projectRoot = path.resolve(workspaceDir, "..");
  const resolvedFrom = path.resolve(fromPath);
  const resolvedTo = path.resolve(toPath);
  if (!resolvedFrom.startsWith(projectRoot)) {
    return `Error: source path "${args.from}" is outside the project directory.`;
  }
  if (!resolvedTo.startsWith(projectRoot)) {
    return `Error: destination path "${args.to}" is outside the project directory.`;
  }

  // Source must exist and be a file
  if (!fs.existsSync(resolvedFrom)) {
    return `Error: source not found: ${args.from}`;
  }
  const stat = fs.statSync(resolvedFrom);
  if (stat.isDirectory()) {
    return `Error: source is a directory, not a file: ${args.from}`;
  }

  // Create destination parent dirs
  const destDir = path.dirname(resolvedTo);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Move
  fs.renameSync(resolvedFrom, resolvedTo);
  return `Moved: ${args.from} → ${args.to}`;
}
```

## Wiring

### 1. Register in SYNC_TOOL_NAMES (`tools.ts`)
Add `"move_file"` to the Set.

### 2. Add to tool list (`llm-caller.ts`)
Import `MOVE_FILE_TOOL`, add alongside other file tools.

### 3. Handle in sync loop (`loop.ts`)
```typescript
} else if (tc.name === "move_file") {
  const args = tc.arguments as Record<string, unknown>;
  result = executeMoveFile(
    { from: args.from as string, to: args.to as string },
    workspaceDir,
  );
```

### 4. System prompt guidance (`llm-caller.ts`)
```
- **move_file**: Move or rename files. Use for pipeline transitions. Paths relative to workspace.
```

## Tests (`src/cortex/__tests__/move-file.test.ts`)

1. Move file between folders — file at destination, gone from source
2. Relative paths resolved correctly
3. Path traversal blocked — both from and to
4. Source not found — error
5. Source is directory — error
6. Destination parent dir created automatically
7. Overwrite existing destination file
8. Registered in SYNC_TOOL_NAMES
