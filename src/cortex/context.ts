/**
 * Cortex Context Manager
 *
 * Assembles the 4-layer context for each LLM call:
 * 1. System floor — identity, memory, workspace (always loaded)
 * 2. Foreground — active channel conversation (demand-based)
 * 3. Background — other channels (compressed summaries)
 * 4. Archived — inactive channels (not in context)
 *
 * @see docs/cortex-architecture.md §4, §10
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { HotFact } from "./hippocampus.js";
import { getChannelStates, getSessionHistory, type SessionMessage } from "./session.js";
import { getActiveShard, getAllActiveShards, getClosedShards, getShardMessages, type Shard, type ForegroundConfig, type ShardFilter } from "./shards.js";
import type { ChannelId, CortexEnvelope } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextLayer {
  name: "system_floor" | "foreground" | "background" | "archived";
  tokens: number;
  content: string;
}

/** Tool result entry for sync tool round-trips */
export interface ToolResultEntry {
  toolCallId: string;
  toolName: string;
  content: string;
}

export interface AssembledContext {
  layers: ContextLayer[];
  totalTokens: number;
  foregroundChannel: ChannelId;
  /** Structured foreground messages — used by contextToMessages() to avoid lossy text round-trip */
  foregroundMessages: SessionMessage[];
  backgroundSummaries: Map<ChannelId, string>;
  /** Whether Hippocampus memory subsystem is active */
  hippocampusEnabled?: boolean;
  /** Whether this is an ops trigger turn — suppress sessions_spawn tool to prevent re-dispatch */
  isOpsTrigger?: boolean;
  /** For sync tool round-trips: previous LLM response + tool results */
  toolRoundTrip?: {
    previousContent: unknown[];
    toolResults: ToolResultEntry[];
  };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Rough token estimate: ~4 chars per token (conservative).
 * Good enough for budgeting — exact tokenization is model-specific.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// System Floor
// ---------------------------------------------------------------------------

/** Files to load for system floor, in order */
const SYSTEM_FLOOR_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
];

