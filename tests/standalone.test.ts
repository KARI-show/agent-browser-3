import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as net from "net";
import Anthropic from "@anthropic-ai/sdk";
import { ASK_TOOL, ToolDef, ToolOutput, TurnCallbacks, compactHistory, describeError, effortFor, modelTraits, runTurn, slimForSummary, wellFormed } from "../browser/standalone/engine";
import { LocalHost, LocalHostDeps, repairHistory, stripThinking } from "../browser/standalone/localHost";
import { ConvStore, KV } from "../browser/standalone/store";

// ---- a mock Claude API: scripted streaming responses, requests recorded ------------

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface Scripted {
  blocks: Block[];
  stop: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "model_context_window_exceeded";
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
  status?: number; // reply with an HTTP error instead
  errorType?: string;
  message?: string;
  stall?: boolean; // never finish (abort tests)
}

function sse(r: Scripted): string {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev("message_start", {
    type: "message_start",
    message: { id: "msg_test", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: r.usage?.input_tokens ?? 10, output_tokens: 1 } },
  });
  r.blocks.forEach((b, i) => {
    if (b.type === "text") {
      out += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      for (const part of b.text.match(/.{1,7}/gs) ?? []) out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: part } });
    } else if (b.type === "thinking") {
      out += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
      out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.thinking } });
      out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: b.signature } });
    } else {
      out += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } });
      out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(5) } });
    }
    out += ev("content_block_stop", { type: "content_block_stop", index: i });
  });
  out += ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: r.stop, stop_sequence: null, ...(r.stop === "refusal" ? { stop_details: { type: "refusal", category: "cyber", explanation: "not allowed" } } : {}) },
    usage: { output_tokens: r.usage?.output_tokens ?? 5, input_tokens: r.usage?.input_tokens ?? 10, cache_read_input_tokens: r.usage?.cache_read_input_tokens ?? 0 },
  });
  out += ev("message_stop", { type: "message_stop" });
  return out;
}

