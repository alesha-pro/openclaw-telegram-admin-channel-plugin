import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import type { PostStorage, CommentStorage } from "./storage.js";
import { resolveBotToken, TelegramBotApi } from "./telegram-api.js";

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

  // F10: Comment notification state
  const notifyCfg = pluginConfig.notifications?.onComment;
  const notifyEnabled = notifyCfg?.enabled && notifyCfg.notifyChatId;
  const minIntervalMs = (notifyCfg?.minInterval ?? 60) * 1000;
  let lastNotifyTs = 0;

  api.on(
    "message_received",
    async (event, ctx) => {
      api.logger.debug?.(
        `message_received: channelId=${ctx.channelId} ` +
          `conversationId=${ctx.conversationId} from=${event.from}`,
      );

      if (ctx.channelId !== "telegram") return;

      const rawConversationId = ctx.conversationId;
      if (!rawConversationId) return;

      // OpenClaw prefixes conversationId with "telegram:" — strip it for matching
      const conversationId = rawConversationId.replace(/^telegram:/, "");

      const isFromChannel = conversationId === channelChatId;
      const isFromDiscussion =
        !!discussionChatId && conversationId === discussionChatId;

      if (!isFromChannel && !isFromDiscussion) {
        api.logger.info(
          `[tg-admin-debug] skipped: conversationId=${rawConversationId} (stripped=${conversationId}) ` +
            `doesn't match channel=${channelChatId} or discussion=${discussionChatId ?? "none"}`,
        );
        return;
      }

      const metadata = (event.metadata ?? {}) as Record<string, unknown>;

      // Log full metadata for debugging — helps identify available fields
      api.logger.debug?.(
        `[tg-admin] metadata keys=${Object.keys(metadata).join(",") || "(empty)"} ` +
          `raw=${JSON.stringify(metadata).slice(0, 500)}`,
      );

      // OpenClaw may pass numeric fields as strings — coerce to number
      const rawMessageId = metadata.messageId ?? metadata.message_id;
      const parsedMsgId = rawMessageId != null ? Number(rawMessageId) : NaN;
      const messageId = Number.isFinite(parsedMsgId) ? parsedMsgId : undefined;
      const rawThreadId = metadata.threadId ?? metadata.thread_id;
      const parsedThreadId = rawThreadId != null ? Number(rawThreadId) : NaN;
      const threadId = Number.isFinite(parsedThreadId) ? parsedThreadId : undefined;
      const senderName =
        (metadata.senderName ?? metadata.sender_name) as string | undefined;
      const senderUsername =
        (metadata.senderUsername ?? metadata.sender_username) as string | undefined;
      const isAutoForward =
        metadata.is_automatic_forward === true ||
        metadata.isAutoForward === true;
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
        // Comment in the discussion group — skip if no valid messageId
        if (messageId === undefined) {
          api.logger.debug?.("skipped comment: no messageId in metadata");
          return;
        }
        // Prefer senderId from metadata (actual user), event.from may be group ID
        const senderId =
          typeof metadata.senderId === "string" ? metadata.senderId : event.from;

        await comments.add({
          messageId,
          chatId: conversationId,
          text: event.content,
          timestamp: event.timestamp ?? Date.now(),
          from: senderId,
          fromName: senderName ?? senderUsername,
          threadId,
          isAutoForward: false,
          fileId,
        });
        api.logger.info(
          `telegram-admin-channel hook: stored comment from ${event.from} in discussion`,
        );

        // F10: Send notification for new comments
        if (notifyEnabled) {
          const now = Date.now();
          if (now - lastNotifyTs >= minIntervalMs) {
            lastNotifyTs = now;
            const from = senderName ?? senderUsername ?? event.from;
            const preview = event.content.slice(0, 200);
            const notifyText = `New comment from ${from}:\n${preview}`;
            try {
              const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
              await TelegramBotApi.sendMessage(token, notifyCfg!.notifyChatId, notifyText);
            } catch (e) {
              api.logger.warn(
                `Comment notification failed: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        }
      }
    },
    { priority: 50 },
  );

  api.logger.info(
    "telegram-admin-channel: message_received hook registered" +
      (discussionChatId ? ` (discussion: ${discussionChatId})` : ""),
  );
}
