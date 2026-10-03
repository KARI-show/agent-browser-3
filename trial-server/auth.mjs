/**
 * Email sign-in for the trial gateways: a one-time 6-digit code goes to the address, the code buys a trial
 * token, and the person behind it is a row in the customer list (budgets follow the person, not the install).
 *
 * Web-standard only (Request -> Response, WebCrypto, fetch): the same file runs in trial-server (Node and
 * Cloudflare) and, as a byte-identical copy, in cli-proxy/queue-manager (deployed on its own, so it can't import
 * from here). Edit this file and copy it over — tests/trialAuth.test.mjs fails while the copies differ.
 *
 *   POST /auth/start   { email }        → a code is mailed (or logged, without RESEND_API_KEY)
 *   POST /auth/verify  { email, code }  → { token, email, …gateway details }
 *   GET  /admin/users[?format=csv]      → the customer list            (Authorization: Bearer ADMIN_TOKEN)
 *   POST /admin/users/block { email, blocked }                         (same)
 *
 * Store methods used, besides the gateway's own putToken(hash, rec) and add(key, n):
 *   getUser(email) / putUser(email, rec) / userCount() / listUsers()   the customer list
 *   getCode(email) / putCode(email, rec) / deleteCode(email)           the one pending code per address
 */

const enc = new TextEncoder();

export async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
export const newTrialToken = () => "trl_" + base64url(randomBytes(32));

/** Uniform digits: bytes ≥ 250 are skipped so `% 10` has no bias. */
function randomCode(len = 6) {
  let out = "";
  while (out.length < len) for (const b of randomBytes(len)) if (b < 250 && out.length < len) out += b % 10;
  return out;
}

/** Constant-time for equal lengths; secrets here are fixed-length hashes or the admin token. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// No quotes, commas, colons or brackets: addresses end up in CSV exports and in counter keys ("…:<day>").
const EMAIL_RE = /^[^\s@"'<>(),;:\\[\]]+@[^\s@"'<>(),;:\\[\]]+\.[^\s@"'<>(),;:\\[\]]{2,}$/;

/** Trimmed and lower-cased (one person, one row), or null when it isn't a plausible address. */
export function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** The key budgets are counted under: the person when the token came from a sign-in, else the token itself. */
export const budgetOwner = (rec, hash) => (rec && rec.userId ? `usr:${rec.userId}` : `tok:${hash}`);

function num(env, name, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name}="${raw}" is not a valid non-negative number.`);
  return n;
}

export function loadAuthConfig(env = {}) {
  const cfg = {
    codeTtlMs: num(env, "AUTH_CODE_TTL_MIN", 10) * 60_000,
    maxAttempts: num(env, "AUTH_MAX_ATTEMPTS", 5),
    resendMs: num(env, "AUTH_RESEND_SECONDS", 60) * 1000,
    codesPerEmailPerDay: num(env, "AUTH_CODES_PER_EMAIL_DAY", 5),
    codesPerIpPerDay: num(env, "AUTH_CODES_PER_IP_DAY", 20),
    maxUsers: num(env, "AUTH_MAX_USERS", 100_000),
    // "me@x.com, @company.com" — exact addresses or whole domains; empty = anyone (unless the gateway is invite-only).
    allowedEmails: (env.AUTH_ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    adminToken: env.ADMIN_TOKEN || "",
    resendKey: env.RESEND_API_KEY || "",
    mailFrom: env.MAIL_FROM || "",
    appName: env.AUTH_APP_NAME || "Agent Browser",
  };
  if (cfg.resendKey && !cfg.mailFrom) throw new Error('MAIL_FROM is required with RESEND_API_KEY (e.g. "Agent Browser <login@your-domain.com>").');
  if (cfg.adminToken && cfg.adminToken.length < 24) throw new Error("ADMIN_TOKEN is too short — use at least 24 random characters.");
  return cfg;
}

/**
 * Sends the code. Resend's HTTP API (no SMTP, so it works on Workers too); without RESEND_API_KEY the code goes
 * to the server log instead — fine for trying it out, and nobody but the operator can sign in that way.
 */
export function createMailer(cfg, { fetchImpl = fetch, log = console } = {}) {
  if (!cfg.resendKey) {
    return async (to, code) => void log.warn?.(`[auth] RESEND_API_KEY is not set — sign-in code for ${to}: ${code}`);
  }
  const minutes = Math.round(cfg.codeTtlMs / 60_000);
  return async (to, code) => {
    const r = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.resendKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: cfg.mailFrom,
        to: [to],
        subject: `${code} is your ${cfg.appName} sign-in code`,
        text: `Your ${cfg.appName} sign-in code: ${code}\n\nIt works for ${minutes} minutes. If you didn't ask for it, just ignore this email.`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`the mail service answered ${r.status}`);
  };
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const fail = (status, type, message, headers = {}) => json(status, { type: "error", error: { type, message } }, { "x-should-retry": "false", ...headers });
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