async function mockApi(script: Scripted[], opts: { models?: string[] } = {}) {
  const requests: any[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      headers.push(req.headers);
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ data: (opts.models ?? ["claude-opus-5-5"]).map((id) => ({ id, display_name: id === "claude-opus-5-5" ? "Claude Opus 5.5" : id, type: "model", created_at: "2026-01-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: null })), has_more: false, first_id: "x", last_id: "x" }));
      }
      requests.push(JSON.parse(body));
      const r = script[requests.length - 1] ?? script[script.length - 1];
      if (r.status) {
        res.writeHead(r.status, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ type: "error", error: { type: r.errorType ?? "api_error", message: r.message ?? `mock ${r.status}` } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (r.stall) return void res.write(sse({ ...r, blocks: [] }).split("event: message_delta")[0]); // opened, never finished
      res.end(sse(r));
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    headers,
    client: () => new Anthropic({ apiKey: "sk-test", baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 }),
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

const TOOLS: ToolDef[] = [
  { name: "browser_read_page", readOnly: true, description: "read", input_schema: { type: "object", properties: {} } },
  { name: "browser_click", readOnly: false, description: "click", input_schema: { type: "object", properties: { ref: { type: "number" } }, required: ["ref"] } },
];

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
    checkpoint: () => log.push("checkpoint"),
    ...over,
  };
  return { cb, log };
}

const okText = (t: string): ToolOutput => ({ content: [{ type: "text", text: t }] });

function turn(api: Awaited<ReturnType<typeof mockApi>>, messages: Anthropic.MessageParam[], cb: TurnCallbacks, over: Partial<Parameters<typeof runTurn>[0]> = {}) {
  return runTurn({
    client: api.client(),
    model: "claude-opus-5-5",
    traits: { thinking: true, effort: true },
    effort: "medium",
    system: "SYS",
    tools: TOOLS,
    messages,
    mode: "agent",
    signal: new AbortController().signal,
    runTool: async () => okText("done"),
    cb,
    ...over,
  });
}

// ---- engine ----------------------------------------------------------------------

test("a tool round trip: streams, runs the tool, sends thinking back unchanged, history only grows", async () => {
  const api = await mockApi([
    { blocks: [{ type: "thinking", thinking: "hmm", signature: "SIG1" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_1", name: "browser_read_page", input: {} }], stop: "tool_use", usage: { input_tokens: 100, output_tokens: 20 } },
    { blocks: [{ type: "text", text: "All done here." }], stop: "end_turn" },
  ]);
  try {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "what is on the page?" }];
    const { cb, log } = callbacks();
    const res = await turn(api, messages, cb, { runTool: async (n) => ({ content: [{ type: "text", text: `ran ${n}` }, { type: "image", data: "QUJD", mimeType: "image/jpeg" }] }) });

    assert.equal(res.stopReason, "end_turn");
    // the mock streams text in 7-character pieces; merge consecutive deltas
    const events = log.filter((l) => !l.startsWith("checkpoint")).reduce<string[]>((acc, l) => {
      const prev = acc[acc.length - 1];
      if (prev && l.startsWith("text:") && prev.startsWith("text:")) acc[acc.length - 1] = prev + l.slice(5);
      else acc.push(l);
      return acc;
    }, []);
    assert.deepEqual(events, ["thinking:hmm", "text:Looking.", "tool:browser_read_page", "result:ran browser_read_page\n[1 image sent to the model]", "text:All done here."]);

    // request 1: adaptive summarized thinking, effort, caching, tools, system — and NOT forced tool_choice / budget
    const r1 = api.requests[0];
    assert.equal(r1.model, "claude-opus-5-5");
    assert.deepEqual(r1.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(r1.output_config, { effort: "medium" });
    assert.deepEqual(r1.cache_control, { type: "ephemeral" });
    assert.equal(r1.tool_choice, undefined);
    assert.equal(r1.tools[0].name, "browser_read_page");
    assert.equal(r1.system[0].text, "SYS");
    assert.equal(r1.stream, true);

    // request 2: prior turns replayed verbatim (thinking + signature), tool_result matches the id, image passed through
    const r2 = api.requests[1];
    assert.equal(r2.messages.length, 3);
    assert.deepEqual(r2.messages[0], r1.messages[0], "append-only: the first message is byte-identical");
    const asst = r2.messages[1];
    assert.equal(asst.role, "assistant");
    assert.equal(asst.content[0].type, "thinking");
    assert.equal(asst.content[0].signature, "SIG1");
    assert.equal(asst.content[2].type, "tool_use");
    const user = r2.messages[2];
    assert.equal(user.content[0].type, "tool_result");
    assert.equal(user.content[0].tool_use_id, "toolu_1");
    assert.equal(user.content[0].content[1].type, "image");
    assert.equal(user.content[0].content[1].source.media_type, "image/jpeg");
    // the caller's array grew by exactly: assistant, tool results, assistant
    assert.equal(messages.length, 4);
  } finally {
    api.close();
  }
});

test("modes: ask denies actions but not reads; careful asks first; agent runs freely", async () => {
  const actions = { ran: [] as string[] };
  const script: Scripted[] = [
    { blocks: [{ type: "tool_use", id: "t1", name: "browser_click", input: { ref: 3 } }, { type: "tool_use", id: "t2", name: "browser_read_page", input: {} }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" },
  ];
  const runTool = async (n: string) => {
    actions.ran.push(n);
    return okText("ran");
  };

  // ask
  let api = await mockApi(script);
  try {
    const { cb, log } = callbacks();
    await turn(api, [{ role: "user", content: "go" }], cb, { mode: "ask", runTool });
    assert.deepEqual(actions.ran, ["browser_read_page"]);
    assert.ok(log.some((l) => l.startsWith("result:ERR Read-only (Ask) mode")));
    const results = api.requests[1].messages[2].content;
    assert.equal(results[0].is_error, true);
    assert.equal(results[1].is_error, undefined);
  } finally {
    api.close();
  }

  // careful: denied
  actions.ran = [];
  api = await mockApi(script);
  try {
    const asked: string[] = [];
    const { cb, log } = callbacks({ approve: async (n) => (asked.push(n), false) });
    await turn(api, [{ role: "user", content: "go" }], cb, { mode: "careful", runTool });
    assert.deepEqual(asked, ["browser_click"], "only the action is put to the user");
    assert.deepEqual(actions.ran, ["browser_read_page"]);
    assert.ok(log.some((l) => l === "result:ERR The user denied this action."));
  } finally {
    api.close();
  }

  // careful: allowed, and agent mode never asks
  for (const mode of ["careful", "agent"] as const) {
    actions.ran = [];
    api = await mockApi(script);
    try {
      let asks = 0;
      const { cb } = callbacks({ approve: async () => (asks++, true) });
      await turn(api, [{ role: "user", content: "go" }], cb, { mode, runTool });
      assert.deepEqual(actions.ran, ["browser_click", "browser_read_page"], mode);
      assert.equal(asks, mode === "careful" ? 1 : 0, mode);
    } finally {
      api.close();
    }
  }
});

test("AskUserQuestion is answered by the user and fed back as the tool result", async () => {
  const api = await mockApi([
    { blocks: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Buy it?", header: "Confirm", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] }] } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "noted" }], stop: "end_turn" },
  ]);
  try {
    let seen: unknown;
    const { cb } = callbacks({ ask: async (input) => ((seen = input), "No") });
    await turn(api, [{ role: "user", content: "buy" }], cb, { tools: [...TOOLS, ASK_TOOL] });
    assert.equal((seen as any).questions[0].question, "Buy it?");
    assert.equal(api.requests[1].messages[2].content[0].content, "The user answered: No");
  } finally {
    api.close();
  }
});

test("a refusal stops the turn and never runs that turn's tools", async () => {
  const api = await mockApi([{ blocks: [{ type: "text", text: "I can't" }, { type: "tool_use", id: "t", name: "browser_click", input: { ref: 1 } }], stop: "refusal" }]);
  try {
    let ran = 0;
    const res = await turn(api, [{ role: "user", content: "x" }], callbacks().cb, { runTool: async () => (ran++, okText("no")) });
    assert.equal(res.stopReason, "refusal");
    assert.ok(res.refusal);
    assert.equal(ran, 0);
  } finally {
    api.close();
  }
});

test("max_tokens with a tool call is never executed; plain max_tokens is reported", async () => {
  let api = await mockApi([{ blocks: [{ type: "tool_use", id: "t", name: "browser_click", input: { ref: 1 } }], stop: "max_tokens" }]);
  try {
    let ran = 0;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
    const res = await turn(api, messages, callbacks().cb, { messages, runTool: async () => (ran++, okText("no")) });
    assert.equal(ran, 0);
    assert.match(res.truncated ?? "", /cut off/);
    assert.equal(messages.length, 1, "the truncated tool call is not added to the history");
  } finally {
    api.close();
  }
  api = await mockApi([{ blocks: [{ type: "text", text: "long answ" }], stop: "max_tokens" }]);
  try {
    const res = await turn(api, [{ role: "user", content: "x" }], callbacks().cb);
    assert.match(res.truncated ?? "", /output limit/);
  } finally {
    api.close();
  }
});

test("abort during a tool leaves a valid history: every tool_use gets a result", async () => {
  const api = await mockApi([{ blocks: [{ type: "tool_use", id: "a", name: "browser_click", input: { ref: 1 } }, { type: "tool_use", id: "b", name: "browser_click", input: { ref: 2 } }], stop: "tool_use" }]);
  try {
    const ctrl = new AbortController();
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
    const res = await turn(api, messages, callbacks().cb, {
      messages,
      signal: ctrl.signal,
      runTool: async () => {
        ctrl.abort();
        return okText("first finished");
      },
    });
    assert.equal(res.aborted, true);
    const last = messages[messages.length - 1] as Anthropic.MessageParam & { content: Anthropic.ToolResultBlockParam[] };
    assert.equal(last.role, "user");
    assert.deepEqual(last.content.map((b) => b.tool_use_id), ["a", "b"]);
    assert.equal(last.content[1].is_error, true);
    assert.equal(api.requests.length, 1, "no further model call after the abort");
  } finally {
    api.close();
  }
});

test("abort while the model is streaming ends the turn quietly", async () => {
  const api = await mockApi([{ blocks: [], stop: "end_turn", stall: true }]);
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 150);
    const res = await turn(api, [{ role: "user", content: "x" }], callbacks().cb, { signal: ctrl.signal });
    assert.equal(res.aborted, true);
  } finally {
    api.close();
  }
});

test("tool errors and unknown tools come back as error results; the loop continues", async () => {
  const api = await mockApi([
    { blocks: [{ type: "tool_use", id: "a", name: "browser_click", input: { ref: 1 } }, { type: "tool_use", id: "b", name: "nope", input: {} }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "sorry" }], stop: "end_turn" },
  ]);
  try {
    const { cb, log } = callbacks();
    await turn(api, [{ role: "user", content: "x" }], cb, { runTool: async () => { throw new Error("element gone"); } });
    assert.ok(log.includes("result:ERR element gone"));
    assert.ok(log.includes('result:ERR Unknown tool "nope".'));
    assert.equal(api.requests[1].messages[2].content.length, 2);
  } finally {
    api.close();
  }
});

test("older models get no thinking or effort parameters", async () => {
  const api = await mockApi([{ blocks: [{ type: "text", text: "hi" }], stop: "end_turn" }]);
  try {
    await turn(api, [{ role: "user", content: "x" }], callbacks().cb, { model: "claude-haiku-4-5", traits: modelTraits("claude-haiku-4-5") });
    assert.equal(api.requests[0].thinking, undefined);
    assert.equal(api.requests[0].output_config, undefined);
  } finally {
    api.close();
  }
  assert.deepEqual(modelTraits("claude-opus-5-5"), { thinking: true, effort: true, maxInput: undefined });
  assert.equal(effortFor({ thinking: true, effort: true }, "max"), "high", "no level list known → default low/medium/high, clamped down");
  assert.equal(effortFor({ thinking: true, effort: true, efforts: ["low", "medium"] }, "xhigh"), "medium", "nearest supported level below the request");
  const info = { capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { supported: true, medium: { supported: true } } }, max_input_tokens: 1000000 } as unknown as Anthropic.ModelInfo;
  assert.deepEqual(modelTraits("claude-x", info), { thinking: true, effort: true, efforts: ["medium"], maxInput: 1000000 });
});

test("compactHistory asks for a summary without tools being callable", async () => {
  const api = await mockApi([{ blocks: [{ type: "text", text: "Summary: the user ordered a Large pizza for Zoe on the pizza page and got a confirmation." }], stop: "end_turn" }]);
  try {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "text", text: "b" }] }];
    const summary = await compactHistory({ client: api.client(), model: "claude-opus-5-5", traits: { thinking: true, effort: true }, effort: "medium", system: "SYS", tools: TOOLS, messages, signal: new AbortController().signal });
    assert.match(summary, /^Summary: the user ordered a Large pizza/);
    assert.deepEqual(api.requests[0].tool_choice, { type: "none" });
    assert.equal(api.requests[0].messages.length, 3);
    assert.equal(messages.length, 2, "the caller's history is untouched");
  } finally {
    api.close();
  }
});

test("errors turn into actionable messages", async () => {
  const cases: Array<[number, string, RegExp, boolean]> = [
    [401, "authentication_error", /key was rejected/, true],
    [403, "permission_error", /isn't allowed/, true],
    [400, "invalid_request_error", /rejected the request/, false],
  ];
  for (const [status, errorType, re, auth] of cases) {
    const api = await mockApi([{ blocks: [], stop: "end_turn", status, errorType }]);
    try {
      await turn(api, [{ role: "user", content: "x" }], callbacks().cb).then(
        () => assert.fail("should have thrown"),
        (e) => {
          const d = describeError(e);
          assert.match(d.message, re);
          assert.equal(!!d.authFailed, auth);
        }
      );
    } finally {
      api.close();
    }
  }
  const dead = new Anthropic({ apiKey: "k", baseURL: "http://127.0.0.1:1", maxRetries: 0 });
  await dead.messages.create({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }] }).catch((e) => assert.match(describeError(e).message, /reach the API/));
});

