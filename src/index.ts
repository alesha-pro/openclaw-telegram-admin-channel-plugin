import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { TelegramAdminChannelConfigSchema } from "./schema.js";
import type { TelegramAdminChannelConfig } from "./schema.js";
import { PostStorage, CommentStorage } from "./storage.js";
import { createToolFactory } from "./tool.js";
import { registerHooks } from "./hooks.js";
import { MtprotoClient } from "./mtproto-client.js";

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

    api.registerTool(createToolFactory(api, posts, comments, mtprotoClient), {
      optional: true,
    });

    registerHooks(api, pluginConfig, posts, comments);

    api.logger.info(
      `telegram-admin-channel plugin registered (data: ${api.resolvePath(dataDir)})`,
    );
  },
};

export default plugin;
