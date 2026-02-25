declare module "openclaw" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk";

  export type MsgContext = {
    Body?: string;
    BodyForAgent?: string;
    From?: string;
    To?: string;
    SessionKey?: string;
    AccountId?: string;
    SenderName?: string;
    SenderId?: string;
    Provider?: string;
    Surface?: string;
    ChatType?: string;
    CommandAuthorized?: boolean;
    OwnerAllowFrom?: Array<string | number>;
    MessageThreadId?: string | number;
    [key: string]: unknown;
  };

  export type ReplyPayload = {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    isError?: boolean;
  };

  export type GetReplyOptions = {
    abortSignal?: AbortSignal;
    isHeartbeat?: boolean;
    skillFilter?: string[];
    timeoutOverrideSeconds?: number;
    [key: string]: unknown;
  };

  export function getReplyFromConfig(
    ctx: MsgContext,
    opts?: GetReplyOptions,
    configOverride?: OpenClawConfig,
  ): Promise<ReplyPayload | ReplyPayload[] | undefined>;

  export function loadConfig(): OpenClawConfig;
}
