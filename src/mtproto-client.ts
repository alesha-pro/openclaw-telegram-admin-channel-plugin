import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TelegramClient, Api } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import { StringSession } from "telegram/sessions/index.js";
import { withRetry, isTelegramRetryable } from "./retry.js";

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

export type AdminInfo = {
  userId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  isCreator: boolean;
  rights: Record<string, unknown>;
};

export type AdminRightsInput = {
  changeInfo?: boolean;
  postMessages?: boolean;
  editMessages?: boolean;
  deleteMessages?: boolean;
  banUsers?: boolean;
  inviteUsers?: boolean;
  pinMessages?: boolean;
  manageCall?: boolean;
  addAdmins?: boolean;
  rank?: string;
};

export type HistoryMessage = {
  id: number;
  date: number;
  text: string;
  views?: number;
  forwards?: number;
  editDate?: number;
  reactions?: { emoji: string; count: number }[];
  fromId?: number;
  fromName?: string;
  fromUsername?: string;
  replyToMsgId?: number;
  replyToTopId?: number;
  isForward?: boolean;
};

function n(val: unknown): number {
  if (typeof val === "bigint") return Number(val);
  if (typeof val === "number") return val;
  // GramJS may wrap IDs in custom objects with valueOf()
  if (val != null) {
    const num = Number(val);
    if (Number.isFinite(num)) return num;
  }
  return 0;
}

