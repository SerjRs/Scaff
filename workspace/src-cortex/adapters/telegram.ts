/**
 * Telegram Channel Adapter
 *
 * Partner detection by Telegram user ID. Group messages from non-partner are external.
 * Supports reply threading via reply_to_message_id.
 */

import type { ChannelAdapter, SenderResolver } from "../channel-adapter.js";
import { createEnvelope, type CortexEnvelope, type OutputTarget } from "../types.js";

/** Raw Telegram message shape */
export interface TelegramRawMessage {
  senderId: string;
  senderName?: string;
  content: string;
  chatId: string;
  messageId?: string;
  replyToMessageId?: string;
  isGroup: boolean;
  timestamp?: string;
}

/** Callback for sending messages back through Telegram */
export type TelegramSendFn = (target: OutputTarget) => Promise<void>;

export class TelegramAdapter implements ChannelAdapter {
  readonly channelId = "telegram" as const;

  private sendFn: TelegramSendFn;
  private available: boolean;

  constructor(sendFn: TelegramSendFn, available = true) {
    this.sendFn = sendFn;
    this.available = available;
  }

  toEnvelope(raw: unknown, senderResolver: SenderResolver): CortexEnvelope {
    const msg = raw as TelegramRawMessage;
    const sender = senderResolver.resolve("telegram", msg.senderId, msg.senderName);

    return createEnvelope({
      channel: "telegram",
      sender,
      content: msg.content,
      timestamp: msg.timestamp,
      priority: sender.relationship === "partner" ? "urgent" : "normal",
      replyContext: {
        channel: "telegram",
        messageId: msg.messageId,
        threadId: msg.chatId,
      },
      metadata: {
        chatId: msg.chatId,
        isGroup: msg.isGroup,
        replyToMessageId: msg.replyToMessageId,
      },
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
