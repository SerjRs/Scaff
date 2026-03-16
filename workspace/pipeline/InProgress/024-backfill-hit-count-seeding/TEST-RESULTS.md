# 024 — Seed hit_count: Test Results

**Date:** 2026-03-16
**Script:** `scripts/seed-hit-counts.ts`
**Status:** PASS

## Rows Updated per Source Type

Note: `DatabaseSync.exec()` doesn't return row counts, but the distribution table confirms all updates applied correctly (no unexpected `hit_count = 0` rows for covered source types).

| Rule | Rows (from distribution) |
|---|---|
| curated_memory → 10 | 339 (235 fact + 56 decision + 26 outcome + 12 preference + 10 correction) |
| correction (fact_type) → 8 | 215 (57 daily_log + 37 executor_doc + 36 architecture_doc + 23 cortex_archive + 19 workspace_session + 16 executor_session + 15 main_session + 7 pipeline_task + 5 correction) |
| daily_log + decision → 7 | 341 |
| daily_log + other → 3 | 534 (292 outcome + 199 fact + 40 lesson + 3 other) |
| pipeline_task/cortex_archive + decision → 5 | 831 (484 pipeline_task + 347 cortex_archive) |
| pipeline_task/cortex_archive + other → 2 | 835 (302+234+206+67+9+6+6+2+2+1) |
| article/executor_session/workspace_session/executor_doc → 1 | 1,637 (507+211+174+150+126+117+72+72+36+31+24+21+12+10+8+5+3+3+2+1+1+1+1) |

**Total seeded:** ~4,732 facts

## Remaining hit_count = 0

These source types were not in the seeding rules (not in SPEC Option A):
- `architecture_doc`: 1,595 facts
- `main_session`: 255 facts
- `correction` (as source_type): 141 facts

These can be addressed in a follow-up if needed.

## Distribution Table

| source_type | fact_type | hit_count | count |
|---|---|---|---|
| conversation | fact | 18 | 1 |
| conversation | fact | 11 | 1 |
| curated_memory | fact | 10 | 235 |
| curated_memory | decision | 10 | 56 |
| curated_memory | outcome | 10 | 26 |
| curated_memory | preference | 10 | 12 |
| curated_memory | correction | 10 | 10 |
| daily_log | correction | 8 | 57 |
| executor_doc | correction | 8 | 37 |
| architecture_doc | correction | 8 | 36 |
| cortex_archive | correction | 8 | 23 |
| workspace_session | correction | 8 | 19 |
| executor_session | correction | 8 | 16 |
| main_session | correction | 8 | 15 |
| pipeline_task | correction | 8 | 7 |
| correction | correction | 8 | 5 |
| daily_log | decision | 7 | 341 |
| pipeline_task | decision | 5 | 484 |
| cortex_archive | decision | 5 | 347 |
| daily_log | outcome | 3 | 292 |
| daily_log | fact | 3 | 199 |
| daily_log | lesson | 3 | 40 |
| cortex_archive | fact | 2 | 302 |
| cortex_archive | outcome | 2 | 234 |
| pipeline_task | fact | 2 | 206 |
| pipeline_task | outcome | 2 | 67 |
| executor_doc | decision | 1 | 507 |
| executor_session | decision | 1 | 211 |
| executor_doc | fact | 1 | 174 |
| article | fact | 1 | 150 |
| executor_session | fact | 1 | 126 |
| executor_doc | outcome | 1 | 117 |
| executor_doc | architecture | 1 | 72 |
| executor_session | outcome | 1 | 72 |
| workspace_session | outcome | 1 | 36 |
| workspace_session | fact | 1 | 31 |
| workspace_session | decision | 1 | 24 |
| article | source | 1 | 21 |
| article | decision | 1 | 12 |
| article | outcome | 1 | 10 |
| architecture_doc | decision | 0 | 1102 |
| architecture_doc | fact | 0 | 313 |
| ... (remaining 0s are uncovered source types) | | | |

## Top-30 Facts (System Floor Preview)

| # | Preview | source_type | fact_type | hit_count |
|---|---|---|---|---|
| 1 | Task 011 addresses 4 root causes: async dispatch with no text fallback... | conversation | fact | 18 |
| 2 | SPEC.md frontmatter updated: status=done, pr=9, executor=claude-opus... | conversation | fact | 11 |
| 3 | Need to investigate browser, vendor, Swabble, and apps directories... | curated_memory | decision | 10 |
| 4 | Need to investigate credentials directory to determine if all files... | curated_memory | decision | 10 |
| 5 | Need to audit and categorize all top-level directories... | curated_memory | decision | 10 |
| 6-30 | (all curated_memory facts and decisions) | curated_memory | fact/decision/outcome/preference | 10 |

## Pass/Fail Verdict

**PASS** — Top-30 contains exclusively curated_memory and high-value conversation facts. No random pipeline noise. The System Floor will now show hand-curated knowledge instead of arbitrary backfill artifacts.
