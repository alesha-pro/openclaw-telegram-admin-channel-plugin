import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import type { TelegramAdminChannelConfig } from "./schema.js";
import type { CommentStorage, PostStorage, StoredComment } from "./storage.js";
import type { MtprotoClient } from "./mtproto-client.js";
import { resolveBotToken, TelegramBotApi } from "./telegram-api.js";

type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type ReplyResult = { text?: string };

// Resolve getReplyFromConfig from the gateway's own openclaw module (simple mode)
let _getReplyFromConfig:
  | ((ctx: Record<string, unknown>, opts: Record<string, unknown>, config: OpenClawConfig) => Promise<ReplyResult | ReplyResult[] | undefined>)
  | null = null;

function resolveGetReplyFn(logger: PluginLogger): typeof _getReplyFromConfig {
  if (_getReplyFromConfig) return _getReplyFromConfig;

  // Try multiple resolve bases — process.argv[1] may be a binary wrapper
  const candidates = [
    process.argv[1],
    "/usr/lib/node_modules/openclaw/dist/entry.js",
    "/usr/lib/node_modules/openclaw/dist/index.js",
  ].filter(Boolean) as string[];

  for (const base of candidates) {
    try {
      const req = createRequire(base);
      const mod = req("openclaw");
      if (typeof mod.getReplyFromConfig === "function") {
        _getReplyFromConfig = mod.getReplyFromConfig;
        logger.info(`discussion-monitor: resolved getReplyFromConfig via ${base}`);
        return _getReplyFromConfig;
      }
    } catch {
      // try next candidate
    }
  }

  logger.warn("discussion-monitor: getReplyFromConfig not found in any candidate path");
  return null;
}

// --- Agent mode: call gateway HTTP /v1/chat/completions ---

async function callAgentApi(params: {
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
  sessionKey: string;
  userMessage: string;
  logger: PluginLogger;
}): Promise<string | null> {
  const { gatewayUrl, gatewayToken, agentId, sessionKey, userMessage, logger } = params;

  logger.debug?.(`discussion-monitor: calling agent API (agent=${agentId}, session=${sessionKey})`);

  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${gatewayToken}`,
      "x-openclaw-agent-id": agentId,
      "x-openclaw-session-key": sessionKey,
    },
    body: JSON.stringify({
      model: "openclaw",
      messages: [{ role: "user", content: userMessage }],
    }),
    signal: AbortSignal.timeout(120_000), // 2min timeout
  });

  if (!response.ok) {
    throw new Error(`Gateway returned ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return data?.choices?.[0]?.message?.content ?? null;
}

// Track last reply timestamp per thread to enforce cooldown
const threadLastReply = new Map<number, number>();

