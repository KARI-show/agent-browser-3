import Anthropic from "@anthropic-ai/sdk";

/**
 * The agent loop for the extension's built-in mode: talks to the Claude API
 * straight from the browser with the user's API key (official SDK), so nothing
 * else has to be installed. Environment-free on purpose — the model client and
 * the browser tools are injected — so it runs the same in the extension and in
 * Node tests against a mock server.
 *
 * History is APPEND-ONLY. Models that keep their reasoning across turns
 * ("preserved thinking") reject a history whose earlier turns were edited, so
 * old screenshots are never pruned client-side; they are downscaled when taken
 * and the only rewrite is the whole-history replacement in `compact`.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Mode = "agent" | "careful" | "ask";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  readOnly: boolean;
}

export type ToolPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolOutput {
  content: ToolPart[];
  isError?: boolean;
}

export interface ModelTraits {
  /** Send `thinking: {type: "adaptive"}` (all current models except Haiku 4.5). */
  thinking: boolean;
  /** Send `output_config.effort` (refused by Haiku 4.5 and pre-4.5 models). */
  effort: boolean;
  /** Effort levels the model accepts, when the Models API said (else low/medium/high). */
  efforts?: Effort[];
  maxInput?: number;
}

const EFFORT_ORDER: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** The requested effort, or the nearest level below it that the model supports. */
export function effortFor(traits: ModelTraits, want: Effort): Effort {
  const ok = traits.efforts?.length ? traits.efforts : (["low", "medium", "high"] as Effort[]);
  for (let i = EFFORT_ORDER.indexOf(want); i >= 0; i--) if (ok.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  return ok[0];
}

/** JSON strings the API accepts: a lone UTF-16 surrogate (from slicing mid-emoji) is rejected. */
export function wellFormed(s: string): string {
  const w = (s as string & { toWellFormed?: () => string }).toWellFormed;
  return typeof w === "function" ? w.call(s) : s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** Derive request parameters from a Models API entry, or from the id when the entry is unknown. */
export function modelTraits(id: string, info?: Anthropic.ModelInfo | null): ModelTraits {
  const caps = info?.capabilities;
  const maxInput = info?.max_input_tokens ?? undefined;
  if (caps) {
    const e = caps.effort;
    const efforts = e?.supported ? EFFORT_ORDER.filter((l) => (e as unknown as Record<string, { supported?: boolean } | null>)[l]?.supported) : undefined;
    return {
      thinking: !!caps.thinking?.types?.adaptive?.supported,
      effort: !!(e?.supported && e.medium?.supported),
      efforts,
      maxInput,
    };
  }
  const old = /^claude-(haiku|3-|sonnet-4-5|opus-4-5|opus-4-1|opus-4-2|sonnet-4-2|opus-4-0|sonnet-4-0)/.test(id);
  return { thinking: !old, effort: !old, maxInput };
}

export interface TurnCallbacks {
  text(delta: string): void;
  thinking(delta: string): void;
  toolUse(id: string, name: string, input: unknown): void;
  toolResult(id: string, text: string, isError: boolean, durationMs: number): void;
  /** After every API response: token usage for the context meter. */
  usage(usage: Anthropic.Usage): void;
  /** Careful mode: ask the user before an action. */
  approve(name: string, input: Record<string, unknown>): Promise<boolean>;
  /** AskUserQuestion: resolves with the answer text. */
  ask(input: Record<string, unknown>): Promise<string>;
  info(text: string): void;
  /** History just grew (assistant turn or tool results): a chance to persist it. */
  checkpoint(): void;
}

export interface TurnOptions {
  client: Anthropic;
  model: string;
  traits: ModelTraits;
  effort: Effort;
  system: string;
  tools: ToolDef[];
  /** Mutated: assistant turns and tool results are appended, nothing earlier is touched. */
  messages: Anthropic.MessageParam[];
  /** A getter lets the user switch modes while a run is in progress (checked before every tool call). */
  mode: Mode | (() => Mode);
  signal: AbortSignal;
  runTool(name: string, input: Record<string, unknown>): Promise<ToolOutput>;
  cb: TurnCallbacks;
  /** Safety valve against a model that never stops calling tools. */
  maxSteps?: number;
}

export interface TurnResult {
  stopReason: string | null;
  refusal?: { category: string | null; explanation: string | null };
  aborted?: boolean;
  /** Ran out of steps or output budget mid-task. */
  truncated?: string;
}

export const ASK_TOOL: ToolDef = {
  name: "AskUserQuestion",
  readOnly: true,
  description:
    "Ask the user a multiple-choice question when you need a decision or confirmation before continuing — " +
    "e.g. before a purchase, sending a message or deleting something. Shows options in the chat and returns the choice.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The full question, ending with a question mark." },
            header: { type: "string", description: "Very short label (max 12 chars)." },
            multiSelect: { type: "boolean", description: "Allow more than one answer." },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: {
                type: "object",
                properties: { label: { type: "string" }, description: { type: "string" } },
                required: ["label", "description"],
              },
            },
          },
          required: ["question", "header", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

const MAX_TOKENS = 64000; // streaming request: thinking counts toward it, so leave room
const DEFAULT_MAX_STEPS = 80;

/**
 * Background: каждый скриншот (base64 JPEG) = 15-100K токенов. После 5 скриншотов
 * контекст раздувается до 500K+. Модель не может смотреть старые скриншоты —
 * страница уже изменилась, они бесполезны.
 * Design: перед отправкой в API заменяем image блоки в СТАРЫХ сообщениях
 * на текстовый placeholder. Оставляем картинки только в последнем user message
 * (текущий turn). Оригинальный массив messages НЕ мутируется — UI сохраняет всё.
 * Constraint: preserved thinking запрещает редактировать assistant сообщения,
 * но мы меняем только user tool_result content — thinking там нет.
 */
function stripOldImages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length < 2) return messages;
  // Find the last user message index (current turn's tool results — keep images)
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }
  return messages.map((m, idx) => {
    if (idx >= lastUserIdx) return m; // keep latest user message intact
    if (m.role !== "user" || typeof m.content === "string") return m;
    if (!Array.isArray(m.content)) return m;
    const hasImage = m.content.some((b: any) =>
      b.type === "image" ||
      (b.type === "tool_result" && Array.isArray(b.content) && b.content.some((x: any) => x.type === "image"))
    );
    if (!hasImage) return m;
    const stripped = m.content.map((b: any) => {
      if (b.type === "image") return { type: "text" as const, text: "[screenshot — no longer in context, use browser_screenshot for a fresh one]" };
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        const inner = b.content.map((x: any) =>
          x.type === "image" ? { type: "text" as const, text: "[screenshot — evicted from context]" } : x
        );
        return { ...b, content: inner };
      }
      return b;
    });
    return { ...m, content: stripped };
  });
}

