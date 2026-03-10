/**
 * Cortex Foreground Sharding — Shard Manager
 *
 * Manages shard lifecycle: creation, closure, message assignment,
 * and heuristic boundary detection (Tier 1A: time gap, Tier 1B: token overflow).
 *
 * Shards are the atomic unit of foreground context — fully included or fully excluded.
 * Never partially. This prevents mid-conversation cuts in the context window.
 *
 * @see docs/foreground-sharding-architecture.md
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { estimateTokens } from "./context.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Shard {
  id: string;
  channel: string;
  topic: string;
  firstMessageId: number;
  lastMessageId: number;
  tokenCount: number;
  messageCount: number;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  createdBy: "inline" | "gardener" | "manual";
}

export interface ForegroundConfig {
  tokenCap: number;
  tolerancePct: number;
  maxShardTokens: number;
  timeGapMinutes: number;
  semanticCheckInterval: number;
  semanticModel: string;
}

export const DEFAULT_FOREGROUND_CONFIG: ForegroundConfig = {
  tokenCap: 8000,
  tolerancePct: 20,
  maxShardTokens: 8000,
  timeGapMinutes: 25,
  semanticCheckInterval: 8,
  semanticModel: "claude-haiku-4-5",
};

// ---------------------------------------------------------------------------
// Shard CRUD
// ---------------------------------------------------------------------------

/** Get the currently open (active) shard for a channel. Returns null if none. */
export function getActiveShard(db: DatabaseSync, channel: string): Shard | null {
  const row = db.prepare(`
    SELECT id, channel, topic, first_message_id, last_message_id,
           token_count, message_count, started_at, ended_at, created_at, created_by
    FROM cortex_shards
    WHERE channel = ? AND ended_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(channel) as Record<string, unknown> | undefined;

  return row ? rowToShard(row) : null;
}

/** Create a new shard. Returns the shard. */
export function createShard(
  db: DatabaseSync,
  channel: string,
  firstMessageId: number,
  startedAt: string,
  topic = "Continued conversation",
): Shard {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cortex_shards (id, channel, topic, first_message_id, last_message_id,
                               token_count, message_count, started_at, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 'inline')
  `).run(id, channel, topic, firstMessageId, firstMessageId, startedAt, now);

  return {
    id, channel, topic,
    firstMessageId, lastMessageId: firstMessageId,
    tokenCount: 0, messageCount: 0,
    startedAt, endedAt: null, createdAt: now, createdBy: "inline",
  };
}

/** Close a shard — sets ended_at and finalizes counts. */
export function closeShard(
  db: DatabaseSync,
  shardId: string,
  lastMessageId: number,
  endedAt: string,
): void {
  // Recalculate token_count and message_count from actual messages
  const stats = db.prepare(`
    SELECT COUNT(*) as cnt, COALESCE(SUM(LENGTH(content)), 0) as total_chars
    FROM cortex_session
    WHERE shard_id = ?
  `).get(shardId) as { cnt: number; total_chars: number };

  const tokenCount = Math.ceil((stats.total_chars as number) / 4);

  db.prepare(`
    UPDATE cortex_shards
    SET ended_at = ?, last_message_id = ?, token_count = ?, message_count = ?
    WHERE id = ?
  `).run(endedAt, lastMessageId, tokenCount, stats.cnt, shardId);
}

/** Assign a message to a shard by updating its shard_id in cortex_session. */
export function assignMessageToShard(db: DatabaseSync, messageId: number, shardId: string): void {
  db.prepare(`UPDATE cortex_session SET shard_id = ? WHERE id = ?`).run(shardId, messageId);
}

