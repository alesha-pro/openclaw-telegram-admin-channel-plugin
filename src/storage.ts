import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock, type FileLockOptions } from "openclaw/plugin-sdk";

export type StoredTemplate = {
  id: string;
  name: string;
  text: string;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  mediaFileIds?: string[];
};

export type StoredPost = {
  messageId: number;
  chatId: string;
  text: string;
  timestamp: number;
  permalink?: string;
  fileId?: string;
};

export type StoredComment = {
  messageId: number;
  chatId: string;
  text: string;
  timestamp: number;
  from: string;
  fromName?: string;
  threadId?: number;
  isAutoForward?: boolean;
  fileId?: string;
  status?: "pending" | "replied" | "skipped";
  replyMessageId?: number;
  repliedAt?: number;
};

const DEFAULT_LOCK_OPTIONS: FileLockOptions = {
  retries: { retries: 3, factor: 2, minTimeout: 100, maxTimeout: 2000 },
  stale: 10_000,
};

// --- generic JSON-file store ---

class JsonFileStore<T> {
  private items: T[] = [];
  private loaded = false;
  private maxItems: number;

  constructor(
    private readonly filePath: string,
    opts?: { maxItems?: number },
  ) {
    this.maxItems = opts?.maxItems ?? 0;
  }

  protected getItems(): T[] {
    return this.items;
  }

  async add(item: T): Promise<void> {
    await this.ensureLoaded();
    this.items.push(item);
    this.trimIfNeeded();
    await this.save();
  }

  async getAll(limit?: number): Promise<T[]> {
    await this.ensureLoaded();
    if (limit && limit > 0) return this.items.slice(-limit);
    return this.items;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.items = JSON.parse(raw) as T[];
      if (!Array.isArray(this.items)) this.items = [];
    } catch {
      this.items = [];
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await withFileLock(this.filePath, DEFAULT_LOCK_OPTIONS, async () => {
      await writeFile(
        this.filePath,
        JSON.stringify(this.items, null, 2),
        "utf-8",
      );
    });
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private trimIfNeeded(): void {
    if (this.maxItems > 0 && this.items.length > this.maxItems) {
      this.items = this.items.slice(-this.maxItems);
    }
  }
}

// --- PostStorage ---

const DEFAULT_MAX_POSTS = 5000;

export class PostStorage extends JsonFileStore<StoredPost> {
  constructor(filePath: string, opts?: { maxItems?: number }) {
    super(filePath, { maxItems: opts?.maxItems ?? DEFAULT_MAX_POSTS });
  }

  hasPost(messageId: number, chatId: string): boolean {
    return this.getItems().some(
      (p) => p.messageId === messageId && p.chatId === chatId,
    );
  }

  async upsertPost(post: StoredPost): Promise<boolean> {
    await this.ensureLoaded();
    const items = this.getItems();
    const idx = items.findIndex(
      (p) => p.messageId === post.messageId && p.chatId === post.chatId,
    );
    if (idx >= 0) {
      items[idx] = post;
      await this.save();
      return false; // updated
    }
    items.push(post);
    await this.save();
    return true; // inserted
  }

  async search(query: string, opts?: { limit?: number }): Promise<StoredPost[]> {
    await this.ensureLoaded();
    const q = query.toLowerCase();
    const matches = this.getItems().filter((p) => p.text.toLowerCase().includes(q));
    const limit = opts?.limit ?? 20;
    return matches.slice(-limit);
  }
}

// --- CommentStorage ---

const DEFAULT_MAX_COMMENTS = 10_000;

export class CommentStorage extends JsonFileStore<StoredComment> {
  constructor(filePath: string, opts?: { maxItems?: number }) {
    super(filePath, { maxItems: opts?.maxItems ?? DEFAULT_MAX_COMMENTS });
  }

  async getFiltered(opts?: {
    limit?: number;
    threadId?: number;
  }): Promise<StoredComment[]> {
    await this.ensureLoaded();
    let comments = this.getItems();
    if (opts?.threadId !== undefined) {
      comments = comments.filter((c) => c.threadId === opts.threadId);
    }
    if (opts?.limit && opts.limit > 0) {
      return comments.slice(-opts.limit);
    }
    return comments;
  }

  async search(query: string, opts?: { limit?: number }): Promise<StoredComment[]> {
    await this.ensureLoaded();
    const q = query.toLowerCase();
    const matches = this.getItems().filter((c) => c.text.toLowerCase().includes(q));
    const limit = opts?.limit ?? 20;
    return matches.slice(-limit);
  }

  async getPending(limit?: number): Promise<StoredComment[]> {
    await this.ensureLoaded();
    const pending = this.getItems().filter((c) => c.status === "pending");
    if (limit && limit > 0) return pending.slice(0, limit);
    return pending;
  }

  async markReplied(
    messageId: number,
    chatId: string,
    replyData: { replyMessageId: number },
  ): Promise<boolean> {
    await this.ensureLoaded();
    const item = this.getItems().find(
      (c) => c.messageId === messageId && c.chatId === chatId,
    );
    if (!item) return false;
    item.status = "replied";
    item.replyMessageId = replyData.replyMessageId;
    item.repliedAt = Date.now();
    await this.save();
    return true;
  }

  async markSkipped(messageId: number, chatId: string): Promise<boolean> {
    await this.ensureLoaded();
    const item = this.getItems().find(
      (c) => c.messageId === messageId && c.chatId === chatId,
    );
    if (!item) return false;
    item.status = "skipped";
    await this.save();
    return true;
  }

  async getByMessageId(
    messageId: number,
    chatId: string,
  ): Promise<StoredComment | undefined> {
    await this.ensureLoaded();
    return this.getItems().find(
      (c) => c.messageId === messageId && c.chatId === chatId,
    );
  }
}

// --- TemplateStorage ---

export class TemplateStorage extends JsonFileStore<StoredTemplate> {
  constructor(filePath: string) {
    super(filePath);
  }

  async getById(id: string): Promise<StoredTemplate | undefined> {
    await this.ensureLoaded();
    return this.getItems().find((t) => t.id === id);
  }

  async getByName(name: string): Promise<StoredTemplate | undefined> {
    await this.ensureLoaded();
    const q = name.toLowerCase();
    return this.getItems().find((t) => t.name.toLowerCase() === q);
  }

  async removeById(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const items = this.getItems();
    const idx = items.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    items.splice(idx, 1);
    await this.save();
    return true;
  }
}