function requestParams(o: Pick<TurnOptions, "model" | "traits" | "effort" | "system" | "tools" | "messages">): Anthropic.MessageStreamParams {
  return {
    model: o.model,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: o.system }],
    cache_control: { type: "ephemeral" },
    tools: o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema })),
    messages: stripOldImages(o.messages),
    ...(o.traits.thinking ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
    ...(o.traits.effort ? { output_config: { effort: effortFor(o.traits, o.effort) } } : {}),
  };
}

function toolResultText(out: ToolOutput): string {
  const text = out.content.filter((p): p is Extract<ToolPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("\n");
  const images = out.content.filter((p) => p.type === "image").length;
  return wellFormed((text + (images ? `${text ? "\n" : ""}[${images} image${images > 1 ? "s" : ""} sent to the model]` : "")).trim() || "(no output)");
}

/** tool_result content for the API: no empty text blocks (a 400 that would poison the chat), well-formed strings. */
function toApiContent(out: ToolOutput): Anthropic.ToolResultBlockParam["content"] {
  const parts: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  for (const p of out.content) {
    if (p.type === "text") {
      if (p.text.trim()) parts.push({ type: "text", text: wellFormed(p.text) });
    } else if (p.data) {
      parts.push({ type: "image", source: { type: "base64", media_type: p.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: p.data } });
    }
  }
  return parts.length ? parts : [{ type: "text", text: "(no output)" }];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface ToolCallResult {
  isError: boolean;
  /** tool_result content for the history. */
  content: Anthropic.ToolResultBlockParam["content"];
  /** The same result as raw parts (what the trial bridge sends back to its server). */
  parts: ToolPart[];
}

/**
 * One tool call under the chat's rules: unknown tools and malformed input refused, the ask tool, Ask/Careful
 * modes, Stop. Shared by the API loop and the free-trial bridge so both enforce exactly the same policy.
 */
export async function callTool(
  o: Pick<TurnOptions, "tools" | "mode" | "signal" | "runTool" | "cb">,
  id: string,
  name: string,
  rawInput: unknown,
): Promise<ToolCallResult> {
  const { cb, signal } = o;
  cb.toolUse(id, name, rawInput);
  const t0 = Date.now();
  const say = (text: string, isError: boolean): ToolCallResult => {
    cb.toolResult(id, text, isError, Date.now() - t0);
    return { isError, content: text, parts: [{ type: "text", text }] };
  };

  const def = o.tools.find((t) => t.name === name);
  const input = isPlainObject(rawInput) ? rawInput : null;
  if (!def || !input) return say(!def ? `Unknown tool "${name}".` : "The tool input was not a valid object.", true);

  if (name === ASK_TOOL.name) return say(`The user answered: ${await cb.ask(input)}`, false);

  if (!def.readOnly) {
    const mode = typeof o.mode === "function" ? o.mode() : o.mode;
    if (mode === "ask") return say("Read-only (Ask) mode — you can read pages and take screenshots but not click, type or navigate.", true);
    if (mode === "careful" && !(await cb.approve(name, input))) return say("The user denied this action.", true);
  }

  try {
    // Stop must not wait for a slow page: race the tool against the abort (the tool itself
    // may finish later in the background; its result is then simply not used).
    const out = await Promise.race([
      o.runTool(name, input),
      new Promise<never>((_, reject) => {
        if (signal.aborted) return reject(new Error("Interrupted by the user."));
        signal.addEventListener("abort", () => reject(new Error("Interrupted by the user.")), { once: true });
      }),
    ]);
    cb.toolResult(id, toolResultText(out), !!out.isError, Date.now() - t0);
    return { isError: !!out.isError, content: toApiContent(out), parts: out.content };
  } catch (e) {
    return say(String((e as Error)?.message ?? e), true);
  }
}

/** Run one user turn to completion: model call → tools → model call … until the model stops. */
export async function runTurn(o: TurnOptions): Promise<TurnResult> {
  const { cb, signal } = o;
  const maxSteps = o.maxSteps ?? DEFAULT_MAX_STEPS;

  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return { stopReason: null, aborted: true };

    const stream = o.client.messages.stream(requestParams(o), { signal });
    stream.on("text", (delta) => cb.text(delta));
    stream.on("thinking", (delta) => cb.thinking(delta));
    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return { stopReason: null, aborted: true };
      throw err;
    }
    cb.usage(message.usage);

    if (message.stop_reason === "refusal") {
      // Never run tools from a refused turn (the request may be cut off mid-input) and never keep it: its
      // partial thinking blocks are unsigned, and replaying them would fail every later request in the chat.
      return {
        stopReason: "refusal",
        refusal: { category: message.stop_details?.category ?? null, explanation: message.stop_details?.explanation ?? null },
      };
    }

    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (message.stop_reason === "max_tokens" && toolUses.length) {
      // A tool input cut off at the limit still parses as a partial object — don't run it.
      return { stopReason: "max_tokens", truncated: "The reply was cut off before the browser action was complete." };
    }

    if ((message.stop_reason as string) === "model_context_window_exceeded") {
      return { stopReason: "context", truncated: "This chat no longer fits in the model's context. Use Compact, or start a new chat." };
    }

    // An empty assistant turn (or one of blank text) is invalid history — the next request would 400.
    const hasContent = message.content.some((b) => (b.type === "text" ? b.text.trim().length > 0 : true));
    if (!hasContent) return { stopReason: message.stop_reason };
    o.messages.push({ role: "assistant", content: message.content });
    cb.checkpoint();

    if (message.stop_reason === "max_tokens") return { stopReason: "max_tokens", truncated: "The reply hit the output limit and was cut off." };
    if (message.stop_reason === "pause_turn") continue;
    if (!toolUses.length) return { stopReason: message.stop_reason };

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      // Out of the loop after an abort: every tool_use still needs its result
      // or the history is invalid for the next turn.
      if (signal.aborted) {
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: "Interrupted by the user." });
        continue;
      }
      const r = await callTool(o, tu.id, tu.name, tu.input);
      results.push({ type: "tool_result", tool_use_id: tu.id, is_error: r.isError || undefined, content: r.content });
    }
    o.messages.push({ role: "user", content: results });
    cb.checkpoint();
    if (signal.aborted) return { stopReason: null, aborted: true };
  }
  return { stopReason: "tool_use", truncated: `Stopped after ${maxSteps} steps — send a message to let it continue.` };
}