test("repairHistory closes tool calls left open by a closed panel", () => {
  const msgs: Anthropic.MessageParam[] = [
    { role: "user", content: "x" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "browser_click", input: {} }] },
  ];
  repairHistory(msgs);
  assert.equal(msgs.length, 3);
  assert.equal((msgs[2].content as Anthropic.ToolResultBlockParam[])[0].tool_use_id, "t1");
  repairHistory(msgs); // idempotent
  assert.equal(msgs.length, 3);
});

// ---- storage ---------------------------------------------------------------------

function memoryKv(): KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, structuredClone(v))),
    remove: async (keys) => void keys.forEach((k) => data.delete(k)),
  };
}

test("ConvStore lists from the index without reading chats, sorts pinned first, caps the unpinned tail", async () => {
  const kv = memoryKv();
  const store = new ConvStore(kv);
  await store.load();
  for (let i = 0; i < 55; i++) {
    await store.save({ id: `c${i}`, title: `chat ${i}`, time: i + 1, messages: [{ kind: "user", text: `hello ${i}` }], apiMessages: [{ role: "user", content: "x".repeat(50) }] });
    if (i === 0) await store.patch("c0", { pinned: true }); // pinned before the cap starts dropping the oldest
  }
  const list = store.list();
  assert.equal(list[0].id, "c0", "pinned chat kept and first even though it is the oldest");
  assert.equal(list.length, 51, "50 unpinned + 1 pinned");
  assert.equal(list[1].id, "c54");
  assert.equal(list[1].preview, "hello 54");
  assert.ok(!kv.data.has("agentConv:c1"), "dropped chats are removed from storage");

  // a fresh store (new panel) sees the same list and loads a chat on demand
  const again = new ConvStore(kv);
  await again.load();
  assert.equal(again.list().length, 51);
  assert.equal((await again.get("c54"))?.title, "chat 54");
  await again.remove("c54");
  assert.equal((await again.get("c54")), undefined);
});

