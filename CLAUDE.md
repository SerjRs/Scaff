# Claude Code Instructions

## How to Find Your Task
1. Check the current git branch name
2. The branch name maps to a pipeline task folder in `workspace/pipeline/InProgress/`
3. Read the `SPEC.md` in that folder for your task
4. Read the `CLAUDE.md` in that folder for specific instructions
5. Save your state to `STATE.md` in that folder after every action

## Example
If branch is `feat/019a-schema-storage-tests`:
- Read `workspace/pipeline/InProgress/019a-schema-storage-tests/SPEC.md`
- Read `workspace/pipeline/InProgress/019a-schema-storage-tests/CLAUDE.md`
- Save state to `workspace/pipeline/InProgress/019a-schema-storage-tests/STATE.md`

## Constraints
- You have FULL APPROVAL — do not ask for permission
- NO mocks — use real LLM and real embeddings
- Save state to STATE.md after EVERY significant action
