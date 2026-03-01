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
  /** Cognitive owner — filters foreground + pending ops by issuer instead of channel */
  issuer?: string;
}): Promise<AssembledContext> {
  const { db, triggerEnvelope, workspaceDir, maxTokens, hippocampusEnabled, issuer } = params;

  // Load hot facts when hippocampus is enabled
  let hotFacts: HotFact[] | undefined;
  if (hippocampusEnabled) {
    const { getTopHotFacts } = await import("./hippocampus.js");
    hotFacts = getTopHotFacts(db, 50);
  }

  // 1. System floor — always loaded first
  const systemFloor = await loadSystemFloor(workspaceDir, hotFacts);

  // 2. Background summaries — small fixed cost
  const background = buildBackground(db, triggerEnvelope.channel, {
    idleCutoff: hippocampusEnabled === true,
  });

  // 3. Foreground — gets remaining budget
  //    When issuer is provided, filter by issuer (cross-channel) instead of channel
  const remainingBudget = Math.max(0, maxTokens - systemFloor.tokens - background.tokens);
  const { layer: foreground, messages: foregroundMessages } = issuer
    ? buildForeground(db, issuer, remainingBudget)
    : buildForeground(db, triggerEnvelope.channel, remainingBudget, { filterByChannel: true });

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
  const prefix = msg.role === "assistant" ? "Cortex" : `[${msg.channel}] ${msg.senderId}`;
  return `${prefix}: ${msg.content}`;
}
