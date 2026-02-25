import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";

import { TelegramAdminChannelConfigSchema } from "./schema.js";
import type { TelegramAdminChannelConfig } from "./schema.js";
import { PostStorage, CommentStorage, TemplateStorage } from "./storage.js";
import { createToolFactory } from "./tool.js";
import { createPostToolFactory } from "./tool-post.js";
import { createStatsToolFactory } from "./tool-stats.js";
import { createScheduleToolFactory } from "./tool-schedule.js";
import { createManageToolFactory } from "./tool-manage.js";
import { registerHooks } from "./hooks.js";
import { MtprotoClient } from "./mtproto-client.js";
import { resolveBotToken } from "./telegram-api.js";

const plugin = {
  id: "telegram-admin-channel",
  name: "Telegram Admin Channel",
  description:
    "Admin assistant for a Telegram channel: posts, comments, basic analytics",

  configSchema: {
    jsonSchema: TelegramAdminChannelConfigSchema as unknown as Record<
      string,
      unknown
    >,
  },

  register(api: OpenClawPluginApi) {
    const dataDir = "~/.openclaw/plugins/telegram-admin-channel";
    const posts = new PostStorage(api.resolvePath(`${dataDir}/posts.json`));
    const comments = new CommentStorage(
      api.resolvePath(`${dataDir}/comments.json`),
    );
    const templates = new TemplateStorage(
      api.resolvePath(`${dataDir}/templates.json`),
    );

    const pluginConfig = api.pluginConfig as
      | TelegramAdminChannelConfig
      | undefined;

    let mtprotoClient: MtprotoClient | undefined;
    if (pluginConfig?.mtproto?.enabled) {
      const mtCfg = pluginConfig.mtproto;
      const sessionPath = api.resolvePath(
        mtCfg.sessionPath ?? `${dataDir}/mtproto.session`,
      );
      mtprotoClient = new MtprotoClient({
        apiId: mtCfg.apiId,
        apiHash: mtCfg.apiHash,
        sessionPath,
        logger: api.logger,
      });
      api.logger.info(`MTProto enabled (session: ${sessionPath})`);
    }

    // Register legacy monolithic tool (backward compat) + new split tools
    api.registerTool(createToolFactory(api, posts, comments, mtprotoClient, templates), {
      optional: true,
    });
    api.registerTool(createPostToolFactory(api, posts, comments, mtprotoClient, templates), {
      optional: true,
    });
    api.registerTool(createManageToolFactory(api, posts, comments, mtprotoClient), {
      optional: true,
    });
    if (mtprotoClient) {
      api.registerTool(createStatsToolFactory(api, mtprotoClient), {
        optional: true,
      });
      api.registerTool(createScheduleToolFactory(api, mtprotoClient), {
        optional: true,
      });
    }

    // Register hooks
    registerHooks(api, pluginConfig, posts, comments);

    // U1/P7: Register MTProto as a background service for clean lifecycle
    if (mtprotoClient) {
      const client = mtprotoClient;
      api.registerService({
        id: "telegram-admin-mtproto",
        async start(ctx) {
          ctx.logger.info("telegram-admin-mtproto service starting");
        },
        async stop(ctx) {
          ctx.logger.info("telegram-admin-mtproto service stopping");
          await client.disconnect();
        },
      });
    }

    // U2: Register slash commands for quick admin operations
    if (pluginConfig) {
      const cfg = pluginConfig;

      api.registerCommand({
        name: "tgstatus",
        description: "Show Telegram channel admin plugin status",
        requireAuth: true,
        async handler() {
          let botOk = false;
          try {
            const token = resolveBotToken(api.config, cfg.telegramAccountId);
            const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
            const data = (await resp.json()) as { ok: boolean };
            botOk = data.ok;
          } catch { /* ignore */ }

          const allPosts = await posts.getAll();
          const allComments = await comments.getFiltered();

          const lines = [
            `**Telegram Admin Channel Status**`,
            `Bot: ${botOk ? "connected" : "disconnected"}`,
            `MTProto: ${mtprotoClient?.isConnected ? "connected" : cfg.mtproto?.enabled ? "enabled (not connected)" : "disabled"}`,
            `Channel: ${cfg.channel.chatId}`,
            `Posts: ${allPosts.length}`,
            `Comments: ${allComments.length}`,
            `Dangerous actions: ${cfg.dangerousActions?.enabled ? "enabled" : "disabled"}`,
          ];
          return { text: lines.join("\n") };
        },
      });

      api.registerCommand({
        name: "tgscheduled",
        description: "List scheduled posts for the channel",
        requireAuth: true,
        async handler() {
          if (!mtprotoClient) {
            return { text: "MTProto is not enabled. Cannot list scheduled posts." };
          }
          try {
            const messages = await mtprotoClient.getScheduledMessages(cfg.channel.chatId);
            if (messages.length === 0) {
              return { text: "No scheduled posts." };
            }
            const lines = messages.map((m) => {
              const date = new Date(m.date * 1000).toISOString();
              const preview = m.text.slice(0, 80).replace(/\n/g, " ");
              return `[${m.id}] ${date} — ${preview}${m.text.length > 80 ? "..." : ""}`;
            });
            return { text: `**Scheduled posts (${messages.length}):**\n${lines.join("\n")}` };
          } catch (e) {
            return { text: `Error: ${e instanceof Error ? e.message : String(e)}` };
          }
        },
      });

      api.registerCommand({
        name: "tgstats",
        description: "Show channel statistics (requires MTProto)",
        requireAuth: true,
        async handler() {
          if (!mtprotoClient) {
            return { text: "MTProto is not enabled. Cannot fetch stats." };
          }
          try {
            const stats = await mtprotoClient.getChannelStats(cfg.channel.chatId);
            const lines = [
              `**Channel Statistics**`,
              `Period: ${new Date(stats.period.minDate * 1000).toLocaleDateString()} – ${new Date(stats.period.maxDate * 1000).toLocaleDateString()}`,
              `Followers: ${stats.followers.current} (${stats.followers.current - stats.followers.previous >= 0 ? "+" : ""}${stats.followers.current - stats.followers.previous})`,
              `Views/post: ${stats.viewsPerPost.current}`,
              `Shares/post: ${stats.sharesPerPost.current}`,
              `Reactions/post: ${stats.reactionsPerPost.current}`,
            ];
            return { text: lines.join("\n") };
          } catch (e) {
            return { text: `Error: ${e instanceof Error ? e.message : String(e)}` };
          }
        },
      });
    }

    // U6: Register CLI for MTProto auth
    api.registerCli((ctx) => {
      const cmd = ctx.program
        .command("telegram-admin")
        .description("Telegram Admin Channel plugin commands");

      cmd
        .command("auth")
        .description("Authorize MTProto session (interactive)")
        .action(async () => {
          ctx.logger.info(
            "Run the MTProto auth script: node ./dist/mtproto-auth.js",
          );
          ctx.logger.info(
            "Set TELEGRAM_API_ID and TELEGRAM_API_HASH environment variables before running.",
          );
        });

      cmd
        .command("status")
        .description("Show plugin status")
        .action(async () => {
          const allPosts = await posts.getAll();
          const allComments = await comments.getFiltered();
          ctx.logger.info(`Posts: ${allPosts.length}`);
          ctx.logger.info(`Comments: ${allComments.length}`);
          ctx.logger.info(`MTProto: ${mtprotoClient ? "configured" : "not configured"}`);
        });
    }, { commands: ["telegram-admin"] });

    api.logger.info(
      `telegram-admin-channel plugin registered (data: ${api.resolvePath(dataDir)})`,
    );
  },
};

export default plugin;
