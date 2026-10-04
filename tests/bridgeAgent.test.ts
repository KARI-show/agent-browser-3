import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as net from "net";
import Anthropic from "@anthropic-ai/sdk";
import { runTurnBridge } from "../browser/standalone/bridgeAgent";
import { ASK_TOOL, Mode, ToolDef, ToolOutput, TurnCallbacks } from "../browser/standalone/engine";

// ---- a mock trial gateway: scripted SSE; a tool_call waits for its POSTed result, like the real one ----

type Ev = { event: string; data: Record<string, unknown> } | "drop";
/** An error answer to the POST before the scripted stream (a busy gateway). */
type Failure = { status: number; headers?: Record<string, string>; message?: string };

async function mockBridge(script: Ev[], failures: Failure[] = []) {
  const posted: { key: unknown; session_id: string; results: { id: string; content: unknown; is_error: boolean }[] }[] = [];
  const waiting = new Map<string, () => void>();
  const sockets = new Set<net.Socket>();
  const pending = [...failures];
  let hits = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      if (req.url === "/v1/agent/tool_result") {
        const b = JSON.parse(body);
        posted.push({ key: req.headers["x-api-key"], ...b });
        for (const r of b.results) waiting.get(r.id)?.();
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end('{"ok":true}');
      }
      hits++;
      const f = pending.shift();
      if (f) {
        res.writeHead(f.status, { "content-type": "application/json", ...f.headers });
        return void res.end(JSON.stringify({ type: "error", error: { type: f.status === 429 ? "rate_limit_error" : "api_error", message: f.message ?? `mock ${f.status}` } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of script) {
        if (e === "drop") return void res.end(); // the gateway went away mid-turn
        res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
        if (e.event === "tool_call") await new Promise<void>((r) => waiting.set(String(e.data.id), r));
      }
      res.end();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    posted,
    get hits() {
      return hits;
    },
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

const TOOLS: ToolDef[] = [
  { name: "browser_read_page", readOnly: true, description: "read", input_schema: { type: "object", properties: {} } },
  { name: "browser_click", readOnly: false, description: "click", input_schema: { type: "object", properties: { ref: { type: "number" } } } },
  ASK_TOOL,
];

const okText = (t: string): ToolOutput => ({ content: [{ type: "text", text: t }] });
const tick = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));

function callbacks(over: Partial<TurnCallbacks> = {}) {
  const log: string[] = [];
  const cb: TurnCallbacks = {
    text: (d) => log.push(`text:${d}`),
    thinking: (d) => log.push(`thinking:${d}`),
    toolUse: (id, name) => log.push(`tool:${name}`),
    toolResult: (id, text, isError) => log.push(`result:${isError ? "ERR " : ""}${text}`),
    usage: () => {},
    approve: async () => true,
    ask: async () => "yes",
    info: (t) => log.push(`info:${t}`),
    checkpoint: () => {},
    ...over,
  };
  return { cb, log };
}

function bridgeTurn(gw: { url: string }, messages: Anthropic.MessageParam[], cb: TurnCallbacks, over: { mode?: Mode; signal?: AbortSignal; runTool?: (name: string, input: Record<string, unknown>) => Promise<ToolOutput> } = {}) {
  return runTurnBridge({
    baseUrl: gw.url,
    apiKey: "trl_test",
    model: "claude-haiku-4-5",
    system: "SYS",
    tools: TOOLS,
    messages,
    signal: over.signal ?? new AbortController().signal,
    runTool: over.runTool ?? (async () => okText("page")),
    cb,
    mode: over.mode ?? "agent",
  });
}

test("trial bridge: history keeps turn order — text after a tool is the model's next turn, not part of the call", async () => {
  const gw = await mockBridge([
    { event: "session", data: { id: "bs_1" } },
    { event: "text", data: { text: "Let me look." } },
    { event: "tool_call", data: { id: "tc1", name: "browser_read_page", input: {} } },
    { event: "text", data: { text: "Done." } },
    { event: "done", data: { stop_reason: "end_turn" } },
  ]);
  try {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "read it" }];
    const r = await bridgeTurn(gw, messages, callbacks().cb);
    assert.equal(r.stopReason, "end_turn");
    assert.deepEqual(messages.slice(1), [
      { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "tc1", name: "browser_read_page", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tc1", is_error: undefined, content: [{ type: "text", text: "page" }] }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
    assert.equal(gw.posted[0].session_id, "bs_1");
    assert.equal(gw.posted[0].key, "trl_test", "tool results are sent with the install's token");
    assert.deepEqual(gw.posted[0].results[0].content, [{ type: "text", text: "page" }]);
  } finally {
    gw.close();
  }
});

test("trial bridge: the same tool rules as the API loop — Ask mode, undeclared tools, AskUserQuestion", async () => {
  const gw = await mockBridge([
    { event: "session", data: { id: "bs_2" } },
    { event: "tool_call", data: { id: "tc1", name: "browser_read_page", input: {} } },
    { event: "tool_call", data: { id: "tc2", name: "browser_click", input: { ref: 3 } } },
    { event: "tool_call", data: { id: "tc3", name: "browser_not_declared", input: {} } },
    { event: "tool_call", data: { id: "tc4", name: ASK_TOOL.name, input: { questions: [{ question: "Go?" }] } } },
    { event: "done", data: { stop_reason: "end_turn" } },
  ]);
  try {
    const ran: string[] = [];
    const asked: unknown[] = [];
    const { cb } = callbacks({ ask: async (input) => (asked.push(input), "yes") });
    await bridgeTurn(gw, [{ role: "user", content: "x" }], cb, { mode: "ask", runTool: async (name) => (ran.push(name), okText("page")) });
    assert.deepEqual(ran, ["browser_read_page"], "Ask mode still reads pages; nothing else reaches the browser");
    const res = Object.fromEntries(gw.posted.map((p) => [p.results[0].id, p.results[0]]));
    assert.equal(res.tc1.is_error, false);
    assert.match(JSON.stringify(res.tc2.content), /Read-only \(Ask\) mode/);
    assert.match(JSON.stringify(res.tc3.content), /Unknown tool/);
    assert.equal(res.tc3.is_error, true);
    assert.equal(asked.length, 1, "the question is shown to the user, not sent to the page");
    assert.match(JSON.stringify(res.tc4.content), /The user answered: yes/);
  } finally {
    gw.close();
  }
});

test("trial bridge: a rejected token is a typed 401, so the panel can forget it", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Unknown trial token." } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    await assert.rejects(bridgeTurn({ url }, [{ role: "user", content: "x" }], callbacks().cb), (e: unknown) => e instanceof Anthropic.AuthenticationError && /Unknown trial token/.test(String((e as Error).message)));
  } finally {
    server.close();
  }
});

test("trial bridge: a stream that ends without `done` is an error, not a finished answer", async () => {
  const gw = await mockBridge([{ event: "session", data: { id: "bs_3" } }, { event: "text", data: { text: "Half a" } }, "drop"]);
  try {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
    await assert.rejects(bridgeTurn(gw, messages, callbacks().cb), Anthropic.APIConnectionError);
    assert.deepEqual(messages[1], { role: "assistant", content: [{ type: "text", text: "Half a" }] }, "what was shown stays in the history");
  } finally {
    gw.close();
  }
});

test("trial bridge: Stop during a slow tool returns at once as stopped; the tool_use keeps its result", async () => {
  const gw = await mockBridge([
    { event: "session", data: { id: "bs_4" } },
    { event: "tool_call", data: { id: "tc1", name: "browser_click", input: { ref: 1 } } },
    { event: "done", data: { stop_reason: "end_turn" } },
  ]);
  try {
    const ctrl = new AbortController();
    const { cb, log } = callbacks();
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
    const run = bridgeTurn(gw, messages, cb, { signal: ctrl.signal, runTool: () => new Promise<ToolOutput>(() => {}) });
    while (!log.includes("tool:browser_click")) await tick(10);
    ctrl.abort();
    const r = await run;
    assert.equal(r.aborted, true);
    assert.deepEqual(messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "tc1", is_error: true, content: "Interrupted by the user." }] });
    await tick(100);
    assert.equal(gw.posted.length, 1, "the gateway's waiting loop is still told");
  } finally {
    gw.close();
  }
});

