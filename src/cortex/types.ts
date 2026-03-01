/**
 * Cortex Types & Envelope Schema
 *
 * Core type definitions for the Cortex unified-brain architecture.
 * Every message entering Cortex is wrapped in a CortexEnvelope.
 * Channels are dumb pipes; all intelligence lives here.
 *
 * @see docs/cortex-architecture.md
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Sender relationship — partner is the owner (Serj), everything else by origin */
export type SenderRelationship = "partner" | "internal" | "external" | "system";

/** Message priority — determines processing order in the bus */
export type MessagePriority = "urgent" | "normal" | "background";

/** Numeric priority for SQLite ordering (lower = higher priority) */
export const PRIORITY_ORDER: Record<MessagePriority, number> = {
  urgent: 0,
  normal: 1,
  background: 2,
} as const;

/** Channel identifier — known channels + extensible string */
export type ChannelId =
  | "whatsapp"
  | "webchat"
  | "telegram"
  | "discord"
  | "signal"
  | "router"
  | "subagent"
  | "cron"
  | "email"
  | (string & {});

/** Internal channels (Router, sub-agent, cron) */
export const INTERNAL_CHANNELS = new Set<string>(["router", "subagent", "cron"]);

/** System channels (automated triggers) */
export const SYSTEM_CHANNELS = new Set<string>(["cron"]);

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

/** Metadata about who sent a message */
export interface Sender {
  /** Unique identifier: "serj", "router:job-123", "subagent:rt05", "system" */
  id: string;
  /** Display name: "Serj", "Router", "Heartbeat" */
  name: string;
  /** Relationship to Cortex */
  relationship: SenderRelationship;
}

// ---------------------------------------------------------------------------
// Reply Context
// ---------------------------------------------------------------------------

