// Anthropic <-> OpenAI translation proxy.
//
// The Claude Agent SDK speaks the Anthropic Messages API. Local runtimes
// (LM Studio, llama.cpp, Ollama) speak the OpenAI Chat Completions API. This
// proxy accepts POST /v1/messages, translates to /v1/chat/completions, calls
// the local server, and translates the (streaming) response back into the
// Anthropic SSE event sequence — text and tool calls included.
//
// Usage:
//   UPSTREAM=http://127.0.0.1:1234/v1 PORT=8787 node anthropic-openai-proxy.mjs
// Then point the Agent SDK at it:  ANTHROPIC_BASE_URL=http://127.0.0.1:8787

import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const UPSTREAM = (process.env.UPSTREAM || "http://127.0.0.1:1234/v1").replace(/\/$/, "");
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL || ""; // override model id, optional

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---- Anthropic request -> OpenAI request -------------------------------------

function blocksToText(content) {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) {
    const sys = typeof system === "string" ? system : blocksToText(system);
    if (sys) out.push({ role: "system", content: sys });
  }
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = blocksToText(m.content);
      const toolUses = m.content.filter((b) => b.type === "tool_use");
      const msg = { role: "assistant", content: text || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        }));
      }
      out.push(msg);
    } else {
      // user turn: may carry tool_result blocks (-> role:tool) and/or text
      const toolResults = m.content.filter((b) => b.type === "tool_result");
      const text = blocksToText(m.content);
      if (text) out.push({ role: "user", content: text });
      for (const tr of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content:
            typeof tr.content === "string" ? tr.content : blocksToText(tr.content ?? []),
        });
      }
    }
  }
  return out;
}

function toOpenAITools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

function translateRequest(body) {
  const openai = {
    model: UPSTREAM_MODEL || body.model,
    messages: toOpenAIMessages(body.system, body.messages ?? []),
    max_tokens: body.max_tokens ?? 1024,
    stream: !!body.stream,
  };
  if (body.temperature != null) openai.temperature = body.temperature;
  const tools = toOpenAITools(body.tools);
  if (tools) {
    openai.tools = tools;
    openai.tool_choice = "auto";
  }
  return openai;
}

// ---- OpenAI finish_reason -> Anthropic stop_reason ---------------------------

function mapStop(reason) {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    default:
      return "end_turn";
  }
}

const msgId = () => "msg_" + Math.random().toString(36).slice(2, 14);

// ---- Non-streaming response --------------------------------------------------

function translateResponse(oai, model) {
  const choice = oai.choices?.[0] ?? {};
  const m = choice.message ?? {};
  const content = [];
  if (m.content) content.push({ type: "text", text: m.content });
  for (const tc of m.tool_calls ?? []) {
    let input = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = { _raw: tc.function.arguments };
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  return {
    id: oai.id || msgId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStop(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: oai.usage?.prompt_tokens ?? 0,
      output_tokens: oai.usage?.completion_tokens ?? 0,
    },
  };
}

// ---- Streaming: OpenAI SSE deltas -> Anthropic SSE events ---------------------

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamResponse(upstreamRes, res, model) {
  const id = msgId();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  // Block bookkeeping: every block (text or tool) takes the next index in
  // arrival order. Text deltas must target the index their block was opened
  // at — with a tool call first, text is block 1+, not 0.
  let textOpen = false;
  let textIndex = -1;
  const toolBlocks = new Map(); // openai tool index -> { anthIndex, started }
  let nextIndex = 0;
  let finish = "stop";
  let buffer = "";

  function openText() {
    if (!textOpen) {
      textOpen = true;
      textIndex = nextIndex++;
      sse(res, "content_block_start", {
        type: "content_block_start",
        index: textIndex,
        content_block: { type: "text", text: "" },
      });
    }
  }

  const decoder = new TextDecoder();
  for await (const chunk of upstreamRes.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta ?? {};

      if (delta.content) {
        openText();
        sse(res, "content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      for (const tc of delta.tool_calls ?? []) {
        const oaIdx = tc.index ?? 0;
        let block = toolBlocks.get(oaIdx);
        if (!block) {
          if (textOpen) {
            sse(res, "content_block_stop", { type: "content_block_stop", index: textIndex });
            textOpen = false;
          }
          block = { anthIndex: nextIndex++ };
          toolBlocks.set(oaIdx, block);
          sse(res, "content_block_start", {
            type: "content_block_start",
            index: block.anthIndex,
            content_block: {
              type: "tool_use",
              id: tc.id || "toolu_" + Math.random().toString(36).slice(2, 12),
              name: tc.function?.name || "",
              input: {},
            },
          });
        }
        if (tc.function?.arguments) {
          sse(res, "content_block_delta", {
            type: "content_block_delta",
            index: block.anthIndex,
            delta: { type: "input_json_delta", partial_json: tc.function.arguments },
          });
        }
      }
    }
  }

  if (textOpen) {
    sse(res, "content_block_stop", { type: "content_block_stop", index: textIndex });
  }
  for (const block of toolBlocks.values()) {
    sse(res, "content_block_stop", { type: "content_block_stop", index: block.anthIndex });
  }
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: mapStop(finish), stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

// ---- Server ------------------------------------------------------------------

async function handle(req, res) {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM }));
    return;
  }
  if (req.method !== "POST" || !req.url.endsWith("/v1/messages")) {
    res.writeHead(404).end("not found");
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: "bad json" } }));
    return;
  }

  const oaiReq = translateRequest(body);
  const model = body.model;

  let upstreamRes;
  try {
    upstreamRes = await fetch(`${UPSTREAM}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(oaiReq),
    });
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: `upstream: ${e.message}` } }));
    return;
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text();
    res.writeHead(upstreamRes.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: text } }));
    return;
  }

  if (oaiReq.stream) {
    await streamResponse(upstreamRes, res, model);
  } else {
    const oai = await upstreamRes.json();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(translateResponse(oai, model)));
  }
}

const server = http.createServer((req, res) => {
  // A malformed request body, a non-JSON upstream reply or a connection reset
  // mid-stream must fail THIS request — not surface as an unhandled rejection
  // that kills the proxy (and with it the whole local-model session).
  handle(req, res).catch((e) => {
    console.error("proxy error:", e?.message ?? e);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `proxy: ${e?.message ?? e}` } }));
    } else {
      res.end();
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`anthropic<->openai proxy on http://127.0.0.1:${PORT}  ->  ${UPSTREAM}`);
});
