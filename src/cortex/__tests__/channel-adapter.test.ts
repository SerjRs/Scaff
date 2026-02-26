import { describe, it, expect } from "vitest";
import {
  createAdapterRegistry,
  createSenderResolver,
  type ChannelAdapter,
  type AdapterRegistry,
} from "../channel-adapter.js";
import { createEnvelope, type OutputTarget } from "../types.js";

// ---------------------------------------------------------------------------
// Mock adapter factory
// ---------------------------------------------------------------------------

function makeMockAdapter(channelId: string, available = true): ChannelAdapter {
  const sent: OutputTarget[] = [];
  return {
    channelId,
    toEnvelope(raw: unknown, senderResolver) {
      const msg = raw as { senderId: string; content: string; displayName?: string };
      const sender = senderResolver.resolve(channelId, msg.senderId, msg.displayName);
      return createEnvelope({
        channel: channelId,
        sender,
        content: msg.content,
        priority: sender.relationship === "partner" ? "urgent" : "normal",
      });
    },
    async send(target: OutputTarget) {
      sent.push(target);
    },
    isAvailable() {
      return available;
    },
    // Test helper — not part of interface
    get sentMessages() {
      return sent;
    },
  };
}

// ---------------------------------------------------------------------------
// AdapterRegistry
// ---------------------------------------------------------------------------

describe("AdapterRegistry", () => {
  it("registers and retrieves adapter by channelId", () => {
    const registry = createAdapterRegistry();
    const adapter = makeMockAdapter("webchat");
    registry.register(adapter);

    expect(registry.get("webchat")).toBe(adapter);
  });

  it("returns undefined for unregistered channel", () => {
    const registry = createAdapterRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("list returns all registered adapters", () => {
    const registry = createAdapterRegistry();
    registry.register(makeMockAdapter("webchat"));
    registry.register(makeMockAdapter("whatsapp"));
    registry.register(makeMockAdapter("telegram"));

    const list = registry.list();
    expect(list).toHaveLength(3);
    expect(list.map((a) => a.channelId).sort()).toEqual(["telegram", "webchat", "whatsapp"]);
  });

  it("duplicate registration overwrites", () => {
    const registry = createAdapterRegistry();
    const first = makeMockAdapter("webchat");
    const second = makeMockAdapter("webchat");
    registry.register(first);
    registry.register(second);

    expect(registry.get("webchat")).toBe(second);
    expect(registry.list()).toHaveLength(1);
  });

  it("list returns empty array when no adapters registered", () => {
    const registry = createAdapterRegistry();
    expect(registry.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SenderResolver
// ---------------------------------------------------------------------------

describe("SenderResolver", () => {
  const partnerIds = new Map([
    ["whatsapp", "+40751845717"],
    ["webchat", "webchat-user"],
    ["telegram", "serj-tg"],
  ]);

  const resolver = createSenderResolver(partnerIds);

  it("partner ID on WhatsApp → relationship partner", () => {
    const sender = resolver.resolve("whatsapp", "+40751845717", "Serj");
    expect(sender.relationship).toBe("partner");
    expect(sender.name).toBe("Serj");
    expect(sender.id).toBe("+40751845717");
  });

  it("partner ID on webchat → relationship partner", () => {
    const sender = resolver.resolve("webchat", "webchat-user");
    expect(sender.relationship).toBe("partner");
  });

  it("unknown sender on WhatsApp → relationship external", () => {
    const sender = resolver.resolve("whatsapp", "stranger-123", "John");
    expect(sender.relationship).toBe("external");
    expect(sender.name).toBe("John");
  });

  it("unknown sender without display name uses raw ID", () => {
    const sender = resolver.resolve("whatsapp", "stranger-123");
    expect(sender.relationship).toBe("external");
    expect(sender.name).toBe("stranger-123");
  });

  it("sender on router channel → relationship internal", () => {
    const sender = resolver.resolve("router", "router:job-42");
    expect(sender.relationship).toBe("internal");
    expect(sender.name).toBe("Router");
  });

  it("sender on subagent channel → relationship internal", () => {
    const sender = resolver.resolve("subagent", "subagent:rt05");
    expect(sender.relationship).toBe("internal");
    expect(sender.name).toBe("Subagent");
  });

  it("sender on cron channel → relationship system", () => {
    const sender = resolver.resolve("cron", "heartbeat");
    expect(sender.relationship).toBe("system");
    expect(sender.name).toBe("System");
  });

  it("partner display name overrides default", () => {
    const sender = resolver.resolve("webchat", "webchat-user", "Serj");
    expect(sender.name).toBe("Serj");
  });
});

// ---------------------------------------------------------------------------
// Adapter integration with SenderResolver
// ---------------------------------------------------------------------------

describe("Adapter + SenderResolver integration", () => {
  const partnerIds = new Map([
    ["webchat", "webchat-user"],
    ["whatsapp", "+40751845717"],
  ]);
  const resolver = createSenderResolver(partnerIds);

  it("adapter creates envelope with correct sender from resolver", () => {
    const adapter = makeMockAdapter("webchat");
    const env = adapter.toEnvelope(
      { senderId: "webchat-user", content: "hello" },
      resolver,
    );

    expect(env.channel).toBe("webchat");
    expect(env.sender.relationship).toBe("partner");
    expect(env.content).toBe("hello");
    expect(env.priority).toBe("urgent"); // partner → urgent
  });

  it("adapter creates envelope with external sender", () => {
    const adapter = makeMockAdapter("whatsapp");
    const env = adapter.toEnvelope(
      { senderId: "stranger", content: "who dis", displayName: "Unknown" },
      resolver,
    );

    expect(env.sender.relationship).toBe("external");
    expect(env.sender.name).toBe("Unknown");
    expect(env.priority).toBe("normal"); // external → normal
  });
});
