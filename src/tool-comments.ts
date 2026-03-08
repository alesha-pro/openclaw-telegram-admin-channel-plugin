import { Type, type Static } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import {
  resolveBotToken,
  TelegramBotApi,
  type TelegramApiResult,
} from "./telegram-api.js";
import type { HistoryMessage, MtprotoClient } from "./mtproto-client.js";
import {
  type ToolContext,
  checkAuth,
  getConfig,
  hasMarkdownFormatting,
  requireMtproto,
  toTelegramHtml,
} from "./tool-shared.js";

const CommentsToolParams = Type.Object({
  action: Type.Unsafe<"list_comments" | "reply_comment" | "post_comment">({
    type: "string",
    enum: ["list_comments", "reply_comment", "post_comment"],
    description: "Action to perform",
  }),
  limit: Type.Optional(
    Type.Number({ description: "Number of comments to return (default: 20)" }),
  ),
  postMessageId: Type.Optional(
    Type.Number({ description: "Channel post message ID to filter comments by thread" }),
  ),
  commentMessageId: Type.Optional(
    Type.Number({ description: "Discussion group comment message ID to reply to" }),
  ),
  replyText: Type.Optional(
    Type.String({ description: "Text content for reply_comment or post_comment" }),
  ),
  parseMode: Type.Optional(
    Type.Unsafe<"HTML" | "Markdown" | "MarkdownV2">({
      type: "string",
      enum: ["HTML", "Markdown", "MarkdownV2"],
      description: "Parse mode for reply text formatting",
    }),
  ),
});

type Params = Static<typeof CommentsToolParams>;

const DESCRIPTION =
  "Telegram discussion comments (requires MTProto and discussion.chatId): " +
  "'list_comments' (list comments for a post or recent discussion comments; optional 'postMessageId' and 'limit'), " +
  "'reply_comment' (reply to a specific comment; requires 'commentMessageId' and 'replyText', optional 'postMessageId'), " +
  "'post_comment' (post a new top-level comment under a channel post; requires 'postMessageId' and 'replyText').";

type DiscussionComment = {
  messageId: number;
  threadId: number;
  replyToMessageId?: number;
  timestamp: number;
  text: string;
  fromId?: number;
  fromName?: string;
  fromUsername?: string;
};

export function createCommentsToolFactory(
  api: OpenClawPluginApi,
  mtprotoClient?: MtprotoClient,
) {
  return (ctx: ToolContext) => ({
    name: "tg_channel_comments",
    label: "Telegram Channel Comments",
    description: DESCRIPTION,
    parameters: CommentsToolParams,
    async execute(_toolCallId: string, params: Params) {
      const { cfg, err } = getConfig(api);
      if (err) return err;

      const authErr = checkAuth(ctx, cfg);
      if (authErr) return authErr;

      switch (params.action) {
        case "list_comments":
          return executeListComments(params, cfg, mtprotoClient);
        case "reply_comment":
          return executeReplyComment(params, cfg, api, mtprotoClient);
        case "post_comment":
          return executePostComment(params, cfg, api, mtprotoClient);
        default:
          return jsonResult({ error: `Unknown action: ${String(params.action)}` });
      }
    },
  });
}

