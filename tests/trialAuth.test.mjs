// Email sign-in for the trial gateways (trial-server/auth.mjs) and the customer list behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../trial-server/config.mjs";
import { createHandler } from "../trial-server/handler.mjs";
import { MemoryStore } from "../trial-server/store.mjs";
import { D1Store } from "../trial-server/d1store.mjs";
import { createEmailAuth, createMailer, loadAuthConfig, normalizeEmail } from "../trial-server/auth.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { info() {}, warn() {}, error() {} };
const ADMIN = "adm_0123456789abcdefghijklmnopqrst";
const DAY = 86_400_000;

/** A gateway on a fake clock, called directly with Requests; sent codes land in `mail`. */
function gw(env = {}, opts = {}) {
  let t = Date.parse("2026-10-02T12:00:00Z");
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-x", ...env });
  const store = opts.store || new MemoryStore();
  const mail = new Map();
  const handler = createHandler(cfg, store, { now: clock.now, log: quiet, sendCode: opts.sendCode || (async (to, code) => void mail.set(to, code)) });
  const call = async (method, path, body, headers = {}, ip = "203.0.113.5") => {
    const r = await handler(new Request("http://gw" + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), { ip });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, body: json, text, headers: r.headers };
  };
  const start = (email, ip) => call("POST", "/auth/start", { email }, {}, ip);
  const verify = (email, code) => call("POST", "/auth/verify", { email, code });
  const signIn = async (email) => {
    assert.equal((await start(email)).status, 200);
    const r = await verify(email, mail.get(email));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const status = (token) => call("GET", "/status", undefined, { "x-api-key": token });
  const admin = (method, path, body, token = ADMIN) => call(method, path, body, { authorization: `Bearer ${token}` });
  return { cfg, store, mail, clock, call, start, verify, signIn, status, admin };
}

test("sign-in: the code is mailed, kept only as a hash and works once; one person is one customer row", async () => {
  const g = gw();
  const s = await g.start("  Me@Example.COM ");
  assert.equal(s.status, 200);
  assert.equal(s.body.email, "me@example.com", "trimmed and lower-cased");
  const code = g.mail.get("me@example.com");
  assert.match(code, /^\d{6}$/);
  assert.ok(!JSON.stringify([...g.store.codes]).includes(code), "the code itself is never stored");

  const v = await g.verify("me@example.com", ` ${code.slice(0, 3)} ${code.slice(3)} `);
  assert.equal(v.status, 200, "spaces in a pasted code are fine");
  assert.match(v.body.token, /^trl_/);
  assert.equal(v.body.transport, "messages");
  assert.equal((await g.verify("me@example.com", code)).status, 400, "single use");

  const user = g.store.users.get("me@example.com");
  assert.match(user.id, /^u_/);
  assert.equal(user.logins, 1);

  g.clock.advance(61_000);
  const again = await g.signIn("me@example.com");
  assert.equal(g.store.users.size, 1);
  assert.equal(g.store.users.get("me@example.com").id, user.id, "same customer");
  assert.equal(g.store.users.get("me@example.com").logins, 2);

  // Budgets follow the person: spend on one device shows on the other.
  await g.store.add(`usr:${user.id}:2026-10-02`, 100_000);
  for (const token of [v.body.token, again.token]) assert.equal((await g.status(token)).body.dailyLeftUsd, 0.15);
  assert.equal((await g.status(v.body.token)).body.email, "me@example.com");
});

test("wrong codes: every guess uses an attempt, even in parallel; after the last one the code is gone", async () => {
  const g = gw();
  await g.start("a@example.com");
  const right = g.mail.get("a@example.com");
  const wrong = (i) => String((Number(right) + 1 + i) % 1_000_000).padStart(6, "0");
  const first = await g.verify("a@example.com", wrong(0));
  assert.equal(first.status, 400);
  assert.match(first.body.error.message, /Wrong code — 4 attempts left/);
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => g.verify("a@example.com", wrong(i + 1))));
  assert.ok(burst.every((r) => r.status !== 200));
  const late = await g.verify("a@example.com", right);
  assert.notEqual(late.status, 200, "the right code no longer works after the attempts ran out");
  assert.equal(g.store.codes.size, 0);
});

