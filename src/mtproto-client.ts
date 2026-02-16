import { readFile } from "node:fs/promises";
import { TelegramClient, Api } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import { StringSession } from "telegram/sessions/index.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type MtprotoClientOpts = {
  apiId: number;
  apiHash: string;
  sessionPath: string;
  logger?: Logger;
};

export type ViewCountResult = {
  messageId: number;
  views: number;
  forwards: number;
};

export type ChannelStatsResult = {
  period: { minDate: number; maxDate: number };
  followers: { current: number; previous: number };
  viewsPerPost: { current: number; previous: number };
  sharesPerPost: { current: number; previous: number };
  reactionsPerPost: { current: number; previous: number };
  enabledNotifications: { part: number };
  growthGraph?: unknown;
  topHoursByViews?: number[];
};

export type PostStatsResult = {
  messageId: number;
  viewsGraph?: unknown;
  reactionsGraph?: unknown;
};

export type ScheduledMessage = {
  id: number;
  date: number;
  text: string;
};

export type HistoryMessage = {
  id: number;
  date: number;
  text: string;
  views?: number;
  forwards?: number;
  editDate?: number;
  reactions?: { emoji: string; count: number }[];
};

function n(val: unknown): number {
  if (typeof val === "bigint") return Number(val);
  if (typeof val === "number") return val;
  return 0;
}

function resolveInputChannel(
  peer: Api.TypeInputPeer,
): Api.InputChannel {
  if (peer instanceof Api.InputPeerChannel) {
    return new Api.InputChannel({
      channelId: peer.channelId,
      accessHash: peer.accessHash,
    });
  }
  throw new Error(
    "Expected InputPeerChannel, got " + peer.className,
  );
}

async function resolveGraph(
  client: TelegramClient,
  graph: Api.TypeStatsGraph,
): Promise<unknown | null> {
  if (graph instanceof Api.StatsGraphAsync) {
    const result = await client.invoke(
      new Api.stats.LoadAsyncGraph({ token: graph.token }),
    );
    if (result instanceof Api.StatsGraph) {
      try {
        return JSON.parse(result.json.data);
      } catch {
        return result.json.data;
      }
    }
    return null;
  }
  if (graph instanceof Api.StatsGraph) {
    try {
      return JSON.parse(graph.json.data);
    } catch {
      return graph.json.data;
    }
  }
  return null;
}

export class MtprotoClient {
  private client: TelegramClient | null = null;
  private readonly opts: MtprotoClientOpts;
  private readonly log: Logger;

  constructor(opts: MtprotoClientOpts) {
    this.opts = opts;
    this.log = opts.logger ?? {
      info: console.log,
      warn: console.warn,
      error: console.error,
    };
  }