/** Get the approximate token count for a shard based on its messages. */
export function getShardTokenCount(db: DatabaseSync, shardId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(LENGTH(content)), 0) as total_chars
    FROM cortex_session
    WHERE shard_id = ?
  `).get(shardId) as { total_chars: number };

  return Math.ceil((row.total_chars as number) / 4);
}

/** Update the last_message_id and running counts on an active shard. */
function updateShardTail(db: DatabaseSync, shardId: string, messageId: number, messageTokens: number): void {
  db.prepare(`
    UPDATE cortex_shards
    SET last_message_id = ?, token_count = token_count + ?, message_count = message_count + 1
    WHERE id = ?
  `).run(messageId, messageTokens, shardId);
}

/** Update a shard's topic label. */
export function updateShardTopic(db: DatabaseSync, shardId: string, topic: string): void {
  db.prepare(`UPDATE cortex_shards SET topic = ? WHERE id = ?`).run(topic, shardId);
}

/** Get closed shards for a channel, newest first. */
export function getClosedShards(db: DatabaseSync, channel: string): Shard[] {
  const rows = db.prepare(`
    SELECT id, channel, topic, first_message_id, last_message_id,
           token_count, message_count, started_at, ended_at, created_at, created_by
    FROM cortex_shards
    WHERE channel = ? AND ended_at IS NOT NULL
    ORDER BY ended_at DESC
  `).all(channel) as Record<string, unknown>[];

  return rows.map(rowToShard);
}

/** Get closed shards that haven't been extracted yet (extracted_at IS NULL). */
export function getUnextractedShards(db: DatabaseSync): Shard[] {
  const rows = db.prepare(`
    SELECT id, channel, topic, first_message_id, last_message_id,
           token_count, message_count, started_at, ended_at, created_at, created_by
    FROM cortex_shards
    WHERE ended_at IS NOT NULL AND extracted_at IS NULL
    ORDER BY ended_at ASC
  `).all() as Record<string, unknown>[];

  return rows.map(rowToShard);
}

/** Mark a shard as extracted by setting extracted_at. */
export function markShardExtracted(db: DatabaseSync, shardId: string): void {
  db.prepare(`UPDATE cortex_shards SET extracted_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), shardId);
}

