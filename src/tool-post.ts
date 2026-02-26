import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import { resolveBotToken, TelegramBotApi, fetchPublicChannelPosts } from "./telegram-api.js";
import type { PostStorage, CommentStorage, TemplateStorage } from "./storage.js";
import type { MtprotoClient } from "./mtproto-client.js";
import {
  type ToolContext,
  type PluginLogger,
  SharedParams,
  checkAuth,
  checkDangerous,
  getConfig,
  toTelegramHtml,
  hasMarkdownFormatting,
} from "./tool-shared.js";

const PostToolParams = Type.Object({
  action: Type.Unsafe<"post" | "edit_post" | "delete_post" | "forward_post" | "sync" | "list_recent_activity" | "create_template" | "list_templates" | "use_template" | "delete_template">({
    type: "string",
    enum: ["post", "edit_post", "delete_post", "forward_post", "sync", "list_recent_activity", "create_template", "list_templates", "use_template", "delete_template"],
    description: "Action to perform",
  }),
  ...SharedParams,
  toChatId: Type.Optional(
    Type.String({ description: "Target chat ID for forward_post" }),
  ),
  templateName: Type.Optional(
    Type.String({ description: "Template name for create_template/use_template/delete_template" }),
  ),
  templateId: Type.Optional(
    Type.String({ description: "Template ID for use_template/delete_template" }),
  ),
});

type Params = Static<typeof PostToolParams>;

const DANGEROUS_ACTIONS = new Set(["edit_post", "delete_post"]);

const DESCRIPTION =
  "Telegram channel post operations: " +
  "'post' (publish text, requires 'text'), " +
  "'edit_post' (edit published post, requires 'messageId' and 'text'), " +
  "'delete_post' (delete messages, requires 'messageIds'), " +
  "'forward_post' (forward messages, requires 'messageIds' and 'toChatId'), " +
  "'sync' (fetch posts from channel), " +
  "'list_recent_activity' (show recent posts & comments, optional 'limit'). " +
  "Templates: 'create_template' (requires 'templateName' and 'text'), " +
  "'list_templates', 'use_template' (post from template, requires 'templateId' or 'templateName'), " +
  "'delete_template' (requires 'templateId').";

export function createPostToolFactory(
  api: OpenClawPluginApi,
  posts: PostStorage,
  comments: CommentStorage,
  mtprotoClient?: MtprotoClient,
  templates?: TemplateStorage,
) {
  const logger = api.logger;

  return (ctx: ToolContext) => ({
    name: "tg_channel_post",
    label: "Telegram Channel Posts",
    description: DESCRIPTION,
    parameters: PostToolParams,
    async execute(_toolCallId: string, params: Params) {
      const { cfg, err } = getConfig(api);
      if (err) return err;

      const authErr = checkAuth(ctx, cfg);
      if (authErr) return authErr;

      const dangerErr = checkDangerous(params.action, DANGEROUS_ACTIONS, cfg);
      if (dangerErr) return dangerErr;

      switch (params.action) {
        case "post":
          return executePost(params, cfg, api, posts, logger);
        case "edit_post":
          return executeEditPost(params, cfg, api, mtprotoClient);
        case "delete_post":
          return executeDeletePost(params, cfg, api, mtprotoClient);
        case "forward_post":
          return executeForwardPost(params, cfg, api, mtprotoClient);
        case "sync":
          return executeSync(cfg, posts, logger, mtprotoClient);
        case "list_recent_activity":
          return executeListRecentActivity(params, posts, comments);
        case "create_template":
          return executeCreateTemplate(params, templates);
        case "list_templates":
          return executeListTemplates(templates);
        case "use_template":
          return executeUseTemplate(params, cfg, api, posts, logger, templates);
        case "delete_template":
          return executeDeleteTemplate(params, templates);
        default:
          return jsonResult({ error: `Unknown action: ${String(params.action)}` });
      }
    },
  });
}

