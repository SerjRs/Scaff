/**
 * Webchat Channel Adapter
 *
 * Webchat is always from the partner (authenticated local connection).
 * All webchat messages get priority: urgent.
 */

import type { ChannelAdapter, SenderResolver } from "../channel-adapter.js";
import { createEnvelope, type CortexEnvelope, type OutputTarget } from "../types.js";

/** Raw webchat message shape */
export interface WebchatRawMessage {
  content: string;
  messageId?: string;
  senderId?: string;
  timestamp?: string;
}

/** Callback for sending messages back through webchat */
export type WebchatSendFn = (target: OutputTarget) => Promise<void>;

export class WebchatAdapter implements ChannelAdapter {
  readonly channelId = "webchat" as const;

  private sendFn: WebchatSendFn;
  private available: boolean;

  constructor(sendFn: WebchatSendFn, available = true) {
    this.sendFn = sendFn;
    this.available = available;
  }

  toEnvelope(raw: unknown, senderResolver: SenderResolver): CortexEnvelope {
    const msg = raw as WebchatRawMessage;
    const senderId = msg.senderId ?? "webchat-user";
    const sender = senderResolver.resolve("webchat", senderId);

    return createEnvelope({
      channel: "webchat",
      sender,
      content: msg.content,
      timestamp: msg.timestamp,
      priority: "urgent", // webchat is always partner → always urgent
      replyContext: {
        channel: "webchat",
        messageId: msg.messageId,
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
