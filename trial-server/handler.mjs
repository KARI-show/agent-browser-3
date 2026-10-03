import { costMicroUsd, priceFor, reserveMicroUsd } from "./pricing.mjs";
import { budgetOwner, createEmailAuth, createMailer } from "./auth.mjs";

/**
 * Free-trial gateway: an Anthropic-compatible proxy that holds the operator's
 * API key and enforces limits, so the extension's SDK can talk to it exactly
 * like it talks to api.anthropic.com — with a trial token in place of a key.
 * Tokens come from an email sign-in (auth.mjs): budgets follow the person. Web-standard (Request -> Response, WebCrypto, no Node built-ins),
 * so the same handler runs under the Node adapter in server.mjs or a
 * Cloudflare Worker / Vercel function.
 *
 * What it guarantees:
 *  - the real key never leaves this process; clients get an opaque token
 *  - tokens are stored only as hashes
 *  - only allow-listed models, capped max_tokens, no server tools / betas
 *  - money is RESERVED at the worst case before a request goes upstream and
 *    settled to the real usage afterwards, against per-token (daily + total),
 *    per-IP (daily) and global (daily) budgets — parallel requests can't
 *    overshoot, and a cancelled request is charged for what it plausibly used
 *  - upstream error text is never relayed verbatim
 *  - request bodies are never logged
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const today = (now) => new Date(now()).toISOString().slice(0, 10);

/** One signal that fires when any of `signals` does (AbortSignal.any isn't available everywhere). */
function anySignal(signals) {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

// Top-level request fields we forward. Anything else (mcp_servers, container,
// betas, service_tier, metadata…) is refused so it can't smuggle in extra cost.
const ALLOWED_FIELDS = new Set(["model", "max_tokens", "messages", "system", "tools", "tool_choice", "thinking", "output_config", "cache_control", "stream", "temperature", "top_p", "top_k", "stop_sequences"]);
const MAX_TOOLS = 64;
const MAX_PARALLEL_PER_TOKEN = 3;
const IMAGE_TOKENS = 3300; // upper bound for one image after the API's own downscaling
const OUTPUT_TPS_CEILING = 300; // tokens/second no model here exceeds — turns time into a token estimate for cancelled streams
const NEARLY_EMPTY_MICRO = 10_000; // below $0.01 left a budget counts as "used up" rather than "too small for this request"

const CORS_ALLOW_HEADERS = "content-type, x-api-key, authorization, anthropic-version, anthropic-dangerous-direct-browser-access, anthropic-beta";

function errorResponse(status, type, message, headers = {}) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500);

/** IPv4 as is; IPv6 collapsed to its /64 (one home network hands out billions of addresses). */
export function normalizeIp(ip) {
  if (!ip) return "unknown";
  ip = ip.trim().replace(/^::ffff:/i, "");
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

function secondsUntilUtcMidnight(now) {
  const d = new Date(now());
  return Math.max(60, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime()) / 1000));
}

async function readLimited(req, max) {
  const declared = Number(req.headers.get("content-length"));
  if (declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Upper-bound input tokens for a request: text at 3 bytes/token, images at a fixed ceiling, other media by size. */
export function estimateInputTokens(body) {
  let media = 0;
  const strip = (blocks) =>
    Array.isArray(blocks)
      ? blocks.map((b) => {
          if (b && typeof b === "object") {
            if (b.source?.type === "base64" && typeof b.source.data === "string") {
              media += b.type === "image" ? IMAGE_TOKENS : Math.ceil(b.source.data.length / 4);
              return { ...b, source: { ...b.source, data: "" } };
            }
            if (Array.isArray(b.content)) return { ...b, content: strip(b.content) };
          }
          return b;
        })
      : blocks;
  const lean = { ...body, messages: body.messages.map((m) => (m && typeof m === "object" ? { ...m, content: strip(m.content) } : m)), system: strip(body.system) };
  return Math.ceil(JSON.stringify(lean).length / 3) + media;
}

/** Wrap an upstream SSE body: pass bytes through untouched, watch usage, report once when it ends or is cancelled. */
function meter(body, now, onDone) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const st = { usage: {}, chars: 0, sawStart: false, sawFinalDelta: false, startedAt: now() };
  let buf = "";
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      st.elapsedMs = now() - st.startedAt;
      onDone(st);
    }
  };
  const take = (u) => {
    if (!u) return;
    for (const k of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]) {
      if (typeof u[k] === "number") st.usage[k] = Math.max(st.usage[k] || 0, u[k]);
    }
    if (u.cache_creation && typeof u.cache_creation === "object") st.usage.cache_creation = u.cache_creation;
  };
  const feed = (chunk) => {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (ev.type === "message_start") {
        st.sawStart = true;
        take(ev.message?.usage);
      } else if (ev.type === "message_delta") {
        st.sawFinalDelta = true;
        take(ev.usage);
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta || {};
        st.chars += (d.text || d.thinking || d.partial_json || "").length;
      }
    }
    if (buf.length > 1_000_000) buf = ""; // a line that long is not SSE we care about
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        feed(value);
        controller.enqueue(value);
      } catch (e) {
        finish();
        controller.error(e);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}