async function executePost(
  params: Params,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  posts: PostStorage,
  logger: PluginLogger,
) {
  if (!params.text) {
    return jsonResult({ error: "'text' parameter is required for 'post' action" });
  }

  const chatId = pluginConfig.channel.chatId;
  const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
  const silent = params.silent ?? pluginConfig.defaults?.silent ?? false;

  // Auto-convert markdown to HTML when no parseMode is specified
  let text = params.text;
  let parseMode = params.parseMode ?? pluginConfig.defaults?.parseMode;
  if (!parseMode && hasMarkdownFormatting(text)) {
    text = toTelegramHtml(text);
    parseMode = "HTML";
  }

  logger.info(`Posting to channel ${chatId}...`);

  const result = await TelegramBotApi.sendMessage(token, chatId, text, {
    parseMode,
    disableNotification: silent,
  });

  if (!result.result) {
    return jsonResult({ error: "Telegram API returned ok but no result object." });
  }

  const messageId = result.result.message_id;
  const chatUsername = result.result.chat?.username;
  const permalink = chatUsername ? `https://t.me/${chatUsername}/${messageId}` : undefined;

  await posts.add({
    messageId,
    chatId,
    text: params.text,
    timestamp: Date.now(),
    permalink,
  });

  logger.info(`Posted message ${messageId} to ${chatId}`);
  return jsonResult({ ok: true, messageId, chatId, permalink });
}

