// The Agent SDK is ESM-only; the VS Code extension host is CommonJS. A dynamic
// import() bridges the two (and esbuild keeps it intact because the package is
// marked external).
import * as fs from "fs";
import * as path from "path";
import { createSuperToolsServer, DevServerManager, SuperModules } from "./superTools";
import { log } from "./log";

/**
 * Find a system-installed `claude` executable. Using it (instead of the
 * platform-specific binary bundled in the .vsix) makes the extension work on
 * any OS — the user already has the Claude CLI for `claude login`. Falls back
 * to the bundled binary if none is found.
 */
let cachedClaudePath: string | null | undefined;
function findClaudeBinary(): string | undefined {
  if (cachedClaudePath !== undefined) return cachedClaudePath ?? undefined;
  const isWin = process.platform === "win32";
  const names = isWin ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) dirs.push(path.join(home, ".local", "bin"));
  for (const dir of dirs) {
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (fs.existsSync(p)) {
          cachedClaudePath = p;
          return p;
        }
      } catch {
        /* ignore */
      }
    }
  }
  cachedClaudePath = null;
  return undefined;
}

/**
 * Thin wrapper around the Claude Agent SDK's `query()` so the rest of the
 * extension never touches the SDK shape directly. This is also the seam where
 * the transport is chosen: `baseUrl` is forwarded as ANTHROPIC_BASE_URL, so a
 * local translation proxy (LM Studio) can be slotted in later without touching
 * callers.
 */

export interface AgentCallbacks {
  onText(text: string): void;
  onThinking(text: string): void;
  onToolUse(name: string, input: unknown, id: string): void;
  onToolResult(id: string, content: string, isError: boolean): void;
  onResult(summary: string, costUsd?: number, usage?: any): void;
  onError(message: string): void;
  /** The SDK session id for this run (for resume / history). Fires once. */
  onSession(sessionId: string): void;
  /** Init message: available slash commands + active model. Fires once. */
  onInit(info: { slashCommands: string[]; model?: string }): void;
  /** Non-init system messages (e.g. compact_boundary). */
  onSystem(subtype: string, data: any): void;
  /** Real list of models the account supports (from the SDK). */
  onModels(models: any[]): void;
  /** A transient failure is being retried (attempt = the one that just failed). */
  onRetry?(attempt: number, maxAttempts: number, delayMs: number, reason: string): void;
  /** Plan rate-limit utilization (5-hour / 7-day windows) from the SDK /usage
   *  data, for the header gauges. Optional + best-effort (EXPERIMENTAL API). */
  onUsageLimits?(info: {
    available: boolean;
    fiveHour?: { utilization: number | null; resetsAt: string | null } | null;
    sevenDay?: { utilization: number | null; resetsAt: string | null } | null;
  }): void;
  /** Current chat context-window usage (tokens used / model max) for the
   *  composer context bar. Best-effort, refreshed after each turn. */
  onContext?(info: { used: number; max: number; pct: number; model?: string }): void;
  /** Human-in-the-loop gate for non-edit tools (e.g. Bash). */
  requestApproval(toolName: string, input: Record<string, unknown>): Promise<boolean>;
  /** Render AskUserQuestion as interactive options; resolves with the answer text. */
  askQuestion(input: Record<string, unknown>): Promise<string>;
  /** Snapshot + auto-apply a file edit; the change is reviewed in-editor after. */
  prepareEdit(toolName: string, input: Record<string, unknown>): Promise<boolean>;
}

