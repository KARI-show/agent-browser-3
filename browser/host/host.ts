/**
 * Agent Browser native host. Chrome launches this (native messaging) when the
 * side panel opens and kills it when the panel closes. It speaks the same
 * message protocol as the VS Code panel, so the unmodified webview bundle
 * (media/main.js) renders it, and runs the agent through src/agent.ts on the
 * user's Claude subscription. Browser tools are declared here but executed by
 * the side panel against the real tabs.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { runAgent, RunHandle } from "../../src/agent";
import { hasClaudeCredentials } from "../../src/auth";
import { ConversationStore, Conversation, ConvMsg } from "../../src/conversations";
import { log } from "../../src/log";
import { NativePort } from "./native";
import { Forwarder, Upstream, startForwarder, testProxy } from "./proxy";
import { FileMemento } from "./memento";
import { RemoteServices } from "./remote";
import {
  ALWAYS_ASK_TOOLS,
  BROWSER_SYSTEM_PROMPT,
  READ_ONLY_TOOLS,
  ToolContent,
  browserToolName,
  createBrowserToolsServer,
} from "./tools";
import { attachmentLimit, isImageAttachment, parseDataUrl, pruneAttachments, safeAttachmentName } from "./attachments";

const DATA_DIR = process.env.AGENT_BROWSER_HOME || path.join(os.homedir(), ".agent-browser");
const WORK_DIR = path.join(DATA_DIR, "work");
const UPLOAD_DIR = path.join(DATA_DIR, "attachments");
// Read lazily by the vscode stub behind src/log.ts on every write.
process.env.AGENT_BROWSER_LOG = path.join(DATA_DIR, "host.log");
fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Nothing else ever deletes an upload; without this the directory grows forever.
try {
  pruneAttachments(UPLOAD_DIR);
} catch (e) {
  log.warn(`attachment clean-up failed: ${(e as Error).message}`);
}

// Fallback shown until the SDK returns the account's real list (onModels).
const MODEL_OPTIONS = [
  { value: "default", label: "Default (recommended)" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];

type BrowserMode = "agent" | "ask" | "careful";
const MODE_OPTIONS: Array<{ value: BrowserMode; label: string; title: string }> = [
  { value: "agent", label: "Agent", title: "Browses and acts on pages itself — asks before risky steps" },
  { value: "careful", label: "Careful", title: "Asks your approval before every click, typing or navigation" },
  { value: "ask", label: "Ask", title: "Read-only — reads pages and answers, never clicks or types" },
];

// Built-in Claude Code tools the browser agent keeps. No Bash/Edit/Write: a
// prompt-injected page must not reach the user's machine. Read stays for
// attachments only (enforced in toolPolicy).
const BUILTIN_TOOLS = ["Read", "WebFetch", "WebSearch", "TodoWrite", "AskUserQuestion"];

// A browser tool that doesn't answer in this long (panel hung, page frozen)
// is failed so the run can move on instead of stalling.
const TOOL_TIMEOUT_MS = 60_000;
// Uploaded bytes travel host → panel in chunked native messages; keep it sane.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

class BrowserHost {
  private port = new NativePort(
    (m) => void this.handle(m).catch((e) => log.error(`message ${m?.type} failed`, e)),
    () => this.shutdown()
  );
  private state = new FileMemento(path.join(DATA_DIR, "state.json"));
  private conversations = new ConversationStore(this.state as any);
  private current?: Conversation;
  private runs = new Map<string, RunHandle>();
  /** Chats deleted while their run was still going (the run must not save them back). */
  private deleted = new Set<string>();
  /** The live object of every chat that has a run: reopening it must attach to THIS object, not a stored copy. */
  private running = new Map<string, Conversation>();
  /** Chats being started (between the click and the run being registered): closes the async gap a double-send slips through. */
  private starting = new Set<string>();
  /** Chats the user switched away from and back to mid-run: their tool cards are rebuilt from history, so reload once at the end. */
  private reopened = new Set<string>();
  // `card` is the message that showed the gate, re-posted when the user comes back to the chat.
  private pendingApprovals = new Map<string, { resolve: (ok: boolean) => void; convId: string; card: unknown }>();
  private pendingQuestions = new Map<string, { resolve: (answer: string) => void; convId: string; card: unknown }>();
  private pendingTools = new Map<number, (r: ToolContent) => void>();
  private toolMsgs = new Map<string, ConvMsg>();
  private toolStartTimes = new Map<string, number>();
  private seq = 0;
  private forwarder?: Forwarder;
  private remote?: RemoteServices;
  private dynamicModels?: Array<{ value: string; label: string; title?: string }>;
  private lastUsageLimits: unknown;
  private slashCommands: string[] = this.state.get<string[]>("slashCommands", []);
  private modelChoice = this.state.get<string>("model", "default");
  private modeChoice = this.state.get<BrowserMode>("mode", "agent");

  private post(m: unknown) {
    this.port.send(m);
  }

  private async handle(msg: any) {
    switch (msg.type) {
      case "ready":
        this.onReady();
        break;
      case "prompt":
        await this.onPrompt(String(msg.text ?? ""), Array.isArray(msg.attachments) ? msg.attachments : []);
        break;
      case "compact":
        await this.onPrompt("/compact", []);
        break;
      case "interrupt":
        if (this.current) this.abort(this.current.id);
        break;
      case "browserToolResult": {
        const resolve = this.pendingTools.get(msg.id);
        if (resolve) {
          this.pendingTools.delete(msg.id);
          resolve({
            content: Array.isArray(msg.content) ? msg.content : [{ type: "text", text: "(no result)" }],
            isError: msg.isError === true,
          });
        }
        break;
      }
      case "approvalResponse": {
        const p = this.pendingApprovals.get(msg.id);
        if (p) {
          this.pendingApprovals.delete(msg.id);
          p.resolve(msg.approved === true);
          this.post({ type: "approvalResolved", id: msg.id, approved: msg.approved === true });
        }
        break;
      }
      case "questionResponse": {
        const p = this.pendingQuestions.get(msg.id);
        if (p) {
          this.pendingQuestions.delete(msg.id);
          p.resolve(msg.answer || "(no answer)");
          this.post({ type: "questionResolved", id: msg.id, answer: msg.answer || "(no answer)" });
        }
        break;
      }
      // The shared chat UI's Retry / ↩ buttons. The SDK session can't be truncated from here.
      case "regenerate":
      case "rewind":
        this.post({ type: "notice", message: "Retry and rewind aren't available with the local helper yet — send a new message instead." });
        break;
      case "newChat":
        this.current = undefined;
        this.post({ type: "clear" });
        this.postModel();
        this.postMode();
        this.post({ type: "contextUsage", info: null });
        this.postConversations();
        break;
      case "listConversations":
        this.postConversations();
        break;
      case "openConversation":
        this.openConversation(String(msg.id));
        break;
      case "deleteConversation": {
        const id = String(msg.id);
        // A running chat finishes after the removal and would save itself back — remember the deletion.
        if (this.runs.has(id)) this.deleted.add(id);
        this.abort(id);
        if (this.current?.id === id) {
          this.current = undefined;
          this.post({ type: "clear" });
        }
        await this.conversations.remove(id);
        this.postConversations();
        break;
      }
      case "renameConversation": {
        const title = String(msg.title ?? "");
        await this.conversations.patch(String(msg.id), { title, renamed: true });
        const live = this.liveConversation(String(msg.id));
        if (live) Object.assign(live, { title, renamed: true });
        this.postConversations();
        break;
      }
      case "pinConversation": {
        await this.conversations.patch(String(msg.id), { pinned: !!msg.pinned });
        const live = this.liveConversation(String(msg.id));
        if (live) live.pinned = !!msg.pinned;
        this.postConversations();
        break;
      }
      case "setModel":
        this.modelChoice = String(msg.model);
        if (this.current) this.current.model = this.modelChoice;
        await this.state.update("model", this.modelChoice);
        break;
      case "setMode":
        if (MODE_OPTIONS.some((o) => o.value === msg.mode)) {
          this.modeChoice = msg.mode;
          if (this.current) this.current.mode = msg.mode;
          await this.state.update("mode", this.modeChoice);
        }
        break;
      case "pasteImage":
      case "uploadAttachment":
        this.saveAttachment(msg.name, msg.dataUrl);
        break;
      case "login":
        this.openLoginTerminal();
        this.watchForLogin();
        break;
      // The settings page asks whether the host is alive and whether Claude Code is signed in.
      case "hostPing":
        this.post({ type: "hostPong", id: msg.id, loggedIn: hasClaudeCredentials(), platform: process.platform });
        break;
      // Proxy support. The extension's service worker holds its own port to a
      // host process for the forwarder (SOCKS5 with a password, which Chrome
      // can't do itself); the options page opens a short-lived one to test.
      case "proxyStart":
        await this.proxyStart(msg);
        break;
      case "proxyTest":
        await this.proxyTest(msg);
        break;
      // Remote access without VS Code: the side panel (relay.js, "helper" mode)
      // holds a dedicated port; while it's open this process runs the relay, a
      // public tunnel and the Telegram bot, and stops them when it closes.
      case "remoteStart":
        await this.remoteStart(msg);
        break;
      case "recheckAuth":
        this.post({ type: "auth", ok: hasClaudeCredentials() });
        break;
      // Everything else in the protocol (diff review, git, remote, rules,
      // orchestrator…) is editor-only; the side panel hides those controls.
    }
  }

  private onReady() {
    if (!this.current) {
      const lastId = this.state.get<string>("activeConversationId");
      const last = lastId ? this.conversations.get(lastId) : undefined;
      if (last) this.current = last;
    }
    this.post({ type: "auth", ok: hasClaudeCredentials() });
    this.post({ type: "identity", name: "Kari" });
    this.postModel();
    this.postMode();
    this.post({ type: "settings", values: {} });
    this.post({ type: "rules", items: [] });
    this.postConversations();
    if (this.slashCommands.length) this.post({ type: "slashCommands", items: this.slashCommands });
    if (this.lastUsageLimits) this.post({ type: "usageLimits", info: this.lastUsageLimits });
    if (this.current) {
      this.post({ type: "loadConversation", convId: this.current.id, title: this.current.title, messages: this.current.messages });
    }
    this.post({ type: "contextUsage", info: this.current?.context ?? null });
    for (const id of this.runs.keys()) this.post({ type: "runState", convId: id, running: true });
  }

  private postModel() {
    this.post({
      type: "model",
      model: this.current?.model || this.modelChoice,
      options: this.dynamicModels?.length ? this.dynamicModels : MODEL_OPTIONS,
    });
  }

  private postMode() {
    this.post({ type: "mode", mode: this.current?.mode || this.modeChoice, options: MODE_OPTIONS });
  }

  private postConversations() {
    this.post({
      type: "conversations",
      items: this.conversations.list().map((c) => ({
        id: c.id,
        title: c.title,
        time: c.time,
        pinned: !!c.pinned,
        preview: (c.messages.find((m) => m.kind === "user")?.text || "").replace(/\s+/g, " ").slice(0, 90),
      })),
      activeId: this.current?.id,
    });
    void this.state.update("activeConversationId", this.current?.id);
  }

  /**
   * The in-memory copy a chat is saved from at the end of its run (or on its
   * next run, for the open chat): a patch to the stored copy alone would be
   * overwritten by that save.
   */
  private liveConversation(id: string): Conversation | undefined {
    return this.running.get(id) ?? (this.current?.id === id ? this.current : undefined);
  }

  /**
   * Stop a chat's run. A run parked on an approval or question would never see
   * the interrupt, so its gates are closed first — and the panel is told, so
   * the cards close too. The end of onPrompt still sweeps anything left over.
   */
  private abort(convId: string) {
    for (const [id, p] of this.pendingApprovals) {
      if (p.convId === convId) {
        this.pendingApprovals.delete(id);
        p.resolve(false);
        this.post({ type: "approvalResolved", id, approved: false });
      }
    }
    for (const [id, p] of this.pendingQuestions) {
      if (p.convId === convId) {
        this.pendingQuestions.delete(id);
        p.resolve("(cancelled)");
        this.post({ type: "questionResolved", id, answer: "(cancelled)" });
      }
    }
    this.runs.get(convId)?.interrupt();
  }

  private openConversation(id: string) {
    const conv = this.running.get(id) ?? this.conversations.get(id);
    if (!conv) return;
    this.current = conv;
    // convId lets the relay mirror route it: it's posted before "conversations" updates activeId.
    this.post({ type: "loadConversation", convId: conv.id, title: conv.title, messages: conv.messages });
    this.postModel();
    this.postMode();
    this.post({ type: "contextUsage", info: conv.context ?? null });
    this.postConversations();
    // A run may be going on in this chat: show Stop, and bring back the approval/question it is waiting on.
    if (this.runs.has(id)) {
      this.reopened.add(id);
      this.post({ type: "runState", convId: id, running: true });
      for (const p of this.pendingApprovals.values()) if (p.convId === id) this.post(p.card);
      for (const p of this.pendingQuestions.values()) if (p.convId === id) this.post(p.card);
    }
  }

  /** Execute a browser tool in the side panel and wait for its result. */
  private callBrowser(name: string, args: Record<string, unknown>): Promise<ToolContent> {
    if (name === "browser_upload_file") {
      // The panel can't read the host's disk: resolve the attachment here and
      // ship its bytes along. Only files the user attached are reachable.
      const file = typeof args.path === "string" ? path.resolve(args.path) : "";
      if (!file.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(file)) {
        return Promise.resolve({
          content: [{ type: "text", text: "That path is not one of the user's attached files." }],
          isError: true,
        });
      }
      const size = fs.statSync(file).size;
      if (size > MAX_UPLOAD_BYTES) {
        return Promise.resolve({
          content: [{ type: "text", text: `File is too large to upload from here (${size} bytes; limit ${MAX_UPLOAD_BYTES}).` }],
          isError: true,
        });
      }
      args = { ref: args.ref, name: path.basename(file).replace(/^[a-z0-9]+-/, ""), data: fs.readFileSync(file).toString("base64") };
    }
    return new Promise((resolve) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pendingTools.delete(id);
        resolve({ content: [{ type: "text", text: `${name} timed out after ${TOOL_TIMEOUT_MS / 1000}s` }], isError: true });
      }, TOOL_TIMEOUT_MS);
      this.pendingTools.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.post({ type: "browserTool", id, name, args });
    });
  }

  private toolPolicy(currentMode: () => BrowserMode) {
    return (toolName: string, input: Record<string, unknown>) => {
      const short = browserToolName(toolName);
      if (short) {
        const mode = currentMode();
        if (READ_ONLY_TOOLS.has(short)) return { behavior: "allow" as const };
        if (mode === "ask") {
          return {
            behavior: "deny" as const,
            message: "Read-only (Ask) mode — you can read pages and take screenshots but not click, type or navigate.",
          };
        }
        // Agent mode runs actions freely, except the tools that reach session data: those ask in every mode.
        if (mode === "agent" && !ALWAYS_ASK_TOOLS.has(short)) return { behavior: "allow" as const };
        return undefined; // approval card
      }
      if (toolName === "Read") {
        const p = typeof input.file_path === "string" ? path.resolve(input.file_path) : "";
        return p.startsWith(UPLOAD_DIR + path.sep)
          ? { behavior: "allow" as const }
          : { behavior: "deny" as const, message: "Read is limited to files the user attached." };
      }
      return undefined;
    };
  }

  private async onPrompt(text: string, attachments: string[]) {
    const atts = attachments.filter((p) => typeof p === "string" && path.resolve(p).startsWith(UPLOAD_DIR + path.sep));
    if (!text.trim() && !atts.length) return;
    // Checked and taken in one synchronous step: everything below awaits, and a second message
    // (the UI's queue sends the next one the moment a run ends) must not slip into that gap and
    // start a second run on the same history.
    const gate = this.current?.id ?? "__new__";
    if (this.starting.has(gate) || (this.current && this.runs.has(this.current.id))) {
      this.post({ type: "notice", message: "This chat is already running — wait for the reply or press Stop." });
      return;
    }
    this.starting.add(gate);
    const unlock = () => this.starting.delete(gate);
    if (!hasClaudeCredentials()) {
      unlock();
      this.post({ type: "auth", ok: false });
      this.post({ type: "error", message: "Not logged in to Claude. Click “Log in” above (runs claude login)." });
      return;
    }

    if (!this.current) {
      this.current = {
        id: "conv" + Date.now().toString(36),
        title: text.slice(0, 60) || "Attachment",
        time: Date.now(),
        messages: [],
      };
      // Listed now, so the user can switch away and back to it while this first turn runs.
      try {
        await this.conversations.save(this.current);
      } catch (e) {
        log.error("saving conversation failed", e);
      }
      this.postConversations();
    }
    const conv = this.current;
    conv.model ||= this.modelChoice;
    const mode: BrowserMode = MODE_OPTIONS.some((o) => o.value === conv.mode) ? (conv.mode as BrowserMode) : this.modeChoice;
    conv.mode = mode as Conversation["mode"];
    conv.time = Date.now();

    let prompt = text;
    if (atts.length) {
      prompt +=
        (text ? "\n\n" : "") +
        "Attached files — use the Read tool to view them (images included):\n" +
        atts.map((p) => `- ${p}`).join("\n");
    }
    const attLabel = atts.length ? `\n📎 ${atts.map((p) => path.basename(p)).join(", ")}` : "";
    conv.messages.push({ kind: "user", text: text + attLabel });

    this.post({ type: "started", model: conv.model });
    this.post({ type: "runState", convId: conv.id, running: true });

    let assistant: ConvMsg | undefined;
    let thinking: ConvMsg | undefined;
    const live = (m: unknown) => {
      if (this.current === conv) this.post(m);
    };

    let sdk: any;
    try {
      sdk = await import("@anthropic-ai/claude-agent-sdk");
    } catch (e) {
      unlock();
      log.error("Agent SDK failed to load", e);
      this.post({ type: "runState", convId: conv.id, running: false });
      this.post({ type: "error", message: "Agent SDK is missing — re-run the Agent Browser installer." });
      this.post({ type: "idle" });
      return;
    }

    const handle = runAgent(
      {
        prompt,
        cwd: WORK_DIR,
        model: conv.model,
        resume: conv.sessionId,
        mode: mode === "ask" ? "ask" : "agent",
        thinking: { type: "adaptive", display: "summarized" },
        tools: BUILTIN_TOOLS,
        appendSystemPrompt: BROWSER_SYSTEM_PROMPT,
        // Read the mode on every tool call, so switching it mid-run takes effect (as the built-in engine does).
        toolPolicy: this.toolPolicy(() => (MODE_OPTIONS.some((o) => o.value === conv.mode) ? (conv.mode as BrowserMode) : mode)),
        mcpServers: { browser: createBrowserToolsServer(sdk, (n, a) => this.callBrowser(n, a)) },
      },
      {
        onText: (t) => {
          thinking = undefined;
          if (!assistant) {
            assistant = { kind: "assistant", text: "" };
            conv.messages.push(assistant);
          }
          assistant.text += t;
          live({ type: "text", text: t });
        },
        onThinking: (t) => {
          // Streamed per delta: keep one transcript entry open and grow it (one entry per delta meant
          // hundreds of thinking bubbles and a state.json rewrite for each).
          assistant = undefined;
          if (!t.trim() && !thinking) return;
          if (!thinking) {
            thinking = { kind: "thinking", text: "" };
            conv.messages.push(thinking);
          }
          thinking.text += t;
          live({ type: "thinking", text: t });
        },
        onToolUse: (name, input, id) => {
          assistant = undefined;
          thinking = undefined;
          const msg: ConvMsg = { kind: "tool", text: `🔧 ${name}`, tool: { name, input } };
          conv.messages.push(msg);
          this.toolMsgs.set(id, msg);
          this.toolStartTimes.set(id, Date.now());
          live({ type: "tool", id, name, input });
        },
        onToolResult: (id, content, isError) => {
          const clipped = content.slice(0, 4000);
          const start = this.toolStartTimes.get(id);
          const durationMs = start ? Date.now() - start : undefined;
          this.toolStartTimes.delete(id);
          const msg = this.toolMsgs.get(id);
          this.toolMsgs.delete(id);
          if (msg?.tool) Object.assign(msg.tool, { result: clipped, isError, durationMs });
          live({ type: "toolResult", id, content: clipped, isError, durationMs });
        },
        onRetry: (attempt, max, delayMs, reason) =>
          live({
            type: "info",
            text: `⟳ Transient error — retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${max}): ${reason.slice(0, 100)}`,
          }),
        onResult: (_summary, costUsd, usage) => {
          assistant = undefined;
          conv.messages.push({ kind: "status", text: "✓ done" });
          live({ type: "result", costUsd, usage });
        },
        onError: (message) => {
          assistant = undefined;
          conv.messages.push({ kind: "error", text: message });
          live({ type: "error", message });
        },
        onSession: (sid) => {
          conv.sessionId ||= sid;
        },
        onInit: (info) => {
          if (info.slashCommands?.length) {
            this.slashCommands = info.slashCommands;
            void this.state.update("slashCommands", info.slashCommands);
            this.post({ type: "slashCommands", items: info.slashCommands });
          }
        },
        onSystem: (subtype, data) => live({ type: "system", subtype, data }),
        onModels: (models) => {
          const opts = models
            .map((m: any) => {
              const value = m.value ?? m.model ?? m.id;
              const label = m.displayName ?? m.display_name ?? m.name ?? value;
              return value ? { value: String(value), label: String(label), title: m.description } : null;
            })
            .filter(Boolean) as Array<{ value: string; label: string; title?: string }>;
          if (opts.length) {
            this.dynamicModels = opts;
            this.postModel();
          }
        },
        onUsageLimits: (info) => {
          this.lastUsageLimits = info;
          this.post({ type: "usageLimits", info });
        },
        onContext: (info) => {
          conv.context = info;
          live({ type: "contextUsage", info });
        },
        // No file edits exist in the browser tool set.
        prepareEdit: async () => false,
        requestApproval: (toolName, input) => {
          const id = `a${++this.seq}`;
          const card = { type: "approval", id, toolName, input };
          return new Promise<boolean>((resolve) => {
            this.pendingApprovals.set(id, { resolve, convId: conv.id, card });
            live(card);
          });
        },
        askQuestion: (input) => {
          const id = `q${++this.seq}`;
          const card = { type: "question", id, questions: (input as any).questions || [] };
          return new Promise<string>((resolve) => {
            this.pendingQuestions.set(id, { resolve, convId: conv.id, card });
            live(card);
          });
        },
      }
    );
    this.runs.set(conv.id, handle);
    this.running.set(conv.id, conv);
    unlock();

    await handle.done;
    this.runs.delete(conv.id);
    this.running.delete(conv.id);
    // An interrupted run leaves its gates open — close them so the chat frees.
    for (const [id, p] of this.pendingApprovals) {
      if (p.convId === conv.id) {
        this.pendingApprovals.delete(id);
        p.resolve(false);
      }
    }
    for (const [id, p] of this.pendingQuestions) {
      if (p.convId === conv.id) {
        this.pendingQuestions.delete(id);
        p.resolve("(cancelled)");
      }
    }
    this.post({ type: "runState", convId: conv.id, running: false });
    if (this.current === conv) {
      // Switched away and back mid-run: the cards were rebuilt from history without live ids, so show the finished chat afresh.
      if (this.reopened.delete(conv.id)) this.post({ type: "loadConversation", convId: conv.id, title: conv.title, messages: conv.messages });
      this.post({ type: "idle" });
    }
    this.reopened.delete(conv.id);
    if (this.deleted.delete(conv.id)) return; // deleted while it ran: don't resurrect it
    try {
      await this.conversations.save(conv);
    } catch (e) {
      log.error("saving conversation failed", e);
    }
    this.postConversations();
  }

  /** Store a pasted/uploaded file where the agent's Read tool may open it. */
  private saveAttachment(name: unknown, dataUrl: unknown) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return;
    const base = safeAttachmentName(name, parsed.mime);
    const bytes = Buffer.from(parsed.data, "base64");
    const limit = attachmentLimit(parsed.mime, base);
    if (bytes.length > limit) {
      this.post({ type: "notice", message: `That file is too large for the model (${(bytes.length / 1048576).toFixed(1)} MB; the limit for this kind of file is ${(limit / 1048576).toFixed(1)} MB).` });
      return;
    }
    const file = path.join(UPLOAD_DIR, `${Date.now().toString(36)}-${base}`);
    fs.writeFileSync(file, bytes);
    const isImage = isImageAttachment(parsed.mime, base);
    this.post({ type: "attached", path: file, name: base, isImage, src: isImage ? dataUrl : undefined });
  }

  /**
   * Run `claude login` in a visible terminal (the panel can't host one). Uses
   * the CLI bundled with the Agent SDK next to host.js — the same binary the
   * runs use — and falls back to a `claude` on PATH.
   */
  private openLoginTerminal() {
    const bundled = path.join(
      __dirname,
      "node_modules",
      "@anthropic-ai",
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      process.platform === "win32" ? "claude.exe" : "claude"
    );
    const claude = fs.existsSync(bundled) ? bundled : "claude";
    let reported = false;
    const fail = (why: unknown) => {
      if (reported) return;
      reported = true;
      log.error("login terminal failed", why);
      this.post({ type: "error", message: "Couldn't open a terminal — run `claude login` yourself, then click “I'm logged in”." });
    };
    try {
      let child;
      if (process.platform === "win32") {
        // A detached console process on Windows gets its own console window.
        child = spawn(claude, ["login"], { detached: true, stdio: "ignore" });
      } else if (process.platform === "darwin") {
        // Shell-quote the path, then escape that for the AppleScript string.
        const cmd = `'${claude.replace(/'/g, "'\\''")}' login`;
        const script = `tell application "Terminal" to do script "${cmd.replace(/(["\\])/g, "\\$1")}"`;
        child = spawn("osascript", ["-e", script, "-e", 'tell application "Terminal" to activate'], {
          detached: true,
          stdio: "ignore",
        });
      } else {
        child = spawn("x-terminal-emulator", ["-e", claude, "login"], { detached: true, stdio: "ignore" });
      }
      // A missing binary (no x-terminal-emulator, no `claude` on PATH) is not a
      // throw: spawn reports it asynchronously, and a terminal that dies at once
      // (no display, Terminal.app not scriptable) never showed the login either.
      const started = Date.now();
      child.on("error", fail);
      child.on("exit", (code) => {
        if (code && Date.now() - started < 5000) fail(`exited with code ${code}`);
      });
      child.unref();
      this.post({ type: "info", text: "Finish the login in the terminal window, then click “I'm logged in”." });
    } catch (e) {
      fail(e);
    }
  }

  private parseUpstream(raw: any): Upstream {
    const type = raw?.type === "socks5" ? "socks5" : raw?.type === "http" ? "http" : null;
    const port = Number(raw?.port);
    if (!type || typeof raw?.host !== "string" || !raw.host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Proxy settings are incomplete — need type (http or socks5), host and port.");
    }
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return { type, host: raw.host, port, username: str(raw.username), password: str(raw.password) };
  }

  private async proxyStart(msg: any) {
    try {
      await this.forwarder?.close();
      this.forwarder = undefined;
      const token = typeof msg.token === "string" && msg.token.length >= 16 ? msg.token : undefined;
      if (!token) throw new Error("Missing forwarder token.");
      this.forwarder = await startForwarder(this.parseUpstream(msg.upstream), 0, (m) => log.warn(`proxy: ${m}`), token);
      this.post({ type: "proxyReady", id: msg.id, port: this.forwarder.port });
    } catch (e) {
      log.error("proxy forwarder failed to start", e);
      this.post({ type: "proxyError", id: msg.id, message: (e as Error).message });
    }
  }

  private async proxyTest(msg: any) {
    try {
      const result = await testProxy(this.parseUpstream(msg.upstream));
      this.post({ type: "proxyTestResult", id: msg.id, result });
    } catch (e) {
      this.post({ type: "proxyTestResult", id: msg.id, result: { ok: false, message: (e as Error).message } });
    }
  }

  private async remoteStart(msg: any) {
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    try {
      this.remote?.stop();
      this.remote = new RemoteServices(DATA_DIR);
      const info = await this.remote.start({ botToken: str(msg.botToken), userId: str(msg.userId) });
      this.post({ type: "remoteReady", ...info });
    } catch (e) {
      log.error("remote access failed to start", e);
      this.remote?.stop();
      this.post({ type: "remoteError", message: (e as Error).message });
    }
  }

  private loginWatch?: ReturnType<typeof setInterval>;

  /**
   * After `claude login` is started, tell the panel as soon as the sign-in has
   * completed (in Anthropic's own flow, in the browser) so the user doesn't
   * have to press "I'm logged in". Only checks that credentials now exist —
   * their contents are never read or kept by this process.
   */
  private watchForLogin() {
    if (this.loginWatch) clearInterval(this.loginWatch);
    const stop = Date.now() + 5 * 60_000;
    this.loginWatch = setInterval(() => {
      if (hasClaudeCredentials()) {
        clearInterval(this.loginWatch);
        this.loginWatch = undefined;
        this.post({ type: "auth", ok: true });
        this.post({ type: "info", text: "Signed in to Claude." });
      } else if (Date.now() > stop) {
        clearInterval(this.loginWatch);
        this.loginWatch = undefined;
      }
    }, 2000);
  }

  private shutdown() {
    if (this.loginWatch) clearInterval(this.loginWatch);
    void this.forwarder?.close();
    this.remote?.stop(); // relay, tunnel and bot go with the panel's port
    for (const h of this.runs.values()) h.interrupt();
    // Give interrupted runs a moment to flush, then leave — Chrome expects the
    // host to exit once the panel's port is gone.
    setTimeout(() => process.exit(0), 500).unref();
  }
}

process.on("uncaughtException", (e) => log.error("uncaught", e));
process.on("unhandledRejection", (e) => log.error("unhandled rejection", e));
new BrowserHost();
