import { Type, type Static } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import type { MtprotoClient } from "./mtproto-client.js";
import {
  type ToolContext,
  SharedParams,
  checkAuth,
  getConfig,
  requireMtproto,
} from "./tool-shared.js";

const StatsToolParams = Type.Object({
  action: Type.Union([
    Type.Literal("get_views"),
    Type.Literal("get_channel_stats"),
    Type.Literal("get_post_stats"),
    Type.Literal("get_history"),
    Type.Literal("engagement_dashboard"),
  ]),
  ...SharedParams,
  offsetId: Type.Optional(
    Type.Number({ description: "Offset message ID for get_history pagination" }),
  ),
  periodDays: Type.Optional(
    Type.Number({ description: "Period in days for engagement_dashboard (default: 7)" }),
  ),
});

type Params = Static<typeof StatsToolParams>;

const DESCRIPTION =
  "Telegram channel statistics and analytics (requires MTProto): " +
  "'get_views' (view/forward counts, requires 'messageIds'), " +
  "'get_channel_stats' (subscribers, growth, reach analytics), " +
  "'get_post_stats' (per-post views/reactions graphs, requires 'messageId'), " +
  "'get_history' (channel message history, optional 'limit' and 'offsetId'), " +
  "'engagement_dashboard' (engagement analytics: top posts, best hours, growth trend; optional 'periodDays' and 'limit').";

export function createStatsToolFactory(
  api: OpenClawPluginApi,
  mtprotoClient?: MtprotoClient,
) {
  return (ctx: ToolContext) => ({
    name: "tg_channel_stats",
    label: "Telegram Channel Stats",
    description: DESCRIPTION,
    parameters: StatsToolParams,
    async execute(_toolCallId: string, params: Params) {
      const { cfg, err } = getConfig(api);
      if (err) return err;

      const authErr = checkAuth(ctx, cfg);
      if (authErr) return authErr;

      switch (params.action) {
        case "get_views":
          return executeGetViews(params, cfg, mtprotoClient);
        case "get_channel_stats":
          return executeGetChannelStats(cfg, mtprotoClient);
        case "get_post_stats":
          return executeGetPostStats(params, cfg, mtprotoClient);
        case "get_history":
          return executeGetHistory(params, cfg, mtprotoClient);
        case "engagement_dashboard":
          return executeEngagementDashboard(params, cfg, mtprotoClient);
        default:
          return jsonResult({ error: `Unknown action: ${String(params.action)}` });
      }
    },
  });
}

async function executeGetViews(
  params: Params,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  if (!params.messageIds || params.messageIds.length === 0) {
    return jsonResult({ error: "'messageIds' parameter is required for 'get_views' action" });
  }

  try {
    const views = await mtprotoClient!.getViews(pluginConfig.channel.chatId, params.messageIds);
    return jsonResult({ ok: true, views });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeGetChannelStats(
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  try {
    const stats = await mtprotoClient!.getChannelStats(pluginConfig.channel.chatId);
    return jsonResult({ ok: true, stats });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeGetPostStats(
  params: Params,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  if (params.messageId == null) {
    return jsonResult({ error: "'messageId' parameter is required for 'get_post_stats' action" });
  }

  try {
    const stats = await mtprotoClient!.getPostStats(pluginConfig.channel.chatId, params.messageId);
    return jsonResult({ ok: true, stats });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeGetHistory(
  params: Params,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  try {
    const messages = await mtprotoClient!.getHistory(pluginConfig.channel.chatId, {
      limit: params.limit, offsetId: params.offsetId,
    });
    return jsonResult({ ok: true, count: messages.length, messages });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeEngagementDashboard(
  params: Params,
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
    const messages = await mtprotoClient!.getHistory(chatId, { limit });
    const periodMessages = messages.filter((m) => m.date >= cutoffTs);

    let channelStats;
    try {
      channelStats = await mtprotoClient!.getChannelStats(chatId);
    } catch {
      // Stats may not be available for small channels
    }

    const totalViews = periodMessages.reduce((s, m) => s + (m.views ?? 0), 0);
    const totalForwards = periodMessages.reduce((s, m) => s + (m.forwards ?? 0), 0);
    const totalReactions = periodMessages.reduce(
      (s, m) => s + (m.reactions?.reduce((rs, r) => rs + r.count, 0) ?? 0), 0,
    );
    const count = periodMessages.length || 1;

    const topByViews = [...periodMessages]
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
      .slice(0, 5)
      .map((m) => ({
        id: m.id, text: m.text.slice(0, 80),
        views: m.views ?? 0, forwards: m.forwards ?? 0,
        reactions: m.reactions?.reduce((s, r) => s + r.count, 0) ?? 0,
      }));

    const topByReactions = [...periodMessages]
      .sort((a, b) => {
        const ar = a.reactions?.reduce((s, r) => s + r.count, 0) ?? 0;
        const br = b.reactions?.reduce((s, r) => s + r.count, 0) ?? 0;
        return br - ar;
      })
      .slice(0, 5)
      .map((m) => ({
        id: m.id, text: m.text.slice(0, 80),
        views: m.views ?? 0,
        reactions: m.reactions?.reduce((s, r) => s + r.count, 0) ?? 0,
      }));

    const hourCounts = new Array(24).fill(0) as number[];
    for (const m of periodMessages) {
      hourCounts[new Date(m.date * 1000).getUTCHours()]++;
    }
    const bestHours = hourCounts
      .map((c, hour) => ({ hour, count: c }))
      .filter((h) => h.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return jsonResult({
      ok: true, periodDays, postsInPeriod: periodMessages.length,
      avgViews: Math.round(totalViews / count),
      avgForwards: Math.round(totalForwards / count),
      avgReactions: Math.round(totalReactions / count),
      totalViews, totalForwards, totalReactions,
      topByViews, topByReactions,
      bestPostingHoursUTC: bestHours,
      followers: channelStats?.followers,
      growthTrend: channelStats ? {
        current: channelStats.followers.current,
        previous: channelStats.followers.previous,
        change: channelStats.followers.current - channelStats.followers.previous,
      } : undefined,
    });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}
