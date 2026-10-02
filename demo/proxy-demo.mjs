// End-to-end test of proxy/anthropic-openai-proxy.mjs WITHOUT a real LM Studio:
// we stand up a FAKE OpenAI-compatible upstream, start the real proxy pointed at
// it, then send Anthropic /v1/messages requests and inspect both translations:
//   (1) Anthropic request  -> OpenAI request   (what the upstream received)
//   (2) OpenAI response     -> Anthropic response (what the proxy returned)
// Covers system prompt, tool definitions, tool_result round-trip, tool_use
// output, stop_reason mapping, and streaming SSE.
import http from "node:http";
import { spawn } from "node:child_process";

const UP_PORT = 9911;
const PROXY_PORT = 9787;
let lastOpenAIReq = null;

// ---- fake OpenAI-compatible upstream ----------------------------------------
const upstream = http.createServer(async (req, res) => {
  const body = await new Promise((r) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
  });
  lastOpenAIReq = JSON.parse(body || "{}");
  if (lastOpenAIReq.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ delta: { content: "Hel" } }] });
    send({ choices: [{ delta: { content: "lo!" } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_s", function: { name: "get_time", arguments: '{"tz"' } }] } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"UTC"}' } }] } }] });
    send({ choices: [{ finish_reason: "tool_calls", delta: {} }] });
    res.write("data: [DONE]\n\n"); res.end();
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-fake-1",
      choices: [{
        finish_reason: "tool_calls",
        message: { content: "It is sunny in Paris.", tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        ] },
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }));
  }
});

const proxyReq = {
  model: "claude-sonnet-4",
  system: "You are concise.",
  max_tokens: 256,
  tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
  messages: [
    { role: "user", content: "Weather in Paris?" },
    { role: "assistant", content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "call_prev", name: "get_weather", input: { city: "Paris" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_prev", content: "sunny 20C" }] },
  ],
};

const post = (port, path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("proxy did not become healthy");
}

await new Promise((r) => upstream.listen(UP_PORT, "127.0.0.1", r));
const proxy = spawn(process.execPath, ["proxy/anthropic-openai-proxy.mjs"], {
  env: { ...process.env, PORT: String(PROXY_PORT), UPSTREAM: `http://127.0.0.1:${UP_PORT}/v1` },
  stdio: "ignore",
});
await waitHealth();

console.log("================ TEST A: non-streaming ================");
const aRes = await (await post(PROXY_PORT, "/v1/messages", proxyReq)).json();
console.log("\n(1) Anthropic req -> OpenAI req the upstream actually received:");
console.log("    roles    :", lastOpenAIReq.messages.map((m) => m.role).join(" → "));
console.log("    system   :", JSON.stringify(lastOpenAIReq.messages[0]));
console.log("    asst call:", JSON.stringify(lastOpenAIReq.messages.find((m) => m.tool_calls)?.tool_calls));
console.log("    toolmsg  :", JSON.stringify(lastOpenAIReq.messages.find((m) => m.role === "tool")));
console.log("    tools    :", JSON.stringify(lastOpenAIReq.tools));
console.log("\n(2) OpenAI resp -> Anthropic resp the proxy returned:");
console.log("    type/role   :", aRes.type, aRes.role);
console.log("    content     :", JSON.stringify(aRes.content));
console.log("    stop_reason :", aRes.stop_reason, "(openai tool_calls → anthropic tool_use)");
console.log("    usage       :", JSON.stringify(aRes.usage));

console.log("\n================ TEST B: streaming SSE ================");
const sRes = await post(PROXY_PORT, "/v1/messages", { ...proxyReq, stream: true });
const text = await sRes.text();
const events = [...text.matchAll(/event: (\w+)/g)].map((m) => m[1]);
let outText = "", toolName = "", toolArgs = "";
for (const block of text.split("\n\n")) {
  const d = block.match(/data: (.+)/)?.[1];
  if (!d) continue;
  const j = JSON.parse(d);
  if (j.delta?.type === "text_delta") outText += j.delta.text;
  if (j.content_block?.type === "tool_use") toolName = j.content_block.name;
  if (j.delta?.type === "input_json_delta") toolArgs += j.delta.partial_json;
}
console.log("    event sequence:", events.join(" → "));
console.log("    reconstructed text :", JSON.stringify(outText));
console.log("    reconstructed tool :", toolName, toolArgs);

console.log("\n================ VERDICT ================");
const ok = {
  "req: system mapped":        lastOpenAIReq.messages[0]?.role === "system",
  "req: tool_result→role:tool": lastOpenAIReq.messages.some((m) => m.role === "tool" && m.content === "sunny 20C"),
  "req: tools→functions":      lastOpenAIReq.tools?.[0]?.type === "function" && lastOpenAIReq.tools[0].function.name === "get_weather",
  "resp: text block":          aRes.content?.[0]?.type === "text",
  "resp: tool_use block":      aRes.content?.some((b) => b.type === "tool_use" && b.name === "get_weather"),
  "resp: stop_reason=tool_use": aRes.stop_reason === "tool_use",
  "stream: full event seq":    ["message_start", "content_block_start", "content_block_delta", "message_stop"].every((e) => events.includes(e)),
  "stream: text rebuilt":      outText === "Hello!",
  "stream: tool args rebuilt": toolArgs === '{"tz":"UTC"}',
};
for (const [k, v] of Object.entries(ok)) console.log(`  ${v ? "✅" : "❌"} ${k}`);
console.log(`\nALL PASS: ${Object.values(ok).every(Boolean)}`);

proxy.kill(); upstream.close();
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
