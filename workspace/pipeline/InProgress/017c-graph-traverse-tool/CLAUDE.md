# Claude Code Instructions — 017c

## Branch
`feat/017c-graph-traverse-tool`

## What to Build

New sync tool `graph_traverse` that walks the knowledge graph N hops from a starting fact.

### 1. `src/cortex/hippocampus.ts` — Add `traverseGraph()` function

```typescript
export interface TraversalNode {
  factId: string;
  factText: string;
  factType: string;
  status: string;
  depth: number;
  edges: Array<{
    edgeType: string;
    direction: "outgoing" | "incoming";
    targetFactId: string;
    targetText: string;
    isStub: boolean;
    stubTopic: string | null;
  }>;
}

export function traverseGraph(
  db: DatabaseSync,
  startFactId: string,
  depth: number = 2,
  direction: "outgoing" | "incoming" | "both" = "both",
): string
```

Use a recursive CTE to collect all reachable fact IDs within `depth` hops. Cap at `depth=4` max, `50` total nodes max.

Return a formatted string showing the subgraph:
```
Subgraph from "Budget is 2.4M" (depth=2, 5 nodes):

[F1] Budget is 2.4M (fact)
  → constrains [F2] O-RAN deployment North
  → part [F3] hardware 1.8M
  ← caused_by [F4] vendor negotiation

[F2] O-RAN deployment North (decision)
  → deadline [EVICTED: Q3 deadline]
  ← constrained_by [F1] Budget is 2.4M
```

If startFactId not found, return: `Error: fact "${startFactId}" not found in knowledge graph.`

### 2. `src/cortex/tools.ts` — Add tool definition and add to SYNC_TOOL_NAMES

Add the tool definition:
```typescript
export const GRAPH_TRAVERSE_TOOL = {
  name: "graph_traverse",
  description: "Walk the knowledge graph from a fact node. Returns connected facts and their relationships up to N hops. Use when a hot memory breadcrumb shows a connection worth exploring.",
  parameters: {
    type: "object" as const,
    properties: {
      fact_id: { type: "string", description: "Starting fact ID (visible in hot memory breadcrumbs)" },
      depth: { type: "number", description: "Hops to traverse (default 2, max 4)" },
      direction: { type: "string", enum: ["outgoing", "incoming", "both"], description: "Edge direction to follow (default: both)" },
    },
    required: ["fact_id"],
  },
};
```

Add `"graph_traverse"` to the `SYNC_TOOL_NAMES` Set.

Import `traverseGraph` from hippocampus.js (add to existing imports).

### 3. `src/cortex/llm-caller.ts` — Register tool

Import `GRAPH_TRAVERSE_TOOL` from tools.js and add it to the `FILE_IO_TOOLS` array.

Add to the Tool Guidance section in the system prompt (find the `## Tool Guidance` section):
```
- **graph_traverse**: Walk the knowledge graph from a fact. Use when hot memory breadcrumbs show a connection you want to explore deeper. The fact_id is shown in brackets in the Knowledge Graph section.
```

### 4. `src/cortex/loop.ts` — Add execution handler

In the sync tool switch (where other tools like `pipeline_transition` and `cortex_config` are handled), add:

```typescript
} else if (tc.name === "graph_traverse") {
  const args = tc.arguments as Record<string, unknown>;
  const { traverseGraph } = require("../cortex/hippocampus.js");
  result = traverseGraph(
    db,
    args.fact_id as string,
    typeof args.depth === "number" ? Math.min(args.depth, 4) : 2,
    (args.direction as string | undefined) ?? "both",
  );
}
```

Note: check how other tools import from hippocampus in loop.ts and follow the same pattern (may use dynamic import or require).

## Constraints
- Do NOT modify any existing tool definitions or handlers
- Cap depth at 4, nodes at 50 — enforce in `traverseGraph`
- Update STATE.md after completion

## Tests
Write tests in `src/cortex/__tests__/graph-traverse.test.ts`:
- 1-hop from a fact with edges returns immediate connections
- 2-hop returns edges of edges
- direction="outgoing" only follows outgoing edges
- direction="incoming" only follows incoming edges  
- Depth capped at 4 (passing 10 returns max 4)
- Node cap at 50 enforced
- Unknown fact_id returns error string
- Stub edges shown as `[EVICTED: topic]`
- Empty graph (fact with no edges) returns just the starting node

When done, commit and run: `openclaw system event --text 'Done: 017c — graph_traverse tool' --mode now`