/** Load system floor: identity + memory + workspace context + hot facts */
export async function loadSystemFloor(
  workspaceDir: string,
  hotFacts?: HotFact[],
): Promise<ContextLayer> {
  const sections: string[] = [];

  // Load workspace files
  for (const file of SYSTEM_FLOOR_FILES) {
    const filePath = path.join(workspaceDir, file);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (content) {
          sections.push(`## ${file}\n${content}`);
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Add hot memory facts (Hippocampus Layer 1)
  if (hotFacts && hotFacts.length > 0) {
    const factsText = hotFacts
      .map((f) => `- ${f.factText}`)
      .join("\n");
    sections.push(`## Known Facts\n${factsText}`);
  }

  const content = sections.join("\n\n---\n\n");
  return {
    name: "system_floor",
    tokens: estimateTokens(content),
    content,
  };
}

// ---------------------------------------------------------------------------
// Foreground
// ---------------------------------------------------------------------------

/** Build foreground context from the issuer's session history (cross-channel) */
export function buildForeground(
  db: DatabaseSync,
  issuer: string,
  budget: number,
  opts?: { filterByChannel?: boolean },
): { layer: ContextLayer; messages: SessionMessage[] } {
  // When filterByChannel is set, use channel filter (legacy/fallback). Otherwise filter by issuer.
  const allMessages = opts?.filterByChannel
    ? getSessionHistory(db, { channel: issuer as ChannelId })
    : getSessionHistory(db, { issuer });

  // Build content from oldest to newest, respecting budget
  const lines: string[] = [];
  let totalTokens = 0;

  // Start from the end (most recent) and work backward to find how many fit
  const messagesToInclude: typeof allMessages = [];
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    const line = formatSessionMessage(msg);
    const lineTokens = estimateTokens(line);
    if (totalTokens + lineTokens > budget) break;
    totalTokens += lineTokens;
    messagesToInclude.unshift(msg);
  }

  for (const msg of messagesToInclude) {
    lines.push(formatSessionMessage(msg));
  }

  const content = lines.join("\n");
  return {
    layer: {
      name: "foreground",
      tokens: estimateTokens(content),
      content,
    },
    messages: messagesToInclude,
  };
}

// ---------------------------------------------------------------------------
// Shard-Based Foreground Assembly
// ---------------------------------------------------------------------------

/**
 * Build foreground context using shard-based token budgeting.
 *
 * Algorithm (§4.2 of foreground-sharding-architecture.md):
 * 1. Active shard is always included (even if it alone exceeds the cap)
 * 2. Walk backward through closed shards, include while within budget
 * 3. Stop when next shard would exceed cap × (1 + tolerance)
 *
 * Returns messages in chronological order with shard separators.
 */
export function buildShardedForeground(
  db: DatabaseSync,
  config: ForegroundConfig,
  opts: { channel?: string; issuer?: string },
): { layer: ContextLayer; messages: SessionMessage[] } {
  const ceiling = config.tokenCap * (1 + config.tolerancePct / 100);
  let runningTotal = 0;

  // Resolve filter: issuer takes precedence (cross-channel unified context)
  const filter: string | ShardFilter = opts.issuer
    ? { issuer: opts.issuer }
    : (opts.channel ?? "");

  // Collect shards to include (newest first, then reversed for chronological output)
  const includedShards: { shard: Shard | null; messages: ReturnType<typeof getShardMessages>; isActive: boolean }[] = [];

  // 1. Active shard(s) — always included
  // When filtering by issuer, there may be multiple active shards from different channels
  // (legacy data from before unified context). Include all of them.
  const activeShards = getAllActiveShards(db, filter);
  for (const activeShard of activeShards) {
    const activeMessages = getShardMessages(db, activeShard.id);
    const activeTokens = activeMessages.reduce((sum, m) => sum + estimateTokens(formatShardMessage(m)), 0);
    runningTotal += activeTokens;
    includedShards.push({ shard: activeShard, messages: activeMessages, isActive: true });
  }

  // Also include unsharded messages (tail messages not yet assigned to any shard)
  const unshardedMessages = getUnshardedMessages(db, opts);
  if (unshardedMessages.length > 0) {
    const unshardedTokens = unshardedMessages.reduce((sum, m) => sum + estimateTokens(formatShardMessage(m)), 0);
    runningTotal += unshardedTokens;
    includedShards.push({ shard: null, messages: unshardedMessages, isActive: true });
  }

  // 2. Walk backward through closed shards
  const closedShards = getClosedShards(db, filter);
  for (const shard of closedShards) {
    if (runningTotal + shard.tokenCount <= ceiling) {
      const messages = getShardMessages(db, shard.id);
      runningTotal += shard.tokenCount;
      includedShards.push({ shard, messages, isActive: false });
    } else {
      break; // Stop — this shard and all older ones are excluded
    }
  }

  // 3. Reverse to chronological order (we built newest-first)
  includedShards.reverse();

  // 4. Build output with shard separators
  const lines: string[] = [];
  const allMessages: SessionMessage[] = [];
  const now = Date.now();

  for (const { shard, messages, isActive } of includedShards) {
    // Add separator for closed shards with topic labels
    if (shard && !isActive) {
      const timeAgo = formatTimeAgo(now, shard.endedAt ?? shard.startedAt);
      // Show distinct channels for cross-channel shards
      const distinctChannels = [...new Set(messages.map((m) => m.channel))];
      const channelInfo = distinctChannels.length > 1 ? ` | via ${distinctChannels.join(", ")}` : "";
      lines.push(`--- [Topic: ${shard.topic}${channelInfo} | ${timeAgo} | ${shard.messageCount} messages] ---`);
    }

    for (const msg of messages) {
      lines.push(formatShardMessage(msg));
      allMessages.push({
        id: msg.id,
        envelopeId: "",
        role: msg.role as "user" | "assistant",
        channel: msg.channel as ChannelId,
        senderId: msg.senderId,
        content: msg.content,
        timestamp: msg.timestamp,
      });
    }
  }

  const content = lines.join("\n");
  return {
    layer: {
      name: "foreground",
      tokens: estimateTokens(content),
      content,
    },
    messages: allMessages,
  };
}

/**
 * Get recent messages that have no shard_id assigned (tail messages not yet sharded).
 * Only returns messages AFTER the last shard's last_message_id to avoid pulling in
 * the entire pre-sharding history. Filters by issuer when provided, otherwise by channel.
 */
function getUnshardedMessages(
  db: DatabaseSync,
  opts: { channel?: string; issuer?: string },
): { id: number; content: string; timestamp: string; role: string; channel: string; senderId: string }[] {
  const filterCol = opts.issuer ? "issuer" : "channel";
  const filterVal = opts.issuer ?? opts.channel ?? "";

  // Find the highest message ID assigned to any shard — only return unsharded messages after that.
  // This prevents dumping the entire pre-sharding history (~1000s of messages) into the foreground.
  const shardFilterCol = opts.issuer ? "issuer" : "channel";
  const lastShardedRow = db.prepare(`
    SELECT MAX(last_message_id) as last_id
    FROM cortex_shards
    WHERE ${shardFilterCol} = ?
  `).get(filterVal) as { last_id: number | null } | undefined;
  const afterId = lastShardedRow?.last_id ?? 0;

  const rows = db.prepare(`
    SELECT id, content, timestamp, role, channel, sender_id
    FROM cortex_session
    WHERE ${filterCol} = ? AND shard_id IS NULL AND id > ?
    ORDER BY timestamp ASC, id ASC
  `).all(filterVal, afterId) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as number,
    content: r.content as string,
    timestamp: r.timestamp as string,
    role: r.role as string,
    channel: r.channel as string,
    senderId: r.sender_id as string,
  }));
}

function formatShardMessage(msg: { role: string; channel: string; senderId: string; content: string }): string {
  const prefix = msg.role === "assistant" ? `Cortex → [${msg.channel}]` : `[${msg.channel}] ${msg.senderId}`;
  return `${prefix}: ${msg.content}`;
}

