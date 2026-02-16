import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import type { PostStorage, CommentStorage } from "./storage.js";

export function registerHooks(
  api: OpenClawPluginApi,
  pluginConfig: TelegramAdminChannelConfig | undefined,
  posts: PostStorage,
  comments: CommentStorage,
): void {
  if (!pluginConfig) {
    api.logger.warn(
      "telegram-admin-channel: no plugin config — skipping hook registration",
    );
    return;
  }

  const channelChatId = pluginConfig.channel.chatId;
  const discussionChatId = pluginConfig.discussion?.chatId;

  api.on(
    "message_received",
    async (event, ctx) => {
      // DEBUG: log every incoming message_received event
      api.logger.info(
        `[tg-admin-debug] message_received: channelId=${ctx.channelId} ` +
          `conversationId=${ctx.conversationId} from=${event.from} ` +
          `content=${event.content?.slice(0, 50)} ` +
          `metadata=${JSON.stringify(event.metadata ?? {})}`,
      );

      if (ctx.channelId !== "telegram") return;

      const conversationId = ctx.conversationId;
      if (!conversationId) return;

      const isFromChannel = conversationId === channelChatId;
      const isFromDiscussion =
        !!discussionChatId && conversationId === discussionChatId;

      if (!isFromChannel && !isFromDiscussion) {
        api.logger.info(
          `[tg-admin-debug] skipped: conversationId=${conversationId} ` +
            `doesn't match channel=${channelChatId} or discussion=${discussionChatId ?? "none"}`,
        );
        return;
      }

      const metadata = (event.metadata ?? {}) as Record<string, unknown>;
      const messageId =
        typeof metadata.messageId === "number"
          ? metadata.messageId
          : undefined;
      const threadId =
        typeof metadata.threadId === "number"
          ? metadata.threadId
          : undefined;
      const senderName =
        typeof metadata.senderName === "string"
          ? metadata.senderName
          : undefined;
      const senderUsername =
        typeof metadata.senderUsername === "string"
          ? metadata.senderUsername
          : undefined;
      const isAutoForward =
        typeof metadata.is_automatic_forward === "boolean"
          ? metadata.is_automatic_forward
          : false;
      const fileId =
        typeof metadata.fileId === "string" ? metadata.fileId : undefined;

      if (isAutoForward || isFromChannel) {
        // Channel post (direct or auto-forwarded to discussion)
        if (messageId !== undefined) {
          const inserted = await posts.upsertPost({
            messageId,
            chatId: channelChatId,
            text: event.content,
            timestamp: event.timestamp ?? Date.now(),
            fileId,
          });
          if (inserted) {
            api.logger.info(
              `telegram-admin-channel hook: stored post #${messageId} from channel`,
            );
          }
        }
      } else if (isFromDiscussion) {
        // Comment in the discussion group
        await comments.add({
          messageId: messageId ?? 0,
          chatId: conversationId,
          text: event.content,
          timestamp: event.timestamp ?? Date.now(),
          from: event.from,
          fromName: senderName ?? senderUsername,
          threadId,
          isAutoForward: false,
          fileId,
        });
        api.logger.info(
          `telegram-admin-channel hook: stored comment from ${event.from} in discussion`,
        );
      }
    },
    { priority: 50 },
  );

  api.logger.info(
    "telegram-admin-channel: message_received hook registered" +
      (discussionChatId ? ` (discussion: ${discussionChatId})` : ""),
  );
}
