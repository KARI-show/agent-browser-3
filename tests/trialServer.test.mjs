import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../trial-server/config.mjs";
import { createHandler, normalizeIp } from "../trial-server/handler.mjs";
import { serve } from "../trial-server/server.mjs";
import { FileStore, MemoryStore } from "../trial-server/store.mjs";
import { costMicroUsd } from "../trial-server/pricing.mjs";

const REAL_KEY = "sk-ant-REAL-OPERATOR-KEY";

function sse({ text = "hello", usage = { input_tokens: 1000, output_tokens: 200 }, stop = "end_turn" } = {}) {
  const ev = (n, d) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
  return (
    ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1, cache_read_input_tokens: usage.cache_read_input_tokens || 0 } } }) +
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }) +
    ev("message_stop", { type: "message_stop" })
  );
}

/** A stand-in for api.anthropic.com. `respond(req, body)` decides what each request gets. */
async function upstream(respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = await respond({ req, res, body, n: seen.length });
      if (out === "handled") return;
      const o = out || {};
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ data: ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5"].map((id) => ({ id, display_name: id, type: "model", created_at: "2026-01-01T00:00:00Z", max_input_tokens: 200000, max_tokens: 64000, capabilities: null })), has_more: false }));
      }
      if (o.status) {
        res.writeHead(o.status, { "content-type": "application/json", ...(o.headers || {}) });
        return void res.end(o.text ?? JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream said no" } }));
      }
      if (body?.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null, usage: o.usage || { input_tokens: 100, output_tokens: 50 } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(o));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.closeAllConnections?.() || server.close() };
}