function formatTimeAgo(now: number, timestamp: string): string {
  const diffMs = now - new Date(timestamp).getTime();
  const diffMin = Math.floor(diffMs / (1000 * 60));
  if (diffMin < 60) return `~${diffMin}min ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `~${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `~${diffDays}d ago`;
}

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

/** Max idle hours before a background channel is excluded (Hippocampus mode) */
export const BACKGROUND_MAX_IDLE_HOURS = 24;

/** Compress other channels into one-line summaries */
export function buildBackground(
  db: DatabaseSync,
  excludeChannel: ChannelId,
  opts?: { idleCutoff?: boolean },
): ContextLayer {
  const states = getChannelStates(db);
  const lines: string[] = [];
  const now = Date.now();

  for (const state of states) {
    if (state.channel === excludeChannel) continue;
    if (state.layer === "archived") continue;

    // When hippocampus idle cutoff is active, exclude channels idle >24h
    if (opts?.idleCutoff) {
      const lastMsg = new Date(state.lastMessageAt).getTime();
      const idleMs = now - lastMsg;
      if (idleMs > BACKGROUND_MAX_IDLE_HOURS * 60 * 60 * 1000) continue;
    }

    const summary = state.summary ?? `${state.unreadCount} unread messages`;
    lines.push(`[${state.channel}] ${summary} (last: ${state.lastMessageAt})`);
  }

  const content = lines.length > 0
    ? `## Other Channels\n${lines.join("\n")}`
    : "";

  return {
    name: "background",
    tokens: estimateTokens(content),
    content,
  };
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

/** Assemble the full 4-layer context for an LLM call */
export async function assembleContext(params: {
  db: DatabaseSync;
  triggerEnvelope: CortexEnvelope;
  workspaceDir: string;
  maxTokens: number;
  hippocampusEnabled?: boolean;
  /** Foreground sharding config — when set, uses shard-based context budgeting */
  foregroundConfig?: ForegroundConfig;
  /** Cognitive owner — filters foreground + pending ops by issuer instead of channel */
  issuer?: string;
}): Promise<AssembledContext> {
  const { db, triggerEnvelope, workspaceDir, maxTokens, hippocampusEnabled, foregroundConfig, issuer } = params;

  // Load hot facts when hippocampus is enabled
  let hotFacts: HotFact[] | undefined;
  if (hippocampusEnabled) {
    const { getTopHotFacts } = await import("./hippocampus.js");
    hotFacts = getTopHotFacts(db, 50);
  }

  // 1. System floor — always loaded first
  const systemFloor = await loadSystemFloor(workspaceDir, hotFacts);

  // 2. Background summaries — small fixed cost
  // When using issuer-based context, all channels are in the foreground — skip background
  const background = issuer
    ? { name: "background" as const, tokens: 0, content: "" }
    : buildBackground(db, triggerEnvelope.channel, {
        idleCutoff: hippocampusEnabled === true,
      });

  // 3. Foreground — shard-based or legacy
  let foreground: ContextLayer;
  let foregroundMessages: SessionMessage[];

  if (foregroundConfig) {
    // Shard-based foreground assembly — cuts at topic boundaries, respects token budget
    // When issuer is set, queries across all channels for unified context
    const result = buildShardedForeground(db, foregroundConfig, {
      channel: triggerEnvelope.channel,
      issuer,
    });
    foreground = result.layer;
    foregroundMessages = result.messages;
  } else {
    // Legacy: unbounded foreground with simple token budget
    const remainingBudget = Math.max(0, maxTokens - systemFloor.tokens - background.tokens);
    const result = issuer
      ? buildForeground(db, issuer, remainingBudget)
      : buildForeground(db, triggerEnvelope.channel, remainingBudget, { filterByChannel: true });
    foreground = result.layer;
    foregroundMessages = result.messages;
  }

  // 4. Archived — not in context (zero cost)
  const archived: ContextLayer = { name: "archived", tokens: 0, content: "" };

  // Build background summaries map
  const backgroundSummaries = new Map<ChannelId, string>();
  const states = getChannelStates(db);
  for (const state of states) {
    if (state.channel !== triggerEnvelope.channel && state.layer !== "archived") {
      backgroundSummaries.set(state.channel, state.summary ?? `${state.unreadCount} unread`);
    }
  }

  const layers = [systemFloor, foreground, background, archived];
  const totalTokens = layers.reduce((sum, l) => sum + l.tokens, 0);

  return {
    layers,
    totalTokens,
    foregroundChannel: triggerEnvelope.channel,
    foregroundMessages,
    backgroundSummaries,
    hippocampusEnabled: hippocampusEnabled === true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FormattableMessage {
  role: string;
  channel: string;
  senderId: string;
  content: string;
}

function formatSessionMessage(msg: FormattableMessage): string {
  const prefix = msg.role === "assistant" ? `Cortex → [${msg.channel}]` : `[${msg.channel}] ${msg.senderId}`;
  return `${prefix}: ${msg.content}`;
}
