# CODEBASE.md — 067h Relevant Surface

## Module: `cli.py` — Current Implementation (to rewrite)

```python
import typer
import httpx
from rich.console import Console
from rich.table import Table

app = typer.Typer(name="pipeline")
console = Console()
API_BASE = "http://localhost:3000"

@app.command()
def status() -> None:
    """Show pipeline status board."""
    resp = httpx.get(f"{API_BASE}/tasks")
    resp.raise_for_status()
    tasks = resp.json()

    table = Table(title="Pipeline Status")
    table.add_column("#", style="dim")
    table.add_column("Task ID", style="bold")
    table.add_column("Stage", style="cyan")
    table.add_column("Status")
    table.add_column("Priority")
    table.add_column("Bounces", justify="right")
    table.add_column("Model")

    status_colors = {
        "PENDING": "yellow",
        "WIP": "green",
        "BLOCKED": "red",
        "FAILED": "red bold",
        "LOOP_DETECTED": "red bold",
        "BackFromReview": "magenta",
        "BackFromTest": "magenta",
    }

    for i, t in enumerate(tasks, 1):
        color = status_colors.get(t["status"], "white")
        table.add_row(
            str(i),
            t["id"],
            t["stage"],
            f"[{color}]{t['status']}[/{color}]",
            t["priority"],
            str(t.get("lifetime_bounces", 0)),
            t.get("current_model") or "—",
        )
    console.print(table)


@app.command()
def approve(task_id: str, priority: str = "P2", complexity: str = "M") -> None:
    """Approve a COOKING task into the pipeline."""
    resp = httpx.post(f"{API_BASE}/tasks/{task_id}/approve",
                      json={"priority": priority, "complexity": complexity})
    resp.raise_for_status()
    console.print(f"[green]✓[/green] Task {task_id} approved → TODO")


@app.command()
def cancel(task_id: str, reason: str = typer.Argument(...)) -> None:
    resp = httpx.post(f"{API_BASE}/tasks/{task_id}/cancel", json={"reason": reason})
    resp.raise_for_status()
    console.print(f"[red]✗[/red] Task {task_id} cancelled")


@app.command()
def reprioritize(task_id: str, priority: str = typer.Argument(...)) -> None:
    resp = httpx.post(f"{API_BASE}/tasks/{task_id}/reprioritize",
                      json={"priority": priority})
    resp.raise_for_status()
    console.print(f"[green]✓[/green] Task {task_id} → {priority}")


@app.command()
def retry(task_id: str) -> None:
    resp = httpx.post(f"{API_BASE}/tasks/{task_id}/retry")
    resp.raise_for_status()
    console.print(f"[green]✓[/green] Task {task_id} requeued")
```

---

## REST API Response Format (`GET /tasks`)

```json
[
  {
    "id": "063-code-review-graph",
    "stage": "EXECUTION",
    "status": "WIP",
    "priority": "P1",
    "complexity": "M",
    "task_path": "/pipeline/EXECUTION/063-code-review-graph",
    "parent_task_id": null,
    "stage_attempts": 1,
    "lifetime_bounces": 0,
    "current_model": "claude-sonnet-4-6",
    "agent_pid": 12345,
    "entered_stage_at": "2026-03-26T12:00:00+00:00",
    "started_at": "2026-03-26T12:00:01+00:00",
    "completed_at": null,
    "created_at": "2026-03-26T10:00:00+00:00",
    "updated_at": "2026-03-26T12:00:01+00:00"
  }
]
```

**Key fields for status display:**
- `entered_stage_at` → calculate duration from now for "Time in Stage" column
- `current_model` → may be null
- `lifetime_bounces` → integer
- `stage` → one of: TODO, ARCHITECTING, SPECKING, EXECUTION, REVIEW, TESTING, DONE

---

## Changes Needed

### 1. Add `--stage` filter
```python
@app.command()
def status(stage: str = typer.Option(None, help="Filter by stage")) -> None:
    resp = httpx.get(f"{API_BASE}/tasks")
    tasks = resp.json()
    
    # Stage summary (always unfiltered)
    stage_counts = {s: 0 for s in PIPELINE_STAGES}
    for t in tasks:
        if t["stage"] in stage_counts:
            stage_counts[t["stage"]] += 1
    
    # Filter for display
    if stage:
        tasks = [t for t in tasks if t["stage"] == stage.upper()]
```

### 2. Add "Time in Stage" column
```python
from datetime import datetime, timezone

def _format_duration(entered_stage_at: str | None) -> str:
    if not entered_stage_at:
        return "—"
    entered = datetime.fromisoformat(entered_stage_at)
    if entered.tzinfo is None:
        entered = entered.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - entered
    hours = int(delta.total_seconds() // 3600)
    minutes = int((delta.total_seconds() % 3600) // 60)
    if hours >= 24:
        return f"{hours // 24}d {hours % 24}h"
    if hours > 0:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"
```

### 3. Empty state handling
```python
if not tasks:
    console.print("[dim]No tasks in pipeline[/dim]")
else:
    # ... build and print table ...

# Always print stage summary
summary = " | ".join(f"{s[:4]}: {stage_counts[s]}" for s in PIPELINE_STAGES)
console.print(f"\n[dim]{summary}[/dim]")
```

---

## Existing Tests: `tests/test_cli.py`

```python
# Tests mock httpx responses
class TestStatus:
    def test_status_displays_tasks(self):
        # Mock httpx.get → return task list
        # Invoke CLI command
        # Assert output contains task IDs

    def test_status_empty(self):
        # Mock httpx.get → return []
        # Assert "No tasks" message
```

---

## Pipeline Stages Constant (for import)

```python
from core.config import PIPELINE_STAGES
# PIPELINE_STAGES = ["TODO", "ARCHITECTING", "SPECKING", "EXECUTION", "REVIEW", "TESTING", "DONE"]
```

---

## Files Summary

| File | Action |
|------|--------|
| `cli.py` | REWRITE `status` command — add table, --stage filter, time column, empty state, summary |
| `tests/test_cli.py` | ADD/UPDATE tests for new status output |
