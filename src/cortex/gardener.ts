/**
 * Cortex Gardener — Background Memory Maintenance
 *
 * Three automated workers that manage the lifecycle of memories:
 * 1. Channel Compactor — compresses inactive foreground → background summaries (hourly)
 * 2. Fact Extractor — extracts persistent facts from recent logs → hot memory (6-hourly)
 * 3. Vector Evictor — sweeps stale hot facts → cold storage (weekly)
 *
 * All tasks are gated by hippocampus.enabled and can be triggered manually for testing.
 *
 * @see docs/hipocampus-implementation.md Phase 4
 */

import type { DatabaseSync } from "node:sqlite";
import {
  getStaleHotFacts,
  deleteHotFact,
  insertHotFact,
  insertColdFact,
  searchHotFacts,
  updateHotFact,
  insertFact,
  insertEdge,
  searchGraphFacts,
  getStaleGraphFacts,
  evictFact,
  pruneOldStubs,
  type HotFact,
} from "./hippocampus.js";
import {
  getChannelStates,
  getSessionHistory,
  updateChannelState,
} from "./session.js";
import {
  getUnextractedShards,
  getShardMessages,
  getRecentClosedShards,
  markShardExtracted,
} from "./shards.js";
import type { EmbedFunction } from "./tools.js";
import type { ChannelId } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** LLM function for fact extraction — injectable for testing */
export type FactExtractorLLM = (prompt: string) => Promise<string>;

/** Result from a gardener task run */
export interface GardenerRunResult {
  task: string;
  processed: number;
  errors: string[];
}

/** A single extracted fact from a conversation */
export interface ExtractedFact {
  /** Temporary local id like "f1", "f2" — NOT a UUID */
  id: string;
  text: string;
  type: "fact" | "decision" | "outcome" | "correction";
  confidence: "high" | "medium" | "low";
}

/** A relationship between two extracted facts */
export interface ExtractedEdge {
  /** References ExtractedFact.id (e.g. "f1") */
  from: string;
  to: string;
  type: "because" | "informed_by" | "resulted_in" | "contradicts" | "updated_by" | "related_to";
}

/** Structured result from fact extraction */
export interface ExtractionResult {
  facts: ExtractedFact[];
  edges: ExtractedEdge[];
}

// ---------------------------------------------------------------------------
// Task 4.1: Channel Compactor
// ---------------------------------------------------------------------------

/** Default idle threshold: channels idle for >1 hour get compacted */
export const COMPACTOR_IDLE_HOURS = 1;

/**
 * Compress a list of chat messages into a 1-2 sentence summary.
 * Pure function — the LLM call is injectable for testing.
 */
export async function compactChannel(
  messages: Array<{ role: string; content: string; senderId: string }>,
  summarize: FactExtractorLLM,
): Promise<string> {
  if (messages.length === 0) return "";

  const transcript = messages
    .map((m) => `${m.role === "assistant" ? "Cortex" : m.senderId}: ${m.content}`)
    .join("\n");

  const prompt = `Summarize this conversation in 1-2 sentences. Focus on key topics, decisions, and any actionable items. Be concise.\n\n${transcript}`;

  return summarize(prompt);
}

/**
 * Run the Channel Compactor: find foreground channels idle for >threshold,
 * summarize their history, and demote them to background layer.
 *
 * When shards are available, builds background summary from recent closed shard
 * topic labels (one line per shard) instead of LLM-summarizing raw messages.
 * Falls back to LLM summarization when no shards exist.
 */