  async ensureConnected(): Promise<TelegramClient> {
    if (this.client) return this.client;

    let sessionStr: string;
    try {
      sessionStr = (await readFile(this.opts.sessionPath, "utf-8")).trim();
    } catch {
      throw new Error(
        `MTProto session file not found at ${this.opts.sessionPath}. ` +
          `Run "pnpm mtproto:auth" to create it (requires TELEGRAM_API_ID and TELEGRAM_API_HASH env vars or interactive input).`,
      );
    }

    const session = new StringSession(sessionStr);
    this.client = new TelegramClient(session, this.opts.apiId, this.opts.apiHash, {
      connectionRetries: 3,
    });

    await this.client.connect();
    this.log.info("MTProto client connected");
    return this.client;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
      this.log.info("MTProto client disconnected");
    }
  }

  async getViews(
    peer: string,
    messageIds: number[],
  ): Promise<ViewCountResult[]> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    const result = await client.invoke(
      new Api.messages.GetMessagesViews({
        peer: inputPeer,
        id: messageIds,
        increment: false,
      }),
    );

    return result.views.map((v, i) => ({
      messageId: messageIds[i],
      views: n(v.views),
      forwards: n(v.forwards),
    }));
  }

  async getChannelStats(peer: string): Promise<ChannelStatsResult> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);
    const inputChannel = resolveInputChannel(inputPeer);

    const stats = await client.invoke(
      new Api.stats.GetBroadcastStats({
        channel: inputChannel,
      }),
    );

    const growthGraph = await resolveGraph(client, stats.growthGraph);

    const topHours = stats.topHoursGraph
      ? await resolveGraph(client, stats.topHoursGraph)
      : undefined;

    return {
      period: {
        minDate: n(stats.period.minDate),
        maxDate: n(stats.period.maxDate),
      },
      followers: {
        current: n(stats.followers.current),
        previous: n(stats.followers.previous),
      },
      viewsPerPost: {
        current: n(stats.viewsPerPost.current),
        previous: n(stats.viewsPerPost.previous),
      },
      sharesPerPost: {
        current: n(stats.sharesPerPost.current),
        previous: n(stats.sharesPerPost.previous),
      },
      reactionsPerPost: {
        current: n(stats.reactionsPerPost.current),
        previous: n(stats.reactionsPerPost.previous),
      },
      enabledNotifications: {
        part: n(stats.enabledNotifications.part),
      },
      growthGraph: growthGraph ?? undefined,
      topHoursByViews: topHours as number[] | undefined,
    };
  }

  async getPostStats(
    peer: string,
    messageId: number,
  ): Promise<PostStatsResult> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);
    const inputChannel = resolveInputChannel(inputPeer);

    const stats = await client.invoke(
      new Api.stats.GetMessageStats({
        channel: inputChannel,
        msgId: messageId,
      }),
    );

    const viewsGraph = await resolveGraph(client, stats.viewsGraph);
    const reactionsGraph = stats.reactionsByEmotionGraph
      ? await resolveGraph(client, stats.reactionsByEmotionGraph)
      : null;

    return {
      messageId,
      viewsGraph: viewsGraph ?? undefined,
      reactionsGraph: reactionsGraph ?? undefined,
    };
  }

  async getHistory(
    peer: string,
    opts?: { limit?: number; offsetId?: number },
  ): Promise<HistoryMessage[]> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    const result = await client.invoke(
      new Api.messages.GetHistory({
        peer: inputPeer,
        limit: opts?.limit ?? 20,
        offsetId: opts?.offsetId ?? 0,
        offsetDate: 0,
        addOffset: 0,
        maxId: 0,
        minId: 0,
        hash: 0 as unknown as Api.long,
      }),
    );

    if (
      !(result instanceof Api.messages.Messages) &&
      !(result instanceof Api.messages.MessagesSlice) &&
      !(result instanceof Api.messages.ChannelMessages)
    ) {
      return [];
    }

    return result.messages
      .filter((m): m is Api.Message => m instanceof Api.Message)
      .map((msg) => {
        const reactions: { emoji: string; count: number }[] = [];
        if (msg.reactions?.results) {
          for (const r of msg.reactions.results) {
            const emoji =
              r.reaction instanceof Api.ReactionEmoji
                ? r.reaction.emoticon
                : r.reaction instanceof Api.ReactionCustomEmoji
                  ? `custom:${n(r.reaction.documentId)}`
                  : "?";
            reactions.push({ emoji, count: n(r.count) });
          }
        }

        return {
          id: n(msg.id),
          date: n(msg.date),
          text: msg.message ?? "",
          views: msg.views != null ? n(msg.views) : undefined,
          forwards: msg.forwards != null ? n(msg.forwards) : undefined,
          editDate: msg.editDate != null ? n(msg.editDate) : undefined,
          reactions: reactions.length > 0 ? reactions : undefined,
        };
      });
  }

  async scheduleMessage(
    peer: string,
    text: string,
    scheduleDate: number,
    opts?: { silent?: boolean; parseMode?: string },
  ): Promise<{ messageId: number; scheduleDate: number }> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    const result = await client.invoke(
      new Api.messages.SendMessage({
        peer: inputPeer,
        message: text,
        scheduleDate,
        silent: opts?.silent,
        randomId: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) as unknown as Api.long,
      }),
    );

    let msgId = 0;
    if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
      for (const upd of result.updates) {
        if (upd instanceof Api.UpdateNewScheduledMessage && upd.message instanceof Api.Message) {
          msgId = n(upd.message.id);
          break;
        }
      }
    }

    return { messageId: msgId, scheduleDate };
  }

  async scheduleMediaPost(
    peer: string,
    botToken: string,
    fileId: string,
    opts: { caption?: string; scheduleDate: number; silent?: boolean },
  ): Promise<{ messageId: number; scheduleDate: number }> {
    const client = await this.ensureConnected();

    // 1. Get file path via Bot API
    const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const getFileResp = await fetch(getFileUrl);
    const getFileData = (await getFileResp.json()) as {
      ok: boolean;
      result?: { file_path: string; file_size?: number };
      description?: string;
    };
    if (!getFileData.ok || !getFileData.result?.file_path) {
      throw new Error(
        `Bot API getFile failed: ${getFileData.description ?? "unknown error"}`,
      );
    }

    // 2. Download the file binary
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${getFileData.result.file_path}`;
    const downloadResp = await fetch(downloadUrl);
    if (!downloadResp.ok) {
      throw new Error(
        `Failed to download file: ${downloadResp.status} ${downloadResp.statusText}`,
      );
    }
    const buffer = Buffer.from(await downloadResp.arrayBuffer());
    const fileName = getFileData.result.file_path.split("/").pop() ?? "photo.jpg";

    // 3. Upload and send via gramjs
    const inputPeer = await client.getInputEntity(peer);
    const file = new CustomFile(fileName, buffer.length, "", buffer);

    const result = await client.sendFile(inputPeer, {
      file,
      caption: opts.caption,
      scheduleDate: opts.scheduleDate,
      silent: opts.silent,
    });

    // 4. Extract messageId
    let msgId = 0;
    if (result instanceof Api.Message) {
      msgId = n(result.id);
    }

    return { messageId: msgId, scheduleDate: opts.scheduleDate };
  }

  async getScheduledMessages(peer: string): Promise<ScheduledMessage[]> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    const result = await client.invoke(
      new Api.messages.GetScheduledHistory({
        peer: inputPeer,
        hash: 0 as unknown as Api.long,
      }),
    );

    if (
      !(result instanceof Api.messages.Messages) &&
      !(result instanceof Api.messages.MessagesSlice) &&
      !(result instanceof Api.messages.ChannelMessages)
    ) {
      return [];
    }

    return result.messages
      .filter((m): m is Api.Message => m instanceof Api.Message)
      .map((msg) => ({
        id: n(msg.id),
        date: n(msg.date),
        text: msg.message ?? "",
      }));
  }

  async deleteScheduledMessages(
    peer: string,
    messageIds: number[],
  ): Promise<void> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    await client.invoke(
      new Api.messages.DeleteScheduledMessages({
        peer: inputPeer,
        id: messageIds,
      }),
    );
  }

  async sendScheduledNow(
    peer: string,
    messageIds: number[],
  ): Promise<void> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    await client.invoke(
      new Api.messages.SendScheduledMessages({
        peer: inputPeer,
        id: messageIds,
      }),
    );
  }
}
