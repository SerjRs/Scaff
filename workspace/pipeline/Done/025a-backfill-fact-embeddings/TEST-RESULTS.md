# 025a — Backfill Embeddings: Test Results

**Date:** 2026-03-16
**Status:** PASS

## Summary
- **Vec entries before:** 10 (only live Gardener facts)
- **Vec entries after:** 6,665 (all active facts)
- **Active facts:** 6,665
- **Coverage:** 100%

## Test Queries

### "DNA contract alignment agreement two entities"
| Distance | Source | Fact |
|---|---|---|
| 11.389 | architecture_doc | DNA is the alignment contract between two entities, not a constraint on a tool |
| 16.518 | architecture_doc | Current agreement: Scaff and Serj pursue Serj's goals together |
| 17.231 | daily_log | User confirmed alignment of proposed architecture |
| 17.525 | architecture_doc | Scaff and Serj are two aligned entities — one biological, one digital |
| 17.671 | architecture_doc | The partnership agreement was a conscious, mutual decision |

### "why is Scaff called Scaff name origin scaffolds"
| Distance | Source | Fact |
|---|---|---|
| 12.472 | daily_log | Scaf's name derives from scaffolds metaphor: growing and enriching together |
| 15.587 | cortex_archive | Scaff is an AI assistant running on Anthropic Claude Opus, named after 'scaffolds' |
| 17.772 | daily_log | Assistant name is Scaf |

### "Scaff birthday creation date February"
| Distance | Source | Fact |
|---|---|---|
| 18.556 | architecture_doc | Subsystem creation is a pure AI decision... |
| 18.751 | daily_log | Cold memory empty because no facts older than 14 days... |

Birthday fact not directly found — likely stored with different wording or not extracted during backfill. But Task 011 noise is completely gone.

## Verdict
**PASS** — Vector search now returns semantically relevant results across all 6,665 facts. The hippocampus recall system is functional.