// ---- the panel protocol ----------------------------------------------------------

function host(api: Awaited<ReturnType<typeof mockApi>>, over: Partial<LocalHostDeps> = {}, kv = memoryKv()) {
  const posted: any[] = [];
  const toolCalls: Array<{ name: string; input: any }> = [];
  const deps: LocalHostDeps = {
    post: (m) => posted.push(m),
    kv,
    loadSettings: async () => ({ apiKey: "sk-test", baseUrl: api.url }),
    createClient: (s) => new Anthropic({ apiKey: s.apiKey, baseURL: s.baseUrl, maxRetries: 0 }),
    tools: TOOLS,
    system: "SYS",
    runTool: async (name, input) => (toolCalls.push({ name, input }), okText(`ran ${name}`)),
    openSettings: () => posted.push({ type: "__openSettings" }),
    ...over,
  };
  const h = new LocalHost(deps);
  const types = () => posted.map((m) => m.type);
  const waitFor = async (pred: () => boolean, ms = 4000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error("timed out; got " + JSON.stringify(types()));
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { h, posted, types, waitFor, toolCalls, kv };
}

test("panel protocol: ready → prompt streams text and tools → saved chat reopens", async () => {
  const api = await mockApi([
    { blocks: [{ type: "text", text: "Checking the page." }, { type: "tool_use", id: "t1", name: "browser_read_page", input: {} }], stop: "tool_use", usage: { input_tokens: 500, output_tokens: 30 } },
    { blocks: [{ type: "text", text: "It is a pizza page." }], stop: "end_turn", usage: { input_tokens: 700, output_tokens: 10 } },
  ]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    assert.ok(t.types().includes("auth") && t.posted.find((m) => m.type === "auth").ok === true);
    assert.ok(t.types().includes("model") && t.types().includes("mode") && t.types().includes("conversations"));
    const modes = t.posted.find((m) => m.type === "mode").options.map((o: any) => o.value);
    assert.deepEqual(modes, ["agent", "careful", "ask"]);

    t.posted.length = 0;
    void t.h.handle({ type: "prompt", text: "what is this page?", attachments: [] });
    await t.waitFor(() => t.types().includes("idle"));

    const types = t.types();
    assert.ok(types.indexOf("started") >= 0 && types.indexOf("started") < types.indexOf("text"), "started precedes the streamed text");
    assert.ok(types.indexOf("tool") > types.indexOf("text") && types.indexOf("toolResult") > types.indexOf("tool") && types.lastIndexOf("text") > types.indexOf("toolResult"), types.join(","));
    assert.equal(t.posted.filter((m) => m.type === "text").map((m) => m.text).join(""), "Checking the page.It is a pizza page.");
    assert.ok(types.includes("result") && types.includes("contextUsage"));
    assert.equal(t.toolCalls[0].name, "browser_read_page");
    const ctx = t.posted.filter((m) => m.type === "contextUsage").pop().info;
    assert.equal(ctx.used, 700);
    assert.equal(ctx.max, 1_000_000);
    assert.ok(types.includes("runState") && t.posted.filter((m) => m.type === "runState").pop().running === false);

    // persisted: a new host (panel reopened) restores the chat and can continue it
    const t2 = host(api, {}, t.kv);
    await t2.h.handle({ type: "ready" });
    const loaded = t2.posted.find((m) => m.type === "loadConversation");
    assert.ok(loaded, "last chat restored");
    assert.deepEqual(loaded.messages.map((m: any) => m.kind), ["user", "assistant", "tool", "assistant", "status"]);
    assert.equal(loaded.messages[2].tool.result, "ran browser_read_page");
    t2.posted.length = 0;
    void t2.h.handle({ type: "prompt", text: "and now?" });
    await t2.waitFor(() => t2.types().includes("idle"));
    const last = api.requests[api.requests.length - 1];
    assert.equal(last.messages.length, 5, "user, assistant(tool), tool_result, assistant, user");
    assert.equal(last.messages[0].content[0].text, "what is this page?");
  } finally {
    api.close();
  }
});

test("panel protocol: careful mode raises an approval card and the answer decides", async () => {
  const api = await mockApi([
    { blocks: [{ type: "tool_use", id: "t1", name: "browser_click", input: { ref: 2 } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" },
  ]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    await t.h.handle({ type: "setMode", mode: "careful" });
    void t.h.handle({ type: "prompt", text: "click it" });
    await t.waitFor(() => t.types().includes("approval"));
    const card = t.posted.find((m) => m.type === "approval");
    assert.equal(card.toolName, "browser_click");
    assert.equal(t.toolCalls.length, 0, "nothing ran before the answer");
    await t.h.handle({ type: "approvalResponse", id: card.id, approved: true });
    await t.waitFor(() => t.types().includes("idle"));
    assert.equal(t.toolCalls.length, 1);
    assert.ok(t.posted.some((m) => m.type === "approvalResolved" && m.approved === true));
  } finally {
    api.close();
  }
});

test("panel protocol: Stop while an approval is pending ends the run and closes the card", async () => {
  const api = await mockApi([{ blocks: [{ type: "tool_use", id: "t1", name: "browser_click", input: { ref: 2 } }], stop: "tool_use" }]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    await t.h.handle({ type: "setMode", mode: "careful" });
    void t.h.handle({ type: "prompt", text: "click it" });
    await t.waitFor(() => t.types().includes("approval"));
    await t.h.handle({ type: "interrupt" });
    await t.waitFor(() => t.types().includes("idle"));
    assert.equal(t.toolCalls.length, 0);
    assert.ok(t.posted.some((m) => m.type === "approvalResolved" && m.approved === false));
    // and the saved history is still valid for the next turn (the save lands just after "idle")
    const saved = () => [...t.kv.data.entries()].find(([k]) => k.startsWith("agentConv:"))?.[1] as any;
    await t.waitFor(() => (saved()?.apiMessages?.length ?? 0) >= 3);
    const conv = saved();
    const lastMsg = conv.apiMessages[conv.apiMessages.length - 1];
    assert.equal(lastMsg.role, "user");
    assert.equal(lastMsg.content[0].type, "tool_result");
  } finally {
    api.close();
  }
});

test("panel protocol: no API key → setup banner, an error, and no API call", async () => {
  const api = await mockApi([{ blocks: [{ type: "text", text: "x" }], stop: "end_turn" }]);
  try {
    const t = host(api, { loadSettings: async () => ({}) });
    await t.h.handle({ type: "ready" });
    assert.equal(t.posted.find((m) => m.type === "auth").ok, false);
    assert.match(t.posted.find((m) => m.type === "auth").text, /API key/);
    t.posted.length = 0;
    await t.h.handle({ type: "prompt", text: "hi" });
    assert.ok(t.types().includes("error") && t.types().includes("idle"));
    assert.equal(api.requests.length, 0);
    await t.h.handle({ type: "login" });
    assert.ok(t.posted.some((m) => m.type === "__openSettings"), "the login button opens the settings page");
  } finally {
    api.close();
  }
});

test("panel protocol: a rejected key shows the banner again", async () => {
  const api = await mockApi([{ blocks: [], stop: "end_turn", status: 401, errorType: "authentication_error" }]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    t.posted.length = 0;
    void t.h.handle({ type: "prompt", text: "hi" });
    await t.waitFor(() => t.types().includes("idle"));
    assert.ok(t.posted.some((m) => m.type === "error" && /rejected/.test(m.message)));
    assert.ok(t.posted.some((m) => m.type === "auth" && m.ok === false && /rejected/.test(m.text)));
  } finally {
    api.close();
  }
});

test("panel protocol: image attachments reach the model; upload_file resolves the attachment", async () => {
  const api = await mockApi([
    { blocks: [{ type: "tool_use", id: "u1", name: "browser_upload_file", input: { ref: 4, path: "PLACEHOLDER" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "uploaded" }], stop: "end_turn" },
  ]);
  try {
    const t = host(api, { tools: [...TOOLS, { name: "browser_upload_file", readOnly: false, description: "up", input_schema: { type: "object", properties: {} } }] });
    await t.h.handle({ type: "ready" });
    const png = "data:image/png;base64,iVBORw0KGgo=";
    await t.h.handle({ type: "uploadAttachment", name: "cat.png", dataUrl: png });
    const chip = t.posted.find((m) => m.type === "attached");
    assert.equal(chip.name, "cat.png");
    assert.equal(chip.isImage, true);
    // the model calls upload with the id it was given
    (api as any).requests.length = 0;
    void t.h.handle({ type: "prompt", text: "put my picture in the form", attachments: [chip.path] });
    await t.waitFor(() => t.toolCalls.length > 0 || t.types().includes("idle"));
    await t.waitFor(() => t.types().includes("idle"));
    const first = api.requests[0].messages[0].content;
    assert.equal(first[0].type, "image");
    assert.equal(first[0].source.media_type, "image/png");
    assert.match(first[1].text, new RegExp(chip.path));
    // (the scripted tool call used a placeholder id, so the host must refuse it rather than upload something)
    assert.match(t.posted.find((m) => m.type === "toolResult").content, /not one of the user's attached files/);
    assert.equal(t.toolCalls.length, 0);
  } finally {
    api.close();
  }
});

test("panel protocol: conversations can be renamed, pinned, switched and deleted; new chat clears", async () => {
  const api = await mockApi([{ blocks: [{ type: "text", text: "a" }], stop: "end_turn" }]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    void t.h.handle({ type: "prompt", text: "first chat" });
    await t.waitFor(() => t.types().includes("idle"));
    await t.h.handle({ type: "newChat" });
    assert.ok(t.types().includes("clear"));
    t.posted.length = 0;
    void t.h.handle({ type: "prompt", text: "second chat" });
    await t.waitFor(() => t.types().includes("idle"));
    const list = () => t.posted.filter((m) => m.type === "conversations").pop().items;
    assert.equal(list().length, 2);
    const first = list().find((c: any) => c.title === "first chat");
    await t.h.handle({ type: "renameConversation", id: first.id, title: "Renamed" });
    await t.h.handle({ type: "pinConversation", id: first.id, pinned: true });
    assert.deepEqual(list().map((c: any) => c.title), ["Renamed", "second chat"]);
    t.posted.length = 0;
    await t.h.handle({ type: "openConversation", id: first.id });
    assert.equal(t.posted.find((m) => m.type === "loadConversation").messages[0].text, "first chat");
    await t.h.handle({ type: "deleteConversation", id: first.id });
    assert.deepEqual(list().map((c: any) => c.title), ["second chat"]);
    assert.ok(t.types().includes("clear"));
  } finally {
    api.close();
  }
});

test("panel protocol: /compact replaces the whole history with a summary and the next turn builds on it", async () => {
  const api = await mockApi([
    { blocks: [{ type: "text", text: "first answer" }], stop: "end_turn" },
    { blocks: [{ type: "text", text: "SUMMARY TEXT — the user wanted a long task done; step one is finished and step two remains." }], stop: "end_turn" },
    { blocks: [{ type: "text", text: "after compaction" }], stop: "end_turn" },
  ]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    void t.h.handle({ type: "prompt", text: "long task" });
    await t.waitFor(() => t.types().includes("idle"));
    t.posted.length = 0;
    void t.h.handle({ type: "prompt", text: "/compact" });
    await t.waitFor(() => t.types().includes("idle"));
    assert.ok(t.posted.some((m) => m.type === "system" && m.subtype === "compact_boundary"));
    t.posted.length = 0;
    void t.h.handle({ type: "prompt", text: "continue" });
    await t.waitFor(() => t.types().includes("idle"));
    const last = api.requests[2].messages;
    assert.equal(last.length, 3, "summary, acknowledgement, new prompt");
    assert.match(last[0].content, /SUMMARY TEXT/);
    assert.equal(last[2].content[0].text, "continue");
  } finally {
    api.close();
  }
});

test("panel protocol: the model list comes from the Models API", async () => {
  const api = await mockApi([{ blocks: [{ type: "text", text: "x" }], stop: "end_turn" }]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    await t.waitFor(() => t.posted.filter((m) => m.type === "model").length >= 2);
    const opts = t.posted.filter((m) => m.type === "model").pop().options;
    assert.deepEqual(opts.map((o: any) => o.value), ["claude-opus-5-5"]);
    assert.equal(opts[0].title, "1,000K context");
    assert.equal(t.posted.filter((m) => m.type === "model")[0].model, "claude-opus-5-5", "default model");
  } finally {
    api.close();
  }
});

// ---- fixes from the review of this feature --------------------------------------------

test("blank tool output never becomes an empty text block; lone surrogates are repaired", async () => {
  const api = await mockApi([
    { blocks: [{ type: "tool_use", id: "t1", name: "browser_read_page", input: {} }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" },
  ]);
  try {
    await turn(api, [{ role: "user", content: "x" }], callbacks().cb, { runTool: async () => ({ content: [{ type: "text", text: "" }, { type: "text", text: "   " }] }) });
    const result = api.requests[1].messages[2].content[0];
    assert.deepEqual(result.content, [{ type: "text", text: "(no output)" }], "the API rejects empty text blocks; one blank tool result would poison the chat");
  } finally {
    api.close();
  }
  assert.equal(wellFormed("ok \ud83d"), "ok \ufffd");
  assert.equal(wellFormed("\ude00 ok"), "\ufffd ok");
  assert.equal(wellFormed("fine 😀"), "fine 😀");
});

test("an empty end_turn reply and a refused turn are not kept in the history", async () => {
  let api = await mockApi([{ blocks: [], stop: "end_turn" }]);
  try {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
    await turn(api, messages, callbacks().cb, { messages });
    assert.equal(messages.length, 1, "no empty assistant message appended");
  } finally {
    api.close();
  }
  api = await mockApi([{ blocks: [{ type: "thinking", thinking: "part", signature: "" }, { type: "text", text: "I can't" }], stop: "refusal" }]);
  try {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
    const res = await turn(api, messages, callbacks().cb, { messages });
    assert.equal(res.stopReason, "refusal");
    assert.equal(messages.length, 1, "a refused turn (partial, unsigned thinking) would fail every later request");
  } finally {
    api.close();
  }
});

test("a full context window stops the turn without running its tools or keeping it", async () => {
  const api = await mockApi([{ blocks: [{ type: "tool_use", id: "t", name: "browser_click", input: { ref: 1 } }], stop: "model_context_window_exceeded" }]);
  try {
    let ran = 0;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
    const res = await turn(api, messages, callbacks().cb, { messages, runTool: async () => (ran++, okText("no")) });
    assert.equal(ran, 0);
    assert.match(res.truncated ?? "", /Compact/);
    assert.equal(messages.length, 1);
  } finally {
    api.close();
  }
});

test("Stop reaches a tool that is still running; the mode can change mid-run", async () => {
  const api = await mockApi([{ blocks: [{ type: "tool_use", id: "a", name: "browser_click", input: { ref: 1 } }], stop: "tool_use" }]);
  try {
    const ctrl = new AbortController();
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
    setTimeout(() => ctrl.abort(), 100);
    const t0 = Date.now();
    const res = await turn(api, messages, callbacks().cb, { messages, signal: ctrl.signal, runTool: () => new Promise(() => {}) /* a page that never answers */ });
    assert.equal(res.aborted, true);
    assert.ok(Date.now() - t0 < 2000, "did not wait for the hung tool");
    const last = messages[messages.length - 1] as Anthropic.MessageParam & { content: Anthropic.ToolResultBlockParam[] };
    assert.equal(last.content[0].tool_use_id, "a", "history stays valid");
    assert.equal(last.content[0].is_error, true);
  } finally {
    api.close();
  }
  // mode read before each tool call
  const api2 = await mockApi([
    { blocks: [{ type: "tool_use", id: "a", name: "browser_click", input: { ref: 1 } }, { type: "tool_use", id: "b", name: "browser_click", input: { ref: 2 } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "done" }], stop: "end_turn" },
  ]);
  try {
    let mode: "agent" | "ask" = "agent";
    const ran: string[] = [];
    await turn(api2, [{ role: "user", content: "x" }], callbacks().cb, { mode: () => mode, runTool: async (n, i) => (ran.push(String((i as any).ref)), (mode = "ask"), okText("clicked")) });
    assert.deepEqual(ran, ["1"], "after switching to Ask, the second click in the same turn was refused");
  } finally {
    api2.close();
  }
});

test("compaction works on a history that no longer fits: the summarizer sees a slim copy", async () => {
  const api = await mockApi([{ blocks: [{ type: "text", text: "Summary of a long browsing session with many pages, forms and decisions recorded here." }], stop: "end_turn" }]);
  try {
    const big = "y".repeat(200_000);
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "S" }, { type: "tool_use", id: "t1", name: "browser_screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD".repeat(50_000) } }, { type: "text", text: big }] }] },
    ];
    const before = JSON.stringify(messages);
    await compactHistory({ client: api.client(), model: "claude-opus-5-5", traits: { thinking: true, effort: true }, effort: "medium", system: "SYS", tools: TOOLS, messages, signal: new AbortController().signal });
    const sent = JSON.stringify(api.requests[0].messages);
    assert.ok(!/"type":"image"/.test(sent) && !/thinking/.test(sent) && sent.length < 5000, "no image, no thinking, clipped text: " + sent.length);
    assert.equal(JSON.stringify(messages), before, "the real history was not touched");
    assert.equal(slimForSummary([{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "S" }] }]).length, 0);
  } finally {
    api.close();
  }
  // a refused or cut-off summary must never replace the history
  for (const stop of ["refusal", "max_tokens"] as const) {
    const api2 = await mockApi([{ blocks: [{ type: "text", text: "A perfectly long enough summary text, but the turn did not end normally." }], stop }]);
    try {
      await assert.rejects(compactHistory({ client: api2.client(), model: "claude-opus-5-5", traits: { thinking: true, effort: true }, effort: "medium", system: "SYS", tools: TOOLS, messages: [{ role: "user", content: "a" }], signal: new AbortController().signal }), /nothing was changed/);
    } finally {
      api2.close();
    }
  }
});

