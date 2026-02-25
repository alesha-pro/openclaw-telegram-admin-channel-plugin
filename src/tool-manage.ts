import { Type, type Static } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import { resolveBotToken, TelegramBotApi } from "./telegram-api.js";
import type { PostStorage, CommentStorage } from "./storage.js";
import type { MtprotoClient } from "./mtproto-client.js";
import {
  type ToolContext,
  SharedParams,
  checkAuth,
  checkDangerous,
  getConfig,
  requireMtproto,
} from "./tool-shared.js";

const ManageToolParams = Type.Object({
  action: Type.Unsafe<"pin_post" | "unpin_post" | "react" | "search" | "status" | "list_admins" | "edit_admin" | "list_pending_comments" | "reply_comment" | "skip_comment">({
    type: "string",
    enum: ["pin_post", "unpin_post", "react", "search", "status", "list_admins", "edit_admin", "list_pending_comments", "reply_comment", "skip_comment"],
    description: "Action to perform",
  }),
  ...SharedParams,
  emoji: Type.Optional(
    Type.String({ description: "Emoji for react action" }),
  ),
  query: Type.Optional(
    Type.String({ description: "Search query for search action" }),
  ),
  searchType: Type.Optional(
    Type.Unsafe<"post" | "comment" | "all">({
      type: "string",
      enum: ["post", "comment", "all"],
      description: "Type filter for search (default: all)",
    }),
  ),
  userId: Type.Optional(
    Type.Union([Type.Number(), Type.String()], { description: "User ID for edit_admin" }),
  ),
  replyText: Type.Optional(
    Type.String({ description: "Text to reply with for reply_comment action" }),
  ),
  chatId: Type.Optional(
    Type.String({ description: "Chat ID for comment operations (defaults to discussion chatId)" }),
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
});

type Params = Static<typeof ManageToolParams>;

const DANGEROUS_ACTIONS = new Set(["pin_post", "unpin_post", "edit_admin"]);

const DESCRIPTION =
  "Telegram channel management: " +
  "'pin_post'/'unpin_post' (pin/unpin message, requires 'messageId'), " +
  "'react' (set reaction, requires 'messageId' and 'emoji', MTProto only), " +
  "'search' (search posts/comments, requires 'query'), " +
  "'status' (check connection status), " +
  "'list_admins' (list channel administrators, MTProto only), " +
  "'edit_admin' (edit admin rights, requires 'userId' and 'adminRights', MTProto only), " +
  "'list_pending_comments' (list comments awaiting reply), " +
  "'reply_comment' (manually reply to a comment, requires 'messageId' and 'replyText'), " +
  "'skip_comment' (mark comment as skipped, requires 'messageId').";

export function createManageToolFactory(
  api: OpenClawPluginApi,
  posts: PostStorage,
  comments: CommentStorage,
  mtprotoClient?: MtprotoClient,
) {
  return (ctx: ToolContext) => ({
    name: "tg_channel_manage",
    label: "Telegram Channel Manage",
    description: DESCRIPTION,
    parameters: ManageToolParams,
    async execute(_toolCallId: string, params: Params) {
      const { cfg, err } = getConfig(api);
      if (err) return err;

      const authErr = checkAuth(ctx, cfg);
      if (authErr) return authErr;

      const dangerErr = checkDangerous(params.action, DANGEROUS_ACTIONS, cfg);
      if (dangerErr) return dangerErr;

      switch (params.action) {
        case "pin_post":
          return executePinPost(params, cfg, api, mtprotoClient);
        case "unpin_post":
          return executeUnpinPost(params, cfg, api, mtprotoClient);
        case "react":
          return executeReact(params, cfg, mtprotoClient);
        case "search":
          return executeSearch(params, posts, comments);
        case "status":
          return executeStatus(cfg, api, posts, comments, mtprotoClient);
        case "list_admins":
          return executeListAdmins(cfg, mtprotoClient);
        case "edit_admin":
          return executeEditAdmin(params, cfg, mtprotoClient);
        case "list_pending_comments":
          return executeListPendingComments(params, comments);
        case "reply_comment":
          return executeReplyComment(params, cfg, api, comments);
        case "skip_comment":
          return executeSkipComment(params, cfg, comments);
        default:
          return jsonResult({ error: `Unknown action: ${String(params.action)}` });
      }
    },
  });
}

async function executePinPost(
  params: Params,
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
      return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    await TelegramBotApi.pinChatMessage(token, chatId, params.messageId, {
      disableNotification: params.silent,
    });
    return jsonResult({ ok: true, messageId: params.messageId, action: "pinned" });
  } catch (e) {
    return jsonResult({ error: `Telegram API error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeUnpinPost(
  params: Params,
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
      return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    await TelegramBotApi.unpinChatMessage(token, chatId, params.messageId);
    return jsonResult({ ok: true, messageId: params.messageId, action: "unpinned" });
  } catch (e) {
    return jsonResult({ error: `Telegram API error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeReact(
  params: Params,
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
    await mtprotoClient!.sendReaction(pluginConfig.channel.chatId, params.messageId, params.emoji);
    return jsonResult({ ok: true, messageId: params.messageId, emoji: params.emoji });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeSearch(
  params: Params,
  posts: PostStorage,
  comments: CommentStorage,
) {
  if (!params.query) {
    return jsonResult({ error: "'query' parameter is required for 'search'" });
  }
  const searchType = params.searchType ?? "all";
  const limit = params.limit ?? 20;
  const results: Array<{ type: "post" | "comment"; data: unknown }> = [];

  if (searchType === "all" || searchType === "post") {
    for (const p of await posts.search(params.query, { limit })) {
      results.push({ type: "post", data: p });
    }
  }
  if (searchType === "all" || searchType === "comment") {
    for (const c of await comments.search(params.query, { limit })) {
      results.push({ type: "comment", data: c });
    }
  }

  return jsonResult({ ok: true, query: params.query, count: results.length, results: results.slice(0, limit) });
}

async function executeStatus(
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  posts: PostStorage,
  comments: CommentStorage,
  mtprotoClient?: MtprotoClient,
) {
  let botOk = false;
  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await resp.json()) as { ok: boolean };
    botOk = data.ok;
  } catch { /* ignore */ }

  const allPosts = await posts.getAll();
  const allComments = await comments.getFiltered();

  return jsonResult({
    ok: true, botOk,
    mtprotoEnabled: !!pluginConfig.mtproto?.enabled,
    mtprotoConnected: mtprotoClient?.isConnected ?? false,
    dangerousActionsEnabled: pluginConfig.dangerousActions?.enabled ?? false,
    postsCount: allPosts.length, commentsCount: allComments.length,
    channelChatId: pluginConfig.channel.chatId,
    discussionChatId: pluginConfig.discussion?.chatId,
  });
}

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
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeEditAdmin(
  params: Params,
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
    await mtprotoClient!.editAdmin(pluginConfig.channel.chatId, params.userId, params.adminRights);
    return jsonResult({ ok: true, userId: params.userId, action: "admin_updated" });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeListPendingComments(
  params: Params,
  comments: CommentStorage,
) {
  const limit = params.limit ?? 20;
  const pending = await comments.getPending(limit);
  return jsonResult({
    ok: true,
    count: pending.length,
    comments: pending.map((c) => ({
      messageId: c.messageId,
      chatId: c.chatId,
      from: c.from,
      fromName: c.fromName,
      text: c.text.slice(0, 300),
      threadId: c.threadId,
      timestamp: c.timestamp,
    })),
  });
}

async function executeReplyComment(
  params: Params,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  comments: CommentStorage,
) {
  if (params.messageId == null) {
    return jsonResult({ error: "'messageId' is required for 'reply_comment'" });
  }
  if (!params.replyText) {
    return jsonResult({ error: "'replyText' is required for 'reply_comment'" });
  }

  const discussionChatId = pluginConfig.discussion?.chatId;
  if (!discussionChatId) {
    return jsonResult({ error: "discussion.chatId not configured" });
  }

  const chatId = params.chatId ?? discussionChatId;
  const comment = await comments.getByMessageId(params.messageId, chatId);
  if (!comment) {
    return jsonResult({ error: `Comment ${params.messageId} not found in chat ${chatId}` });
  }

  try {
    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    const sendResult = await TelegramBotApi.sendMessage(
      token,
      discussionChatId,
      params.replyText,
      {
        replyToMessageId: params.messageId,
        messageThreadId: comment.threadId,
      },
    );

    const replyMsgId = sendResult.result?.message_id ?? 0;
    await comments.markReplied(params.messageId, chatId, {
      replyMessageId: replyMsgId,
    });

    return jsonResult({
      ok: true,
      messageId: params.messageId,
      replyMessageId: replyMsgId,
      action: "replied",
    });
  } catch (e) {
    return jsonResult({ error: `Telegram API error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeSkipComment(
  params: Params,
  pluginConfig: TelegramAdminChannelConfig,
  comments: CommentStorage,
) {
  if (params.messageId == null) {
    return jsonResult({ error: "'messageId' is required for 'skip_comment'" });
  }

  const discussionChatId = pluginConfig.discussion?.chatId;
  if (!discussionChatId) {
    return jsonResult({ error: "discussion.chatId not configured" });
  }

  const chatId = params.chatId ?? discussionChatId;
  const found = await comments.markSkipped(params.messageId, chatId);
  if (!found) {
    return jsonResult({ error: `Comment ${params.messageId} not found in chat ${chatId}` });
  }

  return jsonResult({ ok: true, messageId: params.messageId, action: "skipped" });
}
