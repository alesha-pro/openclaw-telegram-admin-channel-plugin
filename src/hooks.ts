import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import type { PostStorage } from "./storage.js";

export function registerHooks(
  api: OpenClawPluginApi,
  pluginConfig: TelegramAdminChannelConfig | undefined,
  posts: PostStorage,
): void {
  if (!pluginConfig) {
    api.logger.warn(
      "telegram-admin-channel: no plugin config — skipping hook registration",
    );
    return;
  }

  const channelChatId = pluginConfig.channel.chatId;

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

      // Check for auto-forwarded post (channel post mirrored to discussion group)
      const metadata = (event.metadata ?? {}) as Record<string, unknown>;
      const isAutoForward =
        metadata.is_automatic_forward === true ||
        metadata.isAutoForward === true;

      if (!isFromChannel && !isAutoForward) return;

      // Log full metadata for debugging
      api.logger.debug?.(
        `[tg-admin] metadata keys=${Object.keys(metadata).join(",") || "(empty)"} ` +
          `raw=${JSON.stringify(metadata).slice(0, 500)}`,
      );

      // OpenClaw may pass numeric fields as strings — coerce to number
      const rawMessageId = metadata.messageId ?? metadata.message_id;
      const parsedMsgId = rawMessageId != null ? Number(rawMessageId) : NaN;
      const messageId = Number.isFinite(parsedMsgId) ? parsedMsgId : undefined;
      const fileId =
        typeof metadata.fileId === "string" ? metadata.fileId : undefined;

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
    },
    { priority: 50 },
  );

  api.logger.info(
    "telegram-admin-channel: message_received hook registered",
  );
}