test("the requested effort is clamped to a level the model supports", async () => {
  const api = await mockApi([{ blocks: [{ type: "text", text: "x" }], stop: "end_turn" }]);
  try {
    await turn(api, [{ role: "user", content: "x" }], callbacks().cb, { effort: "max", traits: { thinking: true, effort: true, efforts: ["low", "medium", "high"] } });
    assert.deepEqual(api.requests[0].output_config, { effort: "high" });
  } finally {
    api.close();
  }
});

test("panel: a message the API rejects is taken back out of the history, so the chat isn't dead afterwards", async () => {
  const api = await mockApi([
    { blocks: [], stop: "end_turn", status: 400, errorType: "invalid_request_error", message: "messages.0.content.0.image.source.base64: image exceeds 5 MB" },
    { blocks: [{ type: "text", text: "fine now" }], stop: "end_turn" },
  ]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    void t.h.handle({ type: "prompt", text: "look at this" });
    await t.waitFor(() => t.types().includes("idle"));
    assert.ok(t.posted.some((m) => m.type === "error" && /rejected the request/.test(m.message)));
    t.posted.length = 0;
    void t.h.handle({ type: "prompt", text: "never mind, hello" });
    await t.waitFor(() => t.types().includes("idle"));
    assert.equal(api.requests[1].messages.length, 1, "the rejected turn is not replayed");
    assert.equal(api.requests[1].messages[0].content[0].text, "never mind, hello");
    assert.ok(t.posted.some((m) => m.type === "text"));
  } finally {
    api.close();
  }
});

