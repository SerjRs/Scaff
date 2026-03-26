# CODEBASE.md — 067c Relevant Surface

## Module: `agents/base.py` — Agent Spawn (branch creation goes here)

```python
async def spawn_agent(
    stage: str, task: TaskRecord, db: ModuleType, config: PipelineConfig
) -> None:
    """Spawns an agent subprocess. Fire-and-forget."""
    agent_name = STAGE_TO_AGENT[stage]
    agent_config = config.agents[agent_name]

    # Model selection with escalation
    attempt = task.stage_attempts + 1
    if agent_config.model_escalation and attempt in agent_config.model_escalation:
        model = agent_config.model_escalation[attempt]
    else:
        model = agent_config.model

    manifest_path = str(Path(task.task_path) / ".context-manifest.txt")
    repo_path = config.pipeline_root.parent  # <-- repo root

    # Build prompt, write PROMPT.md
    prompt_content = _build_prompt_content(agent_config.prompt_file, task, manifest_path, str(repo_path))
    task_dir = Path(task.task_path)
    task_dir.mkdir(parents=True, exist_ok=True)
    prompt_file = task_dir / "PROMPT.md"
    prompt_file.write_text(prompt_content, encoding="utf-8")

    mcp_config_path = config.pipeline_root / ".mcp-agent-config.json"
    cmd = _build_command_args(agent_config.harness, model, mcp_config_path if mcp_config_path.exists() else None)

    # Build env vars
    env = os.environ.copy()
    env["PIPELINE_TASK_PATH"] = task.task_path
    env["PIPELINE_TASK_ID"] = task.id
    # ... more env vars ...

    # >>> INSERT HERE: if stage == "EXECUTION", create/checkout feature/<task.id> branch
    # >>> Add env["PIPELINE_BRANCH"] = f"feature/{task.id}"

    # Protect SPEC.md
    spec_path = Path(task.task_path) / "SPEC.md"
    if spec_path.exists():
        spec_path.chmod(stat.S_IREAD)

    # Spawn subprocess
    process = await asyncio.create_subprocess_exec(
        *cmd, stdin=stdin_file, stdout=log_file, stderr=log_file,
        cwd=str(repo_path) if repo_path.is_dir() else None, env=env,
    )

    # Update DB: status=WIP, agent_pid, started_at, current_model
    await db.update_task_state(task.id, status="WIP", agent_pid=process.pid, ...)
```

**Git branch helper to add:**
```python
async def _ensure_feature_branch(task_id: str, repo_path: Path) -> None:
    """Create and checkout feature/<task_id> branch. If exists, just checkout."""
    branch = f"feature/{task_id}"
    # Try create
    proc = await asyncio.create_subprocess_exec(
        "git", "checkout", "-b", branch,
        cwd=str(repo_path), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    await proc.wait()
    if proc.returncode != 0:
        # Branch exists — just checkout
        proc2 = await asyncio.create_subprocess_exec(
            "git", "checkout", branch,
            cwd=str(repo_path), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await proc2.wait()
```

---

## Module: `api/mcp.py` — Signal Done (merge goes here)

```python
@mcp_server.tool()
async def orchestrator_signal_done(task_id: str, notes: str = "") -> dict:
    """Signal work complete; advance to next stage."""
    config = _get_config()
    task = await db.get_task(task_id)
    if task is None:
        raise ValueError(f"Task {task_id} not found")
    current_idx = PIPELINE_STAGES.index(task.stage)
    next_stage = PIPELINE_STAGES[current_idx + 1]

    # >>> INSERT HERE: if task.stage == "TESTING" (next_stage == "DONE"):
    # >>>   merge feature/<task_id> to main
    # >>>   if merge fails → set FAILED, return error

    await filesystem.move_task(task_id, task.stage, next_stage, db, config)
    if notes:
        _append_to_agent_log(task.task_path, f"DONE: {notes}")
    return {"ok": True}
```

**Merge helper to add:**
```python
async def _merge_feature_branch(task_id: str, config: PipelineConfig) -> tuple[bool, str]:
    """Merge feature/<task_id> to main. Returns (success, output)."""
    repo_path = config.pipeline_root.parent
    # git checkout main
    proc = await asyncio.create_subprocess_exec(
        "git", "checkout", "main", cwd=str(repo_path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    await proc.wait()
    # git merge feature/<task_id> --no-edit
    proc = await asyncio.create_subprocess_exec(
        "git", "merge", f"feature/{task_id}", "--no-edit", cwd=str(repo_path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    return proc.returncode == 0, stderr.decode()
```

---

## Module: `api/rest.py` — Signal Done REST (also needs merge)

```python
@app.post("/tasks/{task_id}/signal-done")
async def signal_done(task_id: str, body: SignalDoneBody) -> dict:
    config = _get_config()
    task = await db.get_task(task_id)
    current_idx = PIPELINE_STAGES.index(task.stage)
    next_stage = PIPELINE_STAGES[current_idx + 1]

    # >>> SAME: if task.stage == "TESTING", merge feature branch first

    await filesystem.move_task(task_id, task.stage, next_stage, db, config)
    return {"ok": True}
```

---

## Module: `core/config.py` — PipelineConfig (optional addition)

```python
@dataclass
class PipelineConfig:
    pipeline_root: Path
    max_lifetime_bounces: int = 8
    # >>> OPTIONAL: feature_branch_prefix: str = "feature/"
    # ... existing fields ...
```

---

## Existing Tests: `tests/test_agents.py`

```python
# Pattern: mock create_subprocess_exec, verify command args
@pytest.mark.asyncio
async def test_spawn_agent_execution_claude(setup_db, tmp_path, mock_subprocess):
    config = _make_config(tmp_path)
    task = _make_task(stage="EXECUTION", task_path=str(tmp_path / "task"))
    await db.create_task(...)
    await spawn_agent("EXECUTION", task, db, config)
    mock_subprocess.assert_awaited_once()
    # Check cmd args, env vars, etc.
```

**New test pattern for branch creation:**
```python
@pytest.mark.asyncio
async def test_spawn_agent_creates_feature_branch(setup_db, tmp_path, mock_subprocess):
    # Mock git subprocess calls
    # Verify _ensure_feature_branch called for EXECUTION stage
    # Verify PIPELINE_BRANCH env var set
```

---

## Files Summary

| File | Action |
|------|--------|
| `agents/base.py` | ADD `_ensure_feature_branch()`, call before EXECUTION spawn, add PIPELINE_BRANCH env |
| `api/mcp.py` | ADD `_merge_feature_branch()`, call in signal_done when TESTING→DONE |
| `api/rest.py` | ADD same merge logic in signal_done endpoint |
| `core/config.py` | OPTIONAL: add `feature_branch_prefix` |
| `tests/test_agents.py` | ADD branch creation test |
| `tests/test_mcp.py` | ADD merge-on-done test |
