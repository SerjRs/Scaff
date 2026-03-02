/**
 * Cortex Shadow Mode
 *
 * Observation layer: Cortex receives copies of messages without affecting
 * the existing system. Allows validation before going live.
 *
 * Modes per channel:
 * - off: Cortex not involved, existing system only
 * - shadow: Cortex observes (processes silently), existing system responds
 * - live: Cortex handles everything, existing system skipped
 *
 * @see docs/cortex-architecture.md (Safety Architecture)
 */

import type { ChannelId, CortexEnvelope, CortexMode, CortexModeConfig, CortexOutput, OutputTarget } from "./types.js";
import type { CortexInstance } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShadowHook {
  /** Feed a copy of a message to Cortex (shadow mode — no output sent) */
  observe(envelope: CortexEnvelope): void;

  /** Get what Cortex decided for the last processed message */
  getLastDecision(): CortexOutput | null;

  /** Compare Cortex decision vs what the existing system actually did */
  audit(actualResponse: string, actualChannel: ChannelId): AuditResult;
}

export interface AuditResult {
  match: boolean;
  cortexTargets: OutputTarget[];
  actualChannel: ChannelId;
  diff?: string;
}

// ---------------------------------------------------------------------------
// Resolve channel mode
// ---------------------------------------------------------------------------

/** Resolve the effective mode for a given channel */
export function resolveChannelMode(
  config: CortexModeConfig | undefined | null,
  channel: ChannelId,
): CortexMode {
  if (!config || !config.enabled) return "off";

  // Per-channel override takes precedence
  const channelMode = config.channels[channel];
  if (channelMode) return channelMode;

  // Fall back to default mode
  return config.defaultMode ?? "off";
}

// ---------------------------------------------------------------------------
// Shadow Hook
// ---------------------------------------------------------------------------

/**
 * Create a shadow hook that wraps a CortexInstance.
 * In shadow mode, messages are enqueued into Cortex but the output router
 * is replaced with a no-op — nothing gets sent to any channel.
 */
export function createShadowHook(cortex: CortexInstance): ShadowHook {
  let lastDecision: CortexOutput | null = null;

  // Intercept: we need to track decisions without sending
  // The shadow hook enqueues into the real Cortex bus
  // The LLM will process it, but since we're in shadow mode,
  // the gateway integration ensures no sends happen

  return {
    observe(envelope: CortexEnvelope): void {
      // Enqueue into Cortex — it will process normally in the loop
      // But the gateway integration (Task 15) ensures shadow mode
      // channels have their adapters replaced with no-op loggers
      cortex.enqueue(envelope);
    },

    getLastDecision(): CortexOutput | null {
      return lastDecision;
    },

    audit(actualResponse: string, actualChannel: ChannelId): AuditResult {
      const cortexTargets = lastDecision?.targets ?? [];

      // Check if Cortex would have sent to the same channel with the same content
      const matchingTarget = cortexTargets.find(
        (t) => t.channel === actualChannel && t.content.trim() === actualResponse.trim(),
      );

      if (matchingTarget) {
        return { match: true, cortexTargets, actualChannel };
      }

      // Build diff description
      let diff: string;
      if (cortexTargets.length === 0) {
        diff = "Cortex would have been silent; existing system responded";
      } else {
        const cortexChannels = cortexTargets.map((t) => t.channel).join(", ");
        const cortexContent = cortexTargets.map((t) => t.content.slice(0, 100)).join(" | ");
        diff = `Cortex → [${cortexChannels}]: "${cortexContent}" vs Actual → [${actualChannel}]: "${actualResponse.slice(0, 100)}"`;
      }

      return { match: false, cortexTargets, actualChannel, diff };
    },
  };

  // Note: tracking lastDecision requires hooking into the loop's output.
  // For now, audit relies on inspecting the SQLite session table directly.
  // Full implementation wires this in Task 15 (Gateway Integration).
}