test("panel: two messages sent back to back start one run, not two on the same history", async () => {
  const api = await mockApi([{ blocks: [{ type: "text", text: "one" }], stop: "end_turn" }]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    t.posted.length = 0;
    void t.h.handle({ type: "prompt", text: "first" });
    void t.h.handle({ type: "prompt", text: "second" });
    await t.waitFor(() => t.types().includes("idle"));
    await tick(100);
    assert.equal(api.requests.length, 1, "only one request went to the API");
    assert.equal(t.posted.filter((m) => m.type === "notice" && /already running/.test(m.message)).length, 1);
    const ids = t.posted.filter((m) => m.type === "conversations").pop().items.length;
    assert.equal(ids, 1, "one chat, not two");
  } finally {
    api.close();
  }
});

test("panel: deleting a running chat does not bring it back when the run ends", async () => {
  const api = await mockApi([{ blocks: [], stop: "end_turn", stall: true }]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    void t.h.handle({ type: "prompt", text: "long job" });
    await t.waitFor(() => t.types().includes("started"));
    const id = t.posted.filter((m) => m.type === "conversations").pop().activeId;
    assert.ok(id, "the panel is told which chat is active during the first turn");
    await t.h.handle({ type: "deleteConversation", id });
    await t.waitFor(() => t.posted.some((m) => m.type === "runState" && m.convId === id && m.running === false));
    await tick(200);
    assert.deepEqual((t.kv.data.get("agentConvIndex") as any[]).map((e) => e.id), [], "not in the index");
    assert.ok(!t.kv.data.has(`agentConv:${id}`), "not in storage");
    assert.deepEqual(t.posted.filter((m) => m.type === "conversations").pop().items, []);
  } finally {
    api.close();
  }
});

