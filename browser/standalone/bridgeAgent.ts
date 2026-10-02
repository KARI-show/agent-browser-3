/**
 * 背景：Claude Max OAuth token 不能直接调 Messages API（会 429）。只有 Agent SDK（CLI subprocess）
 * 才能路由到 Sonnet/Opus。服务器使用 MCP Bridge 架构：Agent SDK 跑对话循环，tool calls
 * 通过 SSE 实时推送给浏览器 extension 执行。
 *
 * 设计意图：替代 engine.ts 的 runTurn()，在 trial mode 下使用 /v1/agent bridge 端点。
 * 保持相同的 TurnCallbacks 接口，让 localHost.ts 不需要改动 UI 逻辑。
 * Tool calls 通过 SSE event 桥接：server → tool_call → extension 执行 → POST tool_result → server 继续。
 *
 * 约束：
 *  - conversation history 传给 server 后被转为 text（Agent SDK prompt 格式），不是 Messages API 的结构化格式
 *  - 每个 bridge 请求是一个完整的 agent 循环（多 turn tool use 都在服务器内完成）
 *  - 客户端构建 apiMessages 历史以保持 UI 和后续请求的上下文一致性
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Effort, Mode, ToolDef, ToolOutput, TurnCallbacks, TurnResult } from "./engine";

export interface BridgeTurnOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  tools: ToolDef[];
  /** Mutated: assistant turns and tool results are appended, same as engine.ts. */
  messages: Anthropic.MessageParam[];
  signal: AbortSignal;
  runTool(name: string, input: Record<string, unknown>): Promise<ToolOutput>;
  cb: TurnCallbacks;
  mode: Mode | (() => Mode);
  maxTokens?: number;
}

/**
 * 背景：替代 engine.ts 的 runTurn()，专门用于 trial mode 的 bridge 协议。
 * 设计意图：发一个请求到 /v1/agent，通过 SSE stream 接收 text/thinking/tool_call 事件。
 * 当收到 tool_call 时，在浏览器本地执行 tool，然后 POST 结果回 /v1/agent/tool_result。
 * Agent SDK 在服务器端继续对话循环，直到 Claude 完成。
 */
