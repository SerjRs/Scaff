/**
 * Channel Adapter Interface
 *
 * Adapters are dumb pipes — they translate between channel-specific formats
 * and the Cortex envelope. No state, no context, no intelligence.
 *
 * @see docs/cortex-architecture.md §3.2
 */

import {
  classifyRelationship,
  type ChannelId,
  type CortexEnvelope,
  type OutputTarget,
  type Sender,
  type SenderRelationship,
} from "./types.js";

// ---------------------------------------------------------------------------
// Channel Adapter
// ---------------------------------------------------------------------------

/** Interface that all channel adapters must implement */
export interface ChannelAdapter {
  /** The channel this adapter handles */
  readonly channelId: ChannelId;

  /**
   * Convert a channel-specific inbound message to a Cortex envelope.
   * @param raw - The raw message from the channel (format varies per channel)
   * @param senderResolver - Resolves sender identity from channel-specific data
   */
  toEnvelope(raw: unknown, senderResolver: SenderResolver): CortexEnvelope;

  /**
   * Send a Cortex output to the channel.
   * @param target - What to send and where
   */
  send(target: OutputTarget): Promise<void>;

  /** Check if the adapter's channel is connected and available */
  isAvailable(): boolean;
}

// ---------------------------------------------------------------------------
// Sender Resolver
// ---------------------------------------------------------------------------

/**
 * Resolves sender identity from channel-specific data.
 * Uses the partner ID map to determine if a sender is the partner (owner).
 */
export interface SenderResolver {
  /** Resolve a raw sender ID on a given channel to a full Sender object */
  resolve(channelId: ChannelId, rawSenderId: string, displayName?: string): Sender;
}

/**
 * Create a SenderResolver from a map of partner IDs per channel.
 * @param partnerIds - Map of channelId → partner's sender ID on that channel
 */
export function createSenderResolver(partnerIds: Map<ChannelId, string>): SenderResolver {
  return {
    resolve(channelId: ChannelId, rawSenderId: string, displayName?: string): Sender {
      const relationship = classifyRelationship(channelId, rawSenderId, partnerIds);

      return {
        id: rawSenderId,
        name: displayName ?? deriveDisplayName(relationship, rawSenderId),
        relationship,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter Registry
// ---------------------------------------------------------------------------

/** Registry for looking up channel adapters by channelId */
export interface AdapterRegistry {
  /** Register an adapter (overwrites if channelId already registered) */
  register(adapter: ChannelAdapter): void;

  /** Get adapter by channel ID, or undefined if not registered */
  get(channelId: ChannelId): ChannelAdapter | undefined;

  /** List all registered adapters */
  list(): ChannelAdapter[];
}

/** Create a new adapter registry */
export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<ChannelId, ChannelAdapter>();

  return {
    register(adapter: ChannelAdapter): void {
      adapters.set(adapter.channelId, adapter);
    },

    get(channelId: ChannelId): ChannelAdapter | undefined {
      return adapters.get(channelId);
    },

    list(): ChannelAdapter[] {
      return Array.from(adapters.values());
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveDisplayName(relationship: SenderRelationship, rawId: string): string {
  switch (relationship) {
    case "partner":
      return "Partner";
    case "system":
      return "System";
    case "internal": {
      // "router:job-42" → "Router"
      const prefix = rawId.split(":")[0];
      return prefix ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : "Internal";
    }
    case "external":
      return rawId;
    default:
      return rawId;
  }
}