test("panel: coming back to a chat that is waiting for approval shows Stop and the approval again", async () => {
  const api = await mockApi([
    { blocks: [{ type: "tool_use", id: "t1", name: "browser_click", input: { ref: 2 } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "done" }], stop: "end_turn" },
  ]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    await t.h.handle({ type: "setMode", mode: "careful" });
    void t.h.handle({ type: "prompt", text: "click it" });
    await t.waitFor(() => t.types().includes("approval"));
    const first = t.posted.find((m) => m.type === "approval");
    const chat = t.posted.filter((m) => m.type === "conversations").pop().activeId;
    await t.h.handle({ type: "newChat" });
    t.posted.length = 0;
    await t.h.handle({ type: "openConversation", id: chat });
    assert.ok(t.posted.some((m) => m.type === "runState" && m.running === true && m.convId === chat), "Stop is available again");
    assert.ok(t.posted.some((m) => m.type === "approval" && m.id === first.id), "the pending approval is shown again");
    await t.h.handle({ type: "approvalResponse", id: first.id, approved: true });
    await t.waitFor(() => t.types().includes("idle"));
    assert.ok(t.posted.filter((m) => m.type === "loadConversation").length >= 2, "the finished chat is reloaded so its cards are live-correct");
  } finally {
    api.close();
  }
});

