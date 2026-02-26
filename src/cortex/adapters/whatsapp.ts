/**
 * WhatsApp Channel Adapter
 *
 * Partner detection by phone number. Group messages from non-partner are external.
 * Supports attachments (images, voice notes, documents).
 */

import type { ChannelAdapter, SenderResolver } from "../channel-adapter.js";
import { createEnvelope, type Attachment, type CortexEnvelope, type OutputTarget } from "../types.js";

/** Raw WhatsApp message shape */
export interface WhatsAppRawMessage {
  senderId: string;
  senderName?: string;
  content: string;
  chatId: string;
  messageId?: string;
  isGroup: boolean;
  timestamp?: string;
  media?: {
    type: "image" | "audio" | "video" | "file";
    url?: string;
    path?: string;
    mimeType?: string;
    caption?: string;
  }[];
}

/** Callback for sending messages back through WhatsApp */
export type WhatsAppSendFn = (target: OutputTarget) => Promise<void>;

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channelId = "whatsapp" as const;

  private sendFn: WhatsAppSendFn;
  private available: boolean;

  constructor(sendFn: WhatsAppSendFn, available = true) {
    this.sendFn = sendFn;
    this.available = available;
  }

  toEnvelope(raw: unknown, senderResolver: SenderResolver): CortexEnvelope {
    const msg = raw as WhatsAppRawMessage;
    const sender = senderResolver.resolve("whatsapp", msg.senderId, msg.senderName);

    const attachments: Attachment[] | undefined = msg.media?.map((m) => ({
      type: m.type,
      url: m.url,
      path: m.path,
      mimeType: m.mimeType,
      caption: m.caption,
    }));

    return createEnvelope({
      channel: "whatsapp",
      sender,
      content: msg.content,
      timestamp: msg.timestamp,
      priority: sender.relationship === "partner" ? "urgent" : "normal",
      replyContext: {
        channel: "whatsapp",
        messageId: msg.messageId,
        threadId: msg.chatId,
      },
      attachments: attachments?.length ? attachments : undefined,
      metadata: { chatId: msg.chatId, isGroup: msg.isGroup },
    });
  }

  async send(target: OutputTarget): Promise<void> {
    await this.sendFn(target);
  }

  isAvailable(): boolean {
    return this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}
