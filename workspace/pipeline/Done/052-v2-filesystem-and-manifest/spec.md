---
id: 052
title: V2 Filesystem & Context Manifest
priority: P1
status: Cooking
branch: feat/052-v2-filesystem-and-manifest
epic: 050-PIPELINE-V2.1
---

# Specification: V2 Filesystem & Context Manifest

## Objective
Implement the Orchestrator's filesystem operations (`core/filesystem.py`). This includes the transactional folder-move logic (move-first/commit-second) and the context hygiene engine (building `.context-manifest.txt` using a hybrid allowlist/denylist).

## Architecture & Context
This module acts as the bridge between the physical task folders and the SQLite state. It must ensure that a task folder is never left in an inconsistent state if the database transaction fails. It also enforces the 800K token limit by calculating file sizes before generating the manifest.

## Implementation Requirements

### 1. Dependencies & Config
- Add `pathspec` to the project via `uv add pathspec` (for robust `.pipelineignore` parsing).
- Create a simple `core/config.py` with a dataclass `PipelineConfig` holding:
  - `max_context_bytes: int = 3355443`
  - `allowed_extensions: set[str]` (populate with default extensions: `.md`, `.py`, `.json`, etc.)
  - `pipeline_root: Path`

### 2. Move Protocol (`move_task`)
Implement `async def move_task(task_id: str, from_stage: str, to_stage: str, db)`:
- Construct source and destination paths based on `pipeline_root`.
- **Step 1:** Move the folder on the filesystem using `shutil.move()`.
- **Step 2:** Await a database transaction updating the task's stage to `to_stage`, status to `PENDING`, and resetting `stage_attempts` to 0. Log the transition.
- **Rollback:** If the database transaction throws an exception, catch it, use `shutil.move()` to return the folder to `from_stage`, and re-raise the exception.

### 3. Context Manifest Generation (`build_context_manifest`)
Implement `def build_context_manifest(task_path: Path, config: PipelineConfig) -> Path`:
- Load the global `.pipelineignore` (if it exists) and any task-level `.pipelineignore` using `pathspec`.
- Recursively iterate through all files in `task_path`.
- **Allowlist filter:** Skip files whose suffix is not in `config.allowed_extensions`.
- **Denylist filter:** Skip files matching the `pathspec` rules.
- Calculate the total byte size of the allowed files.
- If total > `config.max_context_bytes`, raise a custom `ContextSizeExceededError`.
- Write the final list of relative file paths to `.context-manifest.txt` inside the task folder.
- Return the path to the manifest.

## Testing Requirements
- Create `tests/test_filesystem.py`.
- Use `pytest` and `tmp_path` to create dummy folder structures.
- Test `move_task` success and simulated DB failure (verify the folder is rolled back).
- Test `build_context_manifest` to ensure it correctly respects allowed extensions, ignores `.pipelineignore` patterns, and raises an error on size limits.