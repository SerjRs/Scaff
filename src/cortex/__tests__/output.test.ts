import { describe, it, expect, vi } from "vitest";
import { routeOutput, parseResponse, isSilentResponse } from "../output.js";
import { createAdapterRegistry, type ChannelAdapter } from "../channel-adapter.js";
import { createEnvelope, type OutputTarget } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockAdapter(channelId: string): ChannelAdapter & { sent: OutputTarget[] } {
  const sent: OutputTarget[] = [];
  return {
    channelId,
    toEnvelope: () => { throw new Error("not used"); },
    async send(target) { sent.push(target); },
    isAvailable: () => true,
    sent,
  };
}

function makeEnvelope(channel = "webchat") {
  return createEnvelope({
    channel,
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content: "test",
    replyContext: { channel, messageId: "msg-1", threadId: "thread-1" },
  });
}

// ---------------------------------------------------------------------------
// routeOutput
// ---------------------------------------------------------------------------

describe("routeOutput", () => {
  it("sends to correct adapter for single target", async () => {
    const registry = createAdapterRegistry();
    const adapter = makeMockAdapter("webchat");
    registry.register(adapter);

    await routeOutput({
      output: { targets: [{ channel: "webchat", content: "hello" }] },
      registry,
      onError: () => {},
    });

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("hello");
  });

  it("sends to multiple adapters for multi-channel output", async () => {
    const registry = createAdapterRegistry();
    const wa = makeMockAdapter("whatsapp");
    const wc = makeMockAdapter("webchat");
    registry.register(wa);
    registry.register(wc);

    await routeOutput({
      output: {
        targets: [
          { channel: "whatsapp", content: "alert" },
          { channel: "webchat", content: "alert" },
        ],
      },
      registry,
      onError: () => {},
    });

    expect(wa.sent).toHaveLength(1);
    expect(wc.sent).toHaveLength(1);
  });

  it("handles empty targets (silence) — no adapter calls", async () => {
    const registry = createAdapterRegistry();
    const adapter = makeMockAdapter("webchat");
    registry.register(adapter);

    await routeOutput({
      output: { targets: [] },
      registry,
      onError: () => {},
    });

    expect(adapter.sent).toHaveLength(0);
  });

  it("calls onError when adapter not found", async () => {
    const registry = createAdapterRegistry();
    const errors: { channel: string; error: Error }[] = [];

    await routeOutput({
      output: { targets: [{ channel: "nonexistent", content: "hello" }] },
      registry,
      onError: (channel, error) => { errors.push({ channel, error }); },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].channel).toBe("nonexistent");
  });

  it("calls onError on adapter.send failure", async () => {
    const registry = createAdapterRegistry();
    const failAdapter: ChannelAdapter = {
      channelId: "webchat",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => { throw new Error("send failed"); },
      isAvailable: () => true,
    };
    registry.register(failAdapter);
    const errors: Error[] = [];

    await routeOutput({
      output: { targets: [{ channel: "webchat", content: "hello" }] },
      registry,
      onError: (_ch, err) => { errors.push(err); },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("send failed");
  });
});

// ---------------------------------------------------------------------------
// isSilentResponse
// ---------------------------------------------------------------------------

describe("isSilentResponse", () => {
  it("returns true for NO_REPLY", () => {
    expect(isSilentResponse("NO_REPLY")).toBe(true);
  });

  it("returns true for HEARTBEAT_OK", () => {
    expect(isSilentResponse("HEARTBEAT_OK")).toBe(true);
  });

  it("returns true with whitespace", () => {
    expect(isSilentResponse("  NO_REPLY  ")).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(isSilentResponse("Hello! How can I help?")).toBe(false);
  });

  it("returns false for text containing NO_REPLY", () => {
    expect(isSilentResponse("Here's help... NO_REPLY")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseResponse
// ---------------------------------------------------------------------------

describe("parseResponse", () => {
  it("creates reply to source channel by default", () => {
    const output = parseResponse({
      llmResponse: "Hello Serj!",
      triggerEnvelope: makeEnvelope("webchat"),
    });

    expect(output.targets).toHaveLength(1);
    expect(output.targets[0].channel).toBe("webchat");
    expect(output.targets[0].content).toBe("Hello Serj!");
    expect(output.targets[0].replyTo).toBe("msg-1");
  });

  it("detects [[reply_to_current]] tag and strips it", () => {
    const output = parseResponse({
      llmResponse: "[[reply_to_current]] Here's your answer",
      triggerEnvelope: makeEnvelope("webchat"),
    });

    expect(output.targets).toHaveLength(1);
    expect(output.targets[0].content).toBe("Here's your answer");
  });

  it("handles NO_REPLY as silence", () => {
    const output = parseResponse({
      llmResponse: "NO_REPLY",
      triggerEnvelope: makeEnvelope("webchat"),
    });

    expect(output.targets).toHaveLength(0);
  });

  it("handles HEARTBEAT_OK as silence", () => {
    const output = parseResponse({
      llmResponse: "HEARTBEAT_OK",
      triggerEnvelope: makeEnvelope("cron"),
    });

    expect(output.targets).toHaveLength(0);
  });

  it("detects cross-channel directive [[send_to:whatsapp]]", () => {
    const output = parseResponse({
      llmResponse: "[[send_to:whatsapp]] Alert: server down",
      triggerEnvelope: makeEnvelope("cron"),
    });

    expect(output.targets).toHaveLength(1);
    expect(output.targets[0].channel).toBe("whatsapp");
    expect(output.targets[0].content).toBe("Alert: server down");
  });
});