export interface RunOptions {
  prompt: string;
  cwd: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Resume a prior session (same id) so the model keeps full context. */
  resume?: string;
  /** With resume, branch into a NEW session instead of appending. */
  forkSession?: boolean;
  /** Mode: agent (default), ask (read-only), plan (no edits), acceptEdits (auto-apply). */
  mode?: "agent" | "ask" | "plan" | "acceptEdits";
  /**
   * Surface the model's chain-of-thought. Without this the SDK uses the model
   * default (on for some models, off/omitted for others) — which is why thinking
   * shows up only sometimes. `{ type: "adaptive" }` lets Claude decide depth and
   * reliably emits (summarized) thinking blocks on supporting models.
   */
  thinking?:
    | { type: "adaptive"; display?: "summarized" | "omitted" }
    | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" }
    | { type: "disabled" };
  /** MCP server configs (forwarded to the SDK) — gives the agent extra tools. */
  mcpServers?: Record<string, unknown>;
  /** EXPERIMENTAL: hand the agent the built-in "super tools" (dev server, …). */
  enableSuperTools?: boolean;
  /** Persistent dev-server manager (owned by the provider, survives runs). */
  superDev?: DevServerManager;
  /** Which super-tool capability modules are enabled. */
  superModules?: SuperModules;
  /** Live progress sink for the orchestrator (streamed to the panel). */
  superNotify?: (text: string) => void;
  /** Explicit model for subagents (empty → same as the parent run). */
  subagentModel?: string;
  /** Open the background Orchestrator window (so chat-invoked orchestrate spawns it). */
  onLaunchOrchestrator?: (goal: string) => void;
  /** Restrict the built-in tool set (SDK `tools`); omitted → all Claude Code tools. */
  tools?: string[];
  /** Extra instructions appended to Claude Code's system prompt. */
  appendSystemPrompt?: string;
  /**
   * Host-specific permission policy, consulted before the built-in rules.
   * Return a decision to short-circuit, or undefined to fall through.
   */
  toolPolicy?: (
    toolName: string,
    input: Record<string, unknown>
  ) => { behavior: "allow" } | { behavior: "deny"; message: string } | undefined;
}

// Read-only tools are auto-approved; anything that mutates the workspace or
// runs a shell goes through the approval gate.
const AUTO_ALLOW = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
  "TodoWrite",
]);

// File-mutating tools: snapshot + apply, then review inline in the editor.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" ? b.text : typeof b === "string" ? b : ""))
      .join("");
  }
  return "";
}

export interface RunHandle {
  done: Promise<void>;
  interrupt(): void;
}

// Transient API/network failures worth an automatic retry: overload/rate-limit
// responses and socket-level errors. Anything else (auth, bad request, logic)
// fails fast to the user.
const TRANSIENT_ERROR = new RegExp(
  [
    "overloaded",
    "rate.?limit",
    "too many requests",
    "\\b(?:429|500|502|503|504|522|529)\\b",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EPIPE",
    "EAI_AGAIN",
    "fetch failed",
    "network error",
    "socket hang up",
    "connection (?:closed|reset|error)",
  ].join("|"),
  "i"
);