/** Get recent closed shards for a channel (for background summaries). */
export function getRecentClosedShards(db: DatabaseSync, channel: string, limit = 5): Shard[] {
  const rows = db.prepare(`
    SELECT id, channel, topic, first_message_id, last_message_id,
           token_count, message_count, started_at, ended_at, created_at, created_by
    FROM cortex_shards
    WHERE channel = ? AND ended_at IS NOT NULL
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(channel, limit) as Record<string, unknown>[];

  return rows.map(rowToShard).reverse(); // Oldest first for display
}

/** Get messages belonging to a specific shard. */
export function getShardMessages(db: DatabaseSync, shardId: string): { id: number; content: string; timestamp: string; role: string; channel: string; senderId: string }[] {
  const rows = db.prepare(`
    SELECT id, content, timestamp, role, channel, sender_id
    FROM cortex_session
    WHERE shard_id = ?
    ORDER BY timestamp ASC, id ASC
  `).all(shardId) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as number,
    content: r.content as string,
    timestamp: r.timestamp as string,
    role: r.role as string,
    channel: r.channel as string,
    senderId: r.sender_id as string,
  }));
}

// ---------------------------------------------------------------------------
// Inline Shard Assignment + Heuristic Boundary Detection
// ---------------------------------------------------------------------------

/**
 * Assign an incoming message to the correct shard, handling boundary detection.
 *
 * This is the main entry point called from loop.ts after appendToSession().
 * It implements Tier 1A (time gap) and Tier 1B (token overflow) detection.
 *
 * Returns the shard ID the message was assigned to.
 */
export function assignMessageWithBoundaryDetection(
  db: DatabaseSync,
  messageId: number,
  channel: string,
  messageContent: string,
  messageTimestamp: string,
  config: ForegroundConfig,
): string {
  const messageTokens = estimateTokens(messageContent);

  let targetShardId: string;
  let targetShardTokens: number;

  const activeShard = getActiveShard(db, channel);

  if (!activeShard) {
    // --- No active shard: create one ---
    const shard = createShard(db, channel, messageId, messageTimestamp);
    assignMessageToShard(db, messageId, shard.id);
    updateShardTail(db, shard.id, messageId, messageTokens);
    targetShardId = shard.id;
    targetShardTokens = messageTokens;
  } else {
    // --- Tier 1A: Time gap detection ---
    const lastMessageTime = getLastMessageTimestamp(db, activeShard.id);
    if (lastMessageTime) {
      const gapMs = new Date(messageTimestamp).getTime() - new Date(lastMessageTime).getTime();
      const gapMinutes = gapMs / (1000 * 60);

      if (gapMinutes >= config.timeGapMinutes) {
        // Close the active shard and start a new one
        closeShard(db, activeShard.id, activeShard.lastMessageId, lastMessageTime);
        const newShard = createShard(db, channel, messageId, messageTimestamp);
        assignMessageToShard(db, messageId, newShard.id);
        updateShardTail(db, newShard.id, messageId, messageTokens);
        targetShardId = newShard.id;
        targetShardTokens = messageTokens;
      } else {
        // Assign to existing active shard
        assignMessageToShard(db, messageId, activeShard.id);
        updateShardTail(db, activeShard.id, messageId, messageTokens);
        targetShardId = activeShard.id;
        targetShardTokens = activeShard.tokenCount + messageTokens;
      }
    } else {
      // No messages yet in shard (shouldn't happen, but handle gracefully)
      assignMessageToShard(db, messageId, activeShard.id);
      updateShardTail(db, activeShard.id, messageId, messageTokens);
      targetShardId = activeShard.id;
      targetShardTokens = activeShard.tokenCount + messageTokens;
    }
  }

  // --- Tier 1B: Token threshold detection (post-assignment) ---
  // If the shard now exceeds the token threshold, close it.
  // The message stays in the current shard — the split happens for the NEXT message.
  if (targetShardTokens >= config.maxShardTokens) {
    closeShard(db, targetShardId, messageId, messageTimestamp);
  }

  return targetShardId;
}

// ---------------------------------------------------------------------------
// Semantic Boundary Detection (Tier 2)
// ---------------------------------------------------------------------------

/** LLM function type for shard operations (topic labeling, semantic detection) */
export type ShardLLMFunction = (prompt: string) => Promise<string>;

/** Result of a semantic topic-shift check */
export interface TopicShiftResult {
  shifted: boolean;
  splitAtId?: number;
  oldTopic?: string;
  newTopic?: string;
}

/** Message shape used by detectTopicShift */
export interface ShardMessage {
  id: number;
  role: string;
  senderId: string;
  content: string;
  timestamp: string;
}

/**
 * Tier 2: Semantic boundary detection via LLM.
 *
 * Calls the configured semantic model (e.g. Haiku) with a focused prompt
 * to detect whether the conversation topic shifted in the recent message window.
 *
 * @see docs/foreground-sharding-architecture.md §5.2
 */
export async function detectTopicShift(
  messages: ShardMessage[],
  callLLM: ShardLLMFunction,
): Promise<TopicShiftResult> {
  if (messages.length < 3) {
    return { shifted: false };
  }

  const formatted = messages
    .map((m) => `[${m.id}] ${m.role === "assistant" ? "Cortex" : m.senderId}: ${m.content.slice(0, 300)}`)
    .join("\n");

  const prompt = `Given these recent messages from a conversation, did the primary task or topic shift significantly?

Messages:
${formatted}

If yes: respond with EXACTLY this JSON format:
{"shifted": true, "splitAtId": <message ID where the new topic begins>, "oldTopic": "<3-5 word label for the old topic>", "newTopic": "<3-5 word label for the new topic>"}

If no: respond with EXACTLY:
{"shifted": false}

Rules:
- Do NOT split on minor tangents that return to the main topic within 2-3 messages.
- Only detect SIGNIFICANT topic changes (e.g., moving from debugging one feature to implementing another).
- The splitAtId must be one of the message IDs shown in brackets.
- Topic labels should be 3-5 words, descriptive but concise.
- Respond with ONLY the JSON, no other text.`;

  try {
    const response = await callLLM(prompt);
    const cleaned = response.trim().replace(/```json\s*|\s*```/g, "");
    const parsed = JSON.parse(cleaned) as TopicShiftResult;

    if (parsed.shifted && parsed.splitAtId != null) {
      // Validate that splitAtId is actually one of the message IDs
      const validIds = new Set(messages.map((m) => m.id));
      if (!validIds.has(parsed.splitAtId)) {
        return { shifted: false };
      }
    }

    return {
      shifted: parsed.shifted === true,
      splitAtId: parsed.splitAtId,
      oldTopic: parsed.oldTopic,
      newTopic: parsed.newTopic,
    };
  } catch {
    // LLM call failed or parse error — don't break the loop
    return { shifted: false };
  }
}

/**
 * Async topic labeling for heuristic-closed shards.
 *
 * When Tier 1A/1B closes a shard, it has the default "Continued conversation" topic.
 * This fires an async LLM call to generate a meaningful 3-5 word label and updates the shard.
 *
 * Non-blocking — does not affect the Cortex loop.
 */
export async function labelShardAsync(
  db: DatabaseSync,
  shardId: string,
  callLLM: ShardLLMFunction,
): Promise<string> {
  const messages = getShardMessages(db, shardId);
  if (messages.length === 0) return "Empty conversation";

  // Build a summary of the shard's messages (truncate for cost)
  const formatted = messages
    .slice(-20) // Last 20 messages max
    .map((m) => `${m.role === "assistant" ? "Cortex" : m.senderId}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const prompt = `Summarize the main topic of these conversation messages in 3-5 words. Respond with ONLY the topic label, no other text.

Messages:
${formatted}

Topic label:`;

  try {
    const label = (await callLLM(prompt)).trim().replace(/^["']|["']$/g, "");
    const finalLabel = label.slice(0, 80) || "Continued conversation";
    updateShardTopic(db, shardId, finalLabel);
    return finalLabel;
  } catch {
    return "Continued conversation";
  }
}

/**
 * Apply a detected topic shift: close the current shard at the split point,
 * reassign messages after the split to a new shard.
 */
export function applyTopicShift(
  db: DatabaseSync,
  channel: string,
  shardId: string,
  splitAtId: number,
  oldTopic: string,
  newTopic: string,
): string {
  // Get all messages in the current shard
  const messages = getShardMessages(db, shardId);
  const splitIdx = messages.findIndex((m) => m.id === splitAtId);
  if (splitIdx <= 0) return shardId; // Can't split at first message or not found

  // Messages before split stay in old shard
  const lastOldMsg = messages[splitIdx - 1];
  updateShardTopic(db, shardId, oldTopic);
  closeShard(db, shardId, lastOldMsg.id, lastOldMsg.timestamp);

  // Create new shard for messages from split point onward
  const firstNewMsg = messages[splitIdx];
  const newShard = createShard(db, channel, firstNewMsg.id, firstNewMsg.timestamp, newTopic);

  // Reassign messages from split point onward to the new shard
  let tokenTotal = 0;
  for (let i = splitIdx; i < messages.length; i++) {
    assignMessageToShard(db, messages[i].id, newShard.id);
    tokenTotal += estimateTokens(messages[i].content);
  }

  // Update new shard tail
  const lastNewMsg = messages[messages.length - 1];
  db.prepare(`
    UPDATE cortex_shards
    SET last_message_id = ?, token_count = ?, message_count = ?
    WHERE id = ?
  `).run(lastNewMsg.id, tokenTotal, messages.length - splitIdx, newShard.id);

  return newShard.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the timestamp of the last message in a shard. */
function getLastMessageTimestamp(db: DatabaseSync, shardId: string): string | null {
  const row = db.prepare(`
    SELECT timestamp FROM cortex_session
    WHERE shard_id = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `).get(shardId) as { timestamp: string } | undefined;

  return row?.timestamp ?? null;
}

function rowToShard(row: Record<string, unknown>): Shard {
  return {
    id: row.id as string,
    channel: row.channel as string,
    topic: row.topic as string,
    firstMessageId: row.first_message_id as number,
    lastMessageId: row.last_message_id as number,
    tokenCount: row.token_count as number,
    messageCount: row.message_count as number,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? null,
    createdAt: row.created_at as string,
    createdBy: row.created_by as Shard["createdBy"],
  };
}