/**
 * A trimmed copy of the history for the summarizer: no thinking blocks, screenshots replaced by a note,
 * long tool output clipped. Only the summary request sees it — the real history is replaced wholesale
 * afterwards — and it lets a chat that is already too big for the context still be compacted.
 */
export function slimForSummary(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const clip = (t: string) => (t.length > 1500 ? wellFormed(t.slice(0, 1500)) + " …" : t);
  const slimBlock = (b: Anthropic.ContentBlockParam): Anthropic.ContentBlockParam | null => {
    if (b.type === "thinking" || b.type === "redacted_thinking") return null;
    if (b.type === "image") return { type: "text", text: "[image omitted]" };
    if (b.type === "document") return { type: "text", text: "[document omitted]" };
    if (b.type === "text") return { ...b, text: clip(b.text) };
    if (b.type === "tool_result") {
      const c = b.content;
      const inner = typeof c === "string" ? clip(c) : (c ?? []).map((x) => (x.type === "text" ? { ...x, text: clip(x.text) } : ({ type: "text", text: "[image omitted]" } as const)));
      return { ...b, content: inner };
    }
    return b;
  };
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: clip(m.content) });
      continue;
    }
    const blocks = m.content.map(slimBlock).filter((b): b is Anthropic.ContentBlockParam => !!b);
    if (blocks.length) out.push({ role: m.role, content: blocks });
  }
  return out;
}

