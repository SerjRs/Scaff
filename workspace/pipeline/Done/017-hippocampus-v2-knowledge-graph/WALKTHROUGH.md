# 017 — Architecture Walkthrough

Concrete examples showing how the knowledge graph grows, facts rise and sink, articles integrate, and mistakes reinforce learning.

---

## Day 1 (Monday): First Conversation

**Serj says:** "We need to deploy O-RAN in the North region. Budget is 2.4M, deadline is Q3."

### Fact Extractor runs, produces:

```
Nodes:
  F1: "O-RAN deployment planned for North region"
  F2: "Budget is 2.4M"
  F3: "Deadline is Q3"

Edges:
  F2 --constrains--> F1
  F3 --constrains--> F1
  F1 --sourced_from--> conversation:2026-03-17/shard-4
```

### Hot memory (System Floor injection):

```
- O-RAN deployment planned for North region [→ constrained_by: Budget 2.4M, Deadline Q3]
- Budget is 2.4M [→ constrains: North O-RAN deployment]
- Deadline is Q3 [→ constrains: North O-RAN deployment]
```

### Graph state:
```
Full graph: 3 facts, 3 edges
Hot graph: 3/3 (all hot — everything is new)
Cold storage: empty
```

---

## Day 1 (evening): Article Ingested

**Serj drops a link:** "https://example.com/oran-tco-analysis"

### Librarian processes it → Library stores raw content:
```
Library item #25: { url, title: "O-RAN TCO Analysis 2026", full_text: "...(8KB)..." }
```

### Fact extraction from the article produces:

```
Nodes:
  F4: "O-RAN reduces TCO by 30% compared to traditional RAN"
  F5: "Main cost savings come from vendor-neutral hardware"
  F6: "Integration costs are 15-20% higher in year 1"
  F7: "Break-even point is typically 18 months"

Edges:
  F4 --because--> F5
  F6 --contradicts--> F4  (partial — savings aren't immediate)
  F7 --qualifies--> F4
  F4 --sourced_from--> library://item/25
  F5 --sourced_from--> library://item/25
  F6 --sourced_from--> library://item/25
  F7 --sourced_from--> library://item/25
```

### Consolidator runs, finds cross-connections:

```
New edges (discovered):
  F4 --relevant_to--> F1  (O-RAN TCO relates to O-RAN deployment)
  F4 --informs--> F2      (TCO analysis informs the budget)
  F6 --threatens--> F2    (higher year-1 costs may exceed budget)
```

### Hot memory now:

```
- O-RAN deployment planned for North region [→ constrained_by: Budget 2.4M, Deadline Q3 | → informed_by: O-RAN TCO article]
- Budget is 2.4M [→ constrains: North deployment | ⚠️ threatened_by: Integration costs 15-20% higher in Y1]
- O-RAN reduces TCO by 30% [→ sourced_from: library://25 | → relevant_to: North deployment]
- Integration costs 15-20% higher in year 1 [→ sourced_from: library://25 | → threatens: Budget 2.4M]
- Deadline is Q3 [→ constrains: North deployment]
```

Notice: Cortex now sees that the budget might be at risk because of year-1 integration costs. This wasn't in any single document — it's the graph connecting conversation facts to article facts.

### Graph state:
```
Full graph: 7 facts, 10 edges
Hot graph: 5/7 (F5 and F7 are lower priority — supporting details)
Cold storage: empty
```

---

## Day 3 (Wednesday): The Conversation Continues

**Serj says:** "I talked to the vendor. They quoted 2.1M for the hardware, leaving only 300K for integration."

### Fact Extractor:

```
Nodes:
  F8: "Vendor quoted 2.1M for hardware"
  F9: "Only 300K remaining for integration"

Edges:
  F8 --part_of--> F2      (hardware cost is part of total budget)
  F9 --derived_from--> F2  (300K = 2.4M - 2.1M)
  F9 --conflicts_with--> F6 (300K is likely insufficient for 15-20% integration cost)
```

### Hit counts update:
The conversation referenced F1 (deployment), F2 (budget), F6 (integration costs) — their hit_count increases:

```
F1: hit_count 4 → 5  (referenced in discussion)
F2: hit_count 6 → 8  (central to this conversation)
F6: hit_count 2 → 4  (the integration cost warning proved relevant)
F7: hit_count 1 → 1  (break-even point — nobody mentioned it)
F5: hit_count 1 → 1  (vendor-neutral hardware — not discussed)
```

### Hot memory now:

```
- Budget is 2.4M [hit:8 | → hardware: 2.1M | ⚠️ only 300K for integration | → threatened_by: Y1 costs 15-20%]
- O-RAN deployment planned for North region [hit:5 | → constrained_by: Budget, Deadline Q3]
- Vendor quoted 2.1M for hardware [hit:3 | → part_of: Budget 2.4M]
- Only 300K remaining for integration [hit:3 | ⚠️ conflicts_with: Integration costs 15-20% higher in Y1]
- O-RAN reduces TCO by 30% [hit:2 | → sourced_from: library://25]
- Integration costs 15-20% higher in year 1 [hit:4 | → sourced_from: library://25 | → threatens: Budget]
```

F5 (vendor-neutral hardware) and F7 (break-even 18 months) are dropping — low hit count, not referenced in conversations. They're still in the full graph but losing hot memory priority.

### Graph state:
```
Full graph: 9 facts, 13 edges
Hot graph: 6/9
Cold storage: empty
```

---

## Day 8 (Monday next week): A Mistake Happens

**Serj says:** "The integration estimate was wrong. Vendor says integration is actually 500K, not the 15-20% the article claimed. We're 200K over budget."

### Fact Extractor:

```
Nodes:
  F10: "Integration actually costs 500K (vendor confirmed)"
  F11: "Project is 200K over budget"

Edges:
  F10 --corrects--> F6     (500K vs the article's 15-20% estimate)
  F10 --sourced_from--> conversation:2026-03-24/shard-2
  F11 --caused_by--> F10   (over budget because integration costs more)
  F11 --caused_by--> F8    (and hardware took 2.1M of 2.4M)
  F6  --updated_by--> F10  (F6 is now marked as superseded)
```

### What happens to F6:

F6 ("Integration costs 15-20% higher in year 1") gets an `updated_by` edge pointing to F10. It's not deleted — the original article claim is preserved. But the graph now shows:

```
F6: "Integration costs 15-20% higher in Y1" [SUPERSEDED]
  → updated_by: F10 "Integration actually costs 500K"
  → sourced_from: library://25
```

This is learning from a mistake. The reasoning chain is preserved:
1. Article said 15-20% higher → we used that to estimate
2. Reality was 500K → we learned the article was wrong for our case
3. Result: 200K over budget

Next time the O-RAN TCO article surfaces in breadcrumbs, Cortex sees: "sourced_from library://25 — BUT fact F6 from this article was corrected by real vendor data."

### Hot memory now:

```
- Project is 200K over budget [hit:5 | → caused_by: Integration 500K + Hardware 2.1M]
- Integration actually costs 500K [hit:4 | → corrects: article estimate of 15-20% | → sourced_from: vendor conversation]
- Budget is 2.4M [hit:10 | → hardware: 2.1M | → integration: 500K | → status: exceeded]
- O-RAN deployment planned for North [hit:6 | → constrained_by: Budget (exceeded), Deadline Q3]
- Vendor quoted 2.1M for hardware [hit:4 | → part_of: Budget]
- O-RAN reduces TCO by 30% [hit:2 | → sourced_from: library://25 | ⚠️ article's integration estimate was wrong]
```

F5 (vendor-neutral hardware) and F7 (break-even 18 months) have now gone 8 days without a hit. They're candidates for eviction.

### Graph state:
```
Full graph: 11 facts, 18 edges (including correction chain)
Hot graph: 6/11
Cold storage: empty (but F5, F7 approaching eviction)
```

---

## Day 15 (second Monday): Eviction Happens

The Vector Evictor runs its weekly sweep:

```sql
SELECT * FROM facts
WHERE last_accessed_at < datetime('now', '-14 days')
AND hit_count < 3
```

Matches:
- **F5**: "Main cost savings come from vendor-neutral hardware" (hit_count: 1, last_accessed: Day 1)
- **F7**: "Break-even point is typically 18 months" (hit_count: 1, last_accessed: Day 1)

### Eviction process:

1. F5 and F7 are embedded into cold vector storage
2. Their content is removed from the full knowledge graph
3. Edge stubs remain:

```
Edge stubs (skeleton):
  F4 --because--> [STUB:F5, topic:"vendor-neutral hardware savings", cold_vector:vec_882]
  F7_STUB --qualifies--> F4  [topic:"break-even 18 months", cold_vector:vec_883]
```

The graph still knows that F4 ("TCO reduces 30%") has a "because" connection to something about vendor-neutral hardware — but the full fact is gone from the graph. If someone asks about vendor-neutral hardware, semantic search hits the cold vector, fact gets revived, edges reattach.

### Graph state:
```
Full graph: 9 active facts, 16 edges (2 stubs)
Hot graph: 6/9
Cold storage: 2 evicted facts (F5, F7)
```

---

## Day 16: Revival

**Serj says:** "Actually, the vendor-neutral hardware angle is important — we should use that in the budget renegotiation."