async function gateway(over = {}, up, opts = {}) {
  const cfg = { ...loadConfig({ ANTHROPIC_API_KEY: REAL_KEY, ANTHROPIC_BASE_URL: up.url }), ...over };
  const store = opts.store || new MemoryStore();
  const handler = createHandler(cfg, store, { now: opts.now || Date.now, log: { info() {}, warn() {}, error() {} } });
  const server = await serve(handler, { port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${server.address().port}`;
  const register = async (headers = {}) => {
    const r = await fetch(url + "/register", { method: "POST", headers });
    return { status: r.status, body: await r.json() };
  };
  const client = (token, o = {}) => new Anthropic({ apiKey: token, baseURL: url, maxRetries: 3, ...o });
  return { cfg, store, url, register, client, handler, close: () => (server.closeAllConnections?.(), server.close()) };
}

const params = (over = {}) => ({ model: "claude-haiku-4-5", max_tokens: 1000, messages: [{ role: "user", content: "hi" }], ...over });
const stream = async (client, p = params()) => {
  const s = client.messages.stream(p);
  let text = "";
  s.on("text", (t) => (text += t));
  const msg = await s.finalMessage();
  return { text, msg };
};
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const untilCounter = async (store, key, min = 1) => {
  for (let i = 0; i < 100 && (await store.get(key)) < min; i++) await tick(20);
  return store.get(key);
};
const day = () => new Date().toISOString().slice(0, 10);
/** Wait until a counter settles at exactly `want` (reservations pass through other values first). */
const untilEquals = async (store, key, want, ms = 3000) => {
  const t0 = Date.now();
  while ((await store.get(key)) !== want && Date.now() - t0 < ms) await tick(20);
  return store.get(key);
};

test("register hands out an opaque token, stores only its hash, and limits sign-ups per IP", async () => {
  const up = await upstream(() => {});
  const g = await gateway({ registerPerIpPerDay: 3 }, up);
  try {
    const a = await g.register();
    assert.equal(a.status, 200);
    assert.match(a.body.token, /^trl_[A-Za-z0-9_-]{40,}$/);
    assert.deepEqual(a.body.models, ["claude-haiku-4-5", "claude-sonnet-5-5"]);
    assert.equal(a.body.limits.dailyUsd, 0.25);
    assert.ok(![...g.store.tokens.keys()].includes(a.body.token) && !JSON.stringify([...g.store.tokens]).includes(a.body.token), "token is stored hashed");
    await g.register();
    await g.register();
    const fourth = await g.register();
    assert.equal(fourth.status, 429);
    assert.match(fourth.body.error.message, /sign-ups/);
  } finally {
    g.close();
    up.close();
  }
});

test("requests without a valid trial token are refused, and the real key is never accepted from the client", async () => {
  const up = await upstream(() => {});
  const g = await gateway({}, up);
  try {
    for (const headers of [{}, { "x-api-key": "sk-ant-something" }, { "x-api-key": "trl_doesnotexist" }, { authorization: "Bearer trl_nope" }]) {
      const r = await fetch(g.url + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(params()) });
      assert.equal(r.status, 401, JSON.stringify(headers));
    }
    assert.equal(up.seen.length, 0, "nothing reached the upstream");
  } finally {
    g.close();
    up.close();
  }
});

test("streaming end to end through the real SDK: real key swapped in, request sanitized, usage metered", async () => {
  const up = await upstream(({ body }) => (body?.stream ? { text: "Hi from the model", usage: { input_tokens: 1000, output_tokens: 200 } } : undefined));
  const g = await gateway({}, up);
  try {
    const { token } = (await g.register()).body;
    const { text, msg } = await stream(g.client(token), params({ max_tokens: 64000, output_config: { effort: "xhigh" }, thinking: { type: "adaptive", display: "summarized" }, cache_control: { type: "ephemeral" } }));
    assert.equal(text, "Hi from the model");
    assert.equal(msg.stop_reason, "end_turn");

    const forwarded = up.seen.find((r) => r.url === "/v1/messages");
    assert.equal(forwarded.headers["x-api-key"], REAL_KEY, "operator key used upstream");
    assert.ok(!JSON.stringify(forwarded.headers).includes(token), "the trial token never goes upstream");
    assert.equal(forwarded.body.max_tokens, 8192, "max_tokens clamped to the cap");
    assert.equal(forwarded.body.output_config.effort, "high", "xhigh/max clamped");
    assert.equal(forwarded.body.model, "claude-haiku-4-5");
    assert.deepEqual(forwarded.body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(forwarded.body.cache_control, { type: "ephemeral" });

    // 1000 in × $1 + 200 out × $5 = 2000 micro-dollars, on every counter
    const hash = [...g.store.tokens.keys()][0];
    assert.equal(await untilEquals(g.store, `tok:${hash}:${day()}`, costMicroUsd("claude-haiku-4-5", { input_tokens: 1000, output_tokens: 200 })), 2000);
    assert.equal(await g.store.get(`glob:${day()}`), 2000, "the reservation was replaced by the real cost");
    const st = await (await fetch(g.url + "/status", { headers: { "x-api-key": token } })).json();
    assert.ok(Math.abs(st.dailyLeftUsd - (0.25 - 0.002)) < 1e-9, String(st.dailyLeftUsd));
  } finally {
    g.close();
    up.close();
  }
});

test("non-streaming requests are metered from the JSON usage", async () => {
  const up = await upstream(() => ({ usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 1000 } }));
  const g = await gateway({}, up);
  try {
    const { token } = (await g.register()).body;
    await g.client(token).messages.create(params({ stream: false }));
    // 500×1 + 1000×0.1 + 100×5 = 1100
    assert.equal(await g.store.get(`glob:${day()}`), 1100);
  } finally {
    g.close();
    up.close();
  }
});

test("the gateway refuses models, fields and tools outside the trial", async () => {
  const up = await upstream(() => {});
  const g = await gateway({}, up);
  try {
    const { token } = (await g.register()).body;
    const c = g.client(token, { maxRetries: 0 });
    await assert.rejects(stream(c, params({ model: "claude-opus-5-5" })), (e) => e instanceof Anthropic.BadRequestError && /claude-haiku-4-5, claude-sonnet-5-5/.test(e.message));
    await assert.rejects(stream(c, params({ tools: [{ type: "web_search_20260209", name: "web_search" }] })), (e) => e instanceof Anthropic.BadRequestError && /Server-side tools/.test(e.message));
    const raw = (body) => fetch(g.url + "/v1/messages", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await raw({ ...params(), mcp_servers: [{ type: "url", url: "https://x", name: "x" }] })).status, 400);
    assert.equal((await raw({ ...params(), container: { skills: [] } })).status, 400);
    assert.equal((await raw({ ...params(), messages: [] })).status, 400);
    assert.equal((await raw({ model: "claude-haiku-4-5", messages: params().messages })).status, 400, "max_tokens required");
    assert.equal((await fetch(g.url + "/v1/messages", { method: "POST", headers: { "x-api-key": token }, body: "not json" })).status, 400);
    // custom tools are fine
    const ok = await stream(c, params({ tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }] }));
    assert.ok(ok.text);
    assert.equal(up.seen.filter((r) => r.url === "/v1/messages").length, 1, "only the valid request reached the upstream");
  } finally {
    g.close();
    up.close();
  }
});

test("budgets: an exhausted allowance stops requests at once with an actionable, non-retried error", async () => {
  // A request reserves its worst case (~5,080 µ$ here: 1000 max_tokens × $5/M + input) and settles to the real 5,500 µ$.
  const cases = [
    ["token daily", { tokenDailyMicro: 6000 }, 429, /Today's free-trial allowance/],
    ["token total", { tokenDailyMicro: 1e9, tokenTotalMicro: 6000 }, 429, /free trial is used up/],
    ["ip daily", { tokenDailyMicro: 1e9, ipDailyMicro: 6000 }, 429, /for this network/],
    ["global daily", { tokenDailyMicro: 1e9, globalDailyMicro: 6000 }, 503, /at capacity/],
  ];
  for (const [name, over, status, re] of cases) {
    const up = await upstream(() => ({ usage: { input_tokens: 500, output_tokens: 1000 } })); // really costs 5,500
    const g = await gateway(over, up);
    try {
      const { token } = (await g.register()).body;
      const c = g.client(token); // maxRetries 3: must NOT retry (x-should-retry: false)
      await stream(c);
      assert.equal(await untilEquals(g.store, `glob:${day()}`, 5500), 5500, name);
      const t0 = Date.now();
      await assert.rejects(stream(c), (e) => e instanceof Anthropic.APIError && e.status === status && re.test(e.message), name);
      assert.ok(Date.now() - t0 < 1500, `${name}: refused without retry backoff`);
      assert.equal(up.seen.filter((r) => r.url === "/v1/messages").length, 1, `${name}: second request never reached the upstream`);
      assert.equal(await g.store.get(`glob:${day()}`), 5500, `${name}: a refused request leaves no reservation behind`);
    } finally {
      g.close();
      up.close();
    }
  }
});

test("a request that could cost more than what is left is refused with a 'too large' message, not 'used up'", async () => {
  const up = await upstream(() => ({}));
  const g = await gateway({ tokenDailyMicro: 30_000 }, up); // $0.03 left; this request may cost up to $0.05
  try {
    const { token } = (await g.register()).body;
    await assert.rejects(stream(g.client(token), params({ max_tokens: 8000 })), (e) => e.status === 429 && /larger than your remaining/.test(e.message) && /\$0\.03 left/.test(e.message));
    assert.equal(up.seen.filter((r) => r.url === "/v1/messages").length, 0);
    await stream(g.client(token), params({ max_tokens: 1000 })); // a smaller one still fits
  } finally {
    g.close();
    up.close();
  }
});

test("one IP cannot multiply its allowance by registering several tokens", async () => {
  const up = await upstream(() => ({ usage: { input_tokens: 1000, output_tokens: 200 } })); // costs 2,000 µ$ each
  const g = await gateway({ ipDailyMicro: 9_000 }, up); // two requests settle at 4,000; a third reserves 5,080 → 9,080 > 9,000
  try {
    const a = (await g.register()).body.token;
    const b = (await g.register()).body.token;
    await stream(g.client(a));
    await stream(g.client(b));
    assert.equal(await untilEquals(g.store, `glob:${day()}`, 4000), 4000);
    await assert.rejects(stream(g.client(a), params()), (e) => e.status === 429 && /network/.test(e.message));
    await assert.rejects(stream(g.client(b), params()), (e) => e.status === 429 && /network/.test(e.message));
  } finally {
    g.close();
    up.close();
  }
});

test("kill switch pauses sign-ups and requests", async () => {
  const up = await upstream(() => {});
  const g = await gateway({ enabled: false }, up);
  try {
    assert.equal((await g.register()).status, 503);
    assert.equal((await fetch(g.url + "/v1/messages", { method: "POST", headers: { "x-api-key": "trl_x" }, body: "{}" })).status, 503);
    assert.equal((await (await fetch(g.url + "/health")).json()).enabled, false);
  } finally {
    g.close();
    up.close();
  }
});

test("problems with the operator's own key never leak to trial users", async () => {
  const bad = [
    { status: 401, text: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key sk-ant-REAL…" } }) },
    { status: 400, text: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }) },
    { status: 400, text: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace…" } }) },
  ];
  for (const one of bad) {
    const up = await upstream(() => one);
    const g = await gateway({}, up);
    try {
      const { token } = (await g.register()).body;
      const r = await fetch(g.url + "/v1/messages", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify(params()) });
      const text = await r.text();
      assert.equal(r.status, 503);
      assert.match(text, /temporarily unavailable/);
      assert.ok(!/sk-ant|credit|workspace/i.test(text), "nothing about the operator's account is exposed: " + text);
    } finally {
      g.close();
      up.close();
    }
  }
});

test("the user's own errors and rate limits pass through so the SDK behaves normally", async () => {
  let n = 0;
  const up = await upstream(() => (++n === 1 ? { status: 429, headers: { "retry-after": "0" }, text: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }) } : { text: "after retry" }));
  const g = await gateway({}, up);
  try {
    const { token } = (await g.register()).body;
    const { text } = await stream(g.client(token)); // SDK retries the 429 and succeeds
    assert.equal(text, "after retry");
  } finally {
    g.close();
    up.close();
  }
  const up2 = await upstream(() => ({ status: 400, text: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.0: bad content" } }) }));
  const g2 = await gateway({}, up2);
  try {
    const { token } = (await g2.register()).body;
    await assert.rejects(stream(g2.client(token, { maxRetries: 0 })), (e) => e instanceof Anthropic.BadRequestError && /bad content/.test(e.message));
  } finally {
    g2.close();
    up2.close();
  }
});

test("a client that aborts mid-stream is still charged (estimated) and frees its slot", async () => {
  const up = await upstream(({ res, body }) => {
    if (!body?.stream) return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const full = sse({ text: "x".repeat(3000), usage: { input_tokens: 800, output_tokens: 1000 } });
    // send everything up to (not including) the final message_delta, then stall
    res.write(full.split("event: message_delta")[0]);
    return "handled";
  });
  const g = await gateway({}, up);
  try {
    const { token } = (await g.register()).body;
    const ctrl = new AbortController();
    const s = g.client(token, { maxRetries: 0 }).messages.stream(params(), { signal: ctrl.signal });
    s.on("error", () => {});
    await new Promise((r) => s.on("text", r));
    ctrl.abort();
    await s.finalMessage().catch(() => {});
    // 800 input + ~1000 output tokens (3000 chars / 3) → 800 + 5000 micro
    const spent = await untilEquals(g.store, `glob:${day()}`, 800 * 1 + 1000 * 5);
    assert.equal(spent, 800 * 1 + 1000 * 5);
    assert.equal(g.handler.inflight(), 0, "the slot is free again");
  } finally {
    g.close();
    up.close();
  }
});

test("at most three requests per token run at once", async () => {
  const up = await upstream(({ res, body }) => {
    if (!body?.stream) return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse().split("event: content_block_delta")[0]); // stall after message_start
    return "handled";
  });
  const g = await gateway({}, up);
  try {
    const { token } = (await g.register()).body;
    const open = [];
    for (let i = 0; i < 3; i++) {
      const ctrl = new AbortController();
      const r = fetch(g.url + "/v1/messages", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify(params({ stream: true })), signal: ctrl.signal });
      r.catch(() => {});
      open.push({ ctrl, r });
    }
    await tick(300);
    const fourth = await fetch(g.url + "/v1/messages", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify(params({ stream: true })) });
    assert.equal(fourth.status, 429);
    assert.match((await fourth.json()).error.message, /at once/);
    for (const o of open) o.ctrl.abort();
  } finally {
    g.close();
    up.close();
  }
});

test("oversized bodies are refused before anything is forwarded", async () => {
  const up = await upstream(() => {});
  const g = await gateway({ maxBodyBytes: 2000 }, up);
  try {
    const { token } = (await g.register()).body;
    const r = await fetch(g.url + "/v1/messages", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify(params({ messages: [{ role: "user", content: "x".repeat(5000) }] })) });
    assert.equal(r.status, 413);
    assert.equal(up.seen.length, 0);
  } finally {
    g.close();
    up.close();
  }
});

test("models are limited to the trial's list; CORS answers only for allowed origins", async () => {
  const up = await upstream(() => {});
  const g = await gateway({ models: ["claude-haiku-4-5", "claude-sonnet-5-5"], allowedOrigins: ["chrome-extension://abc"] }, up);
  try {
    const { token } = (await g.register()).body;
    const models = await g.client(token).models.list();
    assert.deepEqual(models.data.map((m) => m.id), ["claude-haiku-4-5", "claude-sonnet-5-5"]);
    assert.equal(models.data[0].max_input_tokens, 200000, "real capabilities are passed through");

    const ok = await fetch(g.url + "/v1/messages", { method: "OPTIONS", headers: { origin: "chrome-extension://abc", "access-control-request-headers": "x-api-key,content-type" } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), "chrome-extension://abc");
    assert.match(ok.headers.get("access-control-allow-headers"), /x-api-key/);
    const no = await fetch(g.url + "/v1/messages", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(no.headers.get("access-control-allow-origin"), null);
    const res = await fetch(g.url + "/register", { method: "POST", headers: { origin: "chrome-extension://abc" } });
    assert.equal(res.headers.get("access-control-allow-origin"), "chrome-extension://abc");
  } finally {
    g.close();
    up.close();
  }
});

test("client IP: socket address by default; the last hop of the trusted header when configured; IPv6 grouped by /64", async () => {
  assert.equal(normalizeIp("203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(normalizeIp("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(normalizeIp(undefined), "unknown");

  const up = await upstream(() => {});
  const g = await gateway({ registerPerIpPerDay: 1, ipHeader: "x-forwarded-for" }, up);
  try {
    // A spoofed leading entry must not let one client mint unlimited tokens: the proxy-added last entry counts.
    assert.equal((await g.register({ "x-forwarded-for": "1.1.1.1, 9.9.9.9" })).status, 200);
    assert.equal((await g.register({ "x-forwarded-for": "2.2.2.2, 9.9.9.9" })).status, 429);
    assert.equal((await g.register({ "x-forwarded-for": "2.2.2.2, 8.8.8.8" })).status, 200);
  } finally {
    g.close();
    up.close();
  }
});

test("FileStore survives a restart, keeps only hashes and drops old daily counters", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trial-")), "trial.json");
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  fs.writeFileSync(file, JSON.stringify({ tokens: {}, counters: { [`glob:${old}`]: 5, "tok:abc:total": 7 } }));
  const up = await upstream(() => ({ usage: { input_tokens: 1000, output_tokens: 200 } }));
  const store1 = new FileStore(file, { flushMs: 10, log: { error() {} } });
  assert.equal(await store1.get(`glob:${old}`), 0, "old daily counter pruned on load");
  assert.equal(await store1.get("tok:abc:total"), 7, "lifetime counters kept");
  const g = await gateway({}, up, { store: store1 });
  try {
    const { token } = (await g.register()).body;
    await stream(g.client(token));
    await untilEquals(g.store, `glob:${day()}`, 2000);
    store1.flush();
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes(token), "the plaintext token is not on disk");
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
    const store2 = new FileStore(file);
    assert.equal(await store2.get(`glob:${day()}`), 2000);
    assert.equal(store2.tokens.size, 1);
  } finally {
    g.close();
    up.close();
  }
});

// ---- fixes from the security review ------------------------------------------------

test("parallel requests cannot overshoot: each reserves its worst case up front", async () => {
  const up = await upstream(({ res, body }) => {
    if (!body?.stream) return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse().split("event: content_block_delta")[0]); // stays open
    return "handled";
  });
  const g = await gateway({ tokenDailyMicro: 8000 }, up); // room for one ~5,080 µ$ reservation, not two
  try {
    const { token } = (await g.register()).body;
    const fire = () => fetch(g.url + "/v1/messages", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify(params({ stream: true })) });
    const first = fire();
    first.catch(() => {});
    await tick(200);
    const second = await fire();
    assert.equal(second.status, 429);
    assert.match((await second.json()).error.message, /allowance/);
    assert.equal(up.seen.filter((r) => r.url === "/v1/messages").length, 1, "the second request never went upstream");
    assert.ok((await g.store.get(`glob:${day()}`)) < 8000, "and its reservation was undone");
  } finally {
    g.close();
    up.close();
  }
});

test("a huge prompt is refused up front — input tokens are estimated from the body, images at a fixed ceiling", async () => {
  const up = await upstream(() => ({}));
  const g = await gateway({}, up);
  try {
    const { token } = (await g.register()).body;
    const big = "word ".repeat(400_000); // ~2 MB of text ≈ 650k tokens ≈ $0.65+ on Haiku, budget is $0.25/day
    await assert.rejects(stream(g.client(token), params({ messages: [{ role: "user", content: big }] })), (e) => e.status === 429 && /larger than your remaining/.test(e.message));
    assert.equal(up.seen.length, 0);
    // a screenshot is 3,300 tokens whatever its base64 length
    const b64 = "A".repeat(600_000);
    const ok = await stream(g.client(token), params({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }, { type: "text", text: "what is this" }] }] }));
    assert.ok(ok.text);
  } finally {
    g.close();
    up.close();
  }
});

test("abort after hidden thinking is billed by elapsed time, capped at max_tokens — not by visible characters", async () => {
  let clock = Date.now();
  const up = await upstream(({ res, body }) => {
    if (!body?.stream) return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (n, d) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
    res.write(ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } }));
    res.write(ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }));
    res.write(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "S" } })); // hidden reasoning: no visible characters
    return "handled";
  });
  const g = await gateway({}, up, { now: () => clock });
  try {
    const { token } = (await g.register()).body;
    const ctrl = new AbortController();
    const s = g.client(token, { maxRetries: 0 }).messages.stream(params({ model: "claude-sonnet-5-5", max_tokens: 4000 }), { signal: ctrl.signal });
    s.on("error", () => {});
    await new Promise((r) => s.on("streamEvent", r));
    clock += 60_000; // a minute of (hidden) generation
    ctrl.abort();
    await s.finalMessage().catch(() => {});
    const key = `glob:${new Date(clock).toISOString().slice(0, 10)}`;
    // 100 input × $2 + min(4000, 60 s × 300 t/s) × $10 = 200 + 40,000
    assert.equal(await untilEquals(g.store, key, 40_200), 40_200);
  } finally {
    g.close();
    up.close();
  }
});

test("a client that stops reading and disconnects frees its slot and is charged", async () => {
  const up = await upstream(({ res, body }) => {
    if (!body?.stream) return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (n, d) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
    res.write(ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, usage: { input_tokens: 500, output_tokens: 1 } } }));
    const pump = setInterval(() => res.write(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(60_000) } })), 5);
    res.on("close", () => clearInterval(pump));
    return "handled";
  });
  const g = await gateway({}, up);
  try {
    const { token } = (await g.register()).body;
    const port = new URL(g.url).port;
    const sock = net.connect(Number(port), "127.0.0.1");
    const body = JSON.stringify(params({ stream: true }));
    sock.write(`POST /v1/messages HTTP/1.1\r\nHost: x\r\nx-api-key: ${token}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    sock.pause(); // never read: the gateway's socket buffer fills and it waits for 'drain'
    await tick(500);
    sock.destroy();
    for (let i = 0; i < 150 && g.handler.inflight() > 0; i++) await tick(20);
    assert.equal(g.handler.inflight(), 0, "slot released after the client vanished mid-drain");
    assert.ok((await g.store.get(`glob:${day()}`)) > 0);
    // and the token is not locked out
    await stream(g.client(token, { maxRetries: 0 }), params({ stream: true })).catch(() => {});
  } finally {
    g.close();
    up.close();
  }
});

