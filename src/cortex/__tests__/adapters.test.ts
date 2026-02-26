import { describe, it, expect } from "vitest";
import { createSenderResolver } from "../channel-adapter.js";
import { WebchatAdapter } from "../adapters/webchat.js";
import { WhatsAppAdapter } from "../adapters/whatsapp.js";
import { TelegramAdapter } from "../adapters/telegram.js";
import { RouterAdapter, SubagentAdapter, CronAdapter } from "../adapters/internal.js";
import type { OutputTarget } from "../types.js";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const partnerIds = new Map([
  ["whatsapp", "+40751845717"],
  ["webchat", "webchat-user"],
  ["telegram", "serj-tg"],
]);

const resolver = createSenderResolver(partnerIds);

function collectSent(): { sent: OutputTarget[]; sendFn: (t: OutputTarget) => Promise<void> } {
  const sent: OutputTarget[] = [];
  return { sent, sendFn: async (t) => { sent.push(t); } };
}

// ---------------------------------------------------------------------------
// Webchat Adapter (Task 4)
// ---------------------------------------------------------------------------

describe("WebchatAdapter", () => {
  const { sent, sendFn } = collectSent();
  const adapter = new WebchatAdapter(sendFn);

  it("channelId is webchat", () => {
    expect(adapter.channelId).toBe("webchat");
  });

  it("toEnvelope creates envelope with partner sender", () => {
    const env = adapter.toEnvelope({ content: "hello" }, resolver);
    expect(env.channel).toBe("webchat");
    expect(env.sender.relationship).toBe("partner");
    expect(env.content).toBe("hello");
  });

  it("toEnvelope sets priority to urgent (partner direct message)", () => {
    const env = adapter.toEnvelope({ content: "hello" }, resolver);
    expect(env.priority).toBe("urgent");
  });

  it("toEnvelope sets replyContext.channel to webchat", () => {
    const env = adapter.toEnvelope({ content: "hello" }, resolver);
    expect(env.replyContext.channel).toBe("webchat");
  });

  it("toEnvelope includes messageId in replyContext", () => {
    const env = adapter.toEnvelope({ content: "hello", messageId: "msg-123" }, resolver);
    expect(env.replyContext.messageId).toBe("msg-123");
  });

  it("send routes through sendFn", async () => {
    await adapter.send({ channel: "webchat", content: "response" });
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe("response");
  });

  it("isAvailable returns true when connected", () => {
    expect(adapter.isAvailable()).toBe(true);
  });

  it("isAvailable reflects connection state", () => {
    adapter.setAvailable(false);
    expect(adapter.isAvailable()).toBe(false);
    adapter.setAvailable(true);
  });
});

// ---------------------------------------------------------------------------
// WhatsApp Adapter (Task 5)
// ---------------------------------------------------------------------------