test("codes expire; a new one only after the cooldown; caps per address and per network per day", async () => {
  const g = gw({ AUTH_CODES_PER_IP_DAY: "7" });
  await g.start("b@example.com");
  const old = g.mail.get("b@example.com");
  const soon = await g.start("b@example.com");
  assert.equal(soon.status, 429);
  assert.ok(Number(soon.headers.get("retry-after")) > 0);

  g.clock.advance(61_000);
  assert.equal((await g.start("b@example.com")).status, 200);
  if (old !== g.mail.get("b@example.com")) assert.equal((await g.verify("b@example.com", old)).status, 400, "a new code replaces the old one");

  g.clock.advance(11 * 60_000);
  const expired = await g.verify("b@example.com", g.mail.get("b@example.com"));
  assert.match(expired.body.error.message, /expired/);

  for (let i = 0; i < 3; i++) {
    g.clock.advance(61_000);
    assert.equal((await g.start("b@example.com")).status, 200);
  }
  g.clock.advance(61_000);
  const capped = await g.start("b@example.com");
  assert.equal(capped.status, 429, "5 codes per address per day");
  assert.match(capped.body.error.message, /this address/);

  assert.equal((await g.start("c@example.com")).status, 200);
  const net = await g.start("d@example.com");
  assert.equal(net.status, 429, "7 codes per network per day (incl. the refused one)");
  assert.match(net.body.error.message, /this network/);
  assert.equal((await g.start("d@example.com", "198.51.100.7")).status, 200, "another network is fine");
});

test("invite list: exact addresses and whole domains; an invite-only gateway lets nobody in without one", async () => {
  const g = gw({ AUTH_ALLOWED_EMAILS: "Boss@X.com, @team.org" });
  assert.equal((await g.start("boss@x.com")).status, 200);
  assert.equal((await g.start("dev@team.org")).status, 200);
  for (const outsider of ["other@x.com", "dev@evilteam.org", "dev@team.org.evil.com"]) {
    const r = await g.start(outsider);
    assert.equal(r.status, 403, outsider);
    assert.match(r.body.error.message, /invite list/);
  }

  const store = new MemoryStore();
  const auth = createEmailAuth({ cfg: loadAuthConfig({}), store, sendCode: async () => {}, clientIp: () => "x", inviteOnly: true, log: quiet });
  const r = await auth.route(new Request("http://gw/auth/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "anyone@x.com" }) }));
  assert.equal(r.status, 403, "invite-only with an empty list: nobody");
  assert.equal(await auth.route(new Request("http://gw/v1/messages", { method: "POST" })), null, "other paths are not its business");
});

test("blocked customers: their tokens stop working at once and they can't sign in again", async () => {
  const g = gw({ ADMIN_TOKEN: ADMIN });
  const { token } = await g.signIn("c@example.com");
  assert.equal((await g.status(token)).status, 200);
  const b = await g.admin("POST", "/admin/users/block", { email: "C@example.com", blocked: true });
  assert.equal(b.status, 200);
  assert.equal(b.body.user.blocked, true);
  const refused = await g.status(token);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error.message, /free-trial account has been disabled/, "worded so the extension shows it as is");
  g.clock.advance(61_000);
  await g.start("c@example.com");
  assert.equal((await g.verify("c@example.com", g.mail.get("c@example.com"))).status, 403);
  await g.admin("POST", "/admin/users/block", { email: "c@example.com", blocked: false });
  assert.equal((await g.status(token)).status, 200, "unblocked: the same token works again");
  assert.equal((await g.admin("POST", "/admin/users/block", { email: "nobody@example.com", blocked: true })).status, 404);
});

test("admin API: invisible without its token; the customer list as JSON or CSV; CSV cells can't turn into formulas", async () => {
  const off = gw();
  await off.signIn("a@example.com");
  assert.equal((await off.admin("GET", "/admin/users")).status, 404, "no ADMIN_TOKEN configured → no admin API");

  const g = gw({ ADMIN_TOKEN: ADMIN });
  await g.signIn("a@example.com");
  await g.signIn("=hyperlink@example.com");
  assert.equal((await g.admin("GET", "/admin/users", undefined, "wrong-token-wrong-token-wrong")).status, 404);
  assert.equal((await g.call("GET", "/admin/users")).status, 404);
  const list = await g.admin("GET", "/admin/users");
  assert.equal(list.status, 200);
  assert.equal(list.body.count, 2);
  assert.deepEqual(list.body.users.map((u) => u.email), ["a@example.com", "=hyperlink@example.com"]);
  const csv = await g.admin("GET", "/admin/users?format=csv");
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const lines = csv.text.trim().split("\n");
  assert.equal(lines[0], "email,id,createdAt,lastLoginAt,logins,blocked,ip,lastIp");
  assert.match(lines[1], /^a@example\.com,u_[\w-]+,2026-10-02T12:00:00\.000Z,2026-10-02T12:00:00\.000Z,1,,203\.0\.113\.5,203\.0\.113\.5$/);
  assert.match(lines[2], /^'=hyperlink@example\.com,/);

  assert.throws(() => loadAuthConfig({ ADMIN_TOKEN: "short" }), /too short/);
});

test("mail: Resend gets the code; a failed send frees the address to retry; without a key the code goes to the log", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => (sent.push({ url, init }), new Response("{}", { status: 200 }));
  const cfg = loadAuthConfig({ RESEND_API_KEY: "re_test", MAIL_FROM: "Agent <login@example.com>", AUTH_APP_NAME: "Kari" });
  await createMailer(cfg, { fetchImpl })("me@example.com", "123456");
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.equal(sent[0].init.headers.authorization, "Bearer re_test");
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.to, ["me@example.com"]);
  assert.equal(body.from, "Agent <login@example.com>");
  assert.match(body.subject, /^123456 is your Kari sign-in code$/);
  assert.match(body.text, /10 minutes/);
  await assert.rejects(createMailer(cfg, { fetchImpl: async () => new Response("no", { status: 500 }) })("me@example.com", "1"), /500/);
  assert.throws(() => loadAuthConfig({ RESEND_API_KEY: "re_test" }), /MAIL_FROM is required/);

  const logged = [];
  await createMailer(loadAuthConfig({}), { log: { warn: (m) => logged.push(m) } })("me@example.com", "654321");
  assert.match(logged[0], /sign-in code for me@example\.com: 654321/);

  const g = gw({}, { sendCode: async () => { throw new Error("smtp down"); } });
  const r = await g.start("e@example.com");
  assert.equal(r.status, 502);
  assert.equal(g.store.codes.size, 0, "no code left behind");
  assert.equal((await g.start("e@example.com")).status, 502, "no cooldown after a failed send");
});