test("a non-streaming request keeps running after the client leaves and is charged its real usage", async () => {
  const up = await upstream(async ({ res, body }) => {
    if (body?.stream !== false) return;
    await tick(400);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "late" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 400 } }));
    return "handled";
  });
  const g = await gateway({}, up);
  try {
    const { token } = (await g.register()).body;
    const ctrl = new AbortController();
    const req = g.client(token, { maxRetries: 0 }).messages.create(params({ stream: false }), { signal: ctrl.signal });
    req.catch(() => {});
    await tick(100);
    ctrl.abort();
    assert.equal(await untilEquals(g.store, `glob:${day()}`, 1000 + 400 * 5), 3000);
    assert.equal(g.handler.inflight(), 0);
  } finally {
    g.close();
    up.close();
  }
});

test("redirects from the upstream are never followed with the operator key", async () => {
  const seen = [];
  const evil = http.createServer((req, res) => (seen.push(req.headers), res.end("{}")));
  await new Promise((r) => evil.listen(0, "127.0.0.1", r));
  const up = await upstream(() => ({ status: 307, headers: { location: `http://127.0.0.1:${evil.address().port}/steal` }, text: "" }));
  const g = await gateway({}, up);
  try {
    const { token } = (await g.register()).body;
    const r = await fetch(g.url + "/v1/messages", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify(params()) });
    assert.equal(r.status, 503);
    assert.equal(seen.length, 0, "the redirect target never saw a request");
  } finally {
    g.close();
    up.close();
    evil.close();
  }
});

