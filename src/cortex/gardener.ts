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
export async function runFactExtractor(params: {
  db: DatabaseSync;
  extractLLM: FactExtractorLLM;
  /** Only process messages newer than this ISO timestamp (fallback mode) */
  since?: string;
  /** Max messages to process per channel (fallback mode) */
  maxMessages?: number;
}): Promise<GardenerRunResult> {
  const { db, extractLLM, maxMessages = 100 } = params;
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

      const facts = await extractFactsFromTranscript(extractLLM, transcript, topicContext);

      for (const factText of facts) {
        if (typeof factText === "string" && factText.trim().length > 0) {
          const existing = db.prepare(
            `SELECT id FROM cortex_hot_memory WHERE fact_text = ?`,
          ).get(factText.trim()) as { id: string } | undefined;

          if (!existing) {
            insertHotFact(db, { factText: factText.trim() });
            result.processed++;
          }
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

      const facts = await extractFactsFromTranscript(extractLLM, transcript);

      for (const factText of facts) {
        if (typeof factText === "string" && factText.trim().length > 0) {
          const existing = db.prepare(
            `SELECT id FROM cortex_hot_memory WHERE fact_text = ?`,
          ).get(factText.trim()) as { id: string } | undefined;

          if (!existing) {
            insertHotFact(db, { factText: factText.trim() });
            result.processed++;
          }
        }
      }
    } catch (err) {
      result.errors.push(`${state.channel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/** Shared extraction logic — builds prompt, calls LLM, parses JSON array of facts. */
async function extractFactsFromTranscript(
  extractLLM: FactExtractorLLM,
  transcript: string,
  topicContext = "",
): Promise<string[]> {
  const prompt = `Extract ONLY facts that are EXPLICITLY stated in this conversation. \
Facts are things like user preferences, personal details, project decisions, \
technical choices, system configurations, or relationships.
${topicContext}
RULES:
- ONLY extract what is directly said or clearly demonstrated. Do NOT infer, assume, or fabricate.
- If the user says "I live in Bucharest" → extract that. If they don't mention where they live → extract nothing about location.
- Prefer specific, verifiable facts that would be useful weeks or months later.
- Skip: greetings, filler, routine acknowledgments, one-off computation results, task dispatch IDs, stress test data, ephemeral status observations, temporary debugging output.
- Each fact should be a standalone statement useful in future conversations.
- If no facts are found, return an empty array [].

Return ONLY a JSON array of strings, one fact per entry.

Conversation:
${transcript}`;

  const response = await extractLLM(prompt);
  console.log(`[gardener] LLM response: ${response.substring(0, 200)}`);

  try {
    const parsed = JSON.parse(response);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const match = response.match(/\[[\s\S]*?\]/);
    return match ? JSON.parse(match[0]) : [];
  }
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
      const result = await runFactExtractor({ db, extractLLM });
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

  console.log(`[gardener] Started — compactor: ${compactorIntervalMs}ms, extractor: ${extractorIntervalMs}ms, evictor: ${evictorIntervalMs}ms`);
  timers.push(setInterval(runCompactor, compactorIntervalMs));
  timers.push(setInterval(runExtractor, extractorIntervalMs));
  timers.push(setInterval(runEvictor, evictorIntervalMs));

  return {
    stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
    async runAll() {
      const results: GardenerRunResult[] = [];
      results.push(await runChannelCompactor({ db, summarize }));
      results.push(await runFactExtractor({ db, extractLLM }));
      results.push(await runVectorEvictor({ db, embedFn }));
      return results;
    },
  };
}