Cortex calls `memory_query("vendor-neutral hardware cost savings")` → semantic search hits cold vector vec_882 → F5 is found.

### Revival:

1. F5 re-inserted into the full knowledge graph
2. Edge stub reconnects: `F4 --because--> F5` (live again)
3. F5.hit_count reset to 1, F5.last_accessed = now

```
F5: "Main cost savings come from vendor-neutral hardware" [REVIVED]
  → explains: O-RAN TCO reduction
  → sourced_from: library://25
```

### Graph state:
```
Full graph: 10 active facts, 17 edges (1 stub remaining for F7)
Hot graph: 7/10 (F5 now active again)
Cold storage: 1 evicted fact (F7 — break-even, still dormant)
```

---

## Day 20: A Success Reinforces the Graph

**Serj says:** "Renegotiated with the vendor. Used the vendor-neutral argument from the article. Got hardware down to 1.8M. Back within budget."

### Fact Extractor:

```
Nodes:
  F12: "Hardware renegotiated to 1.8M (down from 2.1M)"
  F13: "Project back within 2.4M budget"

Edges:
  F12 --resulted_from--> F5  (vendor-neutral hardware argument worked)
  F12 --updates--> F8        (old hardware quote superseded)
  F13 --resulted_from--> F12 (back in budget because hardware cheaper)
  F13 --updates--> F11       (no longer over budget)
```

### Hit count effects:

F5 (vendor-neutral hardware) just proved its value in a real negotiation. Its hit_count jumps:
```
F5: hit_count 1 → 6 (referenced heavily in success discussion)
```

F5 was almost forgotten (evicted on Day 15, revived on Day 16). Now it's one of the most-hit facts because it led to a real outcome. It won't be evicted again anytime soon.

F11 ("200K over budget") gets an `updated_by` edge → F13 ("back within budget"). The mistake is preserved in the graph but marked as resolved.

### Hot memory now:

```
- Project back within 2.4M budget [hit:4 | → resulted_from: hardware renegotiation]
- Hardware renegotiated to 1.8M [hit:5 | → resulted_from: vendor-neutral argument | → updates: old quote 2.1M]
- Budget is 2.4M [hit:12 | → hardware: 1.8M | → integration: 500K | → status: within budget]
- Vendor-neutral hardware is key cost lever [hit:6 | → sourced_from: library://25 | → led_to: successful renegotiation]
- Integration actually costs 500K [hit:4 | → corrects: article estimate]
- O-RAN deployment planned for North [hit:7 | → constrained_by: Budget (OK), Deadline Q3]
```

### The reasoning chain is now complete:

```
Article said TCO -30% (F4)
  → because vendor-neutral hardware (F5)
  → article said integration 15-20% higher (F6) [SUPERSEDED]
    → actually 500K (F10) [CORRECTION]
      → went 200K over budget (F11) [RESOLVED]
  → used vendor-neutral argument in negotiation (F12) [SUCCESS]
    → hardware 2.1M → 1.8M (F12)
      → back within budget (F13)
```

Cortex can trace the entire journey: what we read → what we planned → what went wrong → what we learned → what we did differently → what worked. Not stored as a narrative — emergent from the graph edges.

### Final graph state:
```
Full graph: 13 active facts, 22 edges (1 stub)
Hot graph: 6/13 (top facts by relevance)
Cold storage: 1 fact (F7 — break-even, still dormant)
Superseded facts: 2 (F6, F8 — marked, not deleted)
Resolved facts: 1 (F11 — was a problem, now resolved)
```

---

## What This Shows

1. **Facts rise when discussed.** F2 (budget) started at hit_count 1 and reached 12 because every conversation touched it.

2. **Facts sink when ignored.** F5 and F7 were extracted from the article but never referenced in conversation. They sank to eviction within 2 weeks.

3. **Revival works.** F5 was evicted, then revived when the topic came up again. Edge stubs kept the connection alive. The fact came back fully connected.

4. **Successes reinforce.** F5's hit_count jumped from 1 to 6 after the renegotiation success. A fact that was almost forgotten became one of the most valuable because it led to a real outcome.

5. **Mistakes are learning chains.** F6 (article's integration estimate) wasn't deleted when proven wrong — it was marked `superseded` with an edge to the correction (F10). The chain preserves WHY we were wrong and WHAT we learned.

6. **Articles connect to conversations.** The O-RAN TCO article produced 4 facts. Two became critical (F4, F5), one was wrong (F6), one was forgotten (F7). The graph tracked each one's fate differently based on real-world outcomes.

7. **The graph is bounded.** After 20 days: 13 active facts, 1 evicted, 2 superseded. Not unbounded growth — facts that don't earn their keep get evicted. Facts that prove their value stay hot.