test("upstream errors are re-written: account and limit details never reach trial users", async () => {
  const cases = [
    [{ status: 429, text: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "This request would exceed your organization's rate limit of 50 requests per minute (org 8f2a…)" } }) }, 429, /busy right now/, /organization|50|8f2a/],
    [{ status: 500, text: JSON.stringify({ type: "error", error: { type: "api_error", message: "internal error for key sk-ant-…abcd in workspace wrkspc_123" } }) }, 500, /model service had a problem/, /sk-ant|wrkspc/],
    [{ status: 400, text: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.0.content.1: tool_use ids must be unique", extra: "LEAK" } }) }, 400, /tool_use ids must be unique/, /LEAK/],
    [{ status: 400, text: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your organization has reached its monthly spend limit" } }) }, 503, /temporarily unavailable/, /organization|spend/],
    [{ status: 404, text: JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: claude-x for organization 123" } }) }, 503, /temporarily unavailable/, /organization|123/],
  ];
  for (const [one, status, want, forbidden] of cases) {
    const up = await upstream(() => one);
    const g = await gateway({}, up);
    try {
      const { token } = (await g.register()).body;
      const r = await fetch(g.url + "/v1/messages", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify(params()) });
      const text = await r.text();
      assert.equal(r.status, status, text);
      assert.match(text, want);
      assert.ok(!forbidden.test(text), "leaked: " + text);
      assert.equal(await g.store.get(`glob:${day()}`), 0, "a failed request leaves no reservation behind");
    } finally {
      g.close();
      up.close();
    }
  }
});

test("per-token request rate and gateway-wide concurrency are limited", async () => {
  const up = await upstream(() => ({}));
  const g = await gateway({ tokenRpm: 2 }, up);
  try {
    const { token } = (await g.register()).body;
    await stream(g.client(token, { maxRetries: 0 }));
    await stream(g.client(token, { maxRetries: 0 }));
    await assert.rejects(stream(g.client(token, { maxRetries: 0 })), (e) => e.status === 429 && /Slow down/.test(e.message));
  } finally {
    g.close();
    up.close();
  }
  const up2 = await upstream(({ res, body }) => {
    if (!body?.stream) return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse().split("event: content_block_delta")[0]);
    return "handled";
  });
  const g2 = await gateway({ maxConcurrent: 2 }, up2);
  try {
    const tokens = [];
    for (let i = 0; i < 3; i++) tokens.push((await g2.register()).body.token);
    const opens = tokens.slice(0, 2).map((t) => {
      const c = new AbortController();
      fetch(g2.url + "/v1/messages", { method: "POST", headers: { "x-api-key": t, "content-type": "application/json" }, body: JSON.stringify(params({ stream: true })), signal: c.signal }).catch(() => {});
      return c;
    });
    await tick(300);
    const third = await fetch(g2.url + "/v1/messages", { method: "POST", headers: { "x-api-key": tokens[2], "content-type": "application/json" }, body: JSON.stringify(params({ stream: true })) });
    assert.equal(third.status, 503);
    assert.match((await third.json()).error.message, /busy/);
    opens.forEach((c) => c.abort());
  } finally {
    g2.close();
    up2.close();
  }
});

test("config: a malformed number stops startup instead of silently disabling a budget", () => {
  for (const [name, value] of [["TRIAL_TOKEN_DAILY_USD", "0,25"], ["TRIAL_GLOBAL_DAILY_USD", "$20"], ["TRIAL_MAX_TOKENS", "lots"], ["TRIAL_TOKEN_RPM", "-1"]]) {
    assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", [name]: value }), new RegExp(name));
  }
  assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", TRIAL_ENABLED: "maybe" }), /TRIAL_ENABLED/);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "k", TRIAL_TOKEN_DAILY_USD: "0.4" }).tokenDailyMicro, 400_000);
});

test("pricing: dated model ids, unknown models and the 1-hour cache tier are priced correctly", () => {
  assert.equal(costMicroUsd("claude-haiku-4-5-20251001", { input_tokens: 1000 }), 1000, "dated id priced like its base id");
  assert.equal(costMicroUsd("claude-mystery-9", { input_tokens: 1000 }), 10_000, "unknown model at the dearest rate");
  // 1h writes cost 2x, 5m writes 1.25x; the API's breakdown wins over the total
  const usage = { cache_creation_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 } };
  assert.equal(costMicroUsd("claude-haiku-4-5", usage), 1000 * 1.25 + 1000 * 2);
  assert.equal(costMicroUsd("claude-haiku-4-5", { cache_creation_input_tokens: 1000 }, 2), 2000, "a request that asked for 1h TTL is priced at 2x when no breakdown arrives");
});