function generateRandomId(): Api.long {
  const buf = randomBytes(8);
  const hi = buf.readUInt32BE(0);
  const lo = buf.readUInt32BE(4);
  return (BigInt(hi) << 32n | BigInt(lo)) as unknown as Api.long;
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

export type MediaType = "photo" | "video" | "document";

const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"]);

function detectMediaType(fileName: string): MediaType {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (PHOTO_EXTS.has(ext)) return "photo";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "document";
}

function extractAdminRights(rights: Api.ChatAdminRights): Record<string, boolean> {
  return {
    changeInfo: !!rights.changeInfo,
    postMessages: !!rights.postMessages,
    editMessages: !!rights.editMessages,
    deleteMessages: !!rights.deleteMessages,
    banUsers: !!rights.banUsers,
    inviteUsers: !!rights.inviteUsers,
    pinMessages: !!rights.pinMessages,
    manageCall: !!rights.manageCall,
    addAdmins: !!rights.addAdmins,
  };
}

function redactToken(token: string): string {
  if (token.length <= 8) return "***";
  return token.slice(0, 4) + "***" + token.slice(-4);
}

async function fetchBotFile(
  botToken: string,
  fileId: string,
): Promise<{ buffer: Buffer; fileName: string }> {
  return withRetry(
    async () => {
      const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
      let getFileResp: Response;
      try {
        getFileResp = await fetch(getFileUrl);
      } catch (e) {
        throw new Error(
          `Bot API getFile network error for ${fileId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const getFileData = (await getFileResp.json()) as {
        ok: boolean;
        result?: { file_path: string; file_size?: number };
        description?: string;
      };
      if (!getFileData.ok || !getFileData.result?.file_path) {
        throw new Error(
          `Bot API getFile failed for ${fileId}: ${getFileData.description ?? "unknown error"}`,
        );
      }

      const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${getFileData.result.file_path}`;
      let downloadResp: Response;
      try {
        downloadResp = await fetch(downloadUrl);
      } catch (e) {
        throw new Error(
          `Failed to download file ${fileId} (token: ${redactToken(botToken)}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!downloadResp.ok) {
        throw new Error(
          `Failed to download file ${fileId}: ${downloadResp.status} ${downloadResp.statusText}`,
        );
      }
      const buffer = Buffer.from(await downloadResp.arrayBuffer());
      const fileName = getFileData.result.file_path.split("/").pop() ?? "photo.jpg";
      return { buffer, fileName };
    },
    { isRetryable: isTelegramRetryable },
  );
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

  get isConnected(): boolean {
    return this.client !== null;
  }

  private async invoke<R>(request: Api.AnyRequest): Promise<R> {
    const client = await this.ensureConnected();
    return withRetry(
      () => client.invoke(request) as Promise<R>,
      { isRetryable: isTelegramRetryable },
    );
  }

  async getViews(
    peer: string,
    messageIds: number[],
  ): Promise<ViewCountResult[]> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    const result = await this.invoke<Api.messages.MessageViews>(
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

    const stats = await this.invoke<Api.stats.BroadcastStats>(
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

    const stats = await this.invoke<Api.stats.MessageStats>(
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
    opts?: { limit?: number; offsetId?: number; minId?: number },
  ): Promise<HistoryMessage[]> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    const result = await this.invoke<Api.messages.TypeMessages>(
      new Api.messages.GetHistory({
        peer: inputPeer,
        limit: opts?.limit ?? 20,
        offsetId: opts?.offsetId ?? 0,
        offsetDate: 0,
        addOffset: 0,
        maxId: 0,
        minId: opts?.minId ?? 0,
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

    // Build user map for resolving sender info
    const userMap = new Map<number, Api.User>();
    if (result.users) {
      for (const u of result.users) {
        if (u instanceof Api.User) {
          userMap.set(n(u.id), u);
        }
      }
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

        // Resolve sender
        let fromId: number | undefined;
        let fromName: string | undefined;
        let fromUsername: string | undefined;
        if (msg.fromId instanceof Api.PeerUser) {
          fromId = n(msg.fromId.userId);
          const user = userMap.get(fromId);
          if (user) {
            const parts = [user.firstName, user.lastName].filter(Boolean);
            fromName = parts.join(" ") || undefined;
            fromUsername = user.username ?? undefined;
          }
        } else if (msg.fromId instanceof Api.PeerChannel) {
          fromId = n(msg.fromId.channelId);
        }

        // Resolve reply
        let replyToMsgId: number | undefined;
        let replyToTopId: number | undefined;
        if (msg.replyTo instanceof Api.MessageReplyHeader) {
          replyToMsgId = msg.replyTo.replyToMsgId != null ? n(msg.replyTo.replyToMsgId) : undefined;
          replyToTopId = msg.replyTo.replyToTopId != null ? n(msg.replyTo.replyToTopId) : undefined;
        }

        // Detect forward
        const isForward = !!msg.fwdFrom;

        return {
          id: n(msg.id),
          date: n(msg.date),
          text: msg.message ?? "",
          views: msg.views != null ? n(msg.views) : undefined,
          forwards: msg.forwards != null ? n(msg.forwards) : undefined,
          editDate: msg.editDate != null ? n(msg.editDate) : undefined,
          reactions: reactions.length > 0 ? reactions : undefined,
          fromId,
          fromName,
          fromUsername,
          replyToMsgId,
          replyToTopId,
          isForward,
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

    const result = await this.invoke<Api.TypeUpdates>(
      new Api.messages.SendMessage({
        peer: inputPeer,
        message: text,
        scheduleDate,
        silent: opts?.silent,
        randomId: generateRandomId(),
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
    sources: Array<
      | { type: "fileId"; botToken: string; fileId: string; mediaType?: MediaType }
      | { type: "localFile"; buffer: Buffer; fileName: string; mediaType?: MediaType }
    >,
    opts: { caption?: string; scheduleDate: number; silent?: boolean },
  ): Promise<{ messageIds: number[]; scheduleDate: number }> {
    const client = await this.ensureConnected();

    const files: CustomFile[] = [];
    const forceDocument: boolean[] = [];
    for (const source of sources) {
      let buffer: Buffer;
      let fileName: string;

      if (source.type === "fileId") {
        const downloaded = await fetchBotFile(source.botToken, source.fileId);
        buffer = downloaded.buffer;
        fileName = downloaded.fileName;
      } else {
        buffer = source.buffer;
        fileName = source.fileName;
      }

      files.push(new CustomFile(fileName, buffer.length, "", buffer));
      forceDocument.push((source.mediaType ?? detectMediaType(fileName)) === "document");
    }

    const inputPeer = await client.getInputEntity(peer);

    // For single file, we can set forceDocument directly
    // For albums, GramJS handles type detection from file extension
    const isDocument = forceDocument.length === 1 && forceDocument[0];
    const result = await client.sendFile(inputPeer, {
      file: files.length === 1 ? files[0] : files,
      caption: opts.caption,
      scheduleDate: opts.scheduleDate,
      silent: opts.silent,
      forceDocument: isDocument || undefined,
    });

    const messageIds: number[] = [];
    if (Array.isArray(result)) {
      for (const msg of result) {
        if (msg instanceof Api.Message) messageIds.push(n(msg.id));
      }
    } else if (result instanceof Api.Message) {
      messageIds.push(n(result.id));
    }

    return { messageIds, scheduleDate: opts.scheduleDate };
  }

  async getScheduledMessages(peer: string): Promise<ScheduledMessage[]> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    const result = await this.invoke<Api.messages.TypeMessages>(
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

    await this.invoke(
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

    await this.invoke(
      new Api.messages.SendScheduledMessages({
        peer: inputPeer,
        id: messageIds,
      }),
    );
  }

  // --- Get discussion thread ID for a channel post ---

  async getDiscussionThreadId(
    channelPeer: string,
    postMessageId: number,
  ): Promise<number> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(channelPeer);

    const result = await this.invoke<Api.messages.DiscussionMessage>(
      new Api.messages.GetDiscussionMessage({
        peer: inputPeer,
        msgId: postMessageId,
      }),
    );

    const threadMsg = result.messages[0];
    if (!(threadMsg instanceof Api.Message)) {
      throw new Error(`No discussion thread found for post ${postMessageId}`);
    }
    return n(threadMsg.id);
  }

  // --- Send message (e.g. reply in discussion) ---

  async sendMessage(
    peer: string,
    text: string,
    opts?: { replyToMsgId?: number; topMsgId?: number; silent?: boolean },
  ): Promise<{ messageId: number }> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    const replyTo = opts?.replyToMsgId
      ? new Api.InputReplyToMessage({
          replyToMsgId: opts.replyToMsgId,
          topMsgId: opts.topMsgId,
        })
      : undefined;

    const result = await this.invoke<Api.TypeUpdates>(
      new Api.messages.SendMessage({
        peer: inputPeer,
        message: text,
        replyTo,
        silent: opts?.silent,
        randomId: generateRandomId(),
      }),
    );

    let msgId = 0;
    if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
      for (const upd of result.updates) {
        if (
          (upd instanceof Api.UpdateNewMessage || upd instanceof Api.UpdateNewChannelMessage) &&
          upd.message instanceof Api.Message
        ) {
          msgId = n(upd.message.id);
          break;
        }
      }
    }

    return { messageId: msgId };
  }

  // --- F1: Edit message ---

  async editMessage(
    peer: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    await this.invoke(
      new Api.messages.EditMessage({
        peer: inputPeer,
        id: messageId,
        message: text,
      }),
    );
  }

  // --- F2: Pin/Unpin ---

  async pinMessage(
    peer: string,
    messageId: number,
    opts?: { silent?: boolean },
  ): Promise<void> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    await this.invoke(
      new Api.messages.UpdatePinnedMessage({
        peer: inputPeer,
        id: messageId,
        silent: opts?.silent,
      }),
    );
  }

  async unpinMessage(
    peer: string,
    messageId: number,
  ): Promise<void> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    await this.invoke(
      new Api.messages.UpdatePinnedMessage({
        peer: inputPeer,
        id: messageId,
        unpin: true,
      }),
    );
  }

  // --- F3: Delete messages ---

  async deleteMessages(
    peer: string,
    messageIds: number[],
  ): Promise<void> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);
    const inputChannel = resolveInputChannel(inputPeer);

    await this.invoke(
      new Api.channels.DeleteMessages({
        channel: inputChannel,
        id: messageIds,
      }),
    );
  }

  // --- F4: Forward message ---

  async forwardMessages(
    fromPeer: string,
    toPeer: string,
    messageIds: number[],
    opts?: { silent?: boolean },
  ): Promise<number[]> {
    const client = await this.ensureConnected();
    const fromInput = await client.getInputEntity(fromPeer);
    const toInput = await client.getInputEntity(toPeer);

    const randomIds = messageIds.map(() => generateRandomId());

    const result = await this.invoke<Api.TypeUpdates>(
      new Api.messages.ForwardMessages({
        fromPeer: fromInput,
        toPeer: toInput,
        id: messageIds,
        randomId: randomIds,
        silent: opts?.silent,
      }),
    );

    const forwarded: number[] = [];
    if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
      for (const upd of result.updates) {
        if (
          (upd instanceof Api.UpdateNewMessage || upd instanceof Api.UpdateNewChannelMessage) &&
          upd.message instanceof Api.Message
        ) {
          forwarded.push(n(upd.message.id));
        }
      }
    }
    return forwarded;
  }

  // --- F8: Send reaction ---

  async sendReaction(
    peer: string,
    messageId: number,
    emoji: string,
  ): Promise<void> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);

    await this.invoke(
      new Api.messages.SendReaction({
        peer: inputPeer,
        msgId: messageId,
        reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
      }),
    );
  }

  // --- F12: Admin management ---

  async getAdmins(peer: string): Promise<AdminInfo[]> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);
    const inputChannel = resolveInputChannel(inputPeer);

    const result = await this.invoke<Api.channels.ChannelParticipants>(
      new Api.channels.GetParticipants({
        channel: inputChannel,
        filter: new Api.ChannelParticipantsAdmins(),
        offset: 0,
        limit: 100,
        hash: 0 as unknown as Api.long,
      }),
    );

    const admins: AdminInfo[] = [];

    if (result.participants) {
      for (const p of result.participants) {
        const userId = n(
          p instanceof Api.ChannelParticipantAdmin
            ? p.userId
            : p instanceof Api.ChannelParticipantCreator
              ? p.userId
              : 0,
        );
        if (!userId) continue;

        const user = result.users?.find(
          (u) => u instanceof Api.User && n(u.id) === userId,
        ) as Api.User | undefined;

        const rights =
          p instanceof Api.ChannelParticipantAdmin
            ? extractAdminRights(p.adminRights)
            : p instanceof Api.ChannelParticipantCreator
              ? { isCreator: true }
              : {};

        admins.push({
          userId,
          username: user?.username ?? undefined,
          firstName: user?.firstName ?? undefined,
          lastName: user?.lastName ?? undefined,
          isCreator: p instanceof Api.ChannelParticipantCreator,
          rights,
        });
      }
    }

    return admins;
  }

  async editAdmin(
    peer: string,
    userId: number | string,
    rights: AdminRightsInput,
  ): Promise<void> {
    const client = await this.ensureConnected();
    const inputPeer = await client.getInputEntity(peer);
    const inputChannel = resolveInputChannel(inputPeer);
    const userEntity = await client.getInputEntity(
      typeof userId === "number" ? userId.toString() : userId,
    );

    const adminRights = new Api.ChatAdminRights({
      changeInfo: rights.changeInfo,
      postMessages: rights.postMessages,
      editMessages: rights.editMessages,
      deleteMessages: rights.deleteMessages,
      banUsers: rights.banUsers,
      inviteUsers: rights.inviteUsers,
      pinMessages: rights.pinMessages,
      manageCall: rights.manageCall,
      addAdmins: rights.addAdmins,
    });

    await this.invoke(
      new Api.channels.EditAdmin({
        channel: inputChannel,
        userId: userEntity,
        adminRights,
        rank: rights.rank ?? "",
      }),
    );
  }
}