test("email addresses: plausible ones only, one spelling per person", () => {
  assert.equal(normalizeEmail(" A.B+tag@Sub.Example.CO "), "a.b+tag@sub.example.co");
  for (const bad of ["", "plain", "a@b", "a@b.c", "a b@c.com", "a@b@c.com", 'a"b@c.com', "a,b@c.com", "a:b@c.com", "x".repeat(250) + "@c.com", 42, null]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
});

test("the queue-manager's copy of auth.mjs is identical (it is deployed on its own and can't import trial-server/)", () => {
  assert.equal(readFileSync(join(root, "cli-proxy", "queue-manager", "auth.mjs"), "utf8"), readFileSync(join(root, "trial-server", "auth.mjs"), "utf8"), "copy trial-server/auth.mjs over");
});

let sqlite = null;
try {
  sqlite = (await import("node:sqlite")).DatabaseSync;
} catch {}

/** Cloudflare D1's prepare/bind/first/run/all over node:sqlite — runs the real SQL of D1Store. */
function fakeD1(db) {
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const q = {
        bind: (...a) => ((args = a), q),
        first: async () => st.get(...args) ?? null,
        run: async () => (st.run(...args), { success: true }),
        all: async () => ({ results: st.all(...args) }),
      };
      return q;
    },
  };
}

test("D1Store: the sign-in SQL works on SQLite, and pruning keeps customers' tokens", { skip: sqlite ? false : "node:sqlite not available" }, async () => {
  const db = new sqlite(":memory:");
  db.exec(readFileSync(join(root, "trial-server", "schema.sql"), "utf8"));
  const store = new D1Store(fakeD1(db));
  const g = gw({ ADMIN_TOKEN: ADMIN }, { store });
  const { token } = await g.signIn("d1@example.com");
  assert.equal((await g.status(token)).status, 200);
  assert.equal(await store.userCount(), 1);
  assert.equal((await g.admin("GET", "/admin/users")).body.users[0].email, "d1@example.com");

  await store.putToken("anon", { createdAt: 1 });
  await store.putToken("member-old", { createdAt: 1, userId: "u_x", email: "d1@example.com" });
  await store.putCode("gone@example.com", { hash: "h", sentAt: 1, expiresAt: 2 });
  await store.prune(Date.parse("2026-10-02T12:00:00Z") + 10 * DAY);
  assert.equal(await store.getToken("anon"), undefined, "an anonymous token that never spent → dropped");
  assert.ok(await store.getToken("member-old"), "a customer's token stays");
  assert.equal(await store.getCode("gone@example.com"), undefined, "expired codes dropped");
});
