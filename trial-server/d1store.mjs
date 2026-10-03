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
  async getUser(email) {
    const r = await this.db.prepare("SELECT rec FROM users WHERE email = ?").bind(email).first();
    return r ? JSON.parse(r.rec) : undefined;
  }
  async putUser(email, rec) {
    await this.db.prepare("INSERT OR REPLACE INTO users (email, rec, created_at) VALUES (?, ?, ?)").bind(email, JSON.stringify(rec), rec.createdAt || Date.now()).run();
  }
  async userCount() {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM users").first();
    return r ? r.n : 0;
  }
  async listUsers() {
    const r = await this.db.prepare("SELECT rec FROM users ORDER BY created_at").all();
    return (r.results || []).map((row) => JSON.parse(row.rec));
  }
  async getCode(email) {
    const r = await this.db.prepare("SELECT rec FROM codes WHERE email = ?").bind(email).first();
    return r ? JSON.parse(r.rec) : undefined;
  }
  async putCode(email, rec) {
    await this.db.prepare("INSERT OR REPLACE INTO codes (email, rec, expires_at) VALUES (?, ?, ?)").bind(email, JSON.stringify(rec), rec.expiresAt).run();
  }
  async deleteCode(email) {
    await this.db.prepare("DELETE FROM codes WHERE email = ?").bind(email).run();
  }
  /** Drop old per-day counters, expired codes and anonymous tokens that never spent anything (call now and then, e.g. hourly). */
  async prune(now = Date.now(), keepDays = 3, staleTokenDays = 3) {
    const cutoffDay = new Date(now - keepDays * 86_400_000).toISOString().slice(0, 10);
    await this.db.prepare("DELETE FROM counters WHERE k GLOB '*:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(k, -10) < ?").bind(cutoffDay).run();
    await this.db.prepare("DELETE FROM codes WHERE expires_at < ?").bind(now).run();
    // A signed-in customer's spend is counted under the person: their tokens are never "unused".
    await this.db
      .prepare("DELETE FROM tokens WHERE created_at < ? AND json_extract(rec, '$.userId') IS NULL AND NOT EXISTS (SELECT 1 FROM counters WHERE k = 'tok:' || tokens.hash || ':total' AND v > 0)")
      .bind(now - staleTokenDays * 86_400_000)
      .run();
  }
}