async function readJson(req, max = 4096) {
  if (Number(req.headers.get("content-length")) > max || !req.body) return null;
  const reader = req.body.getReader();
  let text = "";
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    if (text.length > max) {
      reader.cancel().catch(() => {});
      return null;
    }
  }
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Spreadsheet apps run cells that start with these as formulas. */
const csvCell = (v) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
};

/**
 * @param o.cfg        loadAuthConfig()
 * @param o.store      see the header
 * @param o.sendCode   (email, code) => Promise — createMailer(cfg)
 * @param o.clientIp   (req, ctx) => normalized address, the gateway's own
 * @param o.describe   () => extra fields for a successful sign-in (models, limits, transport…)
 * @param o.enabled    () => false pauses sign-in with the gateway's kill switch
 * @param o.inviteOnly no one gets in unless AUTH_ALLOWED_EMAILS names them
 */
export function createEmailAuth({ cfg, store, sendCode, clientIp, describe = () => ({}), enabled = () => true, inviteOnly = false, now = Date.now, log = console }) {
  const untilMidnight = () => {
    const d = new Date(now());
    return String(Math.max(60, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime()) / 1000)));
  };
  const invited = (email) =>
    cfg.allowedEmails.length ? cfg.allowedEmails.some((a) => (a.startsWith("@") ? email.endsWith(a) : email === a)) : !inviteOnly;
  const codeHash = (email, code) => sha256hex(`${email}:${code}`);
  const paused = () => fail(503, "overloaded_error", "Sign-in is paused right now. Try again later.");
  const notInvited = () => fail(403, "permission_error", "This address isn't on the invite list.");

  async function start(req, ctx) {
    if (!enabled()) return paused();
    const email = normalizeEmail((await readJson(req))?.email);
    if (!email) return fail(400, "invalid_request_error", "Enter a valid email address.");
    if (!invited(email)) return notInvited();
    const pending = await store.getCode(email);
    if (pending && now() - pending.sentAt < cfg.resendMs) {
      const wait = Math.ceil((cfg.resendMs - (now() - pending.sentAt)) / 1000);
      return fail(429, "rate_limit_error", `A code was just sent — you can ask for a new one in ${wait} s.`, { "retry-after": String(wait) });
    }
    const ip = clientIp(req, ctx);
    const d = dayOf(now());
    // Counted before sending, so failed sends count too: mailing someone over and over is not free.
    const [perIp, perEmail] = await Promise.all([store.add(`authip:${ip}:${d}`, 1), store.add(`authmail:${email}:${d}`, 1)]);
    if (perIp > cfg.codesPerIpPerDay) return fail(429, "rate_limit_error", "Too many sign-in codes from this network today. Try again tomorrow.", { "retry-after": untilMidnight() });
    if (perEmail > cfg.codesPerEmailPerDay) return fail(429, "rate_limit_error", "Too many codes for this address today. Try again tomorrow.", { "retry-after": untilMidnight() });

    const code = randomCode();
    await store.putCode(email, { hash: await codeHash(email, code), sentAt: now(), expiresAt: now() + cfg.codeTtlMs });
    try {
      await sendCode(email, code);
    } catch (e) {
      await store.deleteCode(email);
      log.error?.(`[auth] couldn't send a sign-in code: ${String(e?.message ?? e).slice(0, 200)}`);
      return fail(502, "api_error", "Couldn't send the email right now. Try again in a minute.");
    }
    return json(200, { ok: true, email, expiresInSec: cfg.codeTtlMs / 1000, resendInSec: cfg.resendMs / 1000 });
  }

  async function verify(req, ctx) {
    if (!enabled()) return paused();
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    const code = String(body?.code ?? "").replace(/\s+/g, "");
    if (!email || !/^\d{6}$/.test(code)) return fail(400, "invalid_request_error", "Enter the 6-digit code from the email.");
    if (!invited(email)) return notInvited();
    const pending = await store.getCode(email);
    if (!pending || now() > pending.expiresAt) {
      if (pending) await store.deleteCode(email);
      return fail(400, "invalid_request_error", "This code has expired. Ask for a new one.");
    }
    // An atomic counter, not a field on the code: parallel guesses must each use up an attempt.
    const tries = await store.add(`authtry:${email}:${pending.sentAt}:${dayOf(pending.sentAt)}`, 1);
    const right = tries <= cfg.maxAttempts && (await codeHash(email, code)) === pending.hash;
    if (!right) {
      const left = cfg.maxAttempts - tries;
      if (left <= 0) {
        await store.deleteCode(email);
        return fail(429, "rate_limit_error", "Too many wrong codes. Ask for a new one.");
      }
      return fail(400, "invalid_request_error", `Wrong code — ${left} attempt${left === 1 ? "" : "s"} left.`);
    }
    await store.deleteCode(email); // single use

    const ip = clientIp(req, ctx);
    let user = await store.getUser(email);
    if (!user) {
      if ((await store.userCount()) >= cfg.maxUsers) return fail(503, "overloaded_error", "Sign-ups are paused right now. Try again later.");
      user = { id: "u_" + base64url(randomBytes(12)), email, createdAt: now(), ip, logins: 0 };
    }
    if (user.blocked) return fail(403, "permission_error", "This free-trial account has been disabled.");
    user = { ...user, lastLoginAt: now(), lastIp: ip, logins: (user.logins || 0) + 1 };
    await store.putUser(email, user);
    const token = newTrialToken();
    await store.putToken(await sha256hex(token), { createdAt: now(), ip, userId: user.id, email });
    log.info?.(JSON.stringify({ t: "auth_signin", user: user.id, first: user.logins === 1 }));
    return json(200, { token, email, ...describe() });
  }

  const isAdmin = (req) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
    return !!cfg.adminToken && !!m && safeEqual(m[1].trim(), cfg.adminToken);
  };

  async function adminUsers(req) {
    const users = (await store.listUsers()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (new URL(req.url).searchParams.get("format") === "csv") {
      const cols = ["email", "id", "createdAt", "lastLoginAt", "logins", "blocked", "ip", "lastIp"];
      const iso = (t) => (t ? new Date(t).toISOString() : "");
      const rows = users.map((u) => cols.map((c) => csvCell(c.endsWith("At") ? iso(u[c]) : c === "blocked" ? (u.blocked ? "yes" : "") : u[c])).join(","));
      return new Response([cols.join(","), ...rows].join("\n") + "\n", { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } });
    }
    return json(200, { count: users.length, users });
  }

  async function adminBlock(req) {
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    if (!email || typeof body.blocked !== "boolean") return fail(400, "invalid_request_error", "Send { email, blocked: true|false }.");
    const user = await store.getUser(email);
    if (!user) return fail(404, "not_found_error", "No such customer.");
    const next = { ...user, blocked: body.blocked };
    await store.putUser(email, next);
    return json(200, { ok: true, user: next });
  }

  return {
    /** This module's response for the request, or null when the path isn't one of its own. */
    async route(req, ctx = {}) {
      const { pathname } = new URL(req.url);
      if (pathname === "/auth/start" && req.method === "POST") return start(req, ctx);
      if (pathname === "/auth/verify" && req.method === "POST") return verify(req, ctx);
      if (pathname === "/admin/users" || pathname === "/admin/users/block") {
        if (!isAdmin(req)) return fail(404, "invalid_request_error", "Not found."); // invisible without the token
        if (pathname === "/admin/users" && req.method === "GET") return adminUsers(req);
        if (pathname === "/admin/users/block" && req.method === "POST") return adminBlock(req);
        return fail(405, "invalid_request_error", "Not found.");
      }
      return null;
    },
    /** For the gateway's own token check: a 403 when the token's owner has been blocked, else null. */
    async refuseBlocked(rec) {
      if (!rec || !rec.email) return null;
      const user = await store.getUser(rec.email);
      return user && user.blocked ? fail(403, "permission_error", "This free-trial account has been disabled.") : null;
    },
  };
}