export async function runTurnBridge(o: BridgeTurnOptions): Promise<TurnResult> {
  const { cb, signal } = o;
  const currentMode = () => (typeof o.mode === "function" ? o.mode() : o.mode);

  const body = {
    model: o.model,
    max_tokens: o.maxTokens || 8192,
    system: typeof o.system === "string" ? o.system : undefined,
    tools: o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    messages: o.messages,
    stream: true,
  };

  const res = await fetch(`${o.baseUrl}/v1/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": o.apiKey },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let errMsg = `API error ${res.status}`;
    try {
      errMsg = JSON.parse(errText).error?.message || errMsg;
    } catch {}
    throw new Error(errMsg);
  }

  if (!res.body) throw new Error("No response body from bridge.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sessionId = "";
  let stopReason: string | null = null;

  // Build structured history from the bridge response
  const assistantBlocks: Anthropic.ContentBlockParam[] = [];
  const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
  let currentTextBlock = "";

  function flushText() {
    if (currentTextBlock) {
      assistantBlocks.push({ type: "text", text: currentTextBlock });
      currentTextBlock = "";
    }
  }

  while (true) {
    if (signal.aborted) return { stopReason: null, aborted: true };

    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      const lines = block.split("\n");
      let event = "";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) event = line.slice(7);
        if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (!event || !data) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      switch (event) {
        case "session":
          sessionId = parsed.id as string;
          break;

        case "text":
          if (parsed.text) {
            const text = parsed.text as string;
            currentTextBlock += text;
            cb.text(text);
          }
          break;

        case "thinking":
          if (parsed.thinking) {
            cb.thinking(parsed.thinking as string);
          }
          break;

        case "tool_call": {
          flushText();
          const id = parsed.id as string;
          const name = parsed.name as string;
          const input = (parsed.input || {}) as Record<string, unknown>;

          // Record tool_use in assistant blocks
          assistantBlocks.push({ type: "tool_use", id, name, input } as Anthropic.ToolUseBlockParam);
          cb.toolUse(id, name, input);
          const t0 = Date.now();

          const mode = currentMode();
          const def = o.tools.find((t) => t.name === name);

          // Ask mode: read-only
          if (mode === "ask") {
            const msg = "Read-only (Ask) mode — you can read pages and take screenshots but not click, type or navigate.";
            await postToolResult(o.baseUrl, sessionId, id, [{ type: "text", text: msg }], true);
            cb.toolResult(id, msg, true, Date.now() - t0);
            toolResultBlocks.push({ type: "tool_result", tool_use_id: id, is_error: true, content: msg });
            break;
          }

          // Careful mode: approval needed for non-read-only
          if (mode === "careful" && def && !def.readOnly) {
            const approved = await cb.approve(name, input);
            if (!approved) {
              const msg = "The user denied this action.";
              await postToolResult(o.baseUrl, sessionId, id, [{ type: "text", text: msg }], true);
              cb.toolResult(id, msg, true, Date.now() - t0);
              toolResultBlocks.push({ type: "tool_result", tool_use_id: id, is_error: true, content: msg });
              break;
            }
          }

          // Execute tool in the browser
          try {
            const out = await Promise.race([
              o.runTool(name, input),
              new Promise<never>((_, reject) => {
                if (signal.aborted) return reject(new Error("Interrupted by the user."));
                signal.addEventListener("abort", () => reject(new Error("Interrupted by the user.")), { once: true });
              }),
            ]);
            const textParts = out.content
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join("\n");
            const resultText = (textParts.trim() || "(no output)").slice(0, 4000);

            await postToolResult(o.baseUrl, sessionId, id, out.content, !!out.isError);
            cb.toolResult(id, resultText, !!out.isError, Date.now() - t0);
            toolResultBlocks.push({ type: "tool_result", tool_use_id: id, is_error: !!out.isError || undefined, content: resultText });
          } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            await postToolResult(o.baseUrl, sessionId, id, [{ type: "text", text: msg }], true);
            cb.toolResult(id, msg, true, Date.now() - t0);
            toolResultBlocks.push({ type: "tool_result", tool_use_id: id, is_error: true, content: msg });
          }
          break;
        }

        case "usage":
          if (parsed.input_tokens || parsed.output_tokens) {
            cb.usage({
              input_tokens: (parsed.input_tokens as number) || 0,
              output_tokens: (parsed.output_tokens as number) || 0,
              cache_read_input_tokens: (parsed.cache_read_input_tokens as number) || 0,
              cache_creation_input_tokens: (parsed.cache_creation_input_tokens as number) || 0,
            } as Anthropic.Usage);
          }
          break;

        case "done":
          stopReason = (parsed.stop_reason as string) || "end_turn";
          break;

        case "error":
          throw new Error((parsed.message as string) || "Agent error");
      }
    }
  }

  // Build structured conversation history for future turns
  flushText();
  if (assistantBlocks.length) {
    o.messages.push({ role: "assistant", content: assistantBlocks });
    cb.checkpoint();
  }
  if (toolResultBlocks.length) {
    o.messages.push({ role: "user", content: toolResultBlocks });
    cb.checkpoint();
  }

  return { stopReason: stopReason || "end_turn" };
}

/**
 * 背景：tool_call 事件告知 extension 执行 browser tool。执行完后需要把结果
 * POST 回服务器的 /v1/agent/tool_result，以便 Agent SDK 继续对话循环。
 * 设计意图：fire-and-forget POST — 如果发送失败不应 crash 主 stream。
 * 服务器端有 2 分钟 timeout 做兜底。
 */
async function postToolResult(
  baseUrl: string,
  sessionId: string,
  toolCallId: string,
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
  isError: boolean
): Promise<void> {
  try {
    await fetch(`${baseUrl}/v1/agent/tool_result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        results: [{ id: toolCallId, content, is_error: isError }],
      }),
    });
  } catch {
    console.error("[bridge] failed to POST tool_result for", toolCallId);
  }
}