export function startDiscussionMonitor(
  api: OpenClawPluginApi,
  pluginConfig: TelegramAdminChannelConfig,
  mtprotoClient: MtprotoClient,
  comments: CommentStorage,
  posts: PostStorage,
): () => void {
  const logger = api.logger;
  const config = api.config;
  const discussionChatId = pluginConfig.discussion!.chatId;
  const ownerIds = new Set(pluginConfig.ownerAllowFrom ?? []);
  const arCfg = pluginConfig.autoReply;
  const intervalMs = (arCfg?.intervalMinutes ?? 5) * 60_000;

  // Notification config
  const notifyCfg = pluginConfig.notifications?.onComment;
  const notifyEnabled = notifyCfg?.enabled && notifyCfg.notifyChatId;
  const minNotifyIntervalMs = (notifyCfg?.minInterval ?? 60) * 1000;
  let lastNotifyTs = 0;

  let botUserId = 0;
  let lastSeenId = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;

  let token: string;
  try {
    token = resolveBotToken(config, pluginConfig.telegramAccountId);
  } catch (e) {
    logger.error(
      `discussion-monitor: cannot resolve bot token — ${e instanceof Error ? e.message : String(e)}`,
    );
    return () => {};
  }

  // Resolve bot user ID, then start polling
  TelegramBotApi.getMe(token)
    .then((me) => {
      botUserId = me.id;
      logger.info(
        `discussion-monitor: bot userId=${botUserId} (${me.username ?? "no username"})`,
      );
    })
    .catch((e) => {
      logger.warn(
        `discussion-monitor: getMe failed, bot filtering disabled — ${e instanceof Error ? e.message : String(e)}`,
      );
    })
    .finally(() => {
      const mode = arCfg?.mode ?? "simple";
      logger.info(
        `discussion-monitor: starting (interval=${arCfg?.intervalMinutes ?? 5}m, ` +
          `discussion=${discussionChatId}, autoReply=${arCfg?.enabled ? "on" : "off"}, mode=${mode})`,
      );

      timer = setInterval(() => {
        pollDiscussion().catch((e) => {
          logger.error(
            `discussion-monitor tick error: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      }, intervalMs);

      // First tick after 15s delay
      initialTimer = setTimeout(() => {
        pollDiscussion().catch((e) => {
          logger.error(
            `discussion-monitor initial tick error: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      }, 15_000);
    });

  async function pollDiscussion(): Promise<void> {
    const messages = await mtprotoClient.getHistory(discussionChatId, {
      limit: 50,
      minId: lastSeenId,
    });

    // Sort ascending by id
    messages.sort((a, b) => a.id - b.id);

    let newCount = 0;

    for (const msg of messages) {
      // Track highest seen
      if (msg.id > lastSeenId) lastSeenId = msg.id;

      // Skip auto-forwarded channel post copies
      if (msg.isForward) continue;

      // Skip bot's own messages
      if (botUserId && msg.fromId === botUserId) continue;

      // Skip empty text
      if (!msg.text) continue;

      // Determine status: owner messages get no status, others get "pending"
      const isOwner = msg.fromId ? ownerIds.has(String(msg.fromId)) : false;
      const status: "pending" | undefined = isOwner ? undefined : "pending";

      const inserted = await comments.upsertComment({
        messageId: msg.id,
        chatId: discussionChatId,
        text: msg.text,
        timestamp: msg.date * 1000,
        from: String(msg.fromId ?? "unknown"),
        fromName: msg.fromName ?? msg.fromUsername,
        threadId: msg.replyToTopId ?? msg.replyToMsgId,
        ...(status ? { status } : {}),
      });

      if (inserted) {
        newCount++;

        // Send notification for new comments
        if (notifyEnabled && status === "pending") {
          const now = Date.now();
          if (now - lastNotifyTs >= minNotifyIntervalMs) {
            lastNotifyTs = now;
            const from = msg.fromName ?? msg.fromUsername ?? String(msg.fromId);
            const preview = msg.text.slice(0, 200);
            const notifyText = `New comment from ${from}:\n${preview}`;
            try {
              await TelegramBotApi.sendMessage(token, notifyCfg!.notifyChatId, notifyText);
            } catch (e) {
              logger.warn(
                `discussion-monitor: notification failed: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        }
      }
    }

    if (newCount > 0) {
      logger.info(`discussion-monitor: polled ${newCount} new message(s)`);
    }

    // Process auto-replies if enabled
    if (arCfg?.enabled) {
      await processAutoReplies();
    }
  }

  // --- Dispatch based on mode ---

  async function processAutoReplies(): Promise<void> {
    const mode = arCfg?.mode ?? "simple";

    if (mode === "agent") {
      await processAutoRepliesAgent();
    } else {
      await processAutoRepliesSimple();
    }
  }

  // --- Agent mode: full agent sessions via gateway HTTP ---

  async function processAutoRepliesAgent(): Promise<void> {
    const gatewayUrl = arCfg?.gatewayUrl ?? "http://127.0.0.1:18789";
    const gatewayToken = arCfg?.gatewayToken;
    const agentId = arCfg?.agentId ?? "discussion-responder";
    const maxPerBatch = arCfg?.maxRepliesPerBatch ?? 5;
    const cooldownMs = (arCfg?.cooldownPerThreadMinutes ?? 30) * 60_000;

    if (!gatewayToken) {
      logger.warn("discussion-monitor: agent mode requires gatewayToken — skipping");
      return;
    }

    const pending = await comments.getPending(maxPerBatch * 2);
    if (pending.length === 0) return;

    logger.info(`discussion-monitor: processing ${pending.length} pending comment(s) via agent`);

    let processed = 0;

    for (const comment of pending) {
      if (processed >= maxPerBatch) break;

      // Per-thread cooldown
      const threadId = comment.threadId ?? comment.messageId;
      const lastReply = threadLastReply.get(threadId);
      if (lastReply && Date.now() - lastReply < cooldownMs) {
        logger.debug?.(
          `discussion-monitor: skipping comment ${comment.messageId} — thread ${threadId} in cooldown`,
        );
        continue;
      }

      try {
        const postContext = await findPostContext(posts, comment);
        const fromName = comment.fromName ?? comment.from;

        let userMessage = "";
        if (postContext) {
          userMessage += `[Post: "${postContext.slice(0, 500)}"]\n\n`;
        }
        userMessage += `Comment from ${fromName}: "${comment.text}"`;

        const sessionKey = `discussion:thread:${threadId}`;

        const replyText = await callAgentApi({
          gatewayUrl,
          gatewayToken,
          agentId,
          sessionKey,
          userMessage,
          logger,
        });

        if (replyText) {
          const sendResult = await TelegramBotApi.sendMessage(
            token,
            discussionChatId,
            replyText,
            {
              replyToMessageId: comment.messageId,
              messageThreadId: comment.threadId,
            },
          );

          await comments.markReplied(comment.messageId, comment.chatId, {
            replyMessageId: sendResult.result?.message_id ?? 0,
          });
          threadLastReply.set(threadId, Date.now());
          logger.info(
            `discussion-monitor: agent replied to ${comment.messageId} from ${fromName}`,
          );
        } else {
          await comments.markSkipped(comment.messageId, comment.chatId);
          logger.debug?.(
            `discussion-monitor: agent returned no reply for ${comment.messageId} — marked skipped`,
          );
        }

        processed++;
      } catch (e) {
        logger.warn(
          `discussion-monitor: agent error for ${comment.messageId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (processed > 0) {
      logger.info(`discussion-monitor: agent processed ${processed} comment(s)`);
    }
  }

  // --- Simple mode: one-shot getReplyFromConfig (legacy) ---

  async function processAutoRepliesSimple(): Promise<void> {
    const maxPerBatch = arCfg?.maxRepliesPerBatch ?? 5;
    const cooldownMs = (arCfg?.cooldownPerThreadMinutes ?? 30) * 60_000;

    const pending = await comments.getPending(maxPerBatch * 2);
    if (pending.length === 0) return;

    const getReplyFn = resolveGetReplyFn(logger);
    if (!getReplyFn) {
      logger.warn("discussion-monitor: getReplyFromConfig unavailable — skipping auto-replies");
      return;
    }

    logger.info(`discussion-monitor: processing ${pending.length} pending comment(s) for auto-reply`);

    let processed = 0;

    for (const comment of pending) {
      if (processed >= maxPerBatch) break;

      // Per-thread cooldown
      if (comment.threadId !== undefined) {
        const lastReply = threadLastReply.get(comment.threadId);
        if (lastReply && Date.now() - lastReply < cooldownMs) {
          logger.debug?.(
            `discussion-monitor: skipping comment ${comment.messageId} — thread ${comment.threadId} in cooldown`,
          );
          continue;
        }
      }

      try {
        await processOneCommentSimple(comment, getReplyFn);
        processed++;
      } catch (e) {
        logger.warn(
          `discussion-monitor: error processing comment ${comment.messageId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (processed > 0) {
      logger.info(`discussion-monitor: auto-replied to ${processed} comment(s)`);
    }
  }

  async function processOneCommentSimple(
    comment: StoredComment,
    getReplyFn: NonNullable<typeof _getReplyFromConfig>,
  ): Promise<void> {
    const postContext = await findPostContext(posts, comment);
    const fromName = comment.fromName ?? comment.from;

    let body = "";
    if (postContext) {
      body += `[Post context: "${postContext.slice(0, 500)}"]\n\n`;
    }
    body += `Comment from ${fromName}: "${comment.text}"`;

    const ctx: Record<string, unknown> = {
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
      `discussion-monitor: calling AI for comment ${comment.messageId} from ${fromName}`,
    );

    let replyResult: ReplyResult | ReplyResult[] | undefined;
    try {
      replyResult = await getReplyFn(ctx, {}, config);
    } catch (e) {
      logger.warn(
        `discussion-monitor: AI call failed for comment ${comment.messageId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    const replyText = Array.isArray(replyResult)
      ? replyResult[0]?.text
      : replyResult?.text;

    if (!replyText) {
      logger.debug?.(
        `discussion-monitor: AI returned no reply for comment ${comment.messageId} — marking skipped`,
      );
      await comments.markSkipped(comment.messageId, comment.chatId);
      return;
    }

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
      await comments.markReplied(comment.messageId, comment.chatId, {
        replyMessageId: replyMsgId ?? 0,
      });

      if (comment.threadId !== undefined) {
        threadLastReply.set(comment.threadId, Date.now());
      }

      logger.info(
        `discussion-monitor: replied to comment ${comment.messageId} from ${fromName}`,
      );
    } catch (e) {
      logger.warn(
        `discussion-monitor: failed to send reply for comment ${comment.messageId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return () => {
    if (timer) clearInterval(timer);
    if (initialTimer) clearTimeout(initialTimer);
    logger.info("discussion-monitor: stopped");
  };
}

async function findPostContext(
  posts: PostStorage,
  comment: StoredComment,
): Promise<string | undefined> {
  if (comment.threadId) {
    const allPosts = await posts.getAll();
    const post = allPosts.find((p) => p.messageId === comment.threadId);
    if (post) return post.text;
  }
  const recent = await posts.getAll(1);
  return recent[0]?.text;
}
