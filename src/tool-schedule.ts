import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import { resolveBotToken } from "./telegram-api.js";
import type { MtprotoClient } from "./mtproto-client.js";
import {
  type ToolContext,
  SharedParams,
  checkAuth,
  checkDangerous,
  getConfig,
  requireMtproto,
} from "./tool-shared.js";

const ScheduleToolParams = Type.Object({
  action: Type.Union([
    Type.Literal("schedule_post"),
    Type.Literal("list_scheduled"),
    Type.Literal("delete_scheduled"),
    Type.Literal("send_scheduled_now"),
  ]),
  ...SharedParams,
  scheduleDate: Type.Optional(
    Type.Number({ description: "Unix timestamp (UTC) for schedule_post" }),
  ),
  photoFileIds: Type.Optional(
    Type.Array(Type.String(), { description: "Telegram file_id(s) for photo(s)" }),
  ),
  photoPaths: Type.Optional(
    Type.Array(Type.String(), { description: "Local file path(s) to photo(s)" }),
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
});

type Params = Static<typeof ScheduleToolParams>;

const DANGEROUS_ACTIONS = new Set(["delete_scheduled", "send_scheduled_now"]);

const DESCRIPTION =
  "Telegram channel scheduled posts (requires MTProto): " +
  "'schedule_post' (schedule text or media, requires 'scheduleDate'; supports photos/videos/documents via Paths or FileIds; multiple = album; 'text' as caption), " +
  "'list_scheduled' (list all pending scheduled messages), " +
  "'delete_scheduled' (requires 'messageIds'), " +
  "'send_scheduled_now' (publish scheduled messages immediately, requires 'messageIds').";

export function createScheduleToolFactory(
  api: OpenClawPluginApi,
  mtprotoClient?: MtprotoClient,
) {
  return (ctx: ToolContext) => ({
    name: "tg_channel_schedule",
    label: "Telegram Channel Schedule",
    description: DESCRIPTION,
    parameters: ScheduleToolParams,
    async execute(_toolCallId: string, params: Params) {
      const { cfg, err } = getConfig(api);
      if (err) return err;

      const authErr = checkAuth(ctx, cfg);
      if (authErr) return authErr;

      const dangerErr = checkDangerous(params.action, DANGEROUS_ACTIONS, cfg);
      if (dangerErr) return dangerErr;

      switch (params.action) {
        case "schedule_post":
          return executeSchedulePost(params, cfg, api, mtprotoClient);
        case "list_scheduled":
          return executeListScheduled(cfg, mtprotoClient);
        case "delete_scheduled":
          return executeDeleteScheduled(params, cfg, mtprotoClient);
        case "send_scheduled_now":
          return executeSendScheduledNow(params, cfg, mtprotoClient);
        default:
          return jsonResult({ error: `Unknown action: ${String(params.action)}` });
      }
    },
  });
}

async function executeSchedulePost(
  params: Params,
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
    return jsonResult({ error: "'text' or media parameters required for 'schedule_post'" });
  }
  if (!params.scheduleDate) {
    return jsonResult({ error: "'scheduleDate' (unix timestamp UTC) is required for 'schedule_post'" });
  }

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

      if (params.photoPaths?.length) {
        for (const p of params.photoPaths) {
          sources.push({ type: "localFile", buffer: await readFile(p), fileName: basename(p), mediaType: "photo" });
        }
      }
      if (params.photoFileIds?.length) {
        const botToken = resolveBotToken(api.config, pluginConfig.telegramAccountId);
        for (const fid of params.photoFileIds) {
          sources.push({ type: "fileId", botToken, fileId: fid, mediaType: "photo" });
        }
      }
      if (params.videoPaths?.length) {
        for (const p of params.videoPaths) {
          sources.push({ type: "localFile", buffer: await readFile(p), fileName: basename(p), mediaType: "video" });
        }
      }
      if (params.videoFileIds?.length) {
        const botToken = resolveBotToken(api.config, pluginConfig.telegramAccountId);
        for (const fid of params.videoFileIds) {
          sources.push({ type: "fileId", botToken, fileId: fid, mediaType: "video" });
        }
      }
      if (params.documentPaths?.length) {
        for (const p of params.documentPaths) {
          sources.push({ type: "localFile", buffer: await readFile(p), fileName: basename(p), mediaType: "document" });
        }
      }
      if (params.documentFileIds?.length) {
        const botToken = resolveBotToken(api.config, pluginConfig.telegramAccountId);
        for (const fid of params.documentFileIds) {
          sources.push({ type: "fileId", botToken, fileId: fid, mediaType: "document" });
        }
      }

      const result = await mtprotoClient!.scheduleMediaPost(
        pluginConfig.channel.chatId, sources,
        { caption: params.text, scheduleDate: params.scheduleDate, silent: params.silent },
      );
      const mediaTypes = new Set(sources.map((s) => s.mediaType ?? "photo"));
      const typeLabel = sources.length > 1 ? "album"
        : mediaTypes.has("video") ? "video"
        : mediaTypes.has("document") ? "document"
        : "photo";
      return jsonResult({
        ok: true, messageIds: result.messageIds, scheduleDate: result.scheduleDate,
        scheduledFor: new Date(result.scheduleDate * 1000).toISOString(), type: typeLabel,
      });
    }

    const result = await mtprotoClient!.scheduleMessage(
      pluginConfig.channel.chatId, params.text!, params.scheduleDate, { silent: params.silent },
    );
    return jsonResult({
      ok: true, messageId: result.messageId, scheduleDate: result.scheduleDate,
      scheduledFor: new Date(result.scheduleDate * 1000).toISOString(),
    });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeListScheduled(
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  try {
    const messages = await mtprotoClient!.getScheduledMessages(pluginConfig.channel.chatId);
    return jsonResult({ ok: true, count: messages.length, messages });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeDeleteScheduled(
  params: Params,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  if (!params.messageIds || params.messageIds.length === 0) {
    return jsonResult({ error: "'messageIds' parameter is required for 'delete_scheduled'" });
  }

  try {
    await mtprotoClient!.deleteScheduledMessages(pluginConfig.channel.chatId, params.messageIds);
    return jsonResult({ ok: true, deleted: params.messageIds });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeSendScheduledNow(
  params: Params,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  if (!params.messageIds || params.messageIds.length === 0) {
    return jsonResult({ error: "'messageIds' parameter is required for 'send_scheduled_now'" });
  }

  try {
    await mtprotoClient!.sendScheduledNow(pluginConfig.channel.chatId, params.messageIds);
    return jsonResult({ ok: true, sent: params.messageIds });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}