async function executeEditPost(
  params: Params,
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

  // Auto-convert markdown to HTML when no parseMode is specified
  let text = params.text;
  let parseMode = params.parseMode ?? pluginConfig.defaults?.parseMode;
  if (!parseMode && hasMarkdownFormatting(text)) {
    text = toTelegramHtml(text);
    parseMode = "HTML";
  }

  if (mtprotoClient) {
    try {
      await mtprotoClient.editMessage(chatId, params.messageId, text);
      return jsonResult({ ok: true, messageId: params.messageId, action: "edited" });
    } catch (e) {
      return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    await TelegramBotApi.editMessageText(token, chatId, params.messageId, text, {
      parseMode,
    });
    return jsonResult({ ok: true, messageId: params.messageId, action: "edited" });
  } catch (e) {
    return jsonResult({ error: `Telegram API error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeDeletePost(
  params: Params,
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
      return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    for (const msgId of params.messageIds) {
      await TelegramBotApi.deleteMessage(token, chatId, msgId);
    }
    return jsonResult({ ok: true, deleted: params.messageIds });
  } catch (e) {
    return jsonResult({ error: `Telegram API error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeForwardPost(
  params: Params,
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
      const forwarded = await mtprotoClient.forwardMessages(chatId, params.toChatId, params.messageIds, { silent: params.silent });
      return jsonResult({ ok: true, forwarded, toChatId: params.toChatId });
    } catch (e) {
      return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    const forwarded: number[] = [];
    for (const msgId of params.messageIds) {
      const result = await TelegramBotApi.forwardMessage(token, chatId, params.toChatId, msgId, {
        disableNotification: params.silent,
      });
      if (result.result) forwarded.push(result.result.message_id);
    }
    return jsonResult({ ok: true, forwarded, toChatId: params.toChatId });
  } catch (e) {
    return jsonResult({ error: `Telegram API error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeSync(
  pluginConfig: TelegramAdminChannelConfig,
  posts: PostStorage,
  logger: PluginLogger,
  mtprotoClient?: MtprotoClient,
) {
  const chatId = pluginConfig.channel.chatId;

  if (mtprotoClient) {
    logger.info(`Syncing posts via MTProto from ${chatId}...`);
    try {
      const messages = await mtprotoClient.getHistory(chatId, { limit: 100 });
      let inserted = 0;
      let updated = 0;
      for (const msg of messages) {
        const isNew = await posts.upsertPost({
          messageId: msg.id, chatId, text: msg.text, timestamp: msg.date * 1000,
        });
        if (isNew) inserted++; else updated++;
      }
      logger.info(`Sync complete (MTProto): ${messages.length} fetched, ${inserted} new, ${updated} updated`);
      return jsonResult({ ok: true, total: messages.length, inserted, updated, source: "mtproto" });
    } catch (e) {
      logger.warn(`MTProto sync failed, falling back to HTML: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const username = chatId.startsWith("@") ? chatId.slice(1) : chatId.startsWith("-") ? null : chatId;
  if (!username) {
    return jsonResult({
      error: "sync requires a public channel username (@channel) or MTProto enabled. Numeric chat IDs cannot be synced via public page.",
    });
  }

  logger.info(`Syncing posts from t.me/s/${username}...`);
  const parsed = await fetchPublicChannelPosts(username);
  let inserted = 0;
  let updated = 0;
  for (const post of parsed) {
    const isNew = await posts.upsertPost({
      messageId: post.messageId, chatId, text: post.text, timestamp: post.timestamp, permalink: post.permalink,
    });
    if (isNew) inserted++; else updated++;
  }
  logger.info(`Sync complete: ${parsed.length} parsed, ${inserted} new, ${updated} updated`);
  return jsonResult({ ok: true, total: parsed.length, inserted, updated, source: "html" });
}

async function executeListRecentActivity(
  params: Params,
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

  return jsonResult({ ok: true, count: items.length, activity: items.slice(0, limit) });
}

// --- Templates ---

function requireTemplates(templates?: TemplateStorage) {
  if (!templates) return jsonResult({ error: "Templates storage not initialized." });
  return null;
}

async function executeCreateTemplate(params: Params, templates?: TemplateStorage) {
  const err = requireTemplates(templates);
  if (err) return err;
  if (!params.templateName) return jsonResult({ error: "'templateName' is required for 'create_template'" });
  if (!params.text) return jsonResult({ error: "'text' is required for 'create_template'" });

  const existing = await templates!.getByName(params.templateName);
  if (existing) return jsonResult({ error: `Template "${params.templateName}" already exists (id: ${existing.id})` });

  const id = `tpl_${Date.now().toString(36)}`;
  await templates!.add({ id, name: params.templateName, text: params.text, parseMode: params.parseMode });
  return jsonResult({ ok: true, id, name: params.templateName, action: "created" });
}

async function executeListTemplates(templates?: TemplateStorage) {
  const err = requireTemplates(templates);
  if (err) return err;
  const all = await templates!.getAll();
  return jsonResult({
    ok: true, count: all.length,
    templates: all.map((t) => ({ id: t.id, name: t.name, textPreview: t.text.slice(0, 100) })),
  });
}

async function executeUseTemplate(
  params: Params,
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
  if (!tpl) return jsonResult({ error: "Template not found. Provide 'templateId' or 'templateName'." });

  const chatId = pluginConfig.channel.chatId;
  const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
  const silent = params.silent ?? pluginConfig.defaults?.silent ?? false;

  const result = await TelegramBotApi.sendMessage(token, chatId, tpl.text, {
    parseMode: tpl.parseMode, disableNotification: silent,
  });
  if (!result.result) return jsonResult({ error: "Telegram API returned ok but no result object." });

  const messageId = result.result.message_id;
  const chatUsername = result.result.chat?.username;
  const permalink = chatUsername ? `https://t.me/${chatUsername}/${messageId}` : undefined;

  await posts.add({ messageId, chatId, text: tpl.text, timestamp: Date.now(), permalink });
  logger.info(`Posted from template "${tpl.name}" — message ${messageId}`);
  return jsonResult({ ok: true, messageId, chatId, permalink, template: tpl.name });
}

async function executeDeleteTemplate(params: Params, templates?: TemplateStorage) {
  const err = requireTemplates(templates);
  if (err) return err;
  if (!params.templateId) return jsonResult({ error: "'templateId' is required for 'delete_template'" });
  const removed = await templates!.removeById(params.templateId);
  if (!removed) return jsonResult({ error: `Template "${params.templateId}" not found.` });
  return jsonResult({ ok: true, id: params.templateId, action: "deleted" });
}
