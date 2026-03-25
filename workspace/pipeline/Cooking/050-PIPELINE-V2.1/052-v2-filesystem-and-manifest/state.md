# Task State: 052-v2-filesystem-and-manifest

**Current Status:** Not Started

## Milestones

- [ ] Branch `feat/052-v2-filesystem-and-manifest` created and up to date with task 051.
- [ ] `pathspec` dependency added via `uv`.
- [ ] `core/config.py` created with `PipelineConfig` dataclass.
- [ ] `core/filesystem.py` created.
- [ ] `move_task` implemented with DB transaction and rollback logic.
- [ ] `build_context_manifest` implemented with allowlist/denylist and size limit checks.
- [ ] `tests/test_filesystem.py` written using `tmp_path`.
- [ ] Tests verify successful move, failed move (rollback), and manifest filtering.
- [ ] All tests passing.
- [ ] Branch pushed to remote.

## Executor Notes
*(Executor: Leave notes here if you encounter blockers or if the session is interrupted.)*