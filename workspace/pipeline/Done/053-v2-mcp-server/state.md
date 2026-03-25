# Task State: 053-v2-mcp-server

**Current Status:** Not Started

## Milestones

- [ ] Branch `feat/053-v2-mcp-server` created.
- [ ] `mcp` SDK added via `uv`.
- [ ] `PIPELINE_STAGES` added to `core/config.py`.
- [ ] `api/mcp.py` created and Server instantiated.
- [ ] Tool: `orchestrator_claim_task` implemented (integrates `build_context_manifest`).
- [ ] Tool: `orchestrator_signal_done` implemented (integrates `move_task`).
- [ ] Tool: `orchestrator_signal_back` implemented (integrates `move_task` + bounce counter).
- [ ] Tool: `orchestrator_signal_cancel` implemented.
- [ ] Tool: `orchestrator_patch_priority` implemented (DB insert).
- [ ] Tool: `orchestrator_append_knowledge` implemented (DB insert).
- [ ] Stdio server entrypoint created.
- [ ] `tests/test_mcp.py` written and passing.
- [ ] Branch pushed to remote.

## Executor Notes
*(Executor: Leave notes here if you encounter blockers or if the session is interrupted.)*