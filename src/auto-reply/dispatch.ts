import type { OpenClawConfig } from "../config/config.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
  type ReplyDispatchKind,
} from "./reply/reply-dispatcher.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";

export type DispatchInboundResult = DispatchFromConfigResult;

export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    // Ensure dispatcher reservations are always released on every exit path.
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } finally {
      await params.onSettled?.();
    }
  }
}

export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  // Cortex shadow/live feed for non-webchat channels (webchat has its own hook in chat.ts)
  const channel = params.ctx.OriginatingChannel;
  if (channel && channel !== "webchat") {
    try {
      const cortexFeed = (globalThis as any).__openclaw_cortex_feed__ as ((e: any) => void) | undefined;
      const cortexMkEnvelope = (globalThis as any).__openclaw_cortex_createEnvelope__ as ((p: any) => any) | undefined;
      const cortexGetMode = (globalThis as any).__openclaw_cortex_getChannelMode__ as ((ch: string) => string) | undefined;
      const cortexMode = cortexGetMode ? cortexGetMode(channel) : "off";
      console.warn(`[dispatch] Cortex mode for ${channel}: ${cortexMode} (getMode=${!!cortexGetMode}, feed=${!!cortexFeed}, mkEnvelope=${!!cortexMkEnvelope})`);
      if ((cortexMode === "shadow" || cortexMode === "live") && cortexFeed && cortexMkEnvelope) {
        const rawBody = params.ctx.RawBody || params.ctx.Body || "";
        if (rawBody.trim() && !rawBody.trim().startsWith("/")) {
          cortexFeed(cortexMkEnvelope({
            channel,
            sender: { id: params.ctx.From || "unknown", name: params.ctx.SenderName || params.ctx.From || "Unknown", relationship: "partner" },
            content: rawBody,
            priority: "normal",
            replyContext: {
              channel,
              threadId: params.ctx.From || undefined,
              messageId: params.ctx.MessageSid || undefined,
            },
          }));
        }
      }
      // When Cortex is live for this channel, skip main agent entirely.
      // Cortex handles the response through its own adapter.
      if (cortexMode === "live") {
        console.warn(`[dispatch] Cortex LIVE for ${channel} — skipping main agent`);
        return { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } as Record<ReplyDispatchKind, number> };
      }
    } catch (err) { console.warn(`[dispatch] Cortex check error: ${err instanceof Error ? err.message : String(err)}`); }
  }

  const finalized = finalizeInboundContext(params.ctx);
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    run: () =>
      dispatchReplyFromConfig({
        ctx: finalized,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        replyOptions: params.replyOptions,
        replyResolver: params.replyResolver,
      }),
  });
}

export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    params.dispatcherOptions,
  );
  try {
    return await dispatchInboundMessage({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcher,
      replyResolver: params.replyResolver,
      replyOptions: {
        ...params.replyOptions,
        ...replyOptions,
      },
    });
  } finally {
    markDispatchIdle();
  }
}

export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const dispatcher = createReplyDispatcher(params.dispatcherOptions);
  return await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
