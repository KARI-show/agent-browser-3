/**
 * Trial state on Cloudflare D1 (SQLite). `add` is a single atomic upsert, so
 * parallel requests — even on different isolates — can't lose or double-count
 * spend. (Workers KV can't do that: its writes are eventually consistent.)
 *
 * Schema: trial-server/schema.sql
 */
export class D1Store {
  constructor(db) {
    this.db = db;
  }
  async getToken(hash) {
    const r = await this.db.prepare("SELECT rec FROM tokens WHERE hash = ?").bind(hash).first();
    return r ? JSON.parse(r.rec) : undefined;
  }
  async putToken(hash, rec) {
    await this.db.prepare("INSERT OR REPLACE INTO tokens (hash, rec, created_at) VALUES (?, ?, ?)").bind(hash, JSON.stringify(rec), rec.createdAt || Date.now()).run();
  }
  async tokenCount() {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM tokens").first();
    return r ? r.n : 0;
  }
  async get(key) {
    const r = await this.db.prepare("SELECT v FROM counters WHERE k = ?").bind(key).first();
    return r ? r.v : 0;
  }
  async add(key, n) {
    const r = await this.db.prepare("INSERT INTO counters (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v RETURNING v").bind(key, Math.round(n)).first();
    return r.v;
  }
  /** Drop old per-day counters and tokens that never spent anything (call now and then, e.g. hourly). */
  async prune(now = Date.now(), keepDays = 3, staleTokenDays = 3) {
    const cutoffDay = new Date(now - keepDays * 86_400_000).toISOString().slice(0, 10);
    await this.db.prepare("DELETE FROM counters WHERE k GLOB '*:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(k, -10) < ?").bind(cutoffDay).run();
    await this.db
      .prepare("DELETE FROM tokens WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM counters WHERE k = 'tok:' || tokens.hash || ':total' AND v > 0)")
      .bind(now - staleTokenDays * 86_400_000)
      .run();
  }
}