async function executeListComments(
  params: Params,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  const discussionChatId = pluginConfig.discussion?.chatId;
  if (!discussionChatId) {
    return jsonResult({ error: "discussion.chatId is required for comment actions" });
  }

  const limit = params.limit ?? 20;

  try {
    const comments = await collectDiscussionComments(mtprotoClient!, discussionChatId, {
      limit,
      postMessageId: params.postMessageId,
    });

    return jsonResult({
      ok: true,
      count: comments.length,
      postMessageId: params.postMessageId,
      comments,
    });
  } catch (e) {
    return jsonResult({ error: `MTProto error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function executeReplyComment(
  params: Params,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  const discussionChatId = pluginConfig.discussion?.chatId;
  if (!discussionChatId) {
    return jsonResult({ error: "discussion.chatId is required for comment actions" });
  }
  if (params.commentMessageId == null) {
    return jsonResult({ error: "'commentMessageId' parameter is required for 'reply_comment'" });
  }
  if (!params.replyText) {
    return jsonResult({ error: "'replyText' parameter is required for 'reply_comment'" });
  }

  try {
    const comment = await findDiscussionCommentById(mtprotoClient!, discussionChatId, params.commentMessageId);
    if (!comment) {
      return jsonResult({ error: `Comment ${params.commentMessageId} was not found in discussion history` });
    }
    if (params.postMessageId != null && comment.threadId !== params.postMessageId) {
      return jsonResult({
        error: `Comment ${params.commentMessageId} belongs to post ${comment.threadId}, not ${params.postMessageId}`,
      });
    }

    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    const prepared = prepareReplyPayload(params.replyText, params.parseMode);

    let sendResult: TelegramApiResult;
    try {
      sendResult = await TelegramBotApi.sendMessage(
        token,
        discussionChatId,
        prepared.text,
        {
          parseMode: prepared.parseMode,
          replyToMessageId: comment.messageId,
          messageThreadId: comment.threadId,
        },
      );
    } catch {
      sendResult = await TelegramBotApi.sendMessage(
        token,
        discussionChatId,
        params.replyText,
        {
          replyToMessageId: comment.messageId,
          messageThreadId: comment.threadId,
        },
      );
    }

    return jsonResult({
      ok: true,
      action: "replied",
      commentMessageId: comment.messageId,
      threadId: comment.threadId,
      replyMessageId: sendResult.result?.message_id ?? 0,
    });
  } catch (e) {
    return jsonResult({ error: `Telegram error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

function prepareReplyPayload(
  replyText: string,
  parseMode?: "HTML" | "Markdown" | "MarkdownV2",
): { text: string; parseMode?: "HTML" | "Markdown" | "MarkdownV2" } {
  if (parseMode) {
    return { text: replyText, parseMode };
  }
  if (hasMarkdownFormatting(replyText)) {
    return { text: toTelegramHtml(replyText), parseMode: "HTML" };
  }
  return { text: replyText };
}

async function executePostComment(
  params: Params,
  pluginConfig: TelegramAdminChannelConfig,
  api: OpenClawPluginApi,
  mtprotoClient?: MtprotoClient,
) {
  const err = requireMtproto(mtprotoClient);
  if (err) return err;

  const discussionChatId = pluginConfig.discussion?.chatId;
  if (!discussionChatId) {
    return jsonResult({ error: "discussion.chatId is required for comment actions" });
  }
  if (params.postMessageId == null) {
    return jsonResult({ error: "'postMessageId' parameter is required for 'post_comment'" });
  }
  if (!params.replyText) {
    return jsonResult({ error: "'replyText' parameter is required for 'post_comment'" });
  }

  try {
    const channelChatId = pluginConfig.channel.chatId;
    const threadId = await mtprotoClient!.getDiscussionThreadId(channelChatId, params.postMessageId);

    const token = resolveBotToken(api.config, pluginConfig.telegramAccountId);
    const prepared = prepareReplyPayload(params.replyText, params.parseMode);

    let sendResult: TelegramApiResult;
    try {
      sendResult = await TelegramBotApi.sendMessage(
        token,
        discussionChatId,
        prepared.text,
        {
          parseMode: prepared.parseMode,
          replyToMessageId: threadId,
          messageThreadId: threadId,
        },
      );
    } catch {
      sendResult = await TelegramBotApi.sendMessage(
        token,
        discussionChatId,
        params.replyText,
        {
          replyToMessageId: threadId,
          messageThreadId: threadId,
        },
      );
    }

    return jsonResult({
      ok: true,
      action: "commented",
      postMessageId: params.postMessageId,
      threadId,
      commentMessageId: sendResult.result?.message_id ?? 0,
    });
  } catch (e) {
    return jsonResult({ error: `Error: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function collectDiscussionComments(
  mtprotoClient: MtprotoClient,
  discussionChatId: string,
  opts: { limit: number; postMessageId?: number },
): Promise<DiscussionComment[]> {
  const comments: DiscussionComment[] = [];
  let offsetId = 0;
  let scanned = 0;
  const scanLimit = Math.max(opts.limit * 10, 200);

  while (comments.length < opts.limit && scanned < scanLimit) {
    const page = await mtprotoClient.getHistory(discussionChatId, {
      limit: Math.min(100, scanLimit - scanned),
      offsetId,
    });

    if (page.length === 0) break;
    scanned += page.length;

    for (const message of page) {
      const comment = toDiscussionComment(message);
      if (!comment) continue;
      if (opts.postMessageId != null && comment.threadId !== opts.postMessageId) continue;
      comments.push(comment);
      if (comments.length >= opts.limit) break;
    }

    const oldestId = Math.min(...page.map((message) => message.id));
    if (!Number.isFinite(oldestId) || oldestId <= 0 || oldestId === offsetId) break;
    offsetId = oldestId;
  }

  comments.sort((a, b) => b.timestamp - a.timestamp);
  return comments.slice(0, opts.limit);
}

async function findDiscussionCommentById(
  mtprotoClient: MtprotoClient,
  discussionChatId: string,
  commentMessageId: number,
): Promise<DiscussionComment | undefined> {
  let offsetId = 0;
  let scanned = 0;
  const scanLimit = 1000;

  while (scanned < scanLimit) {
    const page = await mtprotoClient.getHistory(discussionChatId, {
      limit: Math.min(100, scanLimit - scanned),
      offsetId,
    });
    if (page.length === 0) return undefined;
    scanned += page.length;

    const match = page.find((message) => message.id === commentMessageId);
    if (match) return toDiscussionComment(match);

    const oldestId = Math.min(...page.map((message) => message.id));
    if (!Number.isFinite(oldestId) || oldestId <= 0 || oldestId === offsetId) return undefined;
    offsetId = oldestId;
  }

  return undefined;
}

function toDiscussionComment(message: HistoryMessage): DiscussionComment | undefined {
  const threadId = message.replyToTopId ?? message.replyToMsgId;
  if (!threadId) return undefined;
  if (message.isForward) return undefined;
  if (!message.text.trim()) return undefined;

  return {
    messageId: message.id,
    threadId,
    replyToMessageId: message.replyToMsgId,
    timestamp: message.date * 1000,
    text: message.text,
    fromId: message.fromId,
    fromName: message.fromName,
    fromUsername: message.fromUsername,
  };
}
