/**
 * Internal Channel Adapters — Router, Sub-agent, Cron
 *
 * These adapters handle internal Cortex I/O:
 * - Router: job dispatch + result delivery
 * - Sub-agent: spawn + completion
 * - Cron/Heartbeat: system triggers
 */

import type { ChannelAdapter, SenderResolver } from "../channel-adapter.js";
import { createEnvelope, type CortexEnvelope, type OutputTarget } from "../types.js";

// ---------------------------------------------------------------------------
// Raw message shapes
// ---------------------------------------------------------------------------

export interface RouterRawMessage {
  jobId: string;
  content: string;
  tier?: string;
  model?: string;
  executionMs?: number;
  isAwaited?: boolean;
}

export interface SubagentRawMessage {
  label: string;
  content: string;
  status: "completed" | "failed";
  error?: string;
}

export interface CronRawMessage {
  trigger: "heartbeat" | "scheduled";
  cronId?: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Router Adapter
// ---------------------------------------------------------------------------

export class RouterAdapter implements ChannelAdapter {
  readonly channelId = "router" as const;

  private dispatchFn: (target: OutputTarget) => Promise<void>;

  constructor(dispatchFn: (target: OutputTarget) => Promise<void>) {
    this.dispatchFn = dispatchFn;
  }

  toEnvelope(raw: unknown, senderResolver: SenderResolver): CortexEnvelope {
    const msg = raw as RouterRawMessage;
    const sender = senderResolver.resolve("router", `router:${msg.jobId}`);

    return createEnvelope({
      channel: "router",
      sender,
      content: msg.content,
      priority: msg.isAwaited ? "urgent" : "normal",
      metadata: {
        jobId: msg.jobId,
        tier: msg.tier,
        model: msg.model,
        executionMs: msg.executionMs,
      },
    });
  }

  async send(target: OutputTarget): Promise<void> {
    await this.dispatchFn(target);
  }

  isAvailable(): boolean {
    return true; // Internal — always available
  }
}

// ---------------------------------------------------------------------------
// Sub-agent Adapter
// ---------------------------------------------------------------------------

export class SubagentAdapter implements ChannelAdapter {
  readonly channelId = "subagent" as const;

  private spawnFn: (target: OutputTarget) => Promise<void>;

  constructor(spawnFn: (target: OutputTarget) => Promise<void>) {
    this.spawnFn = spawnFn;
  }

  toEnvelope(raw: unknown, senderResolver: SenderResolver): CortexEnvelope {
    const msg = raw as SubagentRawMessage;
    const sender = senderResolver.resolve("subagent", `subagent:${msg.label}`);

    return createEnvelope({
      channel: "subagent",
      sender,
      content: msg.content,
      metadata: {
        label: msg.label,
        status: msg.status,
        error: msg.error,
      },
    });
  }

  async send(target: OutputTarget): Promise<void> {
    await this.spawnFn(target);
  }

  isAvailable(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Cron Adapter
// ---------------------------------------------------------------------------

export class CronAdapter implements ChannelAdapter {
  readonly channelId = "cron" as const;

  toEnvelope(raw: unknown, senderResolver: SenderResolver): CortexEnvelope {
    const msg = raw as CronRawMessage;
    const sender = senderResolver.resolve("cron", msg.trigger);

    return createEnvelope({
      channel: "cron",
      sender,
      content: msg.content,
      priority: "background",
      metadata: {
        trigger: msg.trigger,
        cronId: msg.cronId,
      },
    });
  }

  async send(_target: OutputTarget): Promise<void> {
    // Cron is inbound-only — no outbound sends
  }

  isAvailable(): boolean {
    return true;
  }
}
