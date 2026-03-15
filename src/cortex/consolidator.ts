/**
 * Cortex Consolidator — Cross-Connection Discovery
 *
 * Scans recent facts in the knowledge graph, finds candidates via embedding
 * similarity, and asks an LLM to identify missing relationships between them.
 * Runs daily as part of the Gardener subsystem.
 *
 * @see CLAUDE.md (017g)
 */

import type { DatabaseSync } from "node:sqlite";
import type { EmbedFunction } from "./tools.js";
import type { FactExtractorLLM } from "./gardener.js";
import { insertEdge, searchGraphFacts } from "./hippocampus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsolidationResult {
  factsScanned: number;
  edgesDiscovered: number;
  errors: string[];
}

interface RecentFact {
  id: string;
  factText: string;
  factType: string;
  sourceType: string | null;
  createdAt: string;
}

interface CandidateFact {
  id: string;
  factText: string;
}

interface LLMEdge {
  from: string;
  to: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Batch size for LLM calls — max recent facts per prompt */
const BATCH_SIZE = 10;

const VALID_EDGE_TYPES = new Set([
  "because",
  "informed_by",
  "resulted_in",
  "contradicts",
  "updated_by",
  "related_to",
]);

/**
 * Returns a Set of "fromId|toId|type" strings for all existing edges
 * between the given fact IDs. Used for fast dedup checking.
 */
function getExistingEdgePairs(db: DatabaseSync, factIds: string[]): Set<string> {
  const pairs = new Set<string>();
  if (factIds.length === 0) return pairs;

  // Build placeholders for IN clause
  const placeholders = factIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT from_fact_id, to_fact_id, edge_type
    FROM hippocampus_edges
    WHERE from_fact_id IN (${placeholders})
       OR to_fact_id IN (${placeholders})
  `).all(...factIds, ...factIds) as Array<{
    from_fact_id: string;
    to_fact_id: string;
    edge_type: string;
  }>;

  for (const row of rows) {
    pairs.add(`${row.from_fact_id}|${row.to_fact_id}|${row.edge_type}`);
    // Also add reverse direction for bidirectional dedup
    pairs.add(`${row.to_fact_id}|${row.from_fact_id}|${row.edge_type}`);
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Find cross-connections between recent facts and existing facts.
 *
 * @param db - bus.sqlite database
 * @param embedFn - embedding function for similarity search
 * @param llmFn - LLM function for relationship identification (same type as FactExtractorLLM)
 * @param since - ISO timestamp, only process facts created after this (default: 24h ago)
 * @param maxFacts - max recent facts to process per run (default: 50)
 */
export async function runConsolidation(params: {
  db: DatabaseSync;
  embedFn: EmbedFunction;
  llmFn: FactExtractorLLM;
  since?: string;
  maxFacts?: number;
}): Promise<ConsolidationResult> {
  const { db, embedFn, llmFn } = params;
  const since = params.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const maxFacts = params.maxFacts ?? 50;

  const result: ConsolidationResult = { factsScanned: 0, edgesDiscovered: 0, errors: [] };

  // 1. Get recent facts
  const recentRows = db.prepare(`
    SELECT id, fact_text, fact_type, source_type, created_at
    FROM hippocampus_facts
    WHERE created_at > ? AND status = 'active'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(since, maxFacts) as Array<Record<string, unknown>>;

  const recentFacts: RecentFact[] = recentRows.map((r) => ({
    id: r.id as string,
    factText: r.fact_text as string,
    factType: r.fact_type as string,
    sourceType: (r.source_type as string) ?? null,
    createdAt: r.created_at as string,
  }));

  result.factsScanned = recentFacts.length;
  if (recentFacts.length === 0) return result;

  // 2. For each recent fact, find candidates via embedding similarity
  const allCandidates = new Map<string, CandidateFact>();
  const recentIds = new Set(recentFacts.map((f) => f.id));

  for (const fact of recentFacts) {
    try {
      const embedding = await embedFn(fact.factText);
      const similar = searchGraphFacts(db, embedding, 5);

      for (const s of similar) {
        // Skip self
        if (s.id === fact.id) continue;
        // Collect unique candidates (may include other recent facts)
        if (!allCandidates.has(s.id)) {
          allCandidates.set(s.id, { id: s.id, factText: s.factText });
        }
      }
    } catch (err) {
      result.errors.push(`embed:${fact.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Filter out candidates that are also recent facts (they'll be in the "recent" section)
  const candidatesOnly: CandidateFact[] = [];
  for (const [id, c] of allCandidates) {
    if (!recentIds.has(id)) {
      candidatesOnly.push(c);
    }
  }

  if (candidatesOnly.length === 0 && recentFacts.length < 2) {
    // Nothing to compare
    return result;
  }

  // Collect all fact IDs for edge dedup lookup
  const allFactIds = [
    ...recentFacts.map((f) => f.id),
    ...candidatesOnly.map((c) => c.id),
  ];
  const existingPairs = getExistingEdgePairs(db, allFactIds);

  // 3. Batch LLM calls (10 recent facts at a time)
  for (let i = 0; i < recentFacts.length; i += BATCH_SIZE) {
    const batch = recentFacts.slice(i, i + BATCH_SIZE);

    const prompt = `You are analyzing a knowledge graph for missing connections.

Recent facts:
${batch.map((f) => `[${f.id}] ${f.factText} (${f.factType}, from ${f.sourceType ?? "unknown"})`).join("\n")}

Existing related facts:
${candidatesOnly.map((f) => `[${f.id}] ${f.factText}`).join("\n")}

Identify relationships between ANY of these facts (recent↔existing or recent↔recent).
Only output relationships you are confident about. Do not invent connections.

Valid edge types: because, informed_by, resulted_in, contradicts, updated_by, related_to

Output ONLY valid JSON:
{"edges": [{"from": "<fact_id>", "to": "<fact_id>", "type": "<edge_type>"}]}

If no relationships exist, output: {"edges": []}`;

    let edges: LLMEdge[] = [];
    try {
      const response = await llmFn(prompt);
      let parsed: unknown;
      try {
        parsed = JSON.parse(response);
      } catch {
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            parsed = JSON.parse(match[0]);
          } catch {
            result.errors.push(`batch:${i}: malformed LLM output`);
            continue;
          }
        } else {
          result.errors.push(`batch:${i}: malformed LLM output`);
          continue;
        }
      }

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];
        edges = rawEdges
          .filter((e): e is Record<string, unknown> => e != null && typeof e === "object")
          .filter((e) => e.from && e.to && e.type)
          .filter((e) => VALID_EDGE_TYPES.has(String(e.type)))
          .map((e) => ({
            from: String(e.from),
            to: String(e.to),
            type: String(e.type),
          }));
      }
    } catch (err) {
      result.errors.push(`batch:${i}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // 4. Insert edges, skipping duplicates
    for (const edge of edges) {
      // Validate that both fact IDs exist in our working set
      const allIds = new Set(allFactIds);
      if (!allIds.has(edge.from) || !allIds.has(edge.to)) continue;
      if (edge.from === edge.to) continue;

      // Check both directions for existing edge
      const fwd = `${edge.from}|${edge.to}|${edge.type}`;
      const rev = `${edge.to}|${edge.from}|${edge.type}`;
      if (existingPairs.has(fwd) || existingPairs.has(rev)) continue;

      try {
        insertEdge(db, {
          fromFactId: edge.from,
          toFactId: edge.to,
          edgeType: edge.type,
          confidence: "medium",
        });
        // Track to avoid inserting the same edge again within this run
        existingPairs.add(fwd);
        existingPairs.add(rev);
        result.edgesDiscovered++;
      } catch (err) {
        result.errors.push(`edge:${edge.from.slice(0, 8)}→${edge.to.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}
