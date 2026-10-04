/**
 * Free-trial turn through the gateway's /v1/agent bridge, in place of engine.ts runTurn().
 *
 * The gateway runs the agent loop itself and streams SSE events back: text/thinking deltas, and a tool_call
 * whenever the model wants a browser tool. The tool runs here, in the panel, and its result is POSTed to
 * /v1/agent/tool_result so the loop on the server can continue. Same TurnCallbacks as runTurn(), so the UI
 * doesn't care which path a chat takes.
 *
 * Constraints:
 *  - the server flattens the history into text; the structured history is still kept here so later turns
 *    (and a switch to the user's own API key) have it in valid Messages API shape;
 *  - one request = one whole agent loop, however many tool calls it makes.
 */

import Anthropic from "@anthropic-ai/sdk";
import { callTool, type Mode, type ToolDef, type ToolOutput, type ToolPart, type TurnCallbacks, type TurnResult } from "./engine";

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

// Statuses worth another try (busy or hiccuping gateway), how often, and how long Retry-After may ask us to wait before
// it is really a "not now" (the daily allowance resets at midnight, not in a minute).
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 30_000;

/** How long to wait before POSTing again, or null when another attempt isn't worth it. */
function retryDelayMs(res: Response, attempt: number): number | null {
  if (attempt >= MAX_ATTEMPTS - 1 || !RETRY_STATUSES.has(res.status) || res.headers.get("x-should-retry") === "false") return null;
  const h = res.headers.get("retry-after")?.trim();
  const secs = !h ? NaN : /^\d+$/.test(h) ? Number(h) : (Date.parse(h) - Date.now()) / 1000;
  const ms = Number.isFinite(secs) ? Math.max(0, secs) * 1000 : 1000 * 2 ** attempt;
  return ms <= MAX_RETRY_WAIT_MS ? ms : null;
}

/** Resolves true after `ms`, or false at once when the user presses Stop meanwhile. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runTurnBridge(o: BridgeTurnOptions): Promise<TurnResult> {
  const { cb, signal } = o;
  const aborted: TurnResult = { stopReason: null, aborted: true };
  const body = JSON.stringify({
    model: o.model,
    max_tokens: o.maxTokens || 8192,
    system: o.system,
    tools: o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    messages: o.messages,
    stream: true,
  });

  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${o.baseUrl}/v1/agent`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": o.apiKey }, body, signal });
    } catch (e) {
      if (signal.aborted) return aborted;
      throw new Anthropic.APIConnectionError({ cause: e as Error });
    }
    if (res.ok) break;

    const text = await res.text().catch(() => "");
    let err: { error?: { message?: string } } | undefined;
    try {
      err = JSON.parse(text);
    } catch {}
    const message = err?.error?.message || text.slice(0, 300) || undefined;
    const delay = retryDelayMs(res, attempt);
    if (delay === null) {
      // A typed error, like the SDK throws: describeError() then spots a rejected trial token (401/403) so it is
      // forgotten and re-registered, and localHost drops a message the gateway refused (400/413) from the history.
      throw Anthropic.APIError.generate(res.status, err, message, res.headers);
    }
    cb.info(`⟳ ${message || `The trial service answered ${res.status}.`} Retrying in ${Math.ceil(delay / 1000)} s…`);
    if (!(await wait(delay, signal))) return aborted;
  }
  if (!res.body) throw new Anthropic.APIConnectionError({ message: "The trial service sent an empty reply." });

  // History in turn order: assistant [text, tool_use…] → user [tool_result…] → assistant [text…] …
  let turn: Anthropic.ContentBlockParam[] = [];
  let results: Anthropic.ToolResultBlockParam[] = [];
  let text = "";
  const flushText = () => {
    if (text.trim()) turn.push({ type: "text", text });
    text = "";
  };
  const commit = () => {
    flushText();
    if (turn.length) {
      o.messages.push({ role: "assistant", content: turn });
      cb.checkpoint();
    }
    if (results.length) {
      o.messages.push({ role: "user", content: results });
      cb.checkpoint();
    }
    turn = [];
    results = [];
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sessionId = "";
  let stopReason: string | null = null;

  try {
    for (;;) {
      if (signal.aborted) return aborted;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal.aborted) return aborted;
        throw new Anthropic.APIConnectionError({ message: "The connection to the trial service dropped mid-reply.", cause: e as Error });
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (!event || !data) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }

        switch (event) {
          case "session":
            sessionId = String(ev.id || "");
            break;
          case "text":
            if (typeof ev.text === "string" && ev.text) {
              // Text after tool results is the model's next turn, not part of the one that called the tools.
              if (results.length) commit();
              text += ev.text;
              cb.text(ev.text);
            }
            break;
          case "thinking":
            if (typeof ev.thinking === "string" && ev.thinking) cb.thinking(ev.thinking);
            break;
          case "tool_call": {
            flushText();
            const id = typeof ev.id === "string" ? ev.id : "";
            const name = typeof ev.name === "string" ? ev.name : "";
            // Without an id the result can't be matched to the call (here or on the server); without a name there
            // is nothing to run. That is the gateway breaking its own protocol, not a tool error to report back.
            if (!id || !name) throw new Error("The trial service sent a tool call without an id or name — the reply was abandoned.");
            const input = ev.input ?? {};
            turn.push({ type: "tool_use", id, name, input });
            const r = await callTool(o, id, name, input);
            results.push({ type: "tool_result", tool_use_id: id, is_error: r.isError || undefined, content: r.content });
            // After Stop, still tell the gateway (its loop is waiting), but don't make Stop wait for it.
            const posted = postToolResult(o, sessionId, id, r.parts, r.isError);
            if (!signal.aborted) await posted;
            break;
          }
          case "usage":
            if (ev.input_tokens || ev.output_tokens) {
              cb.usage({
                input_tokens: Number(ev.input_tokens) || 0,
                output_tokens: Number(ev.output_tokens) || 0,
                cache_read_input_tokens: Number(ev.cache_read_input_tokens) || 0,
                cache_creation_input_tokens: Number(ev.cache_creation_input_tokens) || 0,
              } as Anthropic.Usage);
            }
            break;
          case "done":
            stopReason = String(ev.stop_reason || "end_turn");
            break;
          case "error":
            throw new Error(String(ev.message || "The trial service hit an error."));
        }
      }
    }
  } finally {
    // Whatever ran in the browser stays in the history (every tool_use already has its result), even on Stop/error.
    commit();
    reader.cancel().catch(() => {});
  }

  // A stream that just ends without "done" is a gateway that died mid-turn, not a finished answer.
  if (stopReason === null) throw new Anthropic.APIConnectionError({ message: "The trial service closed the connection before the reply was finished." });
  if (stopReason === "refusal") return { stopReason, refusal: { category: null, explanation: null } };
  if (stopReason === "max_tokens") return { stopReason, truncated: "The reply hit the output limit and was cut off." };
  return { stopReason };
}

/** Hands a tool's result back to the waiting agent loop. Best effort: the gateway times a lost result out itself. */
async function postToolResult(o: BridgeTurnOptions, sessionId: string, id: string, content: ToolPart[], isError: boolean): Promise<void> {
  try {
    await fetch(`${o.baseUrl}/v1/agent/tool_result`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": o.apiKey },
      body: JSON.stringify({ session_id: sessionId, results: [{ id, content, is_error: isError }] }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    console.error("[bridge] failed to POST tool_result for", id);
  }
}
