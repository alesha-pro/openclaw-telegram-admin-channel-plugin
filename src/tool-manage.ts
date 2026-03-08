import { Type, type Static } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import { resolveBotToken, TelegramBotApi } from "./telegram-api.js";
import type { PostStorage } from "./storage.js";
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
  action: Type.Unsafe<"pin_post" | "unpin_post" | "react" | "search" | "status" | "list_admins" | "edit_admin">({
    type: "string",
    enum: ["pin_post", "unpin_post", "react", "search", "status", "list_admins", "edit_admin"],
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
    Type.Unsafe<"post">({
      type: "string",
      enum: ["post"],
      description: "Type filter for search (default: post)",
    }),
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
});

type Params = Static<typeof ManageToolParams>;

const DANGEROUS_ACTIONS = new Set(["pin_post", "unpin_post", "edit_admin"]);

const DESCRIPTION =
  "Telegram channel management: " +
  "'pin_post'/'unpin_post' (pin/unpin message, requires 'messageId'), " +
  "'react' (set reaction, requires 'messageId' and 'emoji', MTProto only), " +
  "'search' (search posts, requires 'query'), " +
  "'status' (check connection status), " +
  "'list_admins' (list channel administrators, MTProto only), " +
  "'edit_admin' (edit admin rights, requires 'userId' and 'adminRights', MTProto only).";

export function createManageToolFactory(
  api: OpenClawPluginApi,
  posts: PostStorage,
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
          return executeSearch(params, posts);
        case "status":
          return executeStatus(cfg, api, posts, mtprotoClient);
        case "list_admins":
          return executeListAdmins(cfg, mtprotoClient);
        case "edit_admin":
          return executeEditAdmin(params, cfg, mtprotoClient);
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
) {
  if (!params.query) {
    return jsonResult({ error: "'query' parameter is required for 'search'" });
  }
  const limit = params.limit ?? 20;
  const results: Array<{ type: "post"; data: unknown }> = [];

  for (const p of await posts.search(params.query, { limit })) {
    results.push({ type: "post", data: p });
  }

  return jsonResult({ ok: true, query: params.query, count: results.length, results: results.slice(0, limit) });
}

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
  } catch { /* ignore */ }

  const allPosts = await posts.getAll();

  return jsonResult({
    ok: true, botOk,
    mtprotoEnabled: !!pluginConfig.mtproto?.enabled,
    mtprotoConnected: mtprotoClient?.isConnected ?? false,
    dangerousActionsEnabled: pluginConfig.dangerousActions?.enabled ?? false,
    postsCount: allPosts.length,
    channelChatId: pluginConfig.channel.chatId,
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