test("FileStore refuses to start from a corrupt file, and forgets tokens that never spent anything", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trial-"));
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{ not json");
  assert.throws(() => new FileStore(bad), /refusing to start with reset budgets/);
  const file = path.join(dir, "ok.json");
  const old = Date.now() - 10 * 86_400_000;
  fs.writeFileSync(file, JSON.stringify({ tokens: { idle: { createdAt: old }, used: { createdAt: old }, fresh: { createdAt: Date.now() } }, counters: { "tok:used:total": 5 } }));
  const store = new FileStore(file);
  assert.equal(store.tokens.has("idle"), false, "old, never used → dropped");
  assert.equal(store.tokens.has("used"), true);
  assert.equal(store.tokens.has("fresh"), true);
  // a failing disk does not throw out of flush()
  const blocked = new FileStore(path.join(dir, "file-as-dir", "x.json"), { log: { error() {} } });
  fs.writeFileSync(path.join(dir, "file-as-dir"), "x");
  assert.doesNotThrow(() => blocked.flush());
});

test("sign-ups pause once the stored-token cap is reached", async () => {
  const up = await upstream(() => ({}));
  const g = await gateway({ maxRegistered: 1, registerPerIpPerDay: 10 }, up);
  try {
    assert.equal((await g.register()).status, 200);
    const second = await g.register();
    assert.equal(second.status, 503);
    assert.match(second.body.error.message, /sign-ups are paused/);
  } finally {
    g.close();
    up.close();
  }
});
