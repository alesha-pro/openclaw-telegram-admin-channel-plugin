import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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
};

// --- generic JSON-file store ---

class JsonFileStore<T> {
  private items: T[] = [];
  private loaded = false;

  constructor(private readonly filePath: string) {}

  protected getItems(): T[] {
    return this.items;
  }

  async add(item: T): Promise<void> {
    await this.ensureLoaded();
    this.items.push(item);
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
    await writeFile(
      this.filePath,
      JSON.stringify(this.items, null, 2),
      "utf-8",
    );
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }
}

// --- PostStorage ---

export class PostStorage extends JsonFileStore<StoredPost> {
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
}

// --- CommentStorage ---

export class CommentStorage extends JsonFileStore<StoredComment> {
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
}
