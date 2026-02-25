import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getReplyFromConfig, type MsgContext } from "openclaw";

import type { TelegramAdminChannelConfig } from "./schema.js";
import type { CommentStorage, PostStorage, StoredComment } from "./storage.js";
import { resolveBotToken, TelegramBotApi } from "./telegram-api.js";

type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

// Track last reply timestamp per thread to enforce cooldown
const threadLastReply = new Map<number, number>();

export function startAutoReplyService(
  api: OpenClawPluginApi,
  pluginConfig: TelegramAdminChannelConfig,
  comments: CommentStorage,
  posts: PostStorage,
): () => void {
  const logger = api.logger;
  const config = api.config;
  const arCfg = pluginConfig.autoReply!;
  const intervalMs = (arCfg.intervalMinutes ?? 10) * 60_000;
  const maxPerBatch = arCfg.maxRepliesPerBatch ?? 5;
  const cooldownMs = (arCfg.cooldownPerThreadMinutes ?? 30) * 60_000;

  const discussionChatId = pluginConfig.discussion?.chatId;
  if (!discussionChatId) {
    logger.warn(
      "auto-reply: discussion.chatId not configured — auto-reply disabled",
    );
    return () => {};
  }

  let token: string;
  try {
    token = resolveBotToken(config, pluginConfig.telegramAccountId);
  } catch (e) {
    logger.error(
      `auto-reply: cannot resolve bot token — ${e instanceof Error ? e.message : String(e)}`,
    );
    return () => {};
  }

  logger.info(
    `auto-reply: starting (interval=${arCfg.intervalMinutes ?? 10}m, ` +
      `maxPerBatch=${maxPerBatch}, cooldown=${arCfg.cooldownPerThreadMinutes ?? 30}m)`,
  );

  const timer = setInterval(() => {
    processPendingComments(
      logger,
      config,
      pluginConfig,
      token,
      discussionChatId,
      comments,
      posts,
      maxPerBatch,
      cooldownMs,
    ).catch((e) => {
      logger.error(
        `auto-reply tick error: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }, intervalMs);

  // Run first tick after a short delay to let the gateway fully start
  const initialTimer = setTimeout(() => {
    processPendingComments(
      logger,
      config,
      pluginConfig,
      token,
      discussionChatId,
      comments,
      posts,
      maxPerBatch,
      cooldownMs,
    ).catch((e) => {
      logger.error(
        `auto-reply initial tick error: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }, 30_000);

  return () => {
    clearInterval(timer);
    clearTimeout(initialTimer);
    logger.info("auto-reply: stopped");
  };
}

async function processPendingComments(
  logger: PluginLogger,
  config: OpenClawConfig,
  pluginConfig: TelegramAdminChannelConfig,
  token: string,
  discussionChatId: string,
  comments: CommentStorage,
  posts: PostStorage,
  maxPerBatch: number,
  cooldownMs: number,
): Promise<void> {
  const pending = await comments.getPending(maxPerBatch * 2); // fetch extra to account for cooldown skips
  if (pending.length === 0) return;

  logger.info(`auto-reply: processing ${pending.length} pending comment(s)`);

  let processed = 0;

  for (const comment of pending) {
    if (processed >= maxPerBatch) break;

    // Check per-thread cooldown
    if (comment.threadId !== undefined) {
      const lastReply = threadLastReply.get(comment.threadId);
      if (lastReply && Date.now() - lastReply < cooldownMs) {
        logger.debug?.(
          `auto-reply: skipping comment ${comment.messageId} — thread ${comment.threadId} in cooldown`,
        );
        continue;
      }
    }

    try {
      await processOneComment(
        logger,
        config,
        pluginConfig,
        token,
        discussionChatId,
        comments,
        posts,
        comment,
      );
      processed++;
    } catch (e) {
      logger.warn(
        `auto-reply: error processing comment ${comment.messageId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (processed > 0) {
    logger.info(`auto-reply: processed ${processed} comment(s) this batch`);
  }
}

async function processOneComment(
  logger: PluginLogger,
  config: OpenClawConfig,
  pluginConfig: TelegramAdminChannelConfig,
  token: string,
  discussionChatId: string,
  comments: CommentStorage,
  posts: PostStorage,
  comment: StoredComment,
): Promise<void> {
  // Find related post for context
  const postContext = await findPostContext(posts, comment);
  const fromName = comment.fromName ?? comment.from;
  const commentText = comment.text;

  // Build the body that provides context to the AI
  let body = "";
  if (postContext) {
    body += `[Post context: "${postContext.slice(0, 500)}"]\n\n`;
  }
  body += `Comment from ${fromName}: "${commentText}"`;

  // Build MsgContext for getReplyFromConfig
  const ctx: MsgContext = {
    Body: body,
    From: comment.from,
    To: `telegram:${discussionChatId}`,
    Provider: "telegram",
    Surface: "telegram",
    SessionKey: `auto-reply:${discussionChatId}`,
    ChatType: "group",
    SenderName: fromName,
    SenderId: comment.from,
    OwnerAllowFrom: pluginConfig.ownerAllowFrom,
    CommandAuthorized: true,
  };

  logger.debug?.(
    `auto-reply: calling AI for comment ${comment.messageId} from ${fromName}`,
  );

  let replyResult: { text?: string } | { text?: string }[] | undefined;
  try {
    replyResult = await getReplyFromConfig(ctx, {}, config);
  } catch (e) {
    logger.warn(
      `auto-reply: AI call failed for comment ${comment.messageId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    // Don't mark as skipped on transient errors — will retry next tick
    return;
  }

  // Extract text from reply
  const replyText = Array.isArray(replyResult)
    ? replyResult[0]?.text
    : replyResult?.text;

  if (!replyText) {
    logger.debug?.(
      `auto-reply: AI returned no reply for comment ${comment.messageId} — marking skipped`,
    );
    await comments.markSkipped(comment.messageId, comment.chatId);
    return;
  }

  // Send reply in the comment thread
  try {
    const sendResult = await TelegramBotApi.sendMessage(
      token,
      discussionChatId,
      replyText,
      {
        replyToMessageId: comment.messageId,
        messageThreadId: comment.threadId,
      },
    );

    const replyMsgId = sendResult.result?.message_id;
    if (replyMsgId) {
      await comments.markReplied(comment.messageId, comment.chatId, {
        replyMessageId: replyMsgId,
      });
    } else {
      await comments.markReplied(comment.messageId, comment.chatId, {
        replyMessageId: 0,
      });
    }

    // Update thread cooldown
    if (comment.threadId !== undefined) {
      threadLastReply.set(comment.threadId, Date.now());
    }

    logger.info(
      `auto-reply: replied to comment ${comment.messageId} from ${fromName}`,
    );
  } catch (e) {
    logger.warn(
      `auto-reply: failed to send reply for comment ${comment.messageId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function findPostContext(
  posts: PostStorage,
  comment: StoredComment,
): Promise<string | undefined> {
  // If the comment has a threadId, the thread starter message in discussion group
  // corresponds to a channel post. Try to find it in storage.
  if (comment.threadId) {
    const allPosts = await posts.getAll();
    // The threadId in discussion group often matches the messageId of the auto-forwarded post
    const post = allPosts.find((p) => p.messageId === comment.threadId);
    if (post) return post.text;
  }

  // Fallback: return the most recent post text as general context
  const recent = await posts.getAll(1);
  return recent[0]?.text;
}