test("trial bridge: a busy gateway (5xx/429) is tried again after its Retry-After, and the user is told", async () => {
  const gw = await mockBridge(
    [{ event: "session", data: { id: "bs_5" } }, { event: "text", data: { text: "Done." } }, { event: "done", data: { stop_reason: "end_turn" } }],
    [{ status: 503, headers: { "retry-after": "0" }, message: "The free trial is busy right now." }, { status: 429, headers: { "retry-after": "0" } }]
  );
  try {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
    const { cb, log } = callbacks();
    const r = await bridgeTurn(gw, messages, cb);
    assert.equal(r.stopReason, "end_turn");
    assert.equal(gw.hits, 3);
    assert.deepEqual(log.filter((l) => l.startsWith("info:")), ["info:⟳ The free trial is busy right now. Retrying in 0 s…", "info:⟳ mock 429 Retrying in 0 s…"]);
    assert.deepEqual(messages[1], { role: "assistant", content: [{ type: "text", text: "Done." }] });
  } finally {
    gw.close();
  }
});

test("trial bridge: three attempts at most, no retry when the gateway says so or wants us back much later", async () => {
  const cases: Array<[Failure[], number, (e: unknown) => boolean]> = [
    [Array(3).fill({ status: 503, headers: { "retry-after": "0" } }), 3, (e) => e instanceof Anthropic.InternalServerError],
    [[{ status: 429, headers: { "retry-after": "3600" }, message: "Today's free-trial allowance is used up." }], 1, (e) => e instanceof Anthropic.RateLimitError && /allowance/.test(String((e as Error).message))],
    [[{ status: 503, headers: { "x-should-retry": "false" } }], 1, (e) => e instanceof Anthropic.InternalServerError],
    [[{ status: 400, message: "messages: bad" }], 1, (e) => e instanceof Anthropic.BadRequestError],
  ];
  for (const [failures, hits, check] of cases) {
    const gw = await mockBridge([{ event: "done", data: { stop_reason: "end_turn" } }], failures);
    try {
      await assert.rejects(bridgeTurn(gw, [{ role: "user", content: "x" }], callbacks().cb), check);
      assert.equal(gw.hits, hits, JSON.stringify(failures));
    } finally {
      gw.close();
    }
  }
});

