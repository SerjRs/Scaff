/**
 * Cortex Output Router
 *
 * Routes Cortex's output decisions to the correct channel adapters.
 * Supports: reply-to-source, cross-channel, multi-channel, and silence.
 *
 * @see docs/cortex-architecture.md §5
 */

import type { AdapterRegistry } from "./channel-adapter.js";
import type { ChannelId, CortexEnvelope, CortexOutput, OutputTarget } from "./types.js";

// ---------------------------------------------------------------------------
// Route output
// ---------------------------------------------------------------------------

/** Route Cortex output through channel adapters */
export async function routeOutput(params: {
  output: CortexOutput;
  registry: AdapterRegistry;
  onError: (channel: ChannelId, error: Error) => void;
}): Promise<void> {
  const { output, registry, onError } = params;

  // Silence — no targets, nothing to do
  if (output.targets.length === 0) return;

  // Send to each target channel
  for (const target of output.targets) {
    const adapter = registry.get(target.channel);
    if (!adapter) {
      onError(target.channel, new Error(`No adapter registered for channel: ${target.channel}`));
      continue;
    }

    try {
      await adapter.send(target);
    } catch (err) {
      onError(target.channel, err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// ---------------------------------------------------------------------------
// Parse LLM response
// ---------------------------------------------------------------------------

/** Patterns for special responses */
const SILENT_RESPONSES = new Set(["NO_REPLY", "HEARTBEAT_OK"]);

/** Check if the LLM response indicates silence (no output) */
export function isSilentResponse(llmResponse: string): boolean {
  const trimmed = llmResponse.trim();
  return SILENT_RESPONSES.has(trimmed);
}

/**
 * Parse the LLM response into a CortexOutput.
 * - Default: reply to the source channel
 * - NO_REPLY/HEARTBEAT_OK → silence (empty targets)
 * - [[send_to:<channel>]] → cross-channel send
 * - [[reply_to_current]] → reply to source (standard)
 */
export function parseResponse(params: {
  llmResponse: string;
  triggerEnvelope: CortexEnvelope;
}): CortexOutput {
  const { llmResponse, triggerEnvelope } = params;

  // Check for silence
  if (isSilentResponse(llmResponse)) {
    return { targets: [] };
  }

  let content = llmResponse;
  const targets: OutputTarget[] = [];

  // Check for cross-channel directives: [[send_to:whatsapp]]
  const sendToPattern = /\[\[\s*send_to\s*:\s*(\w+)\s*\]\]/g;
  let hasCrossChannel = false;
  let match;

  while ((match = sendToPattern.exec(content)) !== null) {
    hasCrossChannel = true;
    const channel = match[1] as ChannelId;
    // Remove the directive from content
    content = content.replace(match[0], "").trim();
    targets.push({
      channel,
      content: content,
      replyTo: channel === triggerEnvelope.channel ? triggerEnvelope.replyContext.messageId : undefined,
      threadId: channel === triggerEnvelope.channel ? triggerEnvelope.replyContext.threadId : undefined,
    });
  }

  // Remove [[reply_to_current]] tag if present
  content = content.replace(/\[\[\s*reply_to_current\s*\]\]\s*/g, "").trim();

  // Default: reply to source channel (if no cross-channel directives added it already)
  if (!hasCrossChannel) {
    targets.push({
      channel: triggerEnvelope.replyContext.channel,
      content,
      replyTo: triggerEnvelope.replyContext.messageId,
      threadId: triggerEnvelope.replyContext.threadId,
      accountId: triggerEnvelope.replyContext.accountId,
    });
  }

  return { targets };
}