test("panel: tool cards left spinning by a closed panel are settled when the chat is reopened", async () => {
  const api = await mockApi([{ blocks: [{ type: "text", text: "x" }], stop: "end_turn" }]);
  try {
    const kv = memoryKv();
    kv.data.set("agentConvIndex", [{ id: "c1", time: 1, pinned: false, title: "old", preview: "" }]);
    kv.data.set("agentConv:c1", { id: "c1", title: "old", time: 1, messages: [{ kind: "user", text: "hi" }, { kind: "tool", text: "🔧 browser_click", tool: { name: "browser_click", input: { ref: 1 } } }], apiMessages: [] });
    kv.data.set("agentLocalPrefs", { model: "claude-opus-5-5", mode: "agent", activeId: "c1" });
    const t = host(api, {}, kv);
    await t.h.handle({ type: "ready" });
    const loaded = t.posted.find((m) => m.type === "loadConversation");
    assert.match(loaded.messages[1].tool.result, /Interrupted/);
    assert.equal(loaded.messages[1].tool.isError, true);
  } finally {
    api.close();
  }
});

test("panel: files the API can't take are refused up front, not stored in the chat", async () => {
  const api = await mockApi([{ blocks: [{ type: "text", text: "x" }], stop: "end_turn" }]);
  try {
    const t = host(api);
    await t.h.handle({ type: "ready" });
    t.posted.length = 0;
    await t.h.handle({ type: "uploadAttachment", name: "huge.png", dataUrl: "data:image/png;base64," + "A".repeat(6_000_000) }); // ≈4.5 MB
    assert.ok(t.posted.some((m) => m.type === "notice" && /too large for the model/.test(m.message)));
    assert.ok(!t.posted.some((m) => m.type === "attached"));
    await t.h.handle({ type: "uploadAttachment", name: "ok.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" });
    assert.ok(t.posted.some((m) => m.type === "attached"));
  } finally {
    api.close();
  }
});

test("panel: approval cards say what the element is, not just its ref number", async () => {
  const api = await mockApi([
    { blocks: [{ type: "tool_use", id: "t1", name: "browser_click", input: { ref: 7 } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" },
  ]);
  try {
    const t = host(api, { describeCall: (name, input) => (input.ref === 7 ? '[7] button "Place order"' : undefined) });
    await t.h.handle({ type: "ready" });
    await t.h.handle({ type: "setMode", mode: "careful" });
    void t.h.handle({ type: "prompt", text: "order" });
    await t.waitFor(() => t.types().includes("approval"));
    const card = t.posted.find((m) => m.type === "approval");
    assert.equal(card.input.element, '[7] button "Place order"');
    assert.equal(card.input.ref, 7);
    await t.h.handle({ type: "approvalResponse", id: card.id, approved: false });
    await t.waitFor(() => t.types().includes("idle"));
  } finally {
    api.close();
  }
});

test("free trial: the model moves to one the gateway offers; a rejected trial token is dropped, not shown as a bad key", async () => {
  const api = await mockApi([{ blocks: [], stop: "end_turn", status: 401, errorType: "authentication_error", message: "Unknown trial token. Reopen the extension settings and choose the free trial again." }], { models: ["claude-haiku-4-5", "claude-sonnet-5-5"] });
  try {
    let forgot = 0;
    const t = host(api, { loadSettings: async () => ({ apiKey: "trl_abc", baseUrl: api.url, trial: true }), forgetTrialToken: () => void forgot++ });
    await t.h.handle({ type: "ready" });
    assert.ok(t.posted.some((m) => m.type === "info" && /Free trial/.test(m.text)), "the user is told requests go through the trial service");
    t.posted.length = 0;
    void t.h.handle({ type: "prompt", text: "hi" });
    await t.waitFor(() => t.types().includes("idle"));
    assert.equal(api.requests[0].model, "claude-haiku-4-5", "the default Opus isn't in the trial list");
    assert.equal(forgot, 1, "token forgotten so the next message registers a fresh one");
    assert.ok(t.posted.some((m) => m.type === "error" && /Unknown trial token/.test(m.message)));
    assert.ok(!t.posted.some((m) => m.type === "auth"), "no 'API key rejected' banner for a trial token");
  } finally {
    api.close();
  }
});

test("a chat saved under a different prompt/tool set drops its old thinking blocks once", async () => {
  const api = await mockApi([
    { blocks: [{ type: "thinking", thinking: "hm", signature: "SIG" }, { type: "text", text: "first" }], stop: "end_turn" },
    { blocks: [{ type: "text", text: "second" }], stop: "end_turn" },
  ]);
  try {
    const kv = memoryKv();
    const a = host(api, { promptId: "A" }, kv);
    await a.h.handle({ type: "ready" });
    void a.h.handle({ type: "prompt", text: "one" });
    await a.waitFor(() => a.types().includes("idle"));
    await tick(150);
    const b = host(api, { promptId: "B" }, kv);
    await b.h.handle({ type: "ready" });
    void b.h.handle({ type: "prompt", text: "two" });
    await b.waitFor(() => b.types().includes("idle"));
    const sent = JSON.stringify(api.requests[1].messages);
    assert.ok(!/thinking/.test(sent), "old thinking blocks are not replayed under a changed prompt");
    assert.match(sent, /first/, "the visible conversation is kept");
    const only: Anthropic.MessageParam[] = [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] }];
    stripThinking(only);
    assert.equal((only[0].content as Anthropic.ContentBlockParam[])[0].type, "text", "a turn that was only thinking keeps a valid placeholder");
  } finally {
    api.close();
  }
});
