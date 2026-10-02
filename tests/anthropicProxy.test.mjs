// Integration tests for proxy/anthropic-openai-proxy.mjs: spawn the proxy in
// front of a fake OpenAI-compatible upstream and check the Anthropic SSE it emits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

const PROXY = fileURLToPath(new URL("../proxy/anthropic-openai-proxy.mjs", import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** An upstream that answers every request with the given SSE `data:` chunks. */
function fakeUpstream(chunks) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const c of chunks) res.write(`data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`);
        res.end();
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function startProxy(upstreamPort) {
  const port = await freePort();
  const cp = spawn(process.execPath, [PROXY], {
    env: { ...process.env, PORT: String(port), UPSTREAM: `http://127.0.0.1:${upstreamPort}/v1`, UPSTREAM_MODEL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("proxy did not start")), 5000);
    cp.stdout.on("data", (d) => {
      if (String(d).includes("proxy on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    cp.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited early (${code})`));
    });
  });
  return { port, cp };
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json" } },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (buf += d));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

const sseEvents = (body) =>
  body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));

const STREAM_REQ = { model: "local", stream: true, max_tokens: 64, messages: [{ role: "user", content: "hi" }] };

test("proxy: text after a tool call streams into its own block index", { timeout: 15000 }, async () => {
  const up = await fakeUpstream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"a":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
    { choices: [{ delta: { content: "done" }, finish_reason: "tool_calls" }] },
    "[DONE]",
  ]);
  const { port, cp } = await startProxy(up.address().port);
  try {
    const { status, body } = await request(port, "POST", "/v1/messages", STREAM_REQ);
    assert.equal(status, 200);
    const ev = sseEvents(body);
    const starts = ev.filter((e) => e.type === "content_block_start").map((e) => [e.index, e.content_block.type]);
    assert.deepEqual(starts, [[0, "tool_use"], [1, "text"]]);
    const text = ev.filter((e) => e.delta?.type === "text_delta");
    assert.ok(text.length && text.every((e) => e.index === 1), "text deltas target the text block, not the tool block");
    const json = ev.filter((e) => e.delta?.type === "input_json_delta");
    assert.ok(json.every((e) => e.index === 0));
    assert.equal(json.map((e) => e.delta.partial_json).join(""), '{"a":1}');
    const stops = ev.filter((e) => e.type === "content_block_stop").map((e) => e.index).sort();
    assert.deepEqual(stops, [0, 1]);
    assert.equal(ev.find((e) => e.type === "message_delta").delta.stop_reason, "tool_use");
  } finally {
    cp.kill();
    up.close();
  }
});

test("proxy: text first, then a tool call — text is block 0 and closed before the tool", { timeout: 15000 }, async () => {
  const up = await fakeUpstream([
    { choices: [{ delta: { content: "let me look" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    "[DONE]",
  ]);
  const { port, cp } = await startProxy(up.address().port);
  try {
    const ev = sseEvents((await request(port, "POST", "/v1/messages", STREAM_REQ)).body);
    const starts = ev.filter((e) => e.type === "content_block_start").map((e) => [e.index, e.content_block.type]);
    assert.deepEqual(starts, [[0, "text"], [1, "tool_use"]]);
    assert.ok(ev.filter((e) => e.delta?.type === "text_delta").every((e) => e.index === 0));
    const firstStop = ev.findIndex((e) => e.type === "content_block_stop");
    const toolStart = ev.findIndex((e) => e.content_block?.type === "tool_use");
    assert.equal(ev[firstStop].index, 0);
    assert.ok(firstStop < toolStart, "the text block closes before the tool block opens");
  } finally {
    cp.kill();
    up.close();
  }
});

test("proxy: a malformed request fails that request and the proxy stays up", { timeout: 15000 }, async () => {
  const up = await fakeUpstream(["[DONE]"]);
  const { port, cp } = await startProxy(up.address().port);
  try {
    const bad = await request(port, "POST", "/v1/messages", { model: "local", messages: 5 });
    assert.equal(bad.status, 500);
    assert.match(JSON.parse(bad.body).error.message, /^proxy: /);
    const health = await request(port, "GET", "/health");
    assert.equal(health.status, 200, "the proxy process must survive a bad request");
  } finally {
    cp.kill();
    up.close();
  }
});
