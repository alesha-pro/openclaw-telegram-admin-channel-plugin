import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import { resolveBotToken, TelegramBotApi, fetchPublicChannelPosts } from "./telegram-api.js";
import type { PostStorage, CommentStorage } from "./storage.js";
import type { MtprotoClient } from "./mtproto-client.js";

const ToolParameters = Type.Object({
  action: Type.Union([
    Type.Literal("post"),
    Type.Literal("sync"),
    Type.Literal("list_recent_activity"),
    Type.Literal("get_views"),
    Type.Literal("get_channel_stats"),
    Type.Literal("get_post_stats"),
    Type.Literal("get_history"),
    Type.Literal("schedule_post"),
    Type.Literal("list_scheduled"),
    Type.Literal("delete_scheduled"),
    Type.Literal("send_scheduled_now"),
  ]),
  text: Type.Optional(Type.String({ description: "Post text content" })),
  parseMode: Type.Optional(
    Type.Union([
      Type.Literal("HTML"),
      Type.Literal("Markdown"),
      Type.Literal("MarkdownV2"),
    ]),
  ),
  silent: Type.Optional(
    Type.Boolean({ description: "Send without notification" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Number of items to return (default: 10)" }),
  ),
  messageIds: Type.Optional(
    Type.Array(Type.Number(), { description: "Message IDs for get_views" }),
  ),
  messageId: Type.Optional(
    Type.Number({ description: "Message ID for get_post_stats" }),
  ),
  offsetId: Type.Optional(
    Type.Number({ description: "Offset message ID for get_history pagination" }),
  ),
  scheduleDate: Type.Optional(
    Type.Number({ description: "Unix timestamp (UTC) for schedule_post" }),
  ),
  photoFileIds: Type.Optional(
    Type.Array(Type.String(), { description: "Telegram file_id(s) for photo(s); album if multiple" }),
  ),
  photoPaths: Type.Optional(
    Type.Array(Type.String(), { description: "Local file path(s) to photo(s); album if multiple" }),
  ),
});

type ToolParams = Static<typeof ToolParameters>;

type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

const BASE_DESCRIPTION =
  "Manage a Telegram channel: publish posts, sync existing posts, view activity. " +
  "Actions: 'post' (publish text), 'sync' (fetch posts from public channel), " +
  "'list_recent_activity' (show recent posts & comments, optional 'limit').";

const MTPROTO_DESCRIPTION =
  " MTProto actions: " +
  "'get_views' (view/forward counts, requires 'messageIds'), " +
  "'get_channel_stats' (subscribers, growth, reach analytics), " +
  "'get_post_stats' (per-post views/reactions graphs, requires 'messageId'), " +
  "'get_history' (channel message history, optional 'limit' and 'offsetId'). " +
  "Scheduled posts: " +
  "'schedule_post' (text or photo/album, requires 'scheduleDate'; use 'photoPaths' for local files or 'photoFileIds' for Telegram file_ids, multiple = album; 'text' as caption), " +
  "'list_scheduled' (list all pending scheduled messages), " +
  "'delete_scheduled' (requires 'messageIds'), " +
  "'send_scheduled_now' (publish scheduled messages immediately, requires 'messageIds').";

export function createToolFactory(
  api: OpenClawPluginApi,
  posts: PostStorage,
  comments: CommentStorage,
  mtprotoClient?: MtprotoClient,
) {
  const logger = api.logger;
  const description = mtprotoClient
    ? BASE_DESCRIPTION + MTPROTO_DESCRIPTION
    : BASE_DESCRIPTION;

  return (_ctx: unknown) => ({
    name: "tg_channel_admin",
    label: "Telegram Channel Admin",
    description,
    parameters: ToolParameters,
    async execute(
      _toolCallId: string,
      params: ToolParams,
    ) {
      const pluginConfig = api.pluginConfig as
        | TelegramAdminChannelConfig
        | undefined;
      if (!pluginConfig) {
        return jsonResult({
          error: "Plugin config not found. Configure telegram-admin-channel in plugins.entries.",
        });
      }

      // TODO: ownerAllowFrom check — needs senderId from context.
      // In tool context, senderId is not directly available yet.
      // This will be addressed when hook-based context passing is implemented.

      const result = await executeAction(
        params,
        pluginConfig,
        api,
        posts,
        comments,
        logger,
        mtprotoClient,
      );
      return result;
    },
  });
}

async function executeAction(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  posts: PostStorage,
  comments: CommentStorage,
  logger: PluginLogger,
  mtprotoClient?: MtprotoClient,
) {
  switch (params.action) {
    case "post":
      return executePost(params, pluginConfig, api, posts, logger);
    case "sync":
      return executeSync(pluginConfig, posts, logger);
    case "list_recent_activity":
      return executeListRecentActivity(params, posts, comments);
    case "get_views":
      return executeGetViews(params, pluginConfig, mtprotoClient);
    case "get_channel_stats":
      return executeGetChannelStats(pluginConfig, mtprotoClient);
    case "get_post_stats":
      return executeGetPostStats(params, pluginConfig, mtprotoClient);
    case "get_history":
      return executeGetHistory(params, pluginConfig, mtprotoClient);
    case "schedule_post":
      return executeSchedulePost(params, pluginConfig, api, mtprotoClient);
    case "list_scheduled":
      return executeListScheduled(pluginConfig, mtprotoClient);
    case "delete_scheduled":
      return executeDeleteScheduled(params, pluginConfig, mtprotoClient);
    case "send_scheduled_now":
      return executeSendScheduledNow(params, pluginConfig, mtprotoClient);
    default:
      return jsonResult({
        error: `Unknown action: ${String(params.action)}`,
      });
  }
}

async function executePost(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  posts: PostStorage,
  logger: PluginLogger,
) {
  const text = params.text;
  if (!text) {
    return jsonResult({ error: "'text' parameter is required for 'post' action" });
  }

  const chatId = pluginConfig.channel.chatId;
  const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
  const silent =
    params.silent ?? pluginConfig.defaults?.silent ?? false;

  logger.info(`Posting to channel ${chatId}...`);

  const result = await TelegramBotApi.sendMessage(token, chatId, text, {
    parseMode: params.parseMode,
    disableNotification: silent,
  });

  const messageId = result.result!.message_id;
  const chatUsername = result.result!.chat?.username;
  const permalink = chatUsername
    ? `https://t.me/${chatUsername}/${messageId}`
    : undefined;

  await posts.add({
    messageId,
    chatId,
    text,
    timestamp: Date.now(),
    permalink,
  });

  logger.info(`Posted message ${messageId} to ${chatId}`);

  return jsonResult({
    ok: true,
    messageId,
    chatId,
    permalink,
  });
}

async function executeSync(
  pluginConfig: TelegramAdminChannelConfig,
  posts: PostStorage,
  logger: PluginLogger,
) {
  const chatId = pluginConfig.channel.chatId;
  const username = chatId.startsWith("@")
    ? chatId.slice(1)
    : chatId.startsWith("-")
      ? null
      : chatId;

  if (!username) {
    return jsonResult({
      error:
        "sync requires a public channel username (@channel). " +
        "Numeric chat IDs cannot be synced via public page.",
    });
  }

  logger.info(`Syncing posts from t.me/s/${username}...`);

  const parsed = await fetchPublicChannelPosts(username);

  let inserted = 0;
  let updated = 0;

  for (const post of parsed) {
    const isNew = await posts.upsertPost({
      messageId: post.messageId,
      chatId,
      text: post.text,
      timestamp: post.timestamp,
      permalink: post.permalink,
    });
    if (isNew) inserted++;
    else updated++;
  }

  logger.info(
    `Sync complete: ${parsed.length} parsed, ${inserted} new, ${updated} updated`,
  );

  return jsonResult({
    ok: true,
    total: parsed.length,
    inserted,
    updated,
  });
}

async function executeListRecentActivity(
  params: ToolParams,
  posts: PostStorage,
  comments: CommentStorage,
) {
  const limit = params.limit ?? 10;
  const recentPosts = await posts.getAll(limit);
  const recentComments = await comments.getFiltered({ limit });

  type ActivityItem =
    | { type: "post"; data: (typeof recentPosts)[number] }
    | { type: "comment"; data: (typeof recentComments)[number] };

  const items: ActivityItem[] = [
    ...recentPosts.map((p) => ({ type: "post" as const, data: p })),
    ...recentComments.map((c) => ({ type: "comment" as const, data: c })),
  ];

  items.sort((a, b) => b.data.timestamp - a.data.timestamp);

  return jsonResult({
    ok: true,
    count: items.length,
    activity: items.slice(0, limit),
  });
}

// --- MTProto action handlers ---

function requireMtproto(client?: MtprotoClient) {
  if (!client) {
    return jsonResult({
      error:
        "MTProto is not configured. Enable mtproto in plugin config and run 'pnpm mtproto:auth' to authorize.",
    });
  }
  return null;
}

async function executeGetViews(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  if (!params.messageIds || params.messageIds.length === 0) {
    return jsonResult({
      error: "'messageIds' parameter is required for 'get_views' action",
    });
  }

  try {
    const views = await mtprotoClient!.getViews(
      pluginConfig.channel.chatId,
      params.messageIds,
    );
    return jsonResult({ ok: true, views });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function executeGetChannelStats(
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  try {
    const stats = await mtprotoClient!.getChannelStats(
      pluginConfig.channel.chatId,
    );
    return jsonResult({ ok: true, stats });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function executeGetPostStats(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  if (params.messageId == null) {
    return jsonResult({
      error: "'messageId' parameter is required for 'get_post_stats' action",
    });
  }

  try {
    const stats = await mtprotoClient!.getPostStats(
      pluginConfig.channel.chatId,
      params.messageId,
    );
    return jsonResult({ ok: true, stats });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function executeGetHistory(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  try {
    const messages = await mtprotoClient!.getHistory(
      pluginConfig.channel.chatId,
      { limit: params.limit, offsetId: params.offsetId },
    );
    return jsonResult({ ok: true, count: messages.length, messages });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function executeSchedulePost(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  const hasMedia = !!(
    (params.photoFileIds && params.photoFileIds.length > 0) ||
    (params.photoPaths && params.photoPaths.length > 0)
  );
  if (!hasMedia && !params.text) {
    return jsonResult({ error: "'text', 'photoFileIds', or 'photoPaths' is required for 'schedule_post'" });
  }
  if (!params.scheduleDate) {
    return jsonResult({ error: "'scheduleDate' (unix timestamp UTC) is required for 'schedule_post'" });
  }

  try {
    if (hasMedia) {
      type MediaSource = Parameters<MtprotoClient["scheduleMediaPost"]>[1][number];
      const sources: MediaSource[] = [];

      if (params.photoPaths && params.photoPaths.length > 0) {
        for (const p of params.photoPaths) {
          const buffer = await readFile(p);
          sources.push({ type: "localFile", buffer, fileName: basename(p) });
        }
      }
      if (params.photoFileIds && params.photoFileIds.length > 0) {
        const botToken = resolveBotToken(api.config, pluginConfig.telegramAccountId);
        for (const fid of params.photoFileIds) {
          sources.push({ type: "fileId", botToken, fileId: fid });
        }
      }

      const result = await mtprotoClient!.scheduleMediaPost(
        pluginConfig.channel.chatId,
        sources,
        {
          caption: params.text,
          scheduleDate: params.scheduleDate,
          silent: params.silent,
        },
      );
      return jsonResult({
        ok: true,
        messageIds: result.messageIds,
        scheduleDate: result.scheduleDate,
        scheduledFor: new Date(result.scheduleDate * 1000).toISOString(),
        type: sources.length > 1 ? "album" : "photo",
      });
    }

    const result = await mtprotoClient!.scheduleMessage(
      pluginConfig.channel.chatId,
      params.text!,
      params.scheduleDate,
      { silent: params.silent },
    );
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      scheduleDate: result.scheduleDate,
      scheduledFor: new Date(result.scheduleDate * 1000).toISOString(),
    });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function executeListScheduled(
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  try {
    const messages = await mtprotoClient!.getScheduledMessages(
      pluginConfig.channel.chatId,
    );
    return jsonResult({ ok: true, count: messages.length, messages });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function executeDeleteScheduled(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  if (!params.messageIds || params.messageIds.length === 0) {
    return jsonResult({ error: "'messageIds' parameter is required for 'delete_scheduled'" });
  }

  try {
    await mtprotoClient!.deleteScheduledMessages(
      pluginConfig.channel.chatId,
      params.messageIds,
    );
    return jsonResult({ ok: true, deleted: params.messageIds });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function executeSendScheduledNow(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  if (!params.messageIds || params.messageIds.length === 0) {
    return jsonResult({ error: "'messageIds' parameter is required for 'send_scheduled_now'" });
  }

  try {
    await mtprotoClient!.sendScheduledNow(
      pluginConfig.channel.chatId,
      params.messageIds,
    );
    return jsonResult({ ok: true, sent: params.messageIds });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