/** Where to send a reply */
export interface ReplyContext {
  /** Target channel for the reply */
  channel: ChannelId;
  /** Thread ID for threaded channels (Discord threads, Telegram topics) */
  threadId?: string;
  /** Message ID to reply to (for reply-quoting) */
  messageId?: string;
  /** Account ID for multi-account channels (e.g. WhatsApp business vs personal) */
  accountId?: string;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** Attachment types */
export type AttachmentType = "image" | "audio" | "video" | "file";

/** Media attachment on a message */
export interface Attachment {
  type: AttachmentType;
  url?: string;
  path?: string;
  mimeType?: string;
  caption?: string;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** The envelope — wraps every message entering Cortex */
export interface CortexEnvelope {
  /** Unique message ID (UUID) */
  id: string;
  /** Source channel */
  channel: ChannelId;
  /** Who sent it */
  sender: Sender;
  /** When it was sent (ISO 8601) */
  timestamp: string;
  /** Where to send a reply */
  replyContext: ReplyContext;
  /** Message content (text) */
  content: string;
  /** Processing priority */
  priority: MessagePriority;
  /** Optional media attachments */
  attachments?: Attachment[];
  /** Channel-specific metadata (flexible) */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Bus Message
// ---------------------------------------------------------------------------

/** States a message can be in within the bus */
export type BusMessageState = "pending" | "processing" | "completed" | "failed";

/** Valid state transitions */
export const VALID_STATE_TRANSITIONS: Record<BusMessageState, BusMessageState[]> = {
  pending: ["processing"],
  processing: ["completed", "failed"],
  completed: [],
  failed: ["pending"], // retry: failed → pending
} as const;

/** A message stored in the bus (envelope + tracking state) */
export interface BusMessage {
  envelope: CortexEnvelope;
  state: BusMessageState;
  enqueuedAt: string;
  processedAt?: string;
  attempts: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** A single output target — where and what to send */
export interface OutputTarget {
  /** Target channel */
  channel: ChannelId;
  /** Content to send */
  content: string;
  /** Message ID to reply to */
  replyTo?: string;
  /** Thread ID */
  threadId?: string;
  /** Account ID */
  accountId?: string;
  /** Optional attachments */
  attachments?: Attachment[];
}

/** Memory action — internal side-effect of processing a message */
export type MemoryAction =
  | { type: "log"; content: string }
  | { type: "update_file"; path: string; content: string };

/** What Cortex decides to do after processing a message */
export interface CortexOutput {
  /** Zero or more output targets (empty = silence) */
  targets: OutputTarget[];
  /** Optional memory side-effects */
  memoryActions?: MemoryAction[];
}

// ---------------------------------------------------------------------------
// Channel State
// ---------------------------------------------------------------------------

/** Which attention layer a channel is in */
export type AttentionLayer = "foreground" | "background" | "archived";

/** Snapshot of a channel's state (for context budgeting) */
export interface ChannelState {
  channel: ChannelId;
  lastMessageAt: string;
  unreadCount: number;
  summary?: string;
  layer: AttentionLayer;
}

// ---------------------------------------------------------------------------
// Pending Operations
// ---------------------------------------------------------------------------

/** Types of operations Cortex can have in flight */
export type PendingOpType = "router_job" | "subagent" | "cron_task";

/** Lifecycle status: pending → completed/failed → [LLM sees it] → copy to cortex_session + DELETE */
export type PendingOpStatus = "pending" | "completed" | "failed";

/** An operation Cortex dispatched and is awaiting */
export interface PendingOperation {
  id: string;
  type: PendingOpType;
  description: string;
  dispatchedAt: string;
  expectedChannel: ChannelId;
  /** Lifecycle status (default: "pending") */
  status: PendingOpStatus;
  /** When the result arrived */
  completedAt?: string;
  /** Result content from Router/sub-agent */
  result?: string;
  /** Channel to route results back to (e.g. "webchat") — stored locally, not sent to Router */
  replyChannel?: string;
  /** Priority for the result envelope — stored locally, not sent to Router */
  resultPriority?: "urgent" | "normal" | "background";
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

/** Data persisted at each checkpoint (after every completed turn) */
export interface CheckpointData {
  id?: number;
  createdAt: string;
  /** Compressed session summary (not full history) */
  sessionSnapshot: string;
  /** All channel states */
  channelStates: ChannelState[];
  /** Operations in flight */
  pendingOps: PendingOperation[];
}

// ---------------------------------------------------------------------------
// Cortex Mode (safety architecture)
// ---------------------------------------------------------------------------

/** Operating mode — off/shadow/live per the safety architecture */
export type CortexMode = "off" | "shadow" | "live";

/** Hippocampus memory subsystem configuration */
export interface HippocampusConfig {
  enabled: boolean;
}

/** Per-channel mode configuration */
export interface CortexModeConfig {
  enabled: boolean;
  defaultMode: CortexMode;
  channels: Partial<Record<string, CortexMode>>;
  hippocampus?: HippocampusConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a CortexEnvelope with defaults */
export function createEnvelope(
  params: Pick<CortexEnvelope, "channel" | "sender" | "content"> &
    Partial<Omit<CortexEnvelope, "channel" | "sender" | "content">>,
): CortexEnvelope {
  return {
    id: params.id ?? randomUUID(),
    channel: params.channel,
    sender: params.sender,
    timestamp: params.timestamp ?? new Date().toISOString(),
    replyContext: params.replyContext ?? { channel: params.channel },
    content: params.content,
    priority: params.priority ?? "normal",
    attachments: params.attachments,
    metadata: params.metadata,
  };
}

/** Check if a state transition is valid */
export function isValidTransition(from: BusMessageState, to: BusMessageState): boolean {
  return VALID_STATE_TRANSITIONS[from].includes(to);
}

/** Classify a sender based on channel type */
export function classifyRelationship(
  channelId: ChannelId,
  senderId: string,
  partnerIds: Map<ChannelId, string>,
): SenderRelationship {
  // Check if this sender is the partner on this channel
  if (partnerIds.get(channelId) === senderId) {
    return "partner";
  }
  // System channels
  if (SYSTEM_CHANNELS.has(channelId)) {
    return "system";
  }
  // Internal channels
  if (INTERNAL_CHANNELS.has(channelId)) {
    return "internal";
  }
  // Everything else is external
  return "external";
}

/** Compare priorities: returns negative if a is higher priority than b */
export function comparePriority(a: MessagePriority, b: MessagePriority): number {
  return PRIORITY_ORDER[a] - PRIORITY_ORDER[b];
}