export function createHandler(cfg, store, { fetchImpl = fetch, now = Date.now, log = console, sendCode } = {}) {
  const inflight = new Map(); // budget owner (person or token) -> Map(requestId -> startedAt)
  let inflightTotal = 0;
  let seq = 0;
  const windows = new Map(); // rate limit key -> request timestamps
  let modelsCache = { at: 0, data: null };

  const info = (o) => log.info?.(JSON.stringify(o));

  /** Sliding-window limiter; true = allowed. */
  const allow = (key, limit, windowMs = 60_000) => {
    const t = now();
    const arr = (windows.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= limit) {
      windows.set(key, arr);
      return false;
    }
    arr.push(t);
    windows.set(key, arr);
    if (windows.size > 20_000) for (const [k, v] of windows) if (!v.length || t - v[v.length - 1] > windowMs) windows.delete(k);
    return true;
  };

  const corsFor = (req) => {
    const origin = req.headers.get("origin");
    const ok = origin && (cfg.allowedOrigins.includes("*") || cfg.allowedOrigins.includes(origin));
    return ok ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-expose-headers": "retry-after, x-should-retry, request-id" } : {};
  };

  const clientIp = (req, ctx) => {
    let ip = ctx.ip;
    if (cfg.ipHeader) {
      const v = req.headers.get(cfg.ipHeader);
      // Behind a proxy we control, the LAST hop is the address that proxy saw; earlier ones are client-supplied.
      if (v) ip = v.split(",").pop().trim();
    }
    return normalizeIp(ip);
  };

  const auth = createEmailAuth({
    cfg: cfg.auth,
    store,
    sendCode: sendCode || createMailer(cfg.auth, { log }),
    clientIp,
    enabled: () => cfg.enabled,
    describe: () => ({ models: cfg.models, limits: { dailyUsd: cfg.tokenDailyMicro / 1e6, totalUsd: cfg.tokenTotalMicro / 1e6 }, transport: "messages" }),
    now,
    log,
  });

  /** { hash, rec, owner } — owner is who budgets and rate limits count against: the signed-in person. */
  async function authenticate(req) {
    const header = req.headers.get("authorization") || "";
    const key = req.headers.get("x-api-key") || (/^Bearer\s+(.+)$/i.exec(header) || [])[1] || "";
    const stop = { "x-should-retry": "false" };
    if (!key.startsWith("trl_")) return { error: errorResponse(401, "authentication_error", "Missing or invalid trial token. Sign in to the free trial again in the extension settings.", stop) };
    const hash = await sha(key);
    const rec = await store.getToken(hash);
    if (!rec) return { error: errorResponse(401, "authentication_error", "Unknown trial token. Sign in to the free trial again in the extension settings.", stop) };
    if (rec.revoked) return { error: errorResponse(403, "permission_error", "This trial token has been disabled.", stop) };
    const blocked = await auth.refuseBlocked(rec);
    if (blocked) return { error: blocked };
    return { hash, rec, owner: budgetOwner(rec, hash) };
  }

  // ---- budgets: reserve the worst case, settle to the truth ------------------

  const budgetKeys = (owner, ip) => {
    const d = today(now);
    return [`${owner}:${d}`, `${owner}:total`, `ip:${ip}:${d}`, `glob:${d}`];
  };
  const limits = () => [cfg.tokenDailyMicro, cfg.tokenTotalMicro, cfg.ipDailyMicro, cfg.globalDailyMicro];

  function refusalFor(which, left, cost) {
    const retry = String(secondsUntilUtcMidnight(now));
    const stop = { "x-should-retry": "false" };
    const usedUp = left < NEARLY_EMPTY_MICRO;
    const tooBig = `This request is larger than your remaining free-trial allowance (about $${(Math.max(0, left) / 1e6).toFixed(2)} left; this one could cost up to $${(cost / 1e6).toFixed(2)}). Start a new chat, or add your own API key in the extension settings.`;
    switch (which) {
      case 0:
        return usedUp
          ? errorResponse(429, "rate_limit_error", "Today's free-trial allowance is used up. It resets at 00:00 UTC — or add your own API key in the extension settings to continue now.", { ...stop, "retry-after": retry })
          : errorResponse(429, "rate_limit_error", tooBig, stop);
      case 1:
        return usedUp
          ? errorResponse(429, "rate_limit_error", "The free trial is used up. Add your own API key (or use your Claude subscription) in the extension settings to keep going.", stop)
          : errorResponse(429, "rate_limit_error", tooBig, stop);
      case 2:
        return errorResponse(429, "rate_limit_error", "The free trial has reached its daily limit for this network. Try again tomorrow, or add your own API key in the extension settings.", { ...stop, "retry-after": retry });
      default:
        return errorResponse(503, "overloaded_error", "The free trial is at capacity for today. Try again tomorrow, or add your own API key in the extension settings.", { ...stop, "retry-after": retry });
    }
  }

  /** Atomically add `cost` to every budget; if any goes over its limit, undo and refuse. */
  async function reserve(owner, ip, cost) {
    const keys = budgetKeys(owner, ip);
    const lim = limits();
    const totals = await Promise.all(keys.map((k) => store.add(k, cost)));
    const over = totals.findIndex((t, i) => t > lim[i]);
    if (over < 0) return { keys };
    await Promise.all(keys.map((k) => store.add(k, -cost)));
    return { error: refusalFor(over, lim[over] - (totals[over] - cost), cost) };
  }

  // ---- routes ---------------------------------------------------------------

  async function status(req, ctx) {
    const a = await authenticate(req);
    if (a.error) return a.error;
    const [tokDay, tokTotal] = await Promise.all(budgetKeys(a.owner, clientIp(req, ctx)).slice(0, 2).map((k) => store.get(k)));
    return json(200, {
      enabled: cfg.enabled,
      email: a.rec.email || null,
      models: cfg.models,
      dailyLeftUsd: Math.max(0, cfg.tokenDailyMicro - tokDay) / 1e6,
      totalLeftUsd: Math.max(0, cfg.tokenTotalMicro - tokTotal) / 1e6,
    });
  }

  const upstreamHeaders = (req) => {
    const h = { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": req.headers.get("anthropic-version") || "2023-06-01" };
    if (cfg.workspaceId) h["anthropic-workspace-id"] = cfg.workspaceId;
    return h;
  };

  async function models(req) {
    const a = await authenticate(req);
    if (a.error) return a.error;
    if (!modelsCache.data || now() - modelsCache.at > 10 * 60_000) {
      let data = null;
      try {
        const r = await fetchImpl(`${cfg.upstream}/v1/models?limit=100`, { headers: upstreamHeaders(req), redirect: "manual", signal: AbortSignal.timeout(15_000) });
        if (r.ok) {
          const all = (await r.json()).data || [];
          data = cfg.models.map((id) => all.find((m) => m.id === id)).filter(Boolean);
        }
      } catch (e) {
        log.warn?.("models lookup failed: " + clean(e.message));
      }
      if (!data || !data.length) {
        data = cfg.models.map((id) => ({ id, display_name: id, type: "model", created_at: "2026-01-01T00:00:00Z", max_input_tokens: null, max_tokens: null, capabilities: null }));
      }
      modelsCache = { at: now(), data };
    }
    const data = modelsCache.data;
    return json(200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null });
  }

  /** Validate and normalize the client's request; returns { body } or { error }. */
  function sanitize(raw) {
    let body;
    try {
      body = JSON.parse(dec.decode(raw));
    } catch {
      return { error: errorResponse(400, "invalid_request_error", "Request body is not valid JSON.") };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: errorResponse(400, "invalid_request_error", "Request body must be a JSON object.") };
    for (const k of Object.keys(body)) {
      if (!ALLOWED_FIELDS.has(k)) return { error: errorResponse(400, "invalid_request_error", `"${clean(k).slice(0, 40)}" is not available in the free trial.`) };
    }
    if (typeof body.model !== "string" || !cfg.models.includes(body.model)) {
      return { error: errorResponse(400, "invalid_request_error", `The free trial offers these models: ${cfg.models.join(", ")}.`) };
    }
    if (!Array.isArray(body.messages) || !body.messages.length) return { error: errorResponse(400, "invalid_request_error", "messages is required.") };
    if (!Number.isFinite(body.max_tokens) || body.max_tokens < 1) return { error: errorResponse(400, "invalid_request_error", "max_tokens is required.") };
    body.max_tokens = Math.min(Math.floor(body.max_tokens), cfg.maxTokensCap);
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) return { error: errorResponse(400, "invalid_request_error", `tools must be an array of at most ${MAX_TOOLS} entries.`) };
      for (const t of body.tools) {
        if (!t || typeof t !== "object" || (t.type !== undefined && t.type !== "custom")) {
          return { error: errorResponse(400, "invalid_request_error", "Server-side tools (web search, code execution…) are not available in the free trial.") };
        }
      }
    }
    if (body.thinking?.type === "enabled") {
      // Explicit budgets must fit under the output cap (the API needs budget < max_tokens).
      body.thinking.budget_tokens = Math.min(Number(body.thinking.budget_tokens) || 1024, Math.max(1024, body.max_tokens - 1));
    }
    if (body.output_config && typeof body.output_config === "object") {
      const { effort, format, ...rest } = body.output_config;
      if (Object.keys(rest).length) return { error: errorResponse(400, "invalid_request_error", "Unsupported output_config option in the free trial.") };
      body.output_config = { ...(format ? { format } : {}), ...(effort ? { effort: effort === "xhigh" || effort === "max" ? "high" : effort } : {}) };
    }
    return { body };
  }

  /**
   * Turn an upstream failure into something safe to show a trial user. Nothing
   * is relayed verbatim: the upstream text may describe the operator's account,
   * limits or key. Only the user's own plain request errors keep their message.
   */
  function scrubUpstreamError(up, text, requestId) {
    let type = "";
    let message = "";
    try {
      const j = JSON.parse(text);
      type = String(j?.error?.type || "");
      message = String(j?.error?.message || "");
    } catch {
      /* not JSON */
    }
    log.error?.(JSON.stringify({ t: "upstream_error", status: up.status, type, msg: clean(message).slice(0, 200), req: requestId }));
    const retryAfter = up.headers.get("retry-after");
    if (up.status === 429 || type === "rate_limit_error") {
      return errorResponse(429, "rate_limit_error", "The model service is busy right now. Try again in a moment.", { "retry-after": retryAfter || "5" });
    }
    if (up.status >= 500 || type === "api_error" || type === "overloaded_error") {
      return errorResponse(up.status >= 500 ? up.status : 529, up.status === 529 || type === "overloaded_error" ? "overloaded_error" : "api_error", "The model service had a problem. Try again in a moment.", retryAfter ? { "retry-after": retryAfter } : {});
    }
    const ACCOUNT_TALK = /credit|balance|billing|workspace|organi[sz]ation|account|api[- ]?key|x-api-key|spend|usage limit|plan\b|tier\b|quota|subscription|permission|authenticat|forbidden|budget/i;
    if ((up.status === 400 || up.status === 413 || up.status === 422) && ["invalid_request_error", "request_too_large"].includes(type) && message && !ACCOUNT_TALK.test(message)) {
      return errorResponse(up.status, type, clean(message));
    }
    return errorResponse(503, "overloaded_error", "The free trial is temporarily unavailable. Add your own API key in the extension settings, or try again later.", { "x-should-retry": "false" });
  }

  async function messages(req, ctx) {
    // Work that must finish even after the response is gone (recording what a cancelled stream cost).
    const background = (p) => (ctx.waitUntil ? ctx.waitUntil(p) : p);
    if (!cfg.enabled) return errorResponse(503, "overloaded_error", "The free trial is paused right now. Add your own API key in the extension settings.", { "x-should-retry": "false" });
    const a = await authenticate(req);
    if (a.error) return a.error;
    const ip = clientIp(req, ctx);

    // Cheap gates first — before a body is read or parsed.
    if (!allow(`rpm:${a.owner}`, cfg.tokenRpm) || !allow(`rpm:ip:${ip}`, cfg.ipRpm)) {
      return errorResponse(429, "rate_limit_error", "Too many requests in a minute. Slow down a little.", { "retry-after": "10" });
    }
    if (inflightTotal >= cfg.maxConcurrent) return errorResponse(503, "overloaded_error", "The free trial is busy right now. Try again in a moment.", { "retry-after": "3" });
    const mine = inflight.get(a.owner) || new Map();
    for (const [id, t] of mine) if (now() - t > cfg.upstreamTimeoutMs + 60_000) (mine.delete(id), inflightTotal--); // a leaked slot can't lock a token forever
    if (mine.size >= MAX_PARALLEL_PER_TOKEN) return errorResponse(429, "rate_limit_error", "Too many requests at once. Wait for the current one to finish.", { "retry-after": "2" });
    const id = ++seq;
    mine.set(id, now());
    inflight.set(a.owner, mine);
    inflightTotal++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (mine.delete(id)) inflightTotal--;
      if (!mine.size) inflight.delete(a.owner);
    };

    let reservation = null;
    let reserved = 0;
    let settled = false;
    /** Replace the reservation with the real cost — exactly once — and free the slot. */
    const settle = async (actual, note) => {
      if (settled) return;
      settled = true;
      try {
        if (reservation) await Promise.all(reservation.keys.map((k) => store.add(k, actual - reserved)));
      } catch (e) {
        log.error?.("settle failed: " + clean(e.message));
      } finally {
        release();
      }
      info({ t: "settle", tok: a.hash.slice(0, 8), ip, micro: actual, reserved, note });
    };

    try {
      const raw = await readLimited(req, cfg.maxBodyBytes);
      if (!raw) {
        release();
        return errorResponse(413, "request_too_large", "The request is too large for the free trial (start a new chat or use your own API key).", { "x-should-retry": "false" });
      }
      const s = sanitize(raw);
      if (s.error) {
        release();
        return s.error;
      }
      const body = s.body;
      const inputTok = estimateInputTokens(body);
      reserved = reserveMicroUsd(body.model, inputTok, body.max_tokens);
      const r = await reserve(a.owner, ip, reserved);
      if (r.error) {
        release();
        return r.error;
      }
      reservation = r;
      const wantsHourCache = /"ttl"\s*:\s*"1h"/.test(dec.decode(raw));
      const writeMult = wantsHourCache ? 2 : 1.25;
      const p = priceFor(body.model);
      // What we know about a request that never delivered final usage.
      const unmetered = (st) => {
        if (!st.sawStart) return Math.ceil(inputTok * p.in * 1.25); // never heard back: bill the prefill it may have cost
        const outEst = Math.min(body.max_tokens, Math.max(st.usage.output_tokens || 0, Math.ceil(st.chars / 3), Math.ceil((st.elapsedMs / 1000) * OUTPUT_TPS_CEILING)));
        return costMicroUsd(body.model, { ...st.usage, output_tokens: outEst }, writeMult);
      };

      const streaming = body.stream === true;
      const signals = [AbortSignal.timeout(cfg.upstreamTimeoutMs)];
      // A non-streaming request keeps running upstream when the client leaves (its cost can't be observed
      // otherwise); a stream is cut so a pressed Stop stops the spending.
      if (streaming && req.signal) signals.push(req.signal);

      let up;
      try {
        up = await fetchImpl(`${cfg.upstream}/v1/messages`, {
          method: "POST",
          headers: upstreamHeaders(req),
          body: JSON.stringify(body),
          redirect: "manual", // never let the operator key follow a redirect anywhere
          signal: anySignal(signals),
        });
      } catch (e) {
        const aborted = req.signal?.aborted || e?.name === "AbortError" || e?.name === "TimeoutError";
        // Cut off before any answer: prefill may still have been billed; a plain network failure cost nothing.
        await settle(aborted ? Math.ceil(inputTok * p.in * 1.25) : 0, "fetch-failed");
        if (req.signal?.aborted) return new Response(null, { status: 499 });
        log.warn?.("upstream unreachable: " + clean(e.message));
        return errorResponse(502, "api_error", "The free trial could not reach the model service. Try again in a moment.");
      }

      if (!up.ok) {
        const text = await up.text().catch(() => "");
        await settle(0, `upstream-${up.status}`);
        if (up.status >= 300 && up.status < 400) {
          log.error?.("upstream answered with a redirect — refusing to follow it with the operator key");
          return errorResponse(503, "overloaded_error", "The free trial is temporarily unavailable. Add your own API key in the extension settings, or try again later.", { "x-should-retry": "false" });
        }
        return scrubUpstreamError(up, text, up.headers.get("request-id"));
      }

      const passHeaders = { "content-type": up.headers.get("content-type") || "application/json", "cache-control": "no-cache" };
      if (up.headers.get("request-id")) passHeaders["request-id"] = up.headers.get("request-id");

      if (streaming) {
        const stream = meter(up.body, now, (st) => {
          background(settle(st.sawFinalDelta ? costMicroUsd(body.model, st.usage, writeMult) : unmetered(st), st.sawFinalDelta ? "stream" : "stream-cut").catch(() => {}));
        });
        return new Response(stream, { status: 200, headers: passHeaders });
      }

      let text;
      try {
        text = await up.text();
      } catch (e) {
        await settle(reserved, "non-stream-cut"); // it ran; we can't see how far — keep the reservation as the charge
        return errorResponse(502, "api_error", "The free trial lost the model service mid-request. Try again.");
      }
      let usage = null;
      try {
        usage = JSON.parse(text).usage;
      } catch {
        /* handled below */
      }
      await settle(usage ? costMicroUsd(body.model, usage, writeMult) : reserved, "non-stream");
      return new Response(text, { status: 200, headers: passHeaders });
    } catch (e) {
      await settle(reservation ? reserved : 0, "error"); // unknown failure after money was set aside: keep it
      throw e;
    }
  }

  const handle = async function handle(req, ctx = {}) {
    const cors = corsFor(req);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": req.headers.get("access-control-request-headers") || CORS_ALLOW_HEADERS, "access-control-max-age": "600" } });
    }
    let res;
    try {
      const { pathname } = new URL(req.url);
      if (pathname === "/health" && req.method === "GET") res = json(200, { ok: true, enabled: cfg.enabled });
      else if (pathname === "/register" && req.method === "POST") res = errorResponse(410, "invalid_request_error", "Free-trial sign-up is by email now. Update the extension and sign in from its settings.", { "x-should-retry": "false" });
      else if (pathname === "/status" && req.method === "GET") res = await status(req, ctx);
      else if (pathname === "/v1/models" && req.method === "GET") res = await models(req);
      else if (pathname === "/v1/messages" && req.method === "POST") res = await messages(req, ctx);
      else res = (await auth.route(req, ctx)) || errorResponse(pathname.startsWith("/v1/") || pathname === "/status" ? 405 : 404, "invalid_request_error", "Not found.");
    } catch (e) {
      log.error?.("unhandled: " + clean(e && e.stack ? e.stack : e));
      res = errorResponse(500, "api_error", "Internal error.");
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  };

  /** Resolves when no request is in flight (or after `ms`): call before exiting so pending charges are recorded. */
  handle.drain = async (ms = 10_000) => {
    const end = Date.now() + ms;
    while (inflightTotal > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return inflightTotal === 0;
  };
  handle.inflight = () => inflightTotal;
  return handle;
}
