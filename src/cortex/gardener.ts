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
 */
export async function runChannelCompactor(params: {
  db: DatabaseSync;
  summarize: FactExtractorLLM;
  idleHours?: number;
}): Promise<GardenerRunResult> {
  const { db, summarize, idleHours = COMPACTOR_IDLE_HOURS } = params;
  const result: GardenerRunResult = { task: "channel_compactor", processed: 0, errors: [] };

  const states = getChannelStates(db);
  const now = Date.now();
  const thresholdMs = idleHours * 60 * 60 * 1000;

  for (const state of states) {
    if (state.layer !== "foreground") continue;

    const lastMsg = new Date(state.lastMessageAt).getTime();
    if (now - lastMsg < thresholdMs) continue; // Still active

    try {
      const messages = getSessionHistory(db, { channel: state.channel });
      if (messages.length === 0) continue;

      const summary = await compactChannel(
        messages.map((m) => ({ role: m.role, content: m.content, senderId: m.senderId })),
        summarize,
      );

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

// ---------------------------------------------------------------------------
// Task 4.2: Fact Extractor
// ---------------------------------------------------------------------------

/**
 * Extract persistent facts from recent session messages using an LLM.
 * Inserts extracted facts into cortex_hot_memory.
 */
export async function runFactExtractor(params: {
  db: DatabaseSync;
  extractLLM: FactExtractorLLM;
  /** Only process messages newer than this ISO timestamp */
  since?: string;
  /** Max messages to process per channel */
  maxMessages?: number;
}): Promise<GardenerRunResult> {
  const { db, extractLLM, maxMessages = 100 } = params;
  const result: GardenerRunResult = { task: "fact_extractor", processed: 0, errors: [] };

  // Default: last 6 hours
  const since = params.since ?? new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const states = getChannelStates(db);
  const channelsToProcess: ChannelId[] = states.map((s) => s.channel);

  for (const channel of channelsToProcess) {
    try {
      const messages = getSessionHistory(db, { channel, limit: maxMessages });
      // Filter to recent messages
      const recent = messages.filter((m) => m.timestamp >= since);
      if (recent.length === 0) continue;

      const transcript = recent
        .map((m) => `${m.role === "assistant" ? "Cortex" : m.senderId}: ${m.content}`)
        .join("\n");

      const prompt = `Extract any persistent, reusable facts from this conversation. \
Facts are things like user preferences, personal details, project decisions, \
technical choices, or recurring patterns. Return ONLY a JSON array of strings, \
one fact per entry. If no facts are found, return an empty array [].

Conversation:
${transcript}`;

      const response = await extractLLM(prompt);

      // Parse the JSON array of facts
      let facts: string[];
      try {
        facts = JSON.parse(response);
        if (!Array.isArray(facts)) facts = [];
      } catch {
        // Try extracting JSON from markdown code block
        const match = response.match(/\[[\s\S]*?\]/);
        facts = match ? JSON.parse(match[0]) : [];
      }

      for (const factText of facts) {
        if (typeof factText === "string" && factText.trim().length > 0) {
          // Skip duplicates (exact match in hot memory)
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
      result.errors.push(`${channel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
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
      await runFactExtractor({ db, extractLLM });
    } catch (err) {
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