describe("WhatsAppAdapter", () => {
  const { sent, sendFn } = collectSent();
  const adapter = new WhatsAppAdapter(sendFn);

  it("channelId is whatsapp", () => {
    expect(adapter.channelId).toBe("whatsapp");
  });

  it("toEnvelope from Serj DM → partner, urgent", () => {
    const env = adapter.toEnvelope(
      { senderId: "+40751845717", senderName: "Serj", content: "hey", chatId: "dm-1", isGroup: false },
      resolver,
    );
    expect(env.sender.relationship).toBe("partner");
    expect(env.sender.name).toBe("Serj");
    expect(env.priority).toBe("urgent");
  });

  it("toEnvelope from group (stranger) → external, normal", () => {
    const env = adapter.toEnvelope(
      { senderId: "stranger-123", senderName: "John", content: "sup", chatId: "group-1", isGroup: true },
      resolver,
    );
    expect(env.sender.relationship).toBe("external");
    expect(env.sender.name).toBe("John");
    expect(env.priority).toBe("normal");
  });

  it("toEnvelope from group (Serj) → partner, urgent", () => {
    const env = adapter.toEnvelope(
      { senderId: "+40751845717", senderName: "Serj", content: "hi all", chatId: "group-1", isGroup: true },
      resolver,
    );
    expect(env.sender.relationship).toBe("partner");
    expect(env.priority).toBe("urgent");
  });

  it("toEnvelope maps WhatsApp media to Attachment type", () => {
    const env = adapter.toEnvelope(
      {
        senderId: "+40751845717",
        content: "check this",
        chatId: "dm-1",
        isGroup: false,
        media: [{ type: "image", url: "https://example.com/pic.jpg", mimeType: "image/jpeg" }],
      },
      resolver,
    );
    expect(env.attachments).toHaveLength(1);
    expect(env.attachments![0].type).toBe("image");
    expect(env.attachments![0].mimeType).toBe("image/jpeg");
  });

  it("toEnvelope includes voice note as audio attachment", () => {
    const env = adapter.toEnvelope(
      {
        senderId: "+40751845717",
        content: "",
        chatId: "dm-1",
        isGroup: false,
        media: [{ type: "audio", mimeType: "audio/ogg", path: "/tmp/voice.ogg" }],
      },
      resolver,
    );
    expect(env.attachments![0].type).toBe("audio");
    expect(env.attachments![0].mimeType).toBe("audio/ogg");
  });

  it("toEnvelope sets replyContext with chatId", () => {
    const env = adapter.toEnvelope(
      { senderId: "+40751845717", content: "test", chatId: "chat-42", messageId: "msg-1", isGroup: false },
      resolver,
    );
    expect(env.replyContext.threadId).toBe("chat-42");
    expect(env.replyContext.messageId).toBe("msg-1");
  });

  it("send routes through sendFn", async () => {
    await adapter.send({ channel: "whatsapp", content: "reply" });
    expect(sent.length).toBeGreaterThan(0);
  });

  it("isAvailable reflects connection state", () => {
    expect(adapter.isAvailable()).toBe(true);
    adapter.setAvailable(false);
    expect(adapter.isAvailable()).toBe(false);
    adapter.setAvailable(true);
  });
});

// ---------------------------------------------------------------------------
// Telegram Adapter (Task 6)
// ---------------------------------------------------------------------------

describe("TelegramAdapter", () => {
  const { sendFn } = collectSent();
  const adapter = new TelegramAdapter(sendFn);

  it("channelId is telegram", () => {
    expect(adapter.channelId).toBe("telegram");
  });

  it("toEnvelope from Serj DM → partner, urgent", () => {
    const env = adapter.toEnvelope(
      { senderId: "serj-tg", senderName: "Serj", content: "hello", chatId: "dm-1", isGroup: false },
      resolver,
    );
    expect(env.sender.relationship).toBe("partner");
    expect(env.priority).toBe("urgent");
  });

  it("toEnvelope from group (stranger) → external, normal", () => {
    const env = adapter.toEnvelope(
      { senderId: "other-user", senderName: "Alex", content: "hey", chatId: "group-1", isGroup: true },
      resolver,
    );
    expect(env.sender.relationship).toBe("external");
    expect(env.priority).toBe("normal");
  });

  it("toEnvelope from group (Serj) → partner, urgent", () => {
    const env = adapter.toEnvelope(
      { senderId: "serj-tg", content: "check this", chatId: "group-1", isGroup: true },
      resolver,
    );
    expect(env.sender.relationship).toBe("partner");
    expect(env.priority).toBe("urgent");
  });

  it("toEnvelope handles reply threading", () => {
    const env = adapter.toEnvelope(
      { senderId: "serj-tg", content: "reply", chatId: "dm-1", messageId: "42", replyToMessageId: "41", isGroup: false },
      resolver,
    );
    expect(env.metadata?.replyToMessageId).toBe("41");
    expect(env.replyContext.messageId).toBe("42");
  });

  it("isAvailable reflects bot connection state", () => {
    expect(adapter.isAvailable()).toBe(true);
    adapter.setAvailable(false);
    expect(adapter.isAvailable()).toBe(false);
    adapter.setAvailable(true);
  });
});

// ---------------------------------------------------------------------------
// Router Adapter (Task 7)
// ---------------------------------------------------------------------------

