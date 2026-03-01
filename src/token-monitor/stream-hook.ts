/**
 * Token ledger hook — extracts usage after each agent run and feeds
 * it into the in-memory ledger.
 *
 * Two entry points:
 * 1. `recordUsage(messages)` — scans message history for assistant usage (attempt.ts)
 * 2. `recordFromRunResult(usage, agentId, model)` — direct usage from agent runner (agent-runner.ts)
 *
 * Both use `normalizeUsage()` to handle all provider field name variants.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { normalizeUsage, type UsageLike } from "../agents/usage.js";
import { record, type TokenLedgerEvent } from "./ledger.js";

export type TokenLedgerHook = {
  recordUsage: (messages: AgentMessage[]) => void;
};

export function createTokenLedgerHook(params: {
  agentId: string;
  modelId: string;
}): TokenLedgerHook {
  const { agentId, modelId } = params;

  const recordUsage = (messages: AgentMessage[]) => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i] as { role?: unknown; usage?: unknown };
      if (msg?.role === "assistant" && msg.usage && typeof msg.usage === "object") {
        const normalized = normalizeUsage(msg.usage as UsageLike);
        if (!normalized) break;
        const event: TokenLedgerEvent = {
          agentId,
          model: modelId,
          tokensIn: normalized.input ?? 0,
          tokensOut: normalized.output ?? 0,
          cached: normalized.cacheRead ?? 0,
        };
        record(event);
        return;
      }
    }
  };

  return { recordUsage };
}

/**
 * Record usage directly from a run result (agent-runner.ts post-run hook).
 * This is the most reliable hook — it fires after every agent run regardless
 * of provider, and the usage object is already available.
 */
export function recordRunResultUsage(params: {
  usage: unknown;
  agentId: string;
  model: string;
}): void {
  if (!params.usage || typeof params.usage !== "object") return;
  const normalized = normalizeUsage(params.usage as UsageLike);
  if (!normalized) return;
  record({
    agentId: params.agentId,
    model: params.model,
    tokensIn: normalized.input ?? 0,
    tokensOut: normalized.output ?? 0,
    cached: normalized.cacheRead ?? 0,
  });
}
