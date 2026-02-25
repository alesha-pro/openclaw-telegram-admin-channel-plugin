import { Type } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import type { MtprotoClient } from "./mtproto-client.js";

export type ToolResult = ReturnType<typeof jsonResult>;

export type ToolContext = {
  sessionKey?: string;
  agentAccountId?: string;
  messageChannel?: string;
};

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

// Shared parameter schemas
export const SharedParams = {
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
};

export function checkAuth(
  ctx: ToolContext,
  pluginConfig: TelegramAdminChannelConfig,
): ToolResult | null {
  if (pluginConfig.ownerAllowFrom && pluginConfig.ownerAllowFrom.length > 0) {
    const senderId = ctx.agentAccountId ?? ctx.sessionKey;
    // "default" is the gateway fallback when no explicit accountId is configured —
    // it carries no real identity, so skip the allowlist check in that case.
    if (senderId && senderId !== "default" && !pluginConfig.ownerAllowFrom.includes(senderId)) {
      return jsonResult({
        error: `Access denied: sender "${senderId}" is not in ownerAllowFrom list.`,
      });
    }
  }
  return null;
}

export function checkDangerous(
  action: string,
  dangerousActions: Set<string>,
  pluginConfig: TelegramAdminChannelConfig,
): ToolResult | null {
  if (dangerousActions.has(action) && !pluginConfig.dangerousActions?.enabled) {
    return jsonResult({
      error: `Action "${action}" requires dangerousActions.enabled=true in plugin config.`,
    });
  }
  return null;
}

export function getConfig(
  api: OpenClawPluginApi,
): { cfg: TelegramAdminChannelConfig; err?: undefined } | { cfg?: undefined; err: ToolResult } {
  const pluginConfig = api.pluginConfig as TelegramAdminChannelConfig | undefined;
  if (!pluginConfig) {
    return {
      err: jsonResult({
        error: "Plugin config not found. Configure telegram-admin-channel in plugins.entries.",
      }),
    };
  }
  return { cfg: pluginConfig };
}

export function requireMtproto(client?: MtprotoClient): ToolResult | null {
  if (!client) {
    return jsonResult({
      error: "MTProto is not configured. Enable mtproto in plugin config and run 'pnpm mtproto:auth' to authorize.",
    });
  }
  return null;
}