describe("RouterAdapter", () => {
  const { sent, sendFn } = collectSent();
  const adapter = new RouterAdapter(sendFn);

  it("channelId is router", () => {
    expect(adapter.channelId).toBe("router");
  });

  it("toEnvelope creates envelope with internal sender", () => {
    const env = adapter.toEnvelope(
      { jobId: "job-42", content: "Berlin is the capital of Germany" },
      resolver,
    );
    expect(env.channel).toBe("router");
    expect(env.sender.relationship).toBe("internal");
    expect(env.sender.id).toBe("router:job-42");
    expect(env.content).toBe("Berlin is the capital of Germany");
  });

  it("toEnvelope includes metadata (jobId, tier, model, executionMs)", () => {
    const env = adapter.toEnvelope(
      { jobId: "job-42", content: "result", tier: "haiku", model: "claude-haiku-4-5", executionMs: 1200 },
      resolver,
    );
    expect(env.metadata).toEqual({
      jobId: "job-42",
      tier: "haiku",
      model: "claude-haiku-4-5",
      executionMs: 1200,
    });
  });

  it("toEnvelope: awaited result gets urgent priority", () => {
    const env = adapter.toEnvelope(
      { jobId: "job-42", content: "result", isAwaited: true },
      resolver,
    );
    expect(env.priority).toBe("urgent");
  });

  it("toEnvelope: non-awaited result gets normal priority", () => {
    const env = adapter.toEnvelope(
      { jobId: "job-42", content: "result", isAwaited: false },
      resolver,
    );
    expect(env.priority).toBe("normal");
  });

  it("isAvailable always returns true (internal)", () => {
    expect(adapter.isAvailable()).toBe(true);
  });

  it("send dispatches through dispatchFn", async () => {
    await adapter.send({ channel: "router", content: "dispatch task" });
    expect(sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sub-agent Adapter (Task 7)
// ---------------------------------------------------------------------------

describe("SubagentAdapter", () => {
  const { sendFn } = collectSent();
  const adapter = new SubagentAdapter(sendFn);

  it("channelId is subagent", () => {
    expect(adapter.channelId).toBe("subagent");
  });

  it("toEnvelope creates envelope with label-based sender", () => {
    const env = adapter.toEnvelope(
      { label: "rt05", content: "task completed", status: "completed" },
      resolver,
    );
    expect(env.sender.id).toBe("subagent:rt05");
    expect(env.sender.relationship).toBe("internal");
    expect(env.content).toBe("task completed");
  });

  it("toEnvelope includes status and error in metadata", () => {
    const env = adapter.toEnvelope(
      { label: "rt05", content: "failed", status: "failed", error: "timeout" },
      resolver,
    );
    expect(env.metadata?.status).toBe("failed");
    expect(env.metadata?.error).toBe("timeout");
  });

  it("isAvailable always returns true", () => {
    expect(adapter.isAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cron Adapter (Task 7)
// ---------------------------------------------------------------------------

describe("CronAdapter", () => {
  const adapter = new CronAdapter();

  it("channelId is cron", () => {
    expect(adapter.channelId).toBe("cron");
  });

  it("toEnvelope creates envelope with system sender", () => {
    const env = adapter.toEnvelope(
      { trigger: "heartbeat", content: "heartbeat tick" },
      resolver,
    );
    expect(env.sender.relationship).toBe("system");
    expect(env.channel).toBe("cron");
  });

  it("toEnvelope sets background priority", () => {
    const env = adapter.toEnvelope(
      { trigger: "heartbeat", content: "tick" },
      resolver,
    );
    expect(env.priority).toBe("background");
  });

  it("toEnvelope includes trigger and cronId in metadata", () => {
    const env = adapter.toEnvelope(
      { trigger: "scheduled", cronId: "daily-check", content: "run check" },
      resolver,
    );
    expect(env.metadata?.trigger).toBe("scheduled");
    expect(env.metadata?.cronId).toBe("daily-check");
  });

  it("isAvailable always returns true", () => {
    expect(adapter.isAvailable()).toBe(true);
  });

  it("send is a no-op (cron is inbound-only)", async () => {
    // Should not throw
    await adapter.send({ channel: "cron", content: "noop" });
  });
});