/**
 * Whole-history compaction: ask the model for a summary, then replace the
 * history with it. Replacing everything (not editing part of it) is the one
 * rewrite that keeps thinking-preserving models happy, since no earlier
 * thinking block is replayed afterwards.
 */
export async function compactHistory(
  o: Pick<TurnOptions, "client" | "model" | "traits" | "effort" | "system" | "tools" | "messages" | "signal">
): Promise<string> {
  const ask: Anthropic.MessageParam = {
    role: "user",
    content:
      "Write a summary of this conversation so I can continue it in a fresh context: what the user wants, what has been done, " +
      "the current page/tab state, decisions and preferences, and what remains. Be concrete (names, URLs, values). Plain text.",
  };
  const params = requestParams({ ...o, messages: [...slimForSummary(o.messages), ask] });
  const stream = o.client.messages.stream({ ...params, tool_choice: { type: "none" } }, { signal: o.signal });
  const message = await stream.finalMessage();
  // A refused or cut-off summary must never replace the real history.
  if (message.stop_reason !== "end_turn") throw new Error(`Couldn't summarize this chat (${message.stop_reason}) — nothing was changed.`);
  const summary = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (summary.length < 40) throw new Error("The summary came back empty — nothing was changed.");
  return summary;
}

/** Actionable text for the errors people hit first. */
export function describeError(err: unknown): { message: string; authFailed?: boolean } {
  // The free-trial gateway explains its own limits and outages in plain words — show those as they are.
  if (err instanceof Anthropic.APIError) {
    const body = (err.error as { error?: { message?: string } } | undefined)?.error?.message;
    if (body && /free[- ]trial|trial token/i.test(body)) return { message: body, authFailed: err.status === 401 || err.status === 403 };
  }
  if (err instanceof Anthropic.AuthenticationError) return { message: "The API key was rejected (401). Check it in the settings (🌐 → API key).", authFailed: true };
  if (err instanceof Anthropic.PermissionDeniedError) return { message: `The API key isn't allowed to do that (403): ${err.message}`, authFailed: true };
  if (err instanceof Anthropic.RateLimitError) return { message: "Rate limited by the API (429) even after retries — wait a moment and try again." };
  if (err instanceof Anthropic.BadRequestError) {
    const m = String(err.message);
    if (/prompt is too long|too many tokens|context/i.test(m)) return { message: "This chat no longer fits in the model's context. Use Compact, or start a new chat." };
    if (/credit balance|billing/i.test(m)) return { message: "The API account has no credit left (billing). Add credit in the Anthropic console." };
    return { message: `The API rejected the request: ${m}` };
  }
  if (err instanceof Anthropic.NotFoundError) return { message: `Model or endpoint not found (404): ${err.message}` };
  if (err instanceof Anthropic.InternalServerError) return { message: `The API had a server problem (${err.status}) — try again.` };
  if (err instanceof Anthropic.APIConnectionError) return { message: "Couldn't reach the API — check your connection (and the base URL / proxy in settings)." };
  if (err instanceof Anthropic.APIError) return { message: `API error ${err.status ?? ""}: ${err.message}` };
  return { message: String((err as Error)?.message ?? err) };
}
