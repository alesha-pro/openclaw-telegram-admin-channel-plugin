import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type ToolContext = {
  sessionKey?: string;
  agentAccountId?: string;
  messageChannel?: string;
};

import type { TelegramAdminChannelConfig } from "./schema.js";
import { resolveBotToken, TelegramBotApi, fetchPublicChannelPosts } from "./telegram-api.js";
import type { PostStorage, TemplateStorage } from "./storage.js";
import type { MtprotoClient } from "./mtproto-client.js";

const ToolParameters = Type.Object({
  action: Type.Unsafe<string>({
    type: "string",
    enum: ["post", "sync", "list_recent_activity", "get_views", "get_channel_stats", "get_post_stats", "get_history", "schedule_post", "list_scheduled", "delete_scheduled", "send_scheduled_now", "edit_post", "pin_post", "unpin_post", "delete_post", "forward_post", "react", "search", "status", "engagement_dashboard", "list_admins", "edit_admin", "create_template", "list_templates", "use_template", "delete_template"],
    description: "Action to perform",
  }),
  text: Type.Optional(Type.String({ description: "Post text content" })),
  parseMode: Type.Optional(
    Type.Unsafe<"HTML" | "Markdown" | "MarkdownV2">({
      type: "string",
      enum: ["HTML", "Markdown", "MarkdownV2"],
      description: "Parse mode for text formatting",
    }),
  ),
  silent: Type.Optional(
    Type.Boolean({ description: "Send without notification" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Number of items to return (default: 10)" }),
  ),
  messageIds: Type.Optional(
    Type.Array(Type.Number(), { description: "Message IDs for batch operations" }),
  ),
  messageId: Type.Optional(
    Type.Number({ description: "Single message ID for targeted operations" }),
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
  videoFileIds: Type.Optional(
    Type.Array(Type.String(), { description: "Telegram file_id(s) for video(s)" }),
  ),
  videoPaths: Type.Optional(
    Type.Array(Type.String(), { description: "Local file path(s) to video(s)" }),
  ),
  documentFileIds: Type.Optional(
    Type.Array(Type.String(), { description: "Telegram file_id(s) for document(s)" }),
  ),
  documentPaths: Type.Optional(
    Type.Array(Type.String(), { description: "Local file path(s) to document(s)" }),
  ),
  toChatId: Type.Optional(
    Type.String({ description: "Target chat ID for forward_post" }),
  ),
  emoji: Type.Optional(
    Type.String({ description: "Emoji for react action" }),
  ),
  query: Type.Optional(
    Type.String({ description: "Search query for search action" }),
  ),
  searchType: Type.Optional(
    Type.Union([
      Type.Literal("post"),
      Type.Literal("comment"),
      Type.Literal("all"),
    ], { description: "Type filter for search (default: all)" }),
  ),
  userId: Type.Optional(
    Type.Union([Type.Number(), Type.String()], { description: "User ID for edit_admin" }),
  ),
  adminRights: Type.Optional(
    Type.Object({
      changeInfo: Type.Optional(Type.Boolean()),
      postMessages: Type.Optional(Type.Boolean()),
      editMessages: Type.Optional(Type.Boolean()),
      deleteMessages: Type.Optional(Type.Boolean()),
      banUsers: Type.Optional(Type.Boolean()),
      inviteUsers: Type.Optional(Type.Boolean()),
      pinMessages: Type.Optional(Type.Boolean()),
      manageCall: Type.Optional(Type.Boolean()),
      addAdmins: Type.Optional(Type.Boolean()),
      rank: Type.Optional(Type.String()),
    }, { description: "Admin rights for edit_admin" }),
  ),
  periodDays: Type.Optional(
    Type.Number({ description: "Period in days for engagement_dashboard (default: 7)" }),
  ),
  templateName: Type.Optional(
    Type.String({ description: "Template name for create_template/use_template/delete_template" }),
  ),
  templateId: Type.Optional(
    Type.String({ description: "Template ID for use_template/delete_template" }),
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
  "'list_recent_activity' (show recent posts & comments, optional 'limit'), " +
  "'edit_post' (edit published post, requires 'messageId' and 'text'), " +
  "'pin_post'/'unpin_post' (pin/unpin message, requires 'messageId'), " +
  "'delete_post' (delete message, requires 'messageIds'), " +
  "'forward_post' (forward messages, requires 'messageIds' and 'toChatId'), " +
  "'react' (set reaction, requires 'messageId' and 'emoji'), " +
  "'search' (search posts/comments, requires 'query'), " +
  "'status' (check connection status). " +
  "Templates: 'create_template' (requires 'templateName' and 'text'), " +
  "'list_templates', 'use_template' (post from template, requires 'templateId' or 'templateName'), " +
  "'delete_template' (requires 'templateId').";

const MTPROTO_DESCRIPTION =
  " MTProto actions: " +
  "'get_views' (view/forward counts, requires 'messageIds'), " +
  "'get_channel_stats' (subscribers, growth, reach analytics), " +
  "'get_post_stats' (per-post views/reactions graphs, requires 'messageId'), " +
  "'get_history' (channel message history, optional 'limit' and 'offsetId'), " +
  "'engagement_dashboard' (engagement analytics: top posts, best hours, growth trend; optional 'periodDays' and 'limit'), " +
  "'list_admins' (list channel administrators), " +
  "'edit_admin' (edit admin rights, requires 'userId' and 'adminRights'). " +
  "Scheduled posts: " +
  "'schedule_post' (text or media, requires 'scheduleDate'; supports 'photoPaths'/'photoFileIds' for photos, 'videoPaths'/'videoFileIds' for videos, 'documentPaths'/'documentFileIds' for documents; multiple = album; 'text' as caption; note: parseMode is not supported for scheduled posts via MTProto), " +
  "'list_scheduled' (list all pending scheduled messages), " +
  "'delete_scheduled' (requires 'messageIds'), " +
  "'send_scheduled_now' (publish scheduled messages immediately, requires 'messageIds').";

const DANGEROUS_ACTIONS = new Set([
  "edit_post",
  "pin_post",
  "unpin_post",
  "delete_post",
  "delete_scheduled",
  "send_scheduled_now",
  "edit_admin",
]);

export function createToolFactory(
  api: OpenClawPluginApi,
  posts: PostStorage,
  mtprotoClient?: MtprotoClient,
  templates?: TemplateStorage,
) {
  const logger = api.logger;
  const description = mtprotoClient
    ? BASE_DESCRIPTION + MTPROTO_DESCRIPTION
    : BASE_DESCRIPTION;

  return (ctx: ToolContext) => ({
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

      // P1: ownerAllowFrom authorization check
      if (pluginConfig.ownerAllowFrom && pluginConfig.ownerAllowFrom.length > 0) {
        const senderId = ctx.agentAccountId ?? ctx.sessionKey;
        if (senderId && senderId !== "default" && !pluginConfig.ownerAllowFrom.includes(senderId)) {
          return jsonResult({
            error: `Access denied: sender "${senderId}" is not in ownerAllowFrom list.`,
          });
        }
      }

      // P4: dangerousActions guard
      if (DANGEROUS_ACTIONS.has(params.action) && !pluginConfig.dangerousActions?.enabled) {
        return jsonResult({
          error: `Action "${params.action}" requires dangerousActions.enabled=true in plugin config.`,
        });
      }

      const result = await executeAction(
        params,
        pluginConfig,
        api,
        posts,
        logger,
        mtprotoClient,
        templates,
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
  logger: PluginLogger,
  mtprotoClient?: MtprotoClient,
  templates?: TemplateStorage,
) {
  switch (params.action) {
    case "post":
      return executePost(params, pluginConfig, api, posts, logger);
    case "sync":
      return executeSync(pluginConfig, posts, logger, mtprotoClient);
    case "list_recent_activity":
      return executeListRecentActivity(params, posts);
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
    case "edit_post":
      return executeEditPost(params, pluginConfig, api, mtprotoClient);
    case "pin_post":
      return executePinPost(params, pluginConfig, api, mtprotoClient);
    case "unpin_post":
      return executeUnpinPost(params, pluginConfig, api, mtprotoClient);
    case "delete_post":
      return executeDeletePost(params, pluginConfig, api, mtprotoClient);
    case "forward_post":
      return executeForwardPost(params, pluginConfig, api, mtprotoClient);
    case "react":
      return executeReact(params, pluginConfig, mtprotoClient);
    case "search":
      return executeSearch(params, posts);
    case "status":
      return executeStatus(pluginConfig, api, posts, mtprotoClient);
    case "engagement_dashboard":
      return executeEngagementDashboard(params, pluginConfig, mtprotoClient);
    case "list_admins":
      return executeListAdmins(pluginConfig, mtprotoClient);
    case "edit_admin":
      return executeEditAdmin(params, pluginConfig, mtprotoClient);
    case "create_template":
      return executeCreateTemplate(params, templates);
    case "list_templates":
      return executeListTemplates(templates);
    case "use_template":
      return executeUseTemplate(params, pluginConfig, api, posts, logger, templates);
    case "delete_template":
      return executeDeleteTemplate(params, templates);
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

  // P5: null guard
  if (!result.result) {
    return jsonResult({
      error: "Telegram API returned ok but no result object.",
    });
  }

  const messageId = result.result.message_id;
  const chatUsername = result.result.chat?.username;
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
  mtprotoClient?: MtprotoClient,
) {
  const chatId = pluginConfig.channel.chatId;

  // U5: Use MTProto getHistory when available for more reliable sync
  if (mtprotoClient) {
    logger.info(`Syncing posts via MTProto from ${chatId}...`);
    try {
      const messages = await mtprotoClient.getHistory(chatId, { limit: 100 });

      let inserted = 0;
      let updated = 0;

      for (const msg of messages) {
        const isNew = await posts.upsertPost({
          messageId: msg.id,
          chatId,
          text: msg.text,
          timestamp: msg.date * 1000,
        });
        if (isNew) inserted++;
        else updated++;
      }

      logger.info(
        `Sync complete (MTProto): ${messages.length} fetched, ${inserted} new, ${updated} updated`,
      );

      return jsonResult({
        ok: true,
        total: messages.length,
        inserted,
        updated,
        source: "mtproto",
      });
    } catch (e) {
      logger.warn(`MTProto sync failed, falling back to HTML: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Fallback: HTML scraping for public channels
  const username = chatId.startsWith("@")
    ? chatId.slice(1)
    : chatId.startsWith("-")
      ? null
      : chatId;

  if (!username) {
    return jsonResult({
      error:
        "sync requires a public channel username (@channel) or MTProto enabled. " +
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
    source: "html",
  });
}

async function executeListRecentActivity(
  params: ToolParams,
  posts: PostStorage,
) {
  const limit = params.limit ?? 10;
  const recentPosts = await posts.getAll(limit);

  const items = recentPosts.map((p) => ({ type: "post" as const, data: p }));
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
    (params.photoPaths && params.photoPaths.length > 0) ||
    (params.videoFileIds && params.videoFileIds.length > 0) ||
    (params.videoPaths && params.videoPaths.length > 0) ||
    (params.documentFileIds && params.documentFileIds.length > 0) ||
    (params.documentPaths && params.documentPaths.length > 0)
  );
  if (!hasMedia && !params.text) {
    return jsonResult({ error: "'text' or media parameters (photoFileIds/photoPaths/videoFileIds/videoPaths/documentFileIds/documentPaths) required for 'schedule_post'" });
  }
  if (!params.scheduleDate) {
    return jsonResult({ error: "'scheduleDate' (unix timestamp UTC) is required for 'schedule_post'" });
  }

  // P6: Validate scheduleDate is in the future
  const nowUnix = Math.floor(Date.now() / 1000);
  if (params.scheduleDate <= nowUnix) {
    return jsonResult({
      error: `'scheduleDate' must be in the future. Provided: ${params.scheduleDate} (${new Date(params.scheduleDate * 1000).toISOString()}), current: ${nowUnix} (${new Date(nowUnix * 1000).toISOString()})`,
    });
  }

  try {
    if (hasMedia) {
      type MediaSource = Parameters<MtprotoClient["scheduleMediaPost"]>[1][number];
      const sources: MediaSource[] = [];

      // Photos
      if (params.photoPaths && params.photoPaths.length > 0) {
        for (const p of params.photoPaths) {
          const buffer = await readFile(p);
          sources.push({ type: "localFile", buffer, fileName: basename(p), mediaType: "photo" });
        }
      }
      if (params.photoFileIds && params.photoFileIds.length > 0) {
        const botToken = resolveBotToken(api.config, pluginConfig.telegramAccountId);
        for (const fid of params.photoFileIds) {
          sources.push({ type: "fileId", botToken, fileId: fid, mediaType: "photo" });
        }
      }

      // Videos
      if (params.videoPaths && params.videoPaths.length > 0) {
        for (const p of params.videoPaths) {
          const buffer = await readFile(p);
          sources.push({ type: "localFile", buffer, fileName: basename(p), mediaType: "video" });
        }
      }
      if (params.videoFileIds && params.videoFileIds.length > 0) {
        const botToken = resolveBotToken(api.config, pluginConfig.telegramAccountId);
        for (const fid of params.videoFileIds) {
          sources.push({ type: "fileId", botToken, fileId: fid, mediaType: "video" });
        }
      }

      // Documents
      if (params.documentPaths && params.documentPaths.length > 0) {
        for (const p of params.documentPaths) {
          const buffer = await readFile(p);
          sources.push({ type: "localFile", buffer, fileName: basename(p), mediaType: "document" });
        }
      }
      if (params.documentFileIds && params.documentFileIds.length > 0) {
        const botToken = resolveBotToken(api.config, pluginConfig.telegramAccountId);
        for (const fid of params.documentFileIds) {
          sources.push({ type: "fileId", botToken, fileId: fid, mediaType: "document" });
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
      const mediaTypes = new Set(sources.map((s) => s.mediaType ?? "photo"));
      const typeLabel = sources.length > 1
        ? "album"
        : mediaTypes.has("video")
          ? "video"
          : mediaTypes.has("document")
            ? "document"
            : "photo";
      return jsonResult({
        ok: true,
        messageIds: result.messageIds,
        scheduleDate: result.scheduleDate,
        scheduledFor: new Date(result.scheduleDate * 1000).toISOString(),
        type: typeLabel,
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

// --- New action handlers ---

// F1: Edit post
async function executeEditPost(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  mtprotoClient?: MtprotoClient,
) {
  if (params.messageId == null) {
    return jsonResult({ error: "'messageId' parameter is required for 'edit_post'" });
  }
  if (!params.text) {
    return jsonResult({ error: "'text' parameter is required for 'edit_post'" });
  }

  const chatId = pluginConfig.channel.chatId;

  // Prefer MTProto if available, fallback to Bot API
  if (mtprotoClient) {
    try {
      await mtprotoClient.editMessage(chatId, params.messageId, params.text);
      return jsonResult({ ok: true, messageId: params.messageId, action: "edited" });
    } catch (e) {
      return jsonResult({
        error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Bot API fallback
  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    await TelegramBotApi.editMessageText(token, chatId, params.messageId, params.text, {
      parseMode: params.parseMode,
    });
    return jsonResult({ ok: true, messageId: params.messageId, action: "edited" });
  } catch (e) {
    return jsonResult({
      error: `Telegram API error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// F2: Pin post
async function executePinPost(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  mtprotoClient?: MtprotoClient,
) {
  if (params.messageId == null) {
    return jsonResult({ error: "'messageId' parameter is required for 'pin_post'" });
  }

  const chatId = pluginConfig.channel.chatId;

  if (mtprotoClient) {
    try {
      await mtprotoClient.pinMessage(chatId, params.messageId, { silent: params.silent });
      return jsonResult({ ok: true, messageId: params.messageId, action: "pinned" });
    } catch (e) {
      return jsonResult({
        error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    await TelegramBotApi.pinChatMessage(token, chatId, params.messageId, {
      disableNotification: params.silent,
    });
    return jsonResult({ ok: true, messageId: params.messageId, action: "pinned" });
  } catch (e) {
    return jsonResult({
      error: `Telegram API error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// F2: Unpin post
async function executeUnpinPost(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  mtprotoClient?: MtprotoClient,
) {
  if (params.messageId == null) {
    return jsonResult({ error: "'messageId' parameter is required for 'unpin_post'" });
  }

  const chatId = pluginConfig.channel.chatId;

  if (mtprotoClient) {
    try {
      await mtprotoClient.unpinMessage(chatId, params.messageId);
      return jsonResult({ ok: true, messageId: params.messageId, action: "unpinned" });
    } catch (e) {
      return jsonResult({
        error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    await TelegramBotApi.unpinChatMessage(token, chatId, params.messageId);
    return jsonResult({ ok: true, messageId: params.messageId, action: "unpinned" });
  } catch (e) {
    return jsonResult({
      error: `Telegram API error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// F3: Delete post
async function executeDeletePost(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  mtprotoClient?: MtprotoClient,
) {
  if (!params.messageIds || params.messageIds.length === 0) {
    return jsonResult({ error: "'messageIds' parameter is required for 'delete_post'" });
  }

  const chatId = pluginConfig.channel.chatId;

  if (mtprotoClient) {
    try {
      await mtprotoClient.deleteMessages(chatId, params.messageIds);
      return jsonResult({ ok: true, deleted: params.messageIds });
    } catch (e) {
      return jsonResult({
        error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Bot API fallback — delete one by one
  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    for (const msgId of params.messageIds) {
      await TelegramBotApi.deleteMessage(token, chatId, msgId);
    }
    return jsonResult({ ok: true, deleted: params.messageIds });
  } catch (e) {
    return jsonResult({
      error: `Telegram API error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// F4: Forward post
async function executeForwardPost(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  mtprotoClient?: MtprotoClient,
) {
  if (!params.messageIds || params.messageIds.length === 0) {
    return jsonResult({ error: "'messageIds' parameter is required for 'forward_post'" });
  }
  if (!params.toChatId) {
    return jsonResult({ error: "'toChatId' parameter is required for 'forward_post'" });
  }

  const chatId = pluginConfig.channel.chatId;

  if (mtprotoClient) {
    try {
      const forwarded = await mtprotoClient.forwardMessages(
        chatId,
        params.toChatId,
        params.messageIds,
        { silent: params.silent },
      );
      return jsonResult({ ok: true, forwarded, toChatId: params.toChatId });
    } catch (e) {
      return jsonResult({
        error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Bot API fallback — forward one by one
  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    const forwarded: number[] = [];
    for (const msgId of params.messageIds) {
      const result = await TelegramBotApi.forwardMessage(
        token,
        chatId,
        params.toChatId,
        msgId,
        { disableNotification: params.silent },
      );
      if (result.result) {
        forwarded.push(result.result.message_id);
      }
    }
    return jsonResult({ ok: true, forwarded, toChatId: params.toChatId });
  } catch (e) {
    return jsonResult({
      error: `Telegram API error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// F8: React
async function executeReact(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  if (params.messageId == null) {
    return jsonResult({ error: "'messageId' parameter is required for 'react'" });
  }
  if (!params.emoji) {
    return jsonResult({ error: "'emoji' parameter is required for 'react'" });
  }

  try {
    await mtprotoClient!.sendReaction(
      pluginConfig.channel.chatId,
      params.messageId,
      params.emoji,
    );
    return jsonResult({ ok: true, messageId: params.messageId, emoji: params.emoji });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// F11: Search
async function executeSearch(
  params: ToolParams,
  posts: PostStorage,
) {
  if (!params.query) {
    return jsonResult({ error: "'query' parameter is required for 'search'" });
  }

  const limit = params.limit ?? 20;
  const results: Array<{ type: "post"; data: unknown }> = [];

  const matchedPosts = await posts.search(params.query, { limit });
  for (const p of matchedPosts) {
    results.push({ type: "post", data: p });
  }

  return jsonResult({
    ok: true,
    query: params.query,
    count: results.length,
    results: results.slice(0, limit),
  });
}

// F7: Status
async function executeStatus(
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  posts: PostStorage,
  mtprotoClient?: MtprotoClient,
) {
  let botOk = false;
  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await resp.json()) as { ok: boolean };
    botOk = data.ok;
  } catch {
    // bot token invalid or network error
  }

  const allPosts = await posts.getAll();

  return jsonResult({
    ok: true,
    botOk,
    mtprotoEnabled: !!pluginConfig.mtproto?.enabled,
    mtprotoConnected: mtprotoClient?.isConnected ?? false,
    dangerousActionsEnabled: pluginConfig.dangerousActions?.enabled ?? false,
    postsCount: allPosts.length,
    channelChatId: pluginConfig.channel.chatId,
  });
}

// --- F12: Admin management ---

async function executeListAdmins(
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  try {
    const admins = await mtprotoClient!.getAdmins(pluginConfig.channel.chatId);
    return jsonResult({ ok: true, count: admins.length, admins });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function executeEditAdmin(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  if (params.userId == null) {
    return jsonResult({ error: "'userId' is required for 'edit_admin'" });
  }
  if (!params.adminRights) {
    return jsonResult({ error: "'adminRights' object is required for 'edit_admin'" });
  }

  try {
    await mtprotoClient!.editAdmin(
      pluginConfig.channel.chatId,
      params.userId,
      params.adminRights,
    );
    return jsonResult({ ok: true, userId: params.userId, action: "admin_updated" });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// --- F9: Engagement Dashboard ---

async function executeEngagementDashboard(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  const chatId = pluginConfig.channel.chatId;
  const limit = params.limit ?? 50;
  const periodDays = params.periodDays ?? 7;
  const cutoffTs = Math.floor(Date.now() / 1000) - periodDays * 86400;

  try {
    // Fetch recent history
    const messages = await mtprotoClient!.getHistory(chatId, { limit });

    // Filter by period
    const periodMessages = messages.filter((m) => m.date >= cutoffTs);

    // Get channel stats
    let channelStats;
    try {
      channelStats = await mtprotoClient!.getChannelStats(chatId);
    } catch {
      // Stats may not be available for small channels
    }

    // Compute engagement metrics
    const totalViews = periodMessages.reduce((s, m) => s + (m.views ?? 0), 0);
    const totalForwards = periodMessages.reduce((s, m) => s + (m.forwards ?? 0), 0);
    const totalReactions = periodMessages.reduce(
      (s, m) => s + (m.reactions?.reduce((rs, r) => rs + r.count, 0) ?? 0),
      0,
    );
    const count = periodMessages.length || 1;

    // Top posts by views
    const topByViews = [...periodMessages]
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
      .slice(0, 5)
      .map((m) => ({
        id: m.id,
        text: m.text.slice(0, 80),
        views: m.views ?? 0,
        forwards: m.forwards ?? 0,
        reactions: m.reactions?.reduce((s, r) => s + r.count, 0) ?? 0,
      }));

    // Top posts by reactions
    const topByReactions = [...periodMessages]
      .sort((a, b) => {
        const ar = a.reactions?.reduce((s, r) => s + r.count, 0) ?? 0;
        const br = b.reactions?.reduce((s, r) => s + r.count, 0) ?? 0;
        return br - ar;
      })
      .slice(0, 5)
      .map((m) => ({
        id: m.id,
        text: m.text.slice(0, 80),
        views: m.views ?? 0,
        reactions: m.reactions?.reduce((s, r) => s + r.count, 0) ?? 0,
      }));

    // Best hours (by post count in period)
    const hourCounts = new Array(24).fill(0) as number[];
    for (const m of periodMessages) {
      const hour = new Date(m.date * 1000).getUTCHours();
      hourCounts[hour]++;
    }
    const bestHours = hourCounts
      .map((count, hour) => ({ hour, count }))
      .filter((h) => h.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return jsonResult({
      ok: true,
      periodDays,
      postsInPeriod: periodMessages.length,
      avgViews: Math.round(totalViews / count),
      avgForwards: Math.round(totalForwards / count),
      avgReactions: Math.round(totalReactions / count),
      totalViews,
      totalForwards,
      totalReactions,
      topByViews,
      topByReactions,
      bestPostingHoursUTC: bestHours,
      followers: channelStats?.followers,
      growthTrend: channelStats
        ? {
            current: channelStats.followers.current,
            previous: channelStats.followers.previous,
            change: channelStats.followers.current - channelStats.followers.previous,
          }
        : undefined,
    });
  } catch (e) {
    return jsonResult({
      error: `MTProto error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// --- F6: Template CRUD ---

function requireTemplates(templates?: TemplateStorage) {
  if (!templates) {
    return jsonResult({ error: "Templates storage not initialized." });
  }
  return null;
}

async function executeCreateTemplate(
  params: ToolParams,
  templates?: TemplateStorage,
) {
  const err = requireTemplates(templates);
  if (err) return err;

  if (!params.templateName) {
    return jsonResult({ error: "'templateName' is required for 'create_template'" });
  }
  if (!params.text) {
    return jsonResult({ error: "'text' is required for 'create_template'" });
  }

  const existing = await templates!.getByName(params.templateName);
  if (existing) {
    return jsonResult({ error: `Template "${params.templateName}" already exists (id: ${existing.id})` });
  }

  const id = `tpl_${Date.now().toString(36)}`;
  await templates!.add({
    id,
    name: params.templateName,
    text: params.text,
    parseMode: params.parseMode,
    mediaFileIds: params.photoFileIds,
  });

  return jsonResult({ ok: true, id, name: params.templateName, action: "created" });
}

async function executeListTemplates(
  templates?: TemplateStorage,
) {
  const err = requireTemplates(templates);
  if (err) return err;

  const all = await templates!.getAll();
  return jsonResult({
    ok: true,
    count: all.length,
    templates: all.map((t) => ({ id: t.id, name: t.name, textPreview: t.text.slice(0, 100) })),
  });
}

async function executeUseTemplate(
  params: ToolParams,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  posts: PostStorage,
  logger: PluginLogger,
  templates?: TemplateStorage,
) {
  const err = requireTemplates(templates);
  if (err) return err;

  const tpl = params.templateId
    ? await templates!.getById(params.templateId)
    : params.templateName
      ? await templates!.getByName(params.templateName)
      : undefined;

  if (!tpl) {
    return jsonResult({ error: "Template not found. Provide 'templateId' or 'templateName'." });
  }

  // Post using the template
  const chatId = pluginConfig.channel.chatId;
  const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
  const silent = params.silent ?? pluginConfig.defaults?.silent ?? false;

  const result = await TelegramBotApi.sendMessage(token, chatId, tpl.text, {
    parseMode: tpl.parseMode,
    disableNotification: silent,
  });

  if (!result.result) {
    return jsonResult({ error: "Telegram API returned ok but no result object." });
  }

  const messageId = result.result.message_id;
  const chatUsername = result.result.chat?.username;
  const permalink = chatUsername
    ? `https://t.me/${chatUsername}/${messageId}`
    : undefined;

  await posts.add({
    messageId,
    chatId,
    text: tpl.text,
    timestamp: Date.now(),
    permalink,
  });

  logger.info(`Posted from template "${tpl.name}" — message ${messageId}`);

  return jsonResult({
    ok: true,
    messageId,
    chatId,
    permalink,
    template: tpl.name,
  });
}

async function executeDeleteTemplate(
  params: ToolParams,
  templates?: TemplateStorage,
) {
  const err = requireTemplates(templates);
  if (err) return err;

  const id = params.templateId;
  if (!id) {
    return jsonResult({ error: "'templateId' is required for 'delete_template'" });
  }

  const removed = await templates!.removeById(id);
  if (!removed) {
    return jsonResult({ error: `Template "${id}" not found.` });
  }
  return jsonResult({ ok: true, id, action: "deleted" });
}