export async function runChannelCompactor(params: {
  db: DatabaseSync;
  summarize: FactExtractorLLM;
  idleHours?: number;
  /** When set, queries shards by issuer instead of per-channel */
  issuer?: string;
}): Promise<GardenerRunResult> {
  const { db, summarize, idleHours = COMPACTOR_IDLE_HOURS, issuer } = params;
  const result: GardenerRunResult = { task: "channel_compactor", processed: 0, errors: [] };

  const states = getChannelStates(db);
  const now = Date.now();
  const thresholdMs = idleHours * 60 * 60 * 1000;

  for (const state of states) {
    if (state.layer !== "foreground") continue;

    const lastMsg = new Date(state.lastMessageAt).getTime();
    if (now - lastMsg < thresholdMs) continue; // Still active

    try {
      // Query shards by issuer (cross-channel) when available, otherwise per-channel
      const shardFilter = issuer ? { issuer } : state.channel;
      const recentShards = getRecentClosedShards(db, shardFilter, 5);

      let summary: string;
      if (recentShards.length > 0) {
        // Build summary from shard topic labels — no LLM call needed
        summary = recentShards
          .map((s) => {
            const timeAgo = formatCompactorTimeAgo(now, s.endedAt ?? s.startedAt);
            return `- ${s.topic} (${timeAgo})`;
          })
          .join("\n");
      } else {
        // Fallback: LLM summarization of raw messages
        const historyOpts = issuer
          ? { issuer }
          : { channel: state.channel as ChannelId };
        const messages = getSessionHistory(db, historyOpts);
        if (messages.length === 0) continue;

        summary = await compactChannel(
          messages.map((m) => ({ role: m.role, content: m.content, senderId: m.senderId })),
          summarize,
        );
      }

      if (summary) {
        updateChannelState(db, state.channel, {
          summary,
          layer: "background",
        });
        result.processed++;
      }
    } catch (err) {
      result.errors.push(`${state.channel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

function formatCompactorTimeAgo(now: number, timestamp: string): string {
  const diffMs = now - new Date(timestamp).getTime();
  const diffMin = Math.floor(diffMs / (1000 * 60));
  if (diffMin < 60) return `${diffMin}min ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// ---------------------------------------------------------------------------
// Task 4.2: Fact Extractor
// ---------------------------------------------------------------------------

/**
 * Extract persistent facts from closed shards (shard-aware) or recent session
 * messages (fallback for unsharded history).
 *
 * Shard-aware mode: processes each unextracted closed shard individually,
 * including its topic label for scoped extraction. Marks shards as extracted
 * via `extracted_at` to avoid reprocessing.
 *
 * Fallback mode: for channels with no shards, falls back to raw session history.
 */
/** L2 distance threshold for near-duplicate detection (nomic-embed-text normalized vectors).
 *  cosine_similarity ≈ 1 - (distance² / 2); threshold 0.55 ≈ cosine sim > 0.85 */
export const DEDUP_SIMILARITY_THRESHOLD = 0.55;

export async function runFactExtractor(params: {
  db: DatabaseSync;
  extractLLM: FactExtractorLLM;
  /** Embedding function for dedup — when provided, enables near-duplicate detection */
  embedFn?: EmbedFunction;
  /** Only process messages newer than this ISO timestamp (fallback mode) */
  since?: string;
  /** Max messages to process per channel (fallback mode) */
  maxMessages?: number;
}): Promise<GardenerRunResult> {
  const { db, extractLLM, embedFn, maxMessages = 100 } = params;
  const result: GardenerRunResult = { task: "fact_extractor", processed: 0, errors: [] };

  // --- Shard-aware extraction: process unextracted closed shards ---
  const unextracted = getUnextractedShards(db);
  const shardsProcessed = new Set<string>();

  for (const shard of unextracted) {
    try {
      const messages = getShardMessages(db, shard.id);
      if (messages.length === 0) {
        markShardExtracted(db, shard.id);
        continue;
      }

      const transcript = messages
        .map((m) => `${m.role === "assistant" ? "Cortex" : m.senderId}: ${m.content}`)
        .join("\n");

      console.log(`[gardener] Shard "${shard.topic}" (${shard.id.slice(0, 8)}): ${messages.length} messages, ${transcript.length} chars`);

      const topicContext = shard.topic !== "Continued conversation"
        ? `\nThis conversation is about: "${shard.topic}". Extract facts relevant to this topic.\n`
        : "";

      const extraction = await extractFactsFromTranscript(extractLLM, transcript, topicContext);

      // Map local IDs to real UUIDs
      const idMap = new Map<string, string>();

      for (const fact of extraction.facts) {
        if (!fact.text?.trim()) continue;
        const { factId, inserted } = await dedupAndInsertGraphFact(db, fact, "conversation", embedFn);
        idMap.set(fact.id, factId);
        if (inserted) result.processed++;
      }

      for (const edge of extraction.edges) {
        const fromId = idMap.get(edge.from);
        const toId = idMap.get(edge.to);
        if (fromId && toId && fromId !== toId) {
          insertEdge(db, { fromFactId: fromId, toFactId: toId, edgeType: edge.type });
        }
      }

      markShardExtracted(db, shard.id);
      shardsProcessed.add(shard.channel);
    } catch (err) {
      result.errors.push(`shard:${shard.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Fallback: process channels with no shards via raw session history ---
  const since = params.since ?? new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const states = getChannelStates(db);

  for (const state of states) {
    if (shardsProcessed.has(state.channel)) continue; // Already processed via shards

    try {
      const messages = getSessionHistory(db, { channel: state.channel });
      const recent = messages.filter((m) => m.timestamp >= since).slice(0, maxMessages);
      console.log(`[gardener] Channel "${state.channel}": ${messages.length} total, ${recent.length} recent (since ${since})`);
      if (recent.length === 0) continue;

      const transcript = recent
        .map((m) => `${m.role === "assistant" ? "Cortex" : m.senderId}: ${m.content}`)
        .join("\n");

      console.log(`[gardener] Transcript length: ${transcript.length} chars, sending to LLM...`);

      const extraction = await extractFactsFromTranscript(extractLLM, transcript);

      // Map local IDs to real UUIDs
      const idMap = new Map<string, string>();

      for (const fact of extraction.facts) {
        if (!fact.text?.trim()) continue;
        const { factId, inserted } = await dedupAndInsertGraphFact(db, fact, "conversation", embedFn);
        idMap.set(fact.id, factId);
        if (inserted) result.processed++;
      }

      for (const edge of extraction.edges) {
        const fromId = idMap.get(edge.from);
        const toId = idMap.get(edge.to);
        if (fromId && toId && fromId !== toId) {
          insertEdge(db, { fromFactId: fromId, toFactId: toId, edgeType: edge.type });
        }
      }
    } catch (err) {
      result.errors.push(`${state.channel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/** Shared extraction logic — builds prompt, calls LLM, parses structured JSON result. */
export async function extractFactsFromTranscript(
  extractLLM: FactExtractorLLM,
  transcript: string,
  topicContext = "",
): Promise<ExtractionResult> {
  const emptyResult: ExtractionResult = { facts: [], edges: [] };

  const prompt = `From this conversation, extract facts and relationships between them.
${topicContext}
CATEGORIES:
- fact: specific claims, preferences, personal details, configurations
- decision: explicit choices ("we decided...", "let's go with...")
- outcome: results of actions ("it worked", "it failed", "we learned...")
- correction: something was wrong ("actually...", "that was incorrect...")

RELATIONSHIPS between facts (only when clearly stated):
- because: A happened because of B
- informed_by: A was informed by B
- resulted_in: A led to B
- contradicts: A contradicts B
- updated_by: A supersedes/updates B
- related_to: A and B are about the same topic

RULES:
- ONLY extract what is directly said or clearly demonstrated. Do NOT infer.
- Prefer specific, verifiable facts useful weeks or months later.
- Skip: greetings, filler, routine acks, one-off results, task IDs, ephemeral status.
- Each fact must be a standalone statement.
- If no facts are found, return {"facts": [], "edges": []}.
- Assign confidence: high (explicitly stated), medium (clearly implied), low (loosely implied).

Return ONLY valid JSON:
{
  "facts": [{"id": "f1", "text": "...", "type": "fact", "confidence": "high"}, ...],
  "edges": [{"from": "f1", "to": "f2", "type": "because"}, ...]
}

Conversation:
${transcript}`;

  const response = await extractLLM(prompt);
  console.log(`[gardener] LLM response: ${response.substring(0, 200)}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    // Try extracting {...} from response
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return emptyResult;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return emptyResult;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyResult;
  }

  const obj = parsed as Record<string, unknown>;
  const rawFacts = Array.isArray(obj.facts) ? obj.facts : [];
  const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];

  const facts: ExtractedFact[] = rawFacts
    .filter((f): f is Record<string, unknown> => f && typeof f === "object")
    .filter((f) => f.id && f.text && f.type)
    .map((f) => ({
      id: String(f.id),
      text: String(f.text),
      type: f.type as ExtractedFact["type"],
      confidence: (f.confidence as ExtractedFact["confidence"]) ?? "medium",
    }));

  const edges: ExtractedEdge[] = rawEdges
    .filter((e): e is Record<string, unknown> => e && typeof e === "object")
    .filter((e) => e.from && e.to && e.type)
    .map((e) => ({
      from: String(e.from),
      to: String(e.to),
      type: e.type as ExtractedEdge["type"],
    }));

  return { facts, edges };
}

// ---------------------------------------------------------------------------
// Dedup Helper
// ---------------------------------------------------------------------------

/**
 * Check for exact or near-duplicate before inserting a new fact into hot memory.
 * Returns true if the fact was inserted or replaced an existing one, false if skipped.
 */
async function dedupAndInsertFact(
  db: DatabaseSync,
  factText: string,
  embedFn?: EmbedFunction,
): Promise<boolean> {
  // 1. Exact match first (fast, no embedding needed)
  const exactMatch = db.prepare(
    `SELECT id FROM cortex_hot_memory WHERE fact_text = ?`,
  ).get(factText) as { id: string } | undefined;

  if (exactMatch) return false; // Skip exact duplicate

  // 2. If no embedFn, fall back to exact-match-only (backward compatible)
  if (!embedFn) {
    insertHotFact(db, { factText });
    return true;
  }

  // 3. Embed the new fact
  let embedding: Float32Array;
  try {
    embedding = await embedFn(factText);
  } catch (err) {
    // Embedding failed — insert without embedding, log warning
    console.log(`[gardener] Embed failed for "${factText.slice(0, 60)}...": ${err instanceof Error ? err.message : String(err)}`);
    insertHotFact(db, { factText });
    return true;
  }

  // 4. Search hot memory vec for similar facts (top-1 nearest)
  let similar: (HotFact & { distance: number })[];
  try {
    similar = searchHotFacts(db, embedding, 1);
  } catch {
    // Vec table may be empty or not initialized — insert with embedding
    insertHotFact(db, { factText, embedding });
    return true;
  }

  if (similar.length > 0 && similar[0].distance < DEDUP_SIMILARITY_THRESHOLD) {
    // Near-duplicate found — replace if newer is longer/more specific, else skip
    console.log(`[gardener] Dedup: "${factText.slice(0, 60)}..." similar to existing (dist=${similar[0].distance.toFixed(3)})`);

    if (factText.length > similar[0].factText.length) {
      updateHotFact(db, similar[0].id, factText, embedding);
      return true;
    }
    // Existing fact is good enough — skip
    return false;
  }

  // 5. New unique fact
  insertHotFact(db, { factText, embedding });
  return true;
}

/**
 * Dedup-aware insert of an extracted fact into the graph tables (hippocampus_facts).
 * Returns the UUID of the fact (new or existing) and whether it was inserted.
 */
export async function dedupAndInsertGraphFact(
  db: DatabaseSync,
  fact: ExtractedFact,
  sourceType: string,
  embedFn?: EmbedFunction,
  sourceRef?: string,
): Promise<{ factId: string; inserted: boolean }> {
  // 1. Exact match
  const exactMatch = db.prepare(
    `SELECT id FROM hippocampus_facts WHERE fact_text = ?`,
  ).get(fact.text) as { id: string } | undefined;

  if (exactMatch) return { factId: exactMatch.id, inserted: false };

  // 2. No embedFn — insert without embedding
  if (!embedFn) {
    const id = insertFact(db, {
      factText: fact.text,
      factType: fact.type,
      confidence: fact.confidence,
      sourceType,
      sourceRef,
    });
    return { factId: id, inserted: true };
  }

  // 3. Embed the fact text
  let embedding: Float32Array;
  try {
    embedding = await embedFn(fact.text);
  } catch (err) {
    console.log(`[gardener] Embed failed for "${fact.text.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`);
    const id = insertFact(db, {
      factText: fact.text,
      factType: fact.type,
      confidence: fact.confidence,
      sourceType,
      sourceRef,
    });
    return { factId: id, inserted: true };
  }

  // 4. Search graph facts vec for top-1 nearest
  let similar: ReturnType<typeof searchGraphFacts>;
  try {
    similar = searchGraphFacts(db, embedding, 1);
  } catch {
    // Vec table may be empty or not initialized — insert with embedding
    const id = insertFact(db, {
      factText: fact.text,
      factType: fact.type,
      confidence: fact.confidence,
      sourceType,
      sourceRef,
      embedding,
    });
    return { factId: id, inserted: true };
  }

  if (similar.length > 0 && similar[0].distance < DEDUP_SIMILARITY_THRESHOLD) {
    const existing = similar[0];
    console.log(`[gardener] Graph dedup: "${fact.text.slice(0, 60)}" similar to existing (dist=${existing.distance.toFixed(3)})`);

    if (fact.text.length > existing.factText.length) {
      // New text is longer/more specific — update existing
      db.prepare(`
        UPDATE hippocampus_facts SET fact_text = ?, last_accessed_at = ? WHERE id = ?
      `).run(fact.text, new Date().toISOString(), existing.id);

      // Update vec embedding
      const row = db.prepare(`SELECT rowid FROM hippocampus_facts WHERE id = ?`).get(existing.id) as { rowid: number | bigint } | undefined;
      if (row) {
        const rowidNum = Number(row.rowid);
        db.prepare(`DELETE FROM hippocampus_facts_vec WHERE rowid = ?`).run(rowidNum);
        db.prepare(`INSERT INTO hippocampus_facts_vec (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(rowidNum, new Uint8Array(embedding.buffer));
      }
      return { factId: existing.id, inserted: true };
    }
    // Existing is good enough — skip
    return { factId: existing.id, inserted: false };
  }

  // 5. New unique fact — insert with embedding
  const id = insertFact(db, {
    factText: fact.text,
    factType: fact.type,
    confidence: fact.confidence,
    sourceType,
    sourceRef,
    embedding,
  });
  return { factId: id, inserted: true };
}

// ---------------------------------------------------------------------------
// Task 4.3: Vector Evictor
// ---------------------------------------------------------------------------

/**
 * Sweep stale hot facts, embed them, move to cold storage, delete from hot.
 * Each fact is processed individually — a failed embedding skips that fact.
 */
export async function runVectorEvictor(params: {
  db: DatabaseSync;
  embedFn: EmbedFunction;
  olderThanDays?: number;
  maxHitCount?: number;
}): Promise<GardenerRunResult> {
  const { db, embedFn, olderThanDays = 14, maxHitCount = 3 } = params;
  const result: GardenerRunResult = { task: "vector_evictor", processed: 0, errors: [] };

  const staleFacts = getStaleHotFacts(db, olderThanDays, maxHitCount);

  for (const fact of staleFacts) {
    try {
      // Embed the fact text
      const embedding = await embedFn(fact.factText);

      // Insert into cold storage
      insertColdFact(db, fact.factText, embedding);

      // Delete from hot memory
      deleteHotFact(db, fact.id);

      result.processed++;
    } catch (err) {
      result.errors.push(`${fact.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Graph-aware eviction
  const staleGraphFacts = getStaleGraphFacts(db, olderThanDays, maxHitCount);
  for (const fact of staleGraphFacts) {
    try {
      const embedding = await embedFn(fact.factText);
      evictFact(db, fact.id, embedding);
      result.processed++;
    } catch (err) {
      result.errors.push(`graph:${fact.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Prune old stubs
  pruneOldStubs(db, 90);

  return result;
}

// ---------------------------------------------------------------------------
// Gardener Scheduler
// ---------------------------------------------------------------------------

export interface GardenerInstance {
  stop(): void;
  /** Manually trigger all tasks (for testing) */
  runAll(): Promise<GardenerRunResult[]>;
}

/**
 * Start the Gardener with interval-based scheduling.
 * Returns a handle to stop the timers.
 */
export function startGardener(params: {
  db: DatabaseSync;
  summarize: FactExtractorLLM;
  extractLLM: FactExtractorLLM;
  embedFn: EmbedFunction;
  onError?: (err: Error) => void;
  /** Override intervals for testing (milliseconds) */
  compactorIntervalMs?: number;
  extractorIntervalMs?: number;
  evictorIntervalMs?: number;
  consolidatorIntervalMs?: number;
}): GardenerInstance {
  const {
    db,
    summarize,
    extractLLM,
    embedFn,
    onError = () => {},
    compactorIntervalMs = 60 * 60 * 1000,       // 1 hour
    extractorIntervalMs = 6 * 60 * 60 * 1000,    // 6 hours
    evictorIntervalMs = 7 * 24 * 60 * 60 * 1000, // 1 week
    consolidatorIntervalMs = 24 * 60 * 60 * 1000, // 1 day
  } = params;

  const timers: ReturnType<typeof setInterval>[] = [];

  const runCompactor = async () => {
    try {
      await runChannelCompactor({ db, summarize });
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const runExtractor = async () => {
    try {
      console.log(`[gardener] Fact extractor starting (interval: ${extractorIntervalMs}ms)`);
      const result = await runFactExtractor({ db, extractLLM, embedFn });
      console.log(`[gardener] Fact extractor done: processed=${result.processed}, errors=${result.errors.length}`);
    } catch (err) {
      console.log(`[gardener] Fact extractor FAILED: ${err}`);
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const runEvictor = async () => {
    try {
      await runVectorEvictor({ db, embedFn });
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const runConsolidator = async () => {
    try {
      const { runConsolidation } = await import("./consolidator.js");
      const result = await runConsolidation({ db, embedFn, llmFn: extractLLM });
      console.log(`[gardener] Consolidator done: scanned=${result.factsScanned}, edges=${result.edgesDiscovered}`);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  console.log(`[gardener] Started — compactor: ${compactorIntervalMs}ms, extractor: ${extractorIntervalMs}ms, evictor: ${evictorIntervalMs}ms, consolidator: ${consolidatorIntervalMs}ms`);
  timers.push(setInterval(runCompactor, compactorIntervalMs));
  timers.push(setInterval(runExtractor, extractorIntervalMs));
  timers.push(setInterval(runEvictor, evictorIntervalMs));
  timers.push(setInterval(runConsolidator, consolidatorIntervalMs));

  return {
    stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
    async runAll() {
      const results: GardenerRunResult[] = [];
      results.push(await runChannelCompactor({ db, summarize }));
      results.push(await runFactExtractor({ db, extractLLM, embedFn }));
      results.push(await runVectorEvictor({ db, embedFn }));
      const { runConsolidation } = await import("./consolidator.js");
      const consResult = await runConsolidation({ db, embedFn, llmFn: summarize });
      results.push({ task: "consolidator", processed: consResult.edgesDiscovered, errors: consResult.errors });
      return results;
    },
  };
}
