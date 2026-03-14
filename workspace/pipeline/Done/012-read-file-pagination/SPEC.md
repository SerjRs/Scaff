---
id: "012"
title: "read_file default limit too low — causes false truncation loops"
created: "2026-03-14"
author: "scaff"
priority: "high"
status: "done"
pr: "pending"
branch: "feat/012-016-cortex-improvements"
moved_at: "2026-03-14"
---

# 012 — read_file Pagination

## Problem

`executeReadFile` defaults to showing lines 1-200 of N. When a file has >200 lines (e.g. SPEC.md at 234 lines), the output says "Showing lines 1-200 of 234." Cortex sees this, panics about "truncation," and re-reads the same file 3-4 times without using offset/limit properly.

## Root Cause

Default limit is 200 in `executeReadFile` (tools.ts). For most workspace files (specs, READMEs, configs) this is too low.

## Fix

1. Increase default limit to 500 lines (covers 99% of workspace files)
2. When output IS truncated (file > limit), append a clear hint:
   `[File truncated. Use offset=${nextLine} to read remaining ${remaining} lines.]`

## Files

| File | Change |
|------|--------|
| `src/cortex/tools.ts` | `executeReadFile` — bump default limit, add pagination hint |
