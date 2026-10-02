import type { Conversation } from "../../src/conversations";

/** Where conversations live: chrome.storage.local in the extension, a Map in tests. */
export interface KV {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface StoredConversation extends Conversation {
  /** The API conversation (blocks incl. thinking and screenshots), replayed verbatim on the next turn. */
  apiMessages?: unknown[];
  /** Which build's system prompt + tool set the history was produced under. */
  promptId?: string;
}

const INDEX = "agentConvIndex";
const conv = (id: string) => `agentConv:${id}`;
const MAX_UNPINNED = 50;

export interface ConvMeta {
  id: string;
  time: number;
  pinned: boolean;
  title: string;
  preview: string;
}

function metaOf(c: StoredConversation): ConvMeta {
  const first = c.messages.find((m) => m.kind === "user");
  return {
    id: c.id,
    time: c.time,
    pinned: !!c.pinned,
    title: c.title,
    preview: (first?.text || "").replace(/\s+/g, " ").slice(0, 90),
  };
}

/**
 * Conversations, one storage key each: a chat with screenshots is megabytes,
 * and rewriting a single big array on every turn would be slow and would hit
 * write-size limits. The index (title, preview, pinned, recency) is loaded once
 * and is all the tab strip needs, so chats you don't open are never read.
 */
export class ConvStore {
  private index: ConvMeta[] = [];
  private cache = new Map<string, StoredConversation>();

  constructor(private kv: KV) {}

  async load(): Promise<void> {
    const idx = (await this.kv.get([INDEX]))[INDEX];
    this.index = Array.isArray(idx) ? (idx as ConvMeta[]).filter((e) => e && typeof e.id === "string") : [];
  }

  /**
   * Re-read the index another panel (a second browser window) may have changed, and forget cached chats
   * that changed or vanished there. Called before every write and when the panel (re)loads.
   */
  async refresh(): Promise<void> {
    const idx = (await this.kv.get([INDEX]))[INDEX];
    if (!Array.isArray(idx)) return;
    this.index = (idx as ConvMeta[]).filter((e) => e && typeof e.id === "string");
    for (const [id, c] of [...this.cache]) {
      const e = this.index.find((x) => x.id === id);
      if (!e || e.time !== c.time) this.cache.delete(id);
    }
  }

  /** Pinned first, then most recent first. */
  list(): ConvMeta[] {
    return this.index.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.time - a.time);
  }

  async get(id: string): Promise<StoredConversation | undefined> {
    if (this.cache.has(id)) return this.cache.get(id);
    const c = (await this.kv.get([conv(id)]))[conv(id)] as StoredConversation | undefined;
    if (c) this.cache.set(id, c);
    return c;
  }

  async save(c: StoredConversation): Promise<void> {
    await this.refresh(); // merge with what other windows wrote, not over it
    this.cache.set(c.id, c);
    const entry = metaOf(c);
    const i = this.index.findIndex((e) => e.id === c.id);
    if (i >= 0) this.index[i] = entry;
    else this.index.push(entry);

    // Cap the unpinned tail so storage stays bounded; pinned chats always stay.
    const drop = this.list().filter((e) => !e.pinned).slice(MAX_UNPINNED);
    for (const d of drop) {
      this.index = this.index.filter((e) => e.id !== d.id);
      this.cache.delete(d.id);
    }
    await this.kv.set({ [conv(c.id)]: c, [INDEX]: this.index });
    if (drop.length) await this.kv.remove(drop.map((d) => conv(d.id)));
  }

  async remove(id: string): Promise<void> {
    await this.refresh();
    this.index = this.index.filter((e) => e.id !== id);
    this.cache.delete(id);
    await this.kv.set({ [INDEX]: this.index });
    await this.kv.remove([conv(id)]);
  }

  async patch(id: string, fields: Partial<StoredConversation>): Promise<void> {
    const c = await this.get(id);
    if (c) await this.save({ ...c, ...fields });
  }
}
