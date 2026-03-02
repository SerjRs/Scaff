# Backup Strategy — Post‑Qdrant Retirement

**Last updated:** 2026-02-11  
**Status:** Active

## Scope

This document defines active backup policy for the current architecture:
- memory-core (`main.sqlite`) is canonical long-term memory
- hot-cache is rebuildable short-term cache
- Qdrant is retired from daily operational backup flow

---

## Active Backup Layers

### 1) Local backup (`OpenClaw-Backup`, daily 04:00)
Destination: `C:\openclaw-backups\<timestamp>\`

Backs up:
- `workspace\memory\`
- key workspace docs/config files
- session transcripts (`%USERPROFILE%\.openclaw\agents\main\sessions\`)
- memory-core DB (`%USERPROFILE%\.openclaw\memory\main.sqlite`)

Retention:
- keep latest 7 local snapshots

### 2) Cloud backup (`OpenClaw-Cloud-Backup`, daily 04:15)
Destination: `gdrive-backup:openclaw-backup/`

Backs up:
- `memory/`
- `scripts/`
- `skills/` (excluding heavy transient dirs)
- workspace root config/docs
- `openclaw.json`
- session transcripts
- memory-core DB (`main.sqlite`)

Retention:
- managed by remote policy/manual pruning

### 3) Legacy workspace snapshot script (`scripts/daily-backup.ps1`)
- Timestamped workspace copy with exclusions
- Not canonical for non-workspace data (sessions/main.sqlite still come from scheduled task scripts)

---

## What Is *Not* Operationally Required to Back Up

- Hot-cache SQLite (`_state/hot-cache/hot-cache.sqlite`) — rebuildable
- Tool binaries (`tools/`) — reinstallable
- Node modules/build artifacts — reproducible

---

## Qdrant Policy (Retired)

Qdrant snapshot backup has been removed from **daily operational backup criteria**.

### Optional archive-only guidance (manual, non-operational)
If historical Qdrant data must be preserved for audit/research, perform ad-hoc export manually and label it clearly as legacy archive material.

This is **not** part of routine health/backup success checks.

---

## Restore Priorities

1. Restore `main.sqlite`
2. Restore `memory/`
3. Restore session transcripts
4. Restore workspace configs/scripts
5. Restart gateway and validate health checks

---

## Validation Checklist

After backup run:
- Task result code = 0
- latest local snapshot exists (if local task)
- latest cloud log exists (if cloud task)
- `main.sqlite` present in backup destination
- sessions present in backup destination

---

## Risks / Follow-ups

- Add periodic restore drills (monthly)
- Add optional encryption-at-rest overlay for cloud backups
- Keep backup logs pruned and monitored for failures
