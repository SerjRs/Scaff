import { describe, it, expect } from "vitest";

describe("replyContext spread into channelContext", () => {
  it("spreads all attributes except channel", () => {
    const replyContext = {
      channel: "whatsapp",
      threadId: "+40751845717",
      accountId: "default",
      messageId: "msg-123",
    };
    const { channel: _, ...channelAttrs } = replyContext;
    expect(channelAttrs).toEqual({
      threadId: "+40751845717",
      accountId: "default",
      messageId: "msg-123",
    });
    expect(channelAttrs).not.toHaveProperty("channel");
  });

  it("handles replyContext with unknown future attributes", () => {
    const replyContext = {
      channel: "telegram",
      threadId: "chat-123",
      topicId: 42,
      someNewField: "value",
    } as Record<string, unknown>;
    const { channel: _, ...channelAttrs } = replyContext;
    expect(channelAttrs).toHaveProperty("topicId", 42);
    expect(channelAttrs).toHaveProperty("someNewField", "value");
    expect(channelAttrs).not.toHaveProperty("channel");
  });

  it("handles empty replyContext", () => {
    const replyContext = { channel: "webchat" };
    const { channel: _, ...channelAttrs } = replyContext;
    expect(channelAttrs).toEqual({});
  });

  it("handles undefined replyContext", () => {
    const replyContext = undefined;
    const { channel: _, ...channelAttrs } = replyContext ?? { channel: "unknown" };
    expect(channelAttrs).toEqual({});
  });
});