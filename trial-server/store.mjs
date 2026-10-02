import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Trial state: registered tokens (stored only as hashes) and spend counters.
 * The interface is tiny on purpose — swap MemoryStore/FileStore for KV or Redis
 * (or D1 on Cloudflare) when running on a platform without a disk.
 *
 *   getToken(hash) / putToken(hash, rec)
 *   tokenCount() -> number        how many tokens exist (sign-ups pause at a cap)
 *   get(key) -> number            counters, micro-USD or counts
 *   add(key, n) -> number         ATOMIC increment (n may be negative), returns the new value
 */
export class MemoryStore {
  constructor() {
    this.tokens = new Map();
    this.counters = new Map();
  }
  async getToken(hash) {
    return this.tokens.get(hash);
  }
  async putToken(hash, rec) {
    this.tokens.set(hash, rec);
  }
  async tokenCount() {
    return this.tokens.size;
  }
  async get(key) {
    return this.counters.get(key) || 0;
  }
  async add(key, n) {
    const v = (this.counters.get(key) || 0) + n;
    this.counters.set(key, v);
    return v;
  }
}

const DAY_MS = 86_400_000;

/** JSON file with a debounced atomic flush — plenty for a trial; one process only. */
export class FileStore extends MemoryStore {
  constructor(file, { flushMs = 3000, keepDays = 3, staleTokenDays = 3, now = () => Date.now(), log = console } = {}) {
    super();
    this.file = file;
    this.flushMs = flushMs;
    this.timer = null;
    this.log = log;
    let text = null;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      /* first run */
    }
    if (text !== null) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        // Starting from zero would silently reset every budget — make the operator decide.
        throw new Error(`Trial state file ${file} is unreadable (${e.message}). Fix or move it away; refusing to start with reset budgets.`);
      }
      this.tokens = new Map(Object.entries(data.tokens || {}));
      this.counters = new Map(Object.entries(data.counters || {}));
    }
    // Drop per-day counters older than a few days, and tokens that were issued but never spent anything.
    const oldest = new Date(now() - keepDays * DAY_MS).toISOString().slice(0, 10);
    for (const k of [...this.counters.keys()]) {
      const m = /:(\d{4}-\d{2}-\d{2})$/.exec(k);
      if (m && m[1] < oldest) this.counters.delete(k);
    }
    for (const [hash, rec] of [...this.tokens]) {
      if (!this.counters.get(`tok:${hash}:total`) && now() - (rec.createdAt || 0) > staleTokenDays * DAY_MS) this.tokens.delete(hash);
    }
  }
  async putToken(hash, rec) {
    await super.putToken(hash, rec);
    this.#schedule();
  }
  async add(key, n) {
    const v = await super.add(key, n);
    this.#schedule();
    return v;
  }
  #schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }
  /** Never throws: a full disk must not take the process (and every in-flight charge) down; the next flush retries. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      const data = { tokens: Object.fromEntries(this.tokens), counters: Object.fromEntries(this.counters) };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log.error?.("could not save trial state: " + e.message);
      this.#schedule();
    }
  }
}
