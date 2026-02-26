import { describe, it, expect } from "vitest";
import {
  createEnvelope,
  isValidTransition,
  classifyRelationship,
  comparePriority,
  PRIORITY_ORDER,
  VALID_STATE_TRANSITIONS,
  INTERNAL_CHANNELS,
  SYSTEM_CHANNELS,
  type CortexEnvelope,
  type Sender,
  type BusMessage,
  type BusMessageState,
  type MessagePriority,
  type SenderRelationship,
  type AttentionLayer,
  type CortexMode,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers for tests
// ---------------------------------------------------------------------------

function makeSender(overrides: Partial<Sender> = {}): Sender {
  return {
    id: "serj",
    name: "Serj",
    relationship: "partner",
    ...overrides,
  };
}

function makePartnerIds(): Map<string, string> {
  return new Map([
    ["whatsapp", "+40751845717"],
    ["webchat", "webchat-user"],
    ["telegram", "serj-tg"],
  ]);
}

// ---------------------------------------------------------------------------
// createEnvelope
// ---------------------------------------------------------------------------

describe("createEnvelope", () => {
  it("creates envelope with all required fields", () => {
    const env = createEnvelope({
      channel: "webchat",
      sender: makeSender(),
      content: "Hello Cortex",
    });

    expect(env.id).toBeDefined();
    expect(env.id.length).toBeGreaterThan(0);
    expect(env.channel).toBe("webchat");
    expect(env.sender.id).toBe("serj");
    expect(env.sender.name).toBe("Serj");
    expect(env.sender.relationship).toBe("partner");
    expect(env.content).toBe("Hello Cortex");
    expect(env.timestamp).toBeDefined();
    expect(env.replyContext).toEqual({ channel: "webchat" });
    expect(env.priority).toBe("normal");
  });

  it("generates unique UUIDs for each envelope", () => {
    const a = createEnvelope({ channel: "webchat", sender: makeSender(), content: "a" });
    const b = createEnvelope({ channel: "webchat", sender: makeSender(), content: "b" });
    expect(a.id).not.toBe(b.id);
  });

  it("uses provided id when given", () => {
    const env = createEnvelope({
      id: "custom-id-123",
      channel: "webchat",
      sender: makeSender(),
      content: "test",
    });
    expect(env.id).toBe("custom-id-123");
  });

  it("uses provided timestamp when given", () => {
    const ts = "2026-02-26T14:00:00.000Z";
    const env = createEnvelope({
      channel: "webchat",
      sender: makeSender(),
      content: "test",
      timestamp: ts,
    });
    expect(env.timestamp).toBe(ts);
  });

  it("defaults replyContext to source channel", () => {
    const env = createEnvelope({
      channel: "whatsapp",
      sender: makeSender(),
      content: "test",
    });
    expect(env.replyContext.channel).toBe("whatsapp");
  });

  it("uses provided replyContext when given", () => {
    const env = createEnvelope({
      channel: "cron",
      sender: makeSender({ id: "system", relationship: "system" }),
      content: "heartbeat",
      replyContext: { channel: "whatsapp", threadId: "thread-1" },
    });
    expect(env.replyContext.channel).toBe("whatsapp");
    expect(env.replyContext.threadId).toBe("thread-1");
  });

  it("defaults priority to normal", () => {
    const env = createEnvelope({
      channel: "webchat",
      sender: makeSender(),
      content: "test",
    });
    expect(env.priority).toBe("normal");
  });

  it("uses provided priority", () => {
    const env = createEnvelope({
      channel: "webchat",
      sender: makeSender(),
      content: "test",
      priority: "urgent",
    });
    expect(env.priority).toBe("urgent");
  });

  it("includes attachments when provided", () => {
    const env = createEnvelope({
      channel: "whatsapp",
      sender: makeSender(),
      content: "check this",
      attachments: [{ type: "image", url: "https://example.com/photo.jpg", mimeType: "image/jpeg" }],
    });
    expect(env.attachments).toHaveLength(1);
    expect(env.attachments![0].type).toBe("image");
  });

  it("includes metadata when provided", () => {
    const env = createEnvelope({
      channel: "router",
      sender: makeSender({ id: "router:job-42", relationship: "internal" }),
      content: "result",
      metadata: { jobId: "42", tier: "haiku", executionMs: 1200 },
    });
    expect(env.metadata).toEqual({ jobId: "42", tier: "haiku", executionMs: 1200 });
  });
});

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

describe("PRIORITY_ORDER", () => {
  it("urgent < normal < background (lower number = higher priority)", () => {
    expect(PRIORITY_ORDER.urgent).toBeLessThan(PRIORITY_ORDER.normal);
    expect(PRIORITY_ORDER.normal).toBeLessThan(PRIORITY_ORDER.background);
  });
});

describe("comparePriority", () => {
  it("returns negative when first is higher priority", () => {
    expect(comparePriority("urgent", "normal")).toBeLessThan(0);
    expect(comparePriority("urgent", "background")).toBeLessThan(0);
    expect(comparePriority("normal", "background")).toBeLessThan(0);
  });

  it("returns positive when first is lower priority", () => {
    expect(comparePriority("background", "urgent")).toBeGreaterThan(0);
    expect(comparePriority("normal", "urgent")).toBeGreaterThan(0);
  });

  it("returns zero for same priority", () => {
    expect(comparePriority("normal", "normal")).toBe(0);
    expect(comparePriority("urgent", "urgent")).toBe(0);
    expect(comparePriority("background", "background")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

describe("isValidTransition", () => {
  it("pending → processing is valid", () => {
    expect(isValidTransition("pending", "processing")).toBe(true);
  });

  it("processing → completed is valid", () => {
    expect(isValidTransition("processing", "completed")).toBe(true);
  });

  it("processing → failed is valid", () => {
    expect(isValidTransition("processing", "failed")).toBe(true);
  });

  it("failed → pending is valid (retry)", () => {
    expect(isValidTransition("failed", "pending")).toBe(true);
  });

  it("pending → completed is invalid (must process first)", () => {
    expect(isValidTransition("pending", "completed")).toBe(false);
  });

  it("completed → anything is invalid (terminal state)", () => {
    expect(isValidTransition("completed", "pending")).toBe(false);
    expect(isValidTransition("completed", "processing")).toBe(false);
    expect(isValidTransition("completed", "failed")).toBe(false);
  });

  it("pending → failed is invalid", () => {
    expect(isValidTransition("pending", "failed")).toBe(false);
  });

  it("processing → pending is invalid (use failed → pending for retry)", () => {
    expect(isValidTransition("processing", "pending")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyRelationship
// ---------------------------------------------------------------------------

describe("classifyRelationship", () => {
  const partnerIds = makePartnerIds();

  it("partner ID on WhatsApp → partner", () => {
    expect(classifyRelationship("whatsapp", "+40751845717", partnerIds)).toBe("partner");
  });

  it("partner ID on webchat → partner", () => {
    expect(classifyRelationship("webchat", "webchat-user", partnerIds)).toBe("partner");
  });

  it("partner ID on Telegram → partner", () => {
    expect(classifyRelationship("telegram", "serj-tg", partnerIds)).toBe("partner");
  });

  it("unknown sender on WhatsApp → external", () => {
    expect(classifyRelationship("whatsapp", "stranger-123", partnerIds)).toBe("external");
  });

  it("unknown sender on webchat → external", () => {
    expect(classifyRelationship("webchat", "unknown", partnerIds)).toBe("external");
  });

  it("sender on router channel → internal", () => {
    expect(classifyRelationship("router", "router:job-42", partnerIds)).toBe("internal");
  });

  it("sender on subagent channel → internal", () => {
    expect(classifyRelationship("subagent", "subagent:rt05", partnerIds)).toBe("internal");
  });

  it("sender on cron channel → system", () => {
    expect(classifyRelationship("cron", "heartbeat", partnerIds)).toBe("system");
  });

  it("unknown channel, unknown sender → external", () => {
    expect(classifyRelationship("email", "someone@example.com", partnerIds)).toBe("external");
  });

  it("partner ID on wrong channel → external (not cross-channel partner)", () => {
    // WhatsApp partner ID used on Telegram → not recognized
    expect(classifyRelationship("telegram", "+40751845717", partnerIds)).toBe("external");
  });
});

// ---------------------------------------------------------------------------
// Channel sets
// ---------------------------------------------------------------------------

describe("INTERNAL_CHANNELS", () => {
  it("includes router, subagent, cron", () => {
    expect(INTERNAL_CHANNELS.has("router")).toBe(true);
    expect(INTERNAL_CHANNELS.has("subagent")).toBe(true);
    expect(INTERNAL_CHANNELS.has("cron")).toBe(true);
  });

  it("does not include external channels", () => {
    expect(INTERNAL_CHANNELS.has("whatsapp")).toBe(false);
    expect(INTERNAL_CHANNELS.has("webchat")).toBe(false);
    expect(INTERNAL_CHANNELS.has("telegram")).toBe(false);
  });
});

describe("SYSTEM_CHANNELS", () => {
  it("includes cron", () => {
    expect(SYSTEM_CHANNELS.has("cron")).toBe(true);
  });

  it("does not include router or subagent (they are internal, not system)", () => {
    expect(SYSTEM_CHANNELS.has("router")).toBe(false);
    expect(SYSTEM_CHANNELS.has("subagent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type guards / shape validation
// ---------------------------------------------------------------------------

describe("BusMessage shape", () => {
  it("can represent a pending message", () => {
    const msg: BusMessage = {
      envelope: createEnvelope({
        channel: "webchat",
        sender: makeSender(),
        content: "test",
      }),
      state: "pending",
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    };
    expect(msg.state).toBe("pending");
    expect(msg.attempts).toBe(0);
    expect(msg.processedAt).toBeUndefined();
    expect(msg.error).toBeUndefined();
  });

  it("can represent a failed message with error", () => {
    const msg: BusMessage = {
      envelope: createEnvelope({
        channel: "webchat",
        sender: makeSender(),
        content: "test",
      }),
      state: "failed",
      enqueuedAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      attempts: 2,
      error: "LLM timeout after 30s",
    };
    expect(msg.state).toBe("failed");
    expect(msg.attempts).toBe(2);
    expect(msg.error).toBe("LLM timeout after 30s");
  });
});

describe("CortexOutput shape", () => {
  it("can represent silence (empty targets)", () => {
    const output: import("../types.js").CortexOutput = {
      targets: [],
    };
    expect(output.targets).toHaveLength(0);
  });

  it("can represent multi-channel output", () => {
    const output: import("../types.js").CortexOutput = {
      targets: [
        { channel: "whatsapp", content: "Alert: server down" },
        { channel: "webchat", content: "Alert: server down" },
      ],
      memoryActions: [{ type: "log", content: "Server alert sent to 2 channels" }],
    };
    expect(output.targets).toHaveLength(2);
    expect(output.memoryActions).toHaveLength(1);
  });
});

describe("CortexMode", () => {
  it("accepts valid modes", () => {
    const modes: CortexMode[] = ["off", "shadow", "live"];
    expect(modes).toHaveLength(3);
  });
});

describe("AttentionLayer", () => {
  it("accepts valid layers", () => {
    const layers: AttentionLayer[] = ["foreground", "background", "archived"];
    expect(layers).toHaveLength(3);
  });
});
