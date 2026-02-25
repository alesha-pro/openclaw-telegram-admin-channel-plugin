import { Type, type Static } from "@sinclair/typebox";

export const TelegramAdminChannelConfigSchema = Type.Object({
  telegramAccountId: Type.Optional(Type.String()),
  channel: Type.Object({
    chatId: Type.String(),
  }),
  discussion: Type.Optional(
    Type.Object({
      chatId: Type.String(),
    }),
  ),
  ownerAllowFrom: Type.Array(Type.String()),
  defaults: Type.Optional(
    Type.Object({
      silent: Type.Optional(Type.Boolean()),
    }),
  ),
  dangerousActions: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
    }),
  ),
  storage: Type.Optional(
    Type.Object({
      mode: Type.Optional(Type.Literal("json")),
    }),
  ),
  mtproto: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      apiId: Type.Number(),
      apiHash: Type.String(),
      sessionPath: Type.Optional(Type.String()),
    }),
  ),
  autoReply: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      mode: Type.Optional(
        Type.Union([Type.Literal("simple"), Type.Literal("agent")], {
          default: "simple",
          description: "simple = one-shot getReplyFromConfig, agent = full agent sessions via gateway HTTP",
        }),
      ),
      // Agent mode settings
      agentId: Type.Optional(
        Type.String({
          default: "discussion-responder",
          description: "Agent ID for agent mode",
        }),
      ),
      gatewayUrl: Type.Optional(
        Type.String({
          default: "http://127.0.0.1:18789",
          description: "Gateway HTTP URL for agent mode",
        }),
      ),
      gatewayToken: Type.Optional(
        Type.String({
          description: "Gateway auth token for agent mode",
        }),
      ),
      // Common settings
      intervalMinutes: Type.Optional(Type.Number({ default: 5 })),
      maxRepliesPerBatch: Type.Optional(Type.Number({ default: 5 })),
      cooldownPerThreadMinutes: Type.Optional(Type.Number({ default: 30 })),
    }),
  ),
  notifications: Type.Optional(
    Type.Object({
      onComment: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean({ default: false })),
          notifyChatId: Type.String({ description: "Chat ID to send notifications to (e.g. owner's personal chat)" }),
          minInterval: Type.Optional(Type.Number({ description: "Minimum seconds between notifications (default: 60)", default: 60 })),
        }),
      ),
    }),
  ),
});

export type TelegramAdminChannelConfig = Static<
  typeof TelegramAdminChannelConfigSchema
>;