test("trial bridge: Stop during the retry wait ends the turn at once, with no further request", async () => {
  const gw = await mockBridge([{ event: "done", data: { stop_reason: "end_turn" } }], [{ status: 502 }]);
  try {
    const ctrl = new AbortController();
    const { cb, log } = callbacks();
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
    const run = bridgeTurn(gw, messages, cb, { signal: ctrl.signal });
    while (!log.some((l) => l.startsWith("info:"))) await tick(10);
    assert.match(log[0], /Retrying in 1 s/, "no Retry-After: the default backoff");
    ctrl.abort();
    const r = await run;
    assert.equal(r.aborted, true);
    await tick(100);
    assert.equal(gw.hits, 1);
    assert.equal(messages.length, 1);
  } finally {
    gw.close();
  }
});

test("trial bridge: a tool call without an id or name is a protocol error — nothing runs, the turn fails", async () => {
  for (const call of [{ id: "", name: "browser_click", input: {} }, { id: "tc1", input: {} }]) {
    const gw = await mockBridge([{ event: "session", data: { id: "bs_6" } }, { event: "text", data: { text: "Let me" } }, { event: "tool_call", data: call }, { event: "done", data: { stop_reason: "end_turn" } }]);
    try {
      const ran: string[] = [];
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
      await assert.rejects(bridgeTurn(gw, messages, callbacks().cb, { runTool: async (name) => (ran.push(name), okText("clicked")) }), /without an id or name/);
      assert.deepEqual(ran, []);
      assert.deepEqual(messages.slice(1), [{ role: "assistant", content: [{ type: "text", text: "Let me" }] }], "the text shown stays; no half tool_use in the history");
      assert.equal(gw.posted.length, 0);
    } finally {
      gw.close();
    }
  }
});
