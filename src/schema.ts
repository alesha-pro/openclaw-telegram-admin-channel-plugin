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
      parseMode: Type.Optional(
        Type.Union([Type.Literal("HTML"), Type.Literal("Markdown"), Type.Literal("MarkdownV2")], {
          description: "Default parse mode for posts when not specified explicitly",
        }),
      ),
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
});

export type TelegramAdminChannelConfig = Static<
  typeof TelegramAdminChannelConfigSchema
>;