export function runAgent(opts: RunOptions, cb: AgentCallbacks): RunHandle {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts.apiKey) {
    env.ANTHROPIC_API_KEY = opts.apiKey;
  } else {
    // No key configured -> run on the Claude subscription (claude login).
    // Drop any stray key so the SDK uses the logged-in OAuth credentials.
    delete env.ANTHROPIC_API_KEY;
  }
  if (opts.baseUrl) env.ANTHROPIC_BASE_URL = opts.baseUrl;

  let q: any;
  let interrupted = false;

  // Windows keeps using the bundled binary (unchanged, proven). Only non-Windows
  // falls back to the system `claude` so the .vsix isn't Windows-only there.
  const claudePath = process.platform === "win32" ? undefined : findClaudeBinary();

  // Exponential backoff over the whole query. Retries are SAFE only while the
  // turn has produced no visible output yet (no text/thinking/tools) — after
  // that a re-run would duplicate work, so mid-stream failures surface as-is.
  const MAX_ATTEMPTS = 3;
  const done = (async () => {
   for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let hadOutput = false;
   try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { query } = sdk;

    // Merge user MCP servers with our experimental in-process "super tools".
    let mcpServers: Record<string, unknown> | undefined = opts.mcpServers
      ? { ...opts.mcpServers }
      : undefined;
    const modules = opts.superModules ?? { eyes: true, hands: true, memory: true, scale: true };
    const anyModule = modules.eyes || modules.hands || modules.memory || modules.scale;
    if (opts.enableSuperTools && opts.superDev && anyModule) {
      const server = createSuperToolsServer(sdk, {
        cwd: opts.cwd,
        dev: opts.superDev,
        model: opts.model,
        env,
        modules,
        notify: opts.superNotify,
        subagentModel: opts.subagentModel,
        launchOrchestrator: opts.onLaunchOrchestrator,
      });
      mcpServers = { ...(mcpServers ?? {}), "agentide-tools": server };
    }

    q = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        env,
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        ...(opts.resume ? { resume: opts.resume } : {}),
        ...(opts.forkSession ? { forkSession: true } : {}),
        ...(opts.thinking ? { thinking: opts.thinking } : {}),
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(opts.appendSystemPrompt
          ? { systemPrompt: { type: "preset", preset: "claude_code", append: opts.appendSystemPrompt } }
          : {}),
        // Stream partial events so we can surface thinking token-by-token (live
        // shimmer) instead of one block at the end. Only when thinking is on.
        ...(opts.thinking && opts.thinking.type !== "disabled"
          ? { includePartialMessages: true }
          : {}),
        ...(mcpServers && Object.keys(mcpServers).length
          ? { mcpServers: mcpServers as any }
          : {}),
        // Keep the SDK in "default" for every non-plan mode and do ALL
        // allow/deny gating ourselves in canUseTool below. Mapping our
        // "Auto-accept" UI mode onto the SDK's own "acceptEdits" mode made the
        // SDK auto-approve edits internally but route Bash/commands through its
        // own permission path — so our canUseTool "allow" for Bash was bypassed
        // and terminals kept asking. In "default" mode canUseTool is invoked
        // for every non-readonly tool, so the acceptEdits branch below reliably
        // auto-runs commands too.
        permissionMode: opts.mode === "plan" ? "plan" : "default",
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          // AskUserQuestion: render interactive options in the panel and feed the
          // user's choice back as the (denied) tool message so the model continues.
          if (toolName === "AskUserQuestion") {
            const answer = await cb.askQuestion(input);
            return { behavior: "deny", message: `The user answered: ${answer}` } as const;
          }
          const policy = opts.toolPolicy?.(toolName, input);
          if (policy) {
            return policy.behavior === "allow"
              ? ({ behavior: "allow", updatedInput: input } as const)
              : ({ behavior: "deny", message: policy.message } as const);
          }
          if (AUTO_ALLOW.has(toolName)) {
            return { behavior: "allow", updatedInput: input } as const;
          }
          // Read-only super tools (mcp__agentide-tools__*) need no approval.
          if (
            /__(dev_server_logs|dev_server_status|project_memory_read|browser_screenshot|browser_html)$/.test(
              toolName
            )
          ) {
            return { behavior: "allow", updatedInput: input } as const;
          }
          // Ask mode: read-only — deny anything that isn't a read-only tool,
          // regardless of its name (Edit/Write/Bash/PowerShell/etc.).
          if (opts.mode === "ask") {
            return {
              behavior: "deny",
              message:
                "Read-only (Ask) mode is active — file edits and commands are disabled. Answer using the read tools only.",
            } as const;
          }
          if (EDIT_TOOLS.has(toolName)) {
            // Stage the diff for the review layer, then auto-allow the edit.
            const ok = await cb.prepareEdit(toolName, input);
            return ok
              ? ({ behavior: "allow", updatedInput: input } as const)
              : ({ behavior: "deny", message: "Denied by user." } as const);
          }
          // Auto-accept mode: run EVERYTHING (commands too) without prompting —
          // not just edits (those already auto-pass above). This is what users
          // expect from "Auto-accept"; without it, Bash/commands kept asking.
          if (opts.mode === "acceptEdits") {
            return { behavior: "allow", updatedInput: input } as const;
          }
          const ok = await cb.requestApproval(toolName, input);
          return ok
            ? ({ behavior: "allow", updatedInput: input } as const)
            : ({ behavior: "deny", message: "Denied by user." } as const);
        },
      },
    });

    if (interrupted) {
      try {
        (q as any).interrupt?.();
      } catch {
        /* ignore */
      }
      return;
    }

    // Ask the SDK for the real model list (account-specific); best-effort.
    try {
      (q as any).supportedModels?.().then((models: any[]) => {
        if (Array.isArray(models) && models.length) cb.onModels(models);
      }).catch(() => {});
    } catch {
      /* ignore */
    }

    // Plan rate-limit windows (5h / 7d) for the header gauges. EXPERIMENTAL,
    // subscription-only — best-effort, refreshed after each turn.
    const fetchLimits = () => {
      try {
        (q as any)
          .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.()
          .then((u: any) => {
            if (!u || !cb.onUsageLimits) return;
            cb.onUsageLimits({
              available: !!u.rate_limits_available,
              fiveHour: u.rate_limits?.five_hour ?? null,
              sevenDay: u.rate_limits?.seven_day ?? null,
            });
          })
          .catch(() => {});
      } catch {
        /* ignore */
      }
    };
    fetchLimits();

    // Chat context-window usage (tokens used / model max) for the composer bar.
    const fetchContext = () => {
      try {
        (q as any)
          .getContextUsage?.()
          .then((c: any) => {
            if (!c || !cb.onContext) return;
            const used = c.totalTokens ?? 0;
            const max = c.maxTokens ?? c.rawMaxTokens ?? 0;
            const pct =
              typeof c.percentage === "number"
                ? c.percentage
                : max
                  ? (used / max) * 100
                  : 0;
            cb.onContext({ used, max, pct, model: c.model });
          })
          .catch(() => {});
      } catch {
        /* ignore */
      }
    };
    fetchContext();

    // When partial streaming is on, thinking arrives token-by-token as
    // `thinking_delta` events; the final assistant message then repeats the
    // whole block. Track whether we streamed any delta so the complete-message
    // handler can skip it (avoid duplication) — but still fall back to emitting
    // the complete block if no deltas ever arrived (e.g. summary sent whole).
    const streamingThinking = !!(opts.thinking && opts.thinking.type !== "disabled");
    let sawThinkingDelta = false;

    try {
      let sentSession = false;
      for await (const message of q as AsyncIterable<any>) {
        if (!sentSession && message.session_id) {
          sentSession = true;
          cb.onSession(message.session_id);
        }
        if (message.type === "stream_event") {
          // Raw Anthropic stream event — pull live thinking deltas only; ignore
          // text deltas (text is delivered whole via the complete message).
          const ev = (message as any).event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
            const chunk = ev.delta.thinking ?? "";
            if (chunk) {
              sawThinkingDelta = true;
              hadOutput = true;
              cb.onThinking(chunk);
            }
          }
          continue;
        }
        if (message.type === "system") {
          if (message.subtype === "init") {
            cb.onInit({
              slashCommands: message.slash_commands ?? [],
              model: message.model,
            });
          } else if (message.subtype) {
            cb.onSystem(message.subtype, message);
          }
        } else if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") {
              hadOutput = true;
              cb.onText(block.text);
            } else if (block.type === "thinking") {
              // Skip if we already streamed this block via thinking_delta events.
              if (!(streamingThinking && sawThinkingDelta)) {
                hadOutput = true;
                cb.onThinking(block.thinking ?? "");
              }
            } else if (block.type === "tool_use") {
              hadOutput = true;
              cb.onToolUse(block.name, block.input, block.id);
            }
          }
        } else if (message.type === "user") {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                cb.onToolResult(
                  block.tool_use_id,
                  extractText(block.content),
                  block.is_error === true
                );
              }
            }
          }
        } else if (message.type === "result") {
          const summary =
            typeof message.result === "string" ? message.result : "(done)";
          cb.onResult(summary, message.total_cost_usd, message.usage);
          fetchLimits(); // refresh plan gauges after the turn consumed quota
          fetchContext(); // refresh chat context-window usage
        }
      }
    } catch (e: any) {
      throw e; // classified by the attempt loop below (retry vs surface)
    }
    return; // turn completed cleanly
   } catch (err: any) {
      if (interrupted) return;
      const msg = err?.message ?? String(err);
      // Transient + nothing shown yet → back off and retry the whole query.
      if (attempt < MAX_ATTEMPTS && !hadOutput && TRANSIENT_ERROR.test(msg)) {
        const delayMs = Math.round(1200 * Math.pow(2, attempt - 1)); // 1.2s → 2.4s
        log.warn(
          `transient agent error (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delayMs}ms: ${msg}`
        );
        cb.onRetry?.(attempt, MAX_ATTEMPTS, delayMs, msg);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      // Non-retriable (or out of attempts / already streamed output). Never let
      // `done` reject, or the caller's cleanup won't run → chat stuck "busy".
      log.error("agent run failed", err);
      cb.onError(msg);
      return;
   }
   }
  })();

  return {
    done,
    interrupt() {
      interrupted = true;
      try {
        (q as any)?.interrupt?.();
      } catch {
        /* ignore */
      }
    },
  };
}
