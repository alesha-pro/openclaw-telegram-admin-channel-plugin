import { resolveTelegramAccount } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

export function resolveBotToken(
  config: OpenClawConfig,
  accountId?: string,
): string {
  const account = resolveTelegramAccount({
    cfg: config,
    accountId: accountId ?? null,
  });
  if (!account.token || account.tokenSource === "none") {
    throw new Error(
      `Telegram bot token not found for account "${account.accountId}". ` +
        `Set channels.telegram.botToken or TELEGRAM_BOT_TOKEN.`,
    );
  }
  return account.token;
}

export type SendMessageOptions = {
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  disableNotification?: boolean;
  replyMarkup?: Record<string, unknown>;
};

export type TelegramApiResult = {
  ok: boolean;
  result?: {
    message_id: number;
    chat: { id: number; title?: string; username?: string };
    date: number;
    text?: string;
  };
  description?: string;
  error_code?: number;
};

export type ParsedPost = {
  messageId: number;
  text: string;
  timestamp: number;
  permalink: string;
};

const TELEGRAM_API_BASE = "https://api.telegram.org";

export class TelegramBotApi {
  static async sendMessage(
    token: string,
    chatId: string,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<TelegramApiResult> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (opts?.parseMode) body.parse_mode = opts.parseMode;
    if (opts?.disableNotification) body.disable_notification = true;
    if (opts?.replyMarkup) body.reply_markup = opts.replyMarkup;

    const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as TelegramApiResult;

    if (!response.ok || !data.ok) {
      throw new Error(
        `Telegram API error ${data.error_code ?? response.status}: ${data.description ?? "unknown error"}`,
      );
    }

    return data;
  }
}

export async function fetchPublicChannelPosts(
  channelUsername: string,
): Promise<ParsedPost[]> {
  const username = channelUsername.replace(/^@/, "");
  const url = `https://t.me/s/${username}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; OpenClaw/1.0; +https://openclaw.dev)",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch t.me/s/${username}: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  return parseChannelHtml(html, username);
}

function parseChannelHtml(html: string, username: string): ParsedPost[] {
  const posts: ParsedPost[] = [];

  // Match each widget message block
  const messageBlockRe =
    /class="tgme_widget_message_wrap[^"]*"[^>]*>[\s\S]*?class="tgme_widget_message "[^>]*data-post="([^"]+)"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;

  // Simpler approach: find all data-post attributes and their associated text/date
  const postRe = /data-post="([^"]+)"/g;
  const dataPostMatches = [...html.matchAll(postRe)];

  for (const match of dataPostMatches) {
    const dataPost = match[1]; // e.g. "channelname/123"
    const msgIdStr = dataPost.split("/").pop();
    if (!msgIdStr) continue;

    const messageId = parseInt(msgIdStr, 10);
    if (isNaN(messageId)) continue;

    // Extract the surrounding context for this message
    const postIdx = match.index!;
    // Find the enclosing message block - look backwards for message wrapper
    const blockStart = html.lastIndexOf("tgme_widget_message_wrap", postIdx);
    // Find reasonable end of block
    const searchEnd = Math.min(postIdx + 5000, html.length);
    const blockHtml = html.slice(
      Math.max(0, blockStart - 100),
      searchEnd,
    );

    // Extract text from tgme_widget_message_text
    const textMatch = blockHtml.match(
      /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    const rawText = textMatch ? stripHtmlTags(textMatch[1]).trim() : "";

    // Extract datetime
    const dateMatch = blockHtml.match(/datetime="([^"]+)"/);
    const timestamp = dateMatch
      ? new Date(dateMatch[1]).getTime()
      : 0;

    const permalink = `https://t.me/${username}/${messageId}`;

    posts.push({ messageId, text: rawText, timestamp, permalink });
  }

  return posts;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
