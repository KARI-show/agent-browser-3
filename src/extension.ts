import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { hasClaudeCredentials } from "./auth";
import { runAgent, RunHandle } from "./agent";
import { registerDiff } from "./diff";
import { CheckpointManager } from "./checkpoints";
import { ReviewManager } from "./review";
import { ConversationStore, Conversation, ConvMsg } from "./conversations";
import { truncateSession, deleteSessionFile } from "./rewind";
import { UsageTracker, formatCost } from "./usage";
import { exportConversation } from "./export";
import { gatherEditorContext, diagnosticsFor } from "./editorContext";
import { RulesManager } from "./rules";
import { McpManager } from "./mcp";
import { ShadowGit } from "./shadowGit";
import * as git from "./git";
import { execFile, spawn } from "child_process";
import { DevServerManager } from "./superTools";
import { OrchestratorPanel } from "./orchestratorPanel";
import { log } from "./log";
import { LocalModelManager } from "./localModel";
import { HubClient } from "./hub";
import { TunnelManager } from "./tunnel";
import * as os from "os";

// Webview message types that make up a chat's live stream — mirrored to the relay
// so a remote web client (mini-app / phone) renders the same thing in real time.
const HUB_MIRROR_TYPES = new Set([
  // chat stream — NOTE: "user" is intentionally NOT mirrored here. The user
  // echo is fanned out by onPrompt's origin-guarded this.hub.emit (local→web
  // only), so the originating view never gets its own bubble back. Adding it
  // here double-renders remote-origin messages (web draws it optimistically,
  // then post() mirrors it back).
  "text", "thinking", "tool", "toolResult", "result", "error",
  "started", "idle", "runState", "contextUsage", "usageLimits",
  "approval", "question", "info", "system",
  // UI chrome — so the web app's dropdowns / labels / lists stay 1:1
  "model", "mode", "settings", "context", "supertools", "autofix",
  "conversations", "slashCommands", "remoteState", "changes", "restored",
  "rules", "mcp", "identity",
]);

// Entry point: VS Code calls activate() when the extension is loaded
// NOTE: registration order matters — diff/checkpoints set up before the webview
export function activate(context: vscode.ExtensionContext) {
  registerDiff(context);
  // Checkpoint blobs live under globalStorage (index stays in workspaceState).
  const checkpoints = new CheckpointManager(
    context.workspaceState,
    vscode.Uri.joinPath(context.globalStorageUri, "checkpoints").fsPath
  );
  checkpoints.sweep(); // async fire-and-forget: drop >30-day-old snapshots
  const review = new ReviewManager(context, checkpoints);
  const conversations = new ConversationStore(context.workspaceState);
  const usage = new UsageTracker(context.workspaceState);
  context.subscriptions.push(usage);
  const devServer = new DevServerManager();
  context.subscriptions.push(devServer);

  // Hybrid engine: runs the bundled Anthropic↔OpenAI proxy so the agent can use
  // a local model instead of the Claude API.
  const localModel = new LocalModelManager(
    vscode.Uri.joinPath(context.extensionUri, "proxy", "anthropic-openai-proxy.mjs").fsPath
  );
  context.subscriptions.push(localModel);

  // Project rules (Cursor-style): discovered from AGENTS.md / .agentiderules /
  // .cursorrules / .cursor/rules — injected into sessions + shown in the UI.
  const rules = new RulesManager(
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    () => provider?.postRules()
  );

  // MCP servers: workspace .mcp.json / .cursor/mcp.json merged over settings.
  const mcp = new McpManager(
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    () => provider?.postMcp()
  );

  // Shadow-git deep snapshots (whole workspace, catches bash side effects).
  // One shadow repo per workspace, keyed by a hash of its path.
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const shadow = wsRoot
    ? new ShadowGit(
        wsRoot,
        vscode.Uri.joinPath(
          context.globalStorageUri,
          "shadow",
          crypto.createHash("sha1").update(wsRoot).digest("hex").slice(0, 12)
        ).fsPath
      )
    : undefined;

  // One-shot state migration: when moving between extension ids (local.* →
  // johnnysilverhe.*), workspaceState doesn't follow — chats appear "lost".
  // If a migration file exists, MERGE its conversations + checkpoints into
  // this id's state (existing ids win), then retire the file.
  void (async () => {
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const mig = path.join(root, ".agent-ide", "import-state.json");
      if (!fs.existsSync(mig)) return;
      const data = JSON.parse(fs.readFileSync(mig, "utf8"));
      let imported = 0;
      for (const conv of data.conversations ?? []) {
        if (conv?.id && !conversations.get(conv.id)) {
          await conversations.save(conv);
          imported++;
        }
      }
      const curCps = context.workspaceState.get<Record<string, unknown>>("checkpointsByConv", {});
      const oldCps = (data.checkpointsByConv ?? {}) as Record<string, unknown>;
      await context.workspaceState.update("checkpointsByConv", { ...oldCps, ...curCps });
      fs.renameSync(mig, mig + ".imported");
      if (imported) {
        vscode.window.showInformationMessage(
          `Agent IDE: imported ${imported} chat(s) from the previous install.`
        );
      }
    } catch (e) {
      log.error("state migration failed", e);
    }
  })();

  const provider = new AgentViewProvider(
    context.extensionUri,
    checkpoints,
    review,
    conversations,
    usage,
    context.workspaceState,
    devServer,
    rules,
    mcp,
    shadow
  );
  rules.watch(context);
  mcp.watch(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentViewProvider.viewId, provider)
  );

  // Status-bar HUD visibility follows the agentIde.showStatusBar setting.
  const applyStatusBar = () => {
    const on = vscode.workspace
      .getConfiguration("agentIde")
      .get<boolean>("showStatusBar", true);
    usage.setVisible(on);
  };
  applyStatusBar();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentIde.showStatusBar")) applyStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentIde.open", () =>
      vscode.commands.executeCommand("agentIde.panel.focus")
    ),
    vscode.commands.registerCommand("agentIde.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("agentIde.doctor", () => provider.doctor()),
    vscode.commands.registerCommand("agentIde.exportConversation", async () => {
      const conv = await pickConversation(provider, conversations);
      if (!conv) return;
      const uri = await exportConversation(conv);
      if (uri) {
        const open = await vscode.window.showInformationMessage(
          `Exported “${conv.title || "chat"}” to ${vscode.workspace.asRelativePath(uri)}`,
          "Open"
        );
        if (open === "Open") vscode.window.showTextDocument(uri, { preview: false });
      }
    }),
    vscode.commands.registerCommand("agentIde.restoreCheckpoint", async () => {
      const conv = provider.currentConversation;
      if (!conv) {
        vscode.window.showInformationMessage("Open a chat first — checkpoints are per chat.");
        return;
      }
      const cps = checkpoints.list(conv.id);
      if (!cps.length) {
        vscode.window.showInformationMessage("No checkpoints yet for this chat.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        cps.map((c) => ({
          label: `↩ ${c.label || "(turn)"}`,
          detail: `${new Date(c.time).toLocaleString()} · ${c.files.length} file(s)`,
          id: c.id,
        })),
        { placeHolder: "Restore the workspace to a checkpoint (before this turn's edits)" }
      );
      if (!pick) return;
      const res = await checkpoints.restore((pick as any).id);
      // Files on disk reverted — recompute the review layer so stale green
      // decorations / Changes entries don't linger.
      await provider.refreshReviewsAfterRestore();
      if (res.failed) {
        vscode.window.showWarningMessage(
          `Restored ${res.restored} file(s); ${res.failed} could not be written — ${res.errors[0] ?? "unknown error"}`
        );
      } else {
        vscode.window.showInformationMessage(`Restored ${res.restored} file(s) from checkpoint.`);
      }
    }),
    vscode.commands.registerCommand("agentIde.showUsage", async () => {
      const { cost, turns } = usage.totals();
      const msg =
        cost > 0
          ? `Workspace usage: $${formatCost(cost)} across ${turns} turn(s).`
          : `Workspace usage: ${turns} turn(s) (no per-turn cost reported — subscription auth).`;
      const choice = await vscode.window.showInformationMessage(msg, "Reset");
      if (choice === "Reset") await usage.reset();
    }),
    vscode.commands.registerCommand("agentIde.addSelectionToChat", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        vscode.window.showInformationMessage("Open a file and select some code first.");
        return;
      }
      const sel = ed.selection;
      const text = ed.document.getText(sel.isEmpty ? undefined : sel);
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      await vscode.commands.executeCommand("agentIde.panel.focus");
      provider.insertContext({
        rel,
        lang: ed.document.languageId,
        startLine: sel.start.line + 1,
        endLine: sel.isEmpty ? ed.document.lineCount : sel.end.line + 1,
        text,
      });
    }),
    vscode.commands.registerCommand("agentIde.gitCommit", () => provider.commitFlow()),
    vscode.commands.registerCommand("agentIde.orchestrate", () => provider.launchOrchestrator()),
    vscode.commands.registerCommand("agentIde.remote", () => provider.startRemote()),
    vscode.commands.registerCommand("agentIde.showLogs", () => log.show()),
    vscode.commands.registerCommand("agentIde.startLocalModel", async () => {
      const cfg = vscode.workspace.getConfiguration("agentIde");
      const upstream = cfg.get<string>("localModelUpstream") || "http://127.0.0.1:1234/v1";
      const port = cfg.get<number>("localModelPort") || 8787;
      const model = cfg.get<string>("localModelId") || "";
      localModel.start({ port, upstream, model });
      // Point the whole extension at the proxy — new messages use the local model.
      await cfg.update("baseUrl", localModel.baseUrl, vscode.ConfigurationTarget.Global);
      vscode.window
        .showInformationMessage(
          `🔌 Local model engine on ${localModel.baseUrl} → ${upstream}. New messages now use your local model.`,
          "Show Logs"
        )
        .then((c) => {
          if (c === "Show Logs") log.show();
        });
    }),
    vscode.commands.registerCommand("agentIde.stopLocalModel", async () => {
      localModel.stop();
      const cfg = vscode.workspace.getConfiguration("agentIde");
      // Only clear baseUrl if it's still pointing at our proxy (don't clobber a
      // manually-configured endpoint).
      if (cfg.get<string>("baseUrl") === localModel.baseUrl) {
        await cfg.update("baseUrl", "", vscode.ConfigurationTarget.Global);
      }
      vscode.window.showInformationMessage(
        "🔌 Local model engine stopped — back to the Claude API / subscription."
      );
    }),
    { dispose: () => provider.disposeRemote() },
    { dispose: () => log.dispose() }
  );
  log.info("Agent IDE activated (v" + (context.extension.packageJSON.version ?? "?") + ")");
}

/** Resolve a conversation to act on: the active one, else let the user pick. */
async function pickConversation(
  provider: AgentViewProvider,
  store: ConversationStore
): Promise<Conversation | undefined> {
  if (provider.currentConversation) return provider.currentConversation;
  const all = store.list();
  if (!all.length) {
    vscode.window.showInformationMessage("No conversations to export yet.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    all.map((c) => ({ label: c.title || "(untitled)", detail: new Date(c.time).toLocaleString(), id: c.id })),
    { placeHolder: "Pick a conversation to export" }
  );
  return pick ? store.get((pick as any).id) : undefined;
}

export function deactivate() {}

// Fallback shown until the SDK returns the account's real list (onModels).
const MODEL_OPTIONS = [
  { value: "default", label: "Default (recommended)" },
  { value: "opus[1m]", label: "Opus 4.8 · 1M" },
  { value: "sonnet", label: "Sonnet 4.6" },
  { value: "haiku", label: "Haiku 4.5" },
];

const MODE_OPTIONS = [
  { value: "agent", label: "Agent", title: "Reads & edits files, runs commands (with review)" },
  { value: "ask", label: "Ask", title: "Read-only — answers without editing or running commands" },
  { value: "plan", label: "Plan", title: "Plans the work first, makes no edits" },
  { value: "acceptEdits", label: "Auto-accept", title: "Runs edits AND commands automatically — never asks for approval" },
];

class AgentViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "agentIde.panel";

  private view?: vscode.WebviewView;
  private pendingApprovals = new Map<
    string,
    { resolve: (ok: boolean) => void; convId: string; toolName: string; input: any }
  >();
  private approvalSeq = 0;
  private pendingQuestions = new Map<
    string,
    { resolve: (answer: string) => void; convId: string; questions: any }
  >();
  private questionSeq = 0;
  // In-UI confirmation prompts (rewind etc.) — rendered in the webview/web app
  // instead of a native VS Code dialog, so they work from the remote client too.
  private pendingConfirms = new Map<
    string,
    { resolve: (value: string | undefined) => void; convId: string }
  >();
  private confirmSeq = 0;

  private current?: Conversation;
  /** Active runs keyed by conversation id — parallel chats each get their own
   *  run (but only ONE per chat). Value holds the handle + the LIVE conv object
   *  the run appends to (so returning to a running chat shows its progress). */
  private runs = new Map<string, { handle: RunHandle; conv: Conversation }>();
  /** Sync relay client (remote access from the mini-app / phone). Lazily
   *  created by the "Remote" command. */
  private hub?: HubClient;
  /** Auto-spawned local relay (when no relayUrl is configured) for zero-config
   *  same-machine / browser testing. */
  private localRelay?: ReturnType<typeof spawn>;
  /** Auto cloudflared tunnel → public HTTPS for the remote link (no domain). */
  private tunnel?: TunnelManager;
  /** Telegram bot child process (navigation: folders → chats → Mini App). */
  private bot?: ReturnType<typeof spawn>;
  /** The public URL the running bot was started with (it bakes it into links). */
  private botPublicUrl?: string;
  private remoteOn = false;
  /** The panel's message handler, reused for messages from remote web clients. */
  private handleMessage?: (msg: any) => void | Promise<void>;
  /** tool_use id → its stored ConvMsg, so onToolResult can attach output to the
   *  saved tool message (for rich rebuild on reload). */
  private toolMsgs = new Map<string, ConvMsg>();
  /** tool_use id → start timestamp (ms), to measure how long each tool ran. */
  private toolStartTimes = new Map<string, number>();
  /** Last plan rate-limit windows (5h/7d) for the header gauges; re-posted on
   *  webview (re)init so the gauges survive a reload. */
  private lastUsageLimits?: unknown;
  private modelChoice = "default";
  private modeChoice: "agent" | "ask" | "plan" | "acceptEdits" = "agent";
  private slashCommands: string[] = [];
  private dynamicModels?: { value: string; label: string; title?: string }[];
  // Auto-fix loop: bounded rounds of "agent edits → read diagnostics → fix".
  // Keyed per conversation so parallel chats don't share (and corrupt) each
  // other's round counter or "tests already ran" flag.
  private autoFixRound = new Map<string, number>();
  private testRan = new Set<string>();
  // Watchdog/transient auto-resume budget per chat (reset by a manual prompt).
  private autoResumeCount = new Map<string, number>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly checkpoints: CheckpointManager,
    private readonly review: ReviewManager,
    private readonly conversations: ConversationStore,
    private readonly usage: UsageTracker,
    private readonly state: vscode.Memento,
    private readonly devServer: DevServerManager,
    private readonly rules: RulesManager,
    private readonly mcp: McpManager,
    private readonly shadow?: ShadowGit
  ) {
    this.slashCommands = state.get<string[]>("slashCommands", []);
  }

  /** Push the merged MCP server list to every connected view. */
  postMcp() {
    this.post({ type: "mcp", items: this.mcp.list() });
  }

  /**
   * One-shot health check of everything the agent depends on. Results land in
   * the chat (if open), a notification, and the output channel.
   */
  async doctor() {
    const results: { name: string; ok: boolean; detail: string }[] = [];
    const check = (name: string, ok: boolean, detail: string) =>
      results.push({ name, ok, detail });

    check(
      "Auth",
      this.isAuthed(),
      this.isAuthed() ? "claude login OK" : "not logged in — run claude login"
    );
    check(
      "Workspace",
      !!vscode.workspace.workspaceFolders?.length,
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "no folder open"
    );

    const which = (cmd: string, args: string[]) =>
      new Promise<string | null>((resolve) => {
        execFile(cmd, args, { timeout: 10_000 }, (err, stdout) =>
          resolve(err ? null : stdout.trim().split("\n")[0])
        );
      });
    const gitV = await which("git", ["--version"]);
    check("git (shadow checkpoints)", !!gitV, gitV ?? "git not found — deep restore disabled");
    const nodeV = await which("node", ["--version"]);
    check("node (MCP stdio servers)", !!nodeV, nodeV ?? "node not found — npx MCP servers can't start");

    const mcpList = this.mcp.list();
    check(
      "MCP config",
      true,
      mcpList.length ? mcpList.map((s) => `${s.name} (${s.transport})`).join(", ") : "no servers configured"
    );
    check(
      "Rules",
      true,
      this.rules.activeNames().join(", ") || "no rules files"
    );
    check(
      "Relay",
      !this.remoteOn || !!this.hub?.connected,
      this.remoteOn ? (this.hub?.connected ? "connected" : "ON but disconnected!") : "off"
    );

    const bad = results.filter((r) => !r.ok);
    const lines = results
      .map((r) => `${r.ok ? "✅" : "❌"} ${r.name}: ${r.detail}`)
      .join("\n");
    log.info("doctor:\n" + lines);
    this.post({ type: "info", text: `⚕ Doctor\n${lines}` });
    if (bad.length) {
      vscode.window
        .showWarningMessage(`Agent doctor: ${bad.length} issue(s) — ${bad.map((b) => b.name).join(", ")}`, "Show log")
        .then((a) => a && log.show());
    } else {
      vscode.window.showInformationMessage("Agent doctor: all systems go ✅");
    }
  }

  /** Push the current project-rules list to every connected view. */
  postRules() {
    const items = this.rules.list().map((f) => ({
      name: f.name,
      path: f.path,
      chars: f.chars,
      native: f.native,
    }));
    this.post({ type: "rules", items });
  }

  /** The active conversation, if any (used by commands outside the panel). */
  get currentConversation(): Conversation | undefined {
    return this.current;
  }

  /** Recompute the review layer after a checkpoint restore so stale green
   *  decorations / Changes entries don't linger on reverted files. */
  async refreshReviewsAfterRestore() {
    this.review.clearAll();
    await this.review.rehydrate(this.current?.changes || []);
  }

  // ---- remote sync (relay) ---------------------------------------------------
  private nodeId(): string {
    let id = this.state.get<string>("nodeId");
    if (!id) {
      id = "node-" + crypto.randomBytes(5).toString("hex");
      void this.state.update("nodeId", id);
    }
    return id;
  }

  private hubPresence(): { workspace: unknown; chats: unknown[] } {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const workspace = folder
      ? { id: folder.uri.toString(), name: folder.name, path: folder.uri.fsPath }
      : null;
    const chats = this.conversations
      .list()
      .map((c) => ({ id: c.id, title: c.title, time: c.time }));
    return { workspace, chats };
  }

  /** "Agent IDE: Remote" — connect to the relay and hand out a web link to the
   *  CURRENT chat (same UI + live process, in a browser / Telegram mini-app). */
  async startRemote() {
    const cfg = vscode.workspace.getConfiguration("agentIde");
    let token = (cfg.get<string>("relayToken") || "").trim();
    let relayUrl = (cfg.get<string>("relayUrl") || "").trim();
    // No active chat required — the bot navigates all folders/chats itself.
    // Zero-config: auto-generate the auth token on first use (persisted so the
    // relay + clients share it), and spin up a LOCAL relay if none is set —
    // works for same-machine / browser testing with one click. For phone access,
    // set agentIde.relayUrl to a host with a public IP.
    if (!token) {
      token = crypto.randomBytes(16).toString("hex");
      await cfg.update("relayToken", token, vscode.ConfigurationTarget.Global);
    }
    // hubRelayUrl = where the NODE connects (local or your central relay).
    // linkBase    = the http(s) origin the web client / phone opens.
    let hubRelayUrl = relayUrl;
    let linkBase: string;
    if (relayUrl) {
      // Central relay you host — node connects there, link points there.
      linkBase = relayUrl.replace(/^ws/, "http").replace(/\/+$/, "");
    } else {
      // Zero-config: local relay + a public cloudflared tunnel (no domain).
      const port = 8790;
      await this.ensureLocalRelay(port, token);
      hubRelayUrl = `ws://127.0.0.1:${port}`;
      if (!this.tunnel) {
        this.tunnel = new TunnelManager(path.join(os.homedir(), ".agent-ide", "bin"));
      }
      const cfPath = (cfg.get<string>("cloudflaredPath") || "").trim() || undefined;
      try {
        linkBase = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Agent IDE: opening public tunnel (cloudflared)…",
          },
          () => this.tunnel!.ensure(port, cfPath)
        );
      } catch (e: any) {
        log.error("tunnel failed", e);
        vscode.window.showWarningMessage(
          "Couldn't open a public tunnel — link is local-only. " + (e?.message ?? e)
        );
        linkBase = `http://127.0.0.1:${port}`;
      }
    }
    if (!this.hub) {
      const folderName = vscode.workspace.workspaceFolders?.[0]?.name ?? "ws";
      this.hub = new HubClient(
        { relayUrl: hubRelayUrl, token, nodeId: this.nodeId(), nodeName: `${os.hostname()}/${folderName}` },
        {
          onClientMessage: (_clientId, msg) => void this.onHubClientMessage(msg),
          presence: () => this.hubPresence(),
          onState: (on) => {
            if (on) this.hub?.publishPresence();
          },
        }
      );
      this.hub.connect();
    } else {
      this.hub.publishPresence();
    }
    // Run the Telegram bot (asks for token + your TG id if not set yet).
    await this.ensureBot(hubRelayUrl, token, linkBase);
    this.remoteOn = true;
    this.post({ type: "remoteState", on: true });
    // Per-chat link is a bonus when a chat is open; the bot is the main entry.
    if (this.current) {
      const link =
        `${linkBase}/app?token=${encodeURIComponent(token)}` +
        `&node=${encodeURIComponent(this.nodeId())}&chat=${encodeURIComponent(this.current.id)}`;
      await vscode.env.clipboard.writeText(link);
      const choice = await vscode.window.showInformationMessage(
        `🛰 Remote ON — link for “${this.current.title || "chat"}” copied. Or open your Telegram bot.`,
        "Open",
        "Copy again"
      );
      if (choice === "Open") vscode.env.openExternal(vscode.Uri.parse(link));
      else if (choice === "Copy again") await vscode.env.clipboard.writeText(link);
    } else {
      vscode.window.showInformationMessage("🛰 Remote ON — open your Telegram bot to pick a folder/chat.");
    }
  }

  /** Turn remote off — stop bot/tunnel/relay/hub. */
  stopRemote() {
    this.disposeRemote();
    this.hub = undefined;
    this.tunnel = undefined;
    this.bot = undefined;
    this.localRelay = undefined;
    this.remoteOn = false;
    this.post({ type: "remoteState", on: false });
    vscode.window.showInformationMessage("🛰 Remote OFF.");
  }

  /** Toggle remote from the panel button. */
  toggleRemote() {
    if (this.remoteOn) this.stopRemote();
    else void this.startRemote();
  }

  /** A web client (mini-app/phone) sent a webview-protocol message via the relay. */
  private async onHubClientMessage(msg: any) {
    if (!msg || typeof msg.type !== "string") return;
    const chatId: string | undefined = msg.chatId;
    switch (msg.type) {
      case "ready":
        // Make the requested chat active, then send the FULL UI state so the
        // web app's dropdowns/labels/lists populate exactly like the panel.
        if (chatId && chatId !== this.current?.id) await this.openConversation(chatId);
        this.sendChatStateToHub(chatId || this.current?.id || "");
        break;
      case "prompt":
        if (chatId && chatId !== this.current?.id) await this.openConversation(chatId);
        this.onPrompt(msg.text, msg.attachments, false, "remote");
        break;
      case "interrupt":
        if (chatId) this.runs.get(chatId)?.handle.interrupt();
        break;
      default:
        // Everything else (setMode, setModel, setContextOpt, toggleSuperTools,
        // toggleAutoFix, newChat, branch, openConversation, listConversations,
        // compact, …) goes through the SAME handler the panel uses — so every
        // button works from the web app too. Responses post() → mirrored to hub.
        // id-keyed responses don't belong to the active view — don't yank the
        // desktop's current chat just because the phone answered an approval.
        const noSwitch =
          msg.type === "newChat" ||
          msg.type === "approvalResponse" ||
          msg.type === "questionResponse" ||
          msg.type === "confirmResponse";
        if (chatId && chatId !== this.current?.id && !noSwitch) {
          await this.openConversation(chatId);
        }
        await this.handleMessage?.(msg);
        break;
    }
  }

  /** Push a chat's full UI state to relay subscribers so the web app renders 1:1. */
  private sendChatStateToHub(chatId: string) {
    if (!this.hub) return;
    const conv = chatId ? this.runs.get(chatId)?.conv ?? this.conversations.get(chatId) : this.current;
    const cid = chatId || this.current?.id || "";
    if (!conv || !cid) return;
    this.hub.emit(cid, { type: "loadConversation", title: conv.title, messages: conv.messages });
    this.hub.emit(cid, { type: "contextUsage", info: conv.context ?? null });
    this.hub.emit(cid, { type: "runState", convId: cid, running: this.runs.has(cid) });
    if (this.lastUsageLimits) this.hub.emit(cid, { type: "usageLimits", info: this.lastUsageLimits });
    // UI chrome so dropdowns/labels/lists populate (mirror what the panel gets).
    this.hub.emit(cid, { type: "remoteState", on: this.remoteOn });
    this.withHubChat(cid, () => {
      this.postModel();
      this.postMode();
      this.postContext();
      this.postSettings();
      this.postSuperTools();
      this.postAutoFix();
      this.postConversations();
      this.postChanges(); // pending file diffs, so they show in a late-joining web app
      if (this.slashCommands.length) this.post({ type: "slashCommands", items: this.slashCommands });
      // Re-emit any approval/question gate raised BEFORE this web client joined,
      // so a late-joining mini-app gets the Allow/Deny data instead of showing a
      // dataless card stuck in the pulsing "awaiting approval" state.
      this.flushPending(cid);
    });
  }

  /** Run post* calls and mirror their output to a specific hub chat channel. */
  private hubChatId?: string;
  private withHubChat(chatId: string, fn: () => void) {
    this.hubChatId = chatId;
    try {
      fn();
    } finally {
      this.hubChatId = undefined;
    }
  }

  /** Spawn the bundled relay locally (Electron-as-node) if not already running. */
  private ensureLocalRelay(port: number, token: string): Promise<void> {
    if (this.localRelay && this.localRelay.exitCode === null) return Promise.resolve();
    const relayPath = vscode.Uri.joinPath(this.extensionUri, "relay", "hub.mjs").fsPath;
    const cp = spawn(process.execPath, [relayPath], {
      cwd: this.extensionUri.fsPath, // so `import "ws"` resolves from node_modules
      // Loopback only: the tunnel reaches it on 127.0.0.1, the LAN has no business here.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", RELAY_TOKEN: token, PORT: String(port), RELAY_HOST: "127.0.0.1" },
    });
    this.localRelay = cp;
    cp.stdout?.on("data", (d) => log.info("relay: " + String(d).trim()));
    cp.stderr?.on("data", (d) => log.warn("relay: " + String(d).trim()));
    cp.on("exit", (code) => log.info("relay exited (" + code + ")"));
    cp.on("error", (e) => log.error("relay spawn failed", e));
    return new Promise((res) => setTimeout(res, 700)); // give it a moment to bind
  }

  /** Spawn the Telegram bot — navigation from the phone. If the bot token / your
   *  Telegram user id aren't set yet, ASK for them right here (both required) and
   *  persist them, so enabling remote "just works" with no trip to Settings. */
  private async ensureBot(relayWsUrl: string, token: string, publicUrl: string) {
    const cfg = vscode.workspace.getConfiguration("agentIde");
    let botToken = (cfg.get<string>("botToken") || "").trim();
    let tgUserId = (cfg.get<string>("telegramUserId") || "").trim();

    if (!botToken) {
      botToken =
        (
          await vscode.window.showInputBox({
            title: "Telegram bot token (1/2)",
            prompt: "Paste the token from @BotFather. Required to run the Telegram bot.",
            placeHolder: "123456789:AAE…",
            ignoreFocusOut: true,
            password: true,
            validateInput: (v) =>
              /^\d+:[\w-]{20,}$/.test((v || "").trim()) ? null : "That doesn't look like a BotFather token.",
          })
        )?.trim() || "";
      if (botToken) await cfg.update("botToken", botToken, vscode.ConfigurationTarget.Global);
    }
    if (botToken && !tgUserId) {
      tgUserId =
        (
          await vscode.window.showInputBox({
            title: "Your Telegram user id (2/2)",
            prompt: "Numeric id from @userinfobot — the bot only ever responds to this id.",
            placeHolder: "7407853189",
            ignoreFocusOut: true,
            validateInput: (v) =>
              /^\d{5,}$/.test((v || "").trim()) ? null : "User id must be numeric.",
          })
        )?.trim() || "";
      if (tgUserId) await cfg.update("telegramUserId", tgUserId, vscode.ConfigurationTarget.Global);
    }
    if (!botToken || !tgUserId) {
      // User dismissed a required prompt — the bot can't run without both.
      log.info(`bot not started: botToken=${botToken ? "set" : "EMPTY"} telegramUserId=${tgUserId ? "set" : "EMPTY"}`);
      vscode.window.showWarningMessage(
        "Telegram bot not started — both the bot token and your Telegram user id are required."
      );
      return;
    }
    if (this.bot && this.bot.exitCode === null) {
      if (this.botPublicUrl === publicUrl) return; // already running
      // The tunnel was regenerated: the running bot would keep handing out
      // Mini App links to the dead URL. Restart it with the new one.
      this.bot.kill();
    }
    const botPath = vscode.Uri.joinPath(this.extensionUri, "relay", "bot.mjs").fsPath;
    const cp = spawn(process.execPath, [botPath], {
      cwd: this.extensionUri.fsPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        BOT_TOKEN: botToken,
        TG_USER_ID: tgUserId,
        RELAY_URL: relayWsUrl,
        RELAY_TOKEN: token,
        PUBLIC_URL: publicUrl,
      },
    });
    this.bot = cp;
    this.botPublicUrl = publicUrl;
    cp.stdout?.on("data", (d) => log.info("bot: " + String(d).trim()));
    cp.stderr?.on("data", (d) => log.warn("bot: " + String(d).trim()));
    cp.on("exit", (code) => log.info("bot exited (" + code + ")"));
    cp.on("error", (e) => log.error("bot spawn failed", e));
    log.info("Telegram bot started");
    vscode.window.showInformationMessage(
      "🤖 Telegram bot started — open it and press Start (it messages only your id)."
    );
  }

  /** Tear down remote resources (hub client + local relay). */
  disposeRemote() {
    try {
      this.hub?.dispose();
    } catch {
      /* ignore */
    }
    try {
      this.tunnel?.dispose();
    } catch {
      /* ignore */
    }
    try {
      this.bot?.kill();
    } catch {
      /* ignore */
    }
    try {
      this.localRelay?.kill();
    } catch {
      /* ignore */
    }
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // Allow loading bundled assets AND workspace files (so attached/pasted
      // images can be shown inline in the chat via asWebviewUri).
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
        ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
      ],
    };
    view.webview.html = this.html(view.webview);

    this.handleMessage = async (msg: any) => {
      switch (msg.type) {
        case "ready":
          // Webview is now listening — (re)send initial state.
          // Restore the last-active conversation after a window/host reload:
          // this.current is per-instance and is lost when the extension host
          // restarts, so re-hydrate it from the persisted active id.
          if (!this.current) {
            const lastId = this.state.get<string>("activeConversationId");
            const last = lastId ? this.conversations.get(lastId) : undefined;
            if (last) {
              this.current = JSON.parse(JSON.stringify(last)) as Conversation;
              if (last.model) this.modelChoice = last.model;
              if (last.mode) this.modeChoice = last.mode;
            }
          }
          this.post({ type: "auth", ok: this.isAuthed() });
          this.postModel();
          this.postMode();
          this.postAutoFix();
          this.postSuperTools();
          this.postContext();
          this.postSettings();
          this.postChanges();
          this.postConversations();
          this.postRules();
          this.postMcp();
          this.post({
            type: "identity",
            name: vscode.workspace
              .getConfiguration("agentIde")
              .get<string>("assistantName", "Kari"),
          });
          if (this.lastUsageLimits) {
            this.post({ type: "usageLimits", info: this.lastUsageLimits });
          }
          if (this.slashCommands.length) {
            this.post({ type: "slashCommands", items: this.slashCommands });
          }
          if (this.current) {
            this.post({
              type: "loadConversation",
              title: this.current.title,
              messages: this.current.messages,
            });
            await this.review.rehydrate(this.current.changes || []);
          }
          this.post({ type: "contextUsage", info: this.current?.context ?? null });
          // Re-announce every chat that's currently running (tab spinners).
          for (const id of this.runs.keys()) {
            this.post({ type: "runState", convId: id, running: true });
          }
          this.post({ type: "remoteState", on: this.remoteOn });
          break;
        case "prompt":
          this.onPrompt(msg.text, msg.attachments);
          break;
        case "openRules": {
          // Open an existing rules file for editing.
          if (msg.path) {
            vscode.window.showTextDocument(vscode.Uri.file(msg.path), { preview: false });
          }
          break;
        }
        case "createRules": {
          const abs = await this.rules.createDefault();
          if (abs) {
            vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false });
            this.postRules();
          }
          break;
        }
        case "openMcp": {
          // Open (creating from the template if needed) the workspace .mcp.json.
          const p = await this.mcp.createDefault();
          if (p) {
            vscode.window.showTextDocument(vscode.Uri.file(p), { preview: false });
            this.postMcp();
          }
          break;
        }
        case "attachFile": {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: "Attach",
          });
          for (const uri of picked || []) {
            const p = uri.fsPath;
            const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p);
            this.post({
              type: "attached",
              path: p,
              name: p.split(/[\\/]/).pop(),
              isImage,
              src: isImage ? this.webviewSrc(p) : undefined,
            });
          }
          break;
        }
        case "pasteImage": {
          const saved = await this.saveClipImage(msg.dataUrl);
          if (saved) {
            this.post({
              type: "attached",
              path: saved,
              name: saved.split(/[\\/]/).pop(),
              isImage: true,
              src: this.webviewSrc(saved),
            });
          }
          break;
        }
        case "uploadAttachment": {
          // A remote web client (phone / Mac browser) uploaded a file's bytes —
          // save them to the workspace and echo the chip to the WEB client (with a
          // browser-loadable data-URL thumbnail, not a vscode-webview src).
          const saved = await this.saveUpload(msg.name, msg.dataUrl);
          if (saved) {
            const isImage =
              /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(saved) ||
              /^data:image\//.test(msg.dataUrl || "");
            const attached = {
              type: "attached",
              path: saved,
              name: saved.split(/[\\/]/).pop(),
              isImage,
              src: isImage ? msg.dataUrl : undefined,
            };
            // Echo to the chat's web subscribers (the uploader sees its own chip).
            if (this.hub) this.hub.emit(this.current?.id ?? "", attached);
          }
          break;
        }
        case "approvalResponse": {
          const p = this.pendingApprovals.get(msg.id);
          if (p) {
            this.pendingApprovals.delete(msg.id);
            p.resolve(msg.approved === true);
            // Tell EVERY view (this panel + any web clients on that chat) to
            // close this approval card — otherwise the device that didn't click
            // keeps showing a live Allow/Deny for an already-resolved request.
            const resolved = { type: "approvalResolved", id: msg.id, approved: msg.approved === true };
            this.post(resolved);
            this.hub?.emit(p.convId, resolved);
          }
          break;
        }
        case "questionResponse": {
          const p = this.pendingQuestions.get(msg.id);
          if (p) {
            this.pendingQuestions.delete(msg.id);
            p.resolve(msg.answer || "(no answer)");
            const resolved = { type: "questionResolved", id: msg.id, answer: msg.answer || "(no answer)" };
            this.post(resolved);
            this.hub?.emit(p.convId, resolved);
          }
          break;
        }
        case "confirmResponse": {
          const p = this.pendingConfirms.get(msg.id);
          if (p) {
            this.pendingConfirms.delete(msg.id);
            p.resolve(typeof msg.value === "string" ? msg.value : undefined);
            const resolved = { type: "confirmResolved", id: msg.id };
            this.post(resolved);
            this.hub?.emit(p.convId, resolved);
          }
          break;
        }
        case "interrupt":
          // Stop the run for the chat you're looking at.
          if (this.current) this.runs.get(this.current.id)?.handle.interrupt();
          break;
        case "login": {
          const bundled = this.bundledClaudePath();
          if (process.platform === "win32") {
            const term = vscode.window.createTerminal({
              name: "Claude login",
              shellPath: "powershell.exe",
            });
            term.show();
            term.sendText(bundled ? `& "${bundled}" login` : "claude login");
          } else {
            const term = vscode.window.createTerminal("Claude login");
            term.show();
            term.sendText(bundled ? `"${bundled}" login` : "claude login");
          }
          break;
        }
        case "recheckAuth":
          this.post({ type: "auth", ok: this.isAuthed() });
          break;
        case "newChat":
          this.newChat();
          break;
        case "compact":
          // Summarize the conversation to free context (SDK /compact command).
          this.onPrompt("/compact");
          break;
        case "remote":
          this.toggleRemote();
          break;
        case "branch":
          this.branch();
          break;
        case "rewind":
          await this.rewind(msg.userIndex);
          break;
        case "listConversations":
          this.postConversations();
          break;
        case "openConversation":
          this.openConversation(msg.id);
          break;
        case "openChange":
          vscode.commands.executeCommand(
            "agentIde.openReviewDiff",
            vscode.Uri.file(msg.path)
          );
          break;
        case "revertChange":
          vscode.commands.executeCommand("agentIde.revertFile", vscode.Uri.file(msg.path));
          break;
        case "keepChange":
          vscode.commands.executeCommand("agentIde.keepFile", vscode.Uri.file(msg.path));
          break;
        case "revertHunk":
          await this.review.revertHunkByPath(msg.path, msg.hunkIndex);
          break;
        case "keepHunk":
          await this.review.keepHunkByPath(msg.path, msg.hunkIndex);
          break;
        case "openFile":
          vscode.window.showTextDocument(vscode.Uri.file(msg.path), { preview: false });
          break;
        case "openTerminal": {
          // Pop a Bash/PowerShell tool card out into a REAL VS Code terminal
          // (native xterm — ANSI colors, scrollback, and draggable into its own
          // editor group / window). Output is post-facto (the SDK returns the
          // command result in one shot, it doesn't stream partial stdout).
          const m = this.toolMsgs.get(msg.id);
          const t = m?.tool;
          if (!t) break;
          const command =
            typeof (t.input as any)?.command === "string"
              ? (t.input as any).command
              : t.name;
          const title =
            (typeof (t.input as any)?.description === "string" && (t.input as any).description) ||
            command ||
            "Terminal";
          this.openInTerminal(title, command, t.result ?? "", !!t.isError, t.durationMs);
          break;
        }
        case "deleteConversation": {
          const conv = this.conversations.get(msg.id);
          // Stop and drop any run that belongs to the chat being deleted.
          const run = this.runs.get(msg.id);
          if (run) {
            run.handle.interrupt();
            this.runs.delete(msg.id);
            this.post({ type: "runState", convId: msg.id, running: false });
          }
          if (this.current?.id === msg.id) {
            this.current = undefined;
            this.post({ type: "clear" });
            this.postModel();
            this.postMode();
            this.postChanges();
          }
          await this.conversations.remove(msg.id);
          if (conv?.sessionId) {
            deleteSessionFile(conv.sessionId); // remove SDK session file
            const owned = this.ownedSessions();
            if (owned.delete(conv.sessionId)) {
              await this.state.update("ownedSessions", [...owned]);
            }
          }
          this.postConversations();
          break;
        }
        case "listCheckpoints":
          this.postCheckpoints();
          break;
        case "restore": {
          await this.restoreCheckpoint3(msg.id);
          break;
        }
        case "setModel":
          this.modelChoice = msg.model;
          if (this.current) this.current.model = msg.model;
          this.usage.setModel(msg.model);
          break;
        case "setMode":
          this.modeChoice = msg.mode;
          if (this.current) this.current.mode = msg.mode;
          break;
        case "renameConversation": {
          await this.conversations.patch(msg.id, { title: msg.title, renamed: true });
          const cur = this.current;
          if (cur && cur.id === msg.id) {
            cur.title = msg.title;
            cur.renamed = true;
          }
          this.postConversations();
          break;
        }
        case "pinConversation": {
          await this.conversations.patch(msg.id, { pinned: !!msg.pinned });
          const cur = this.current;
          if (cur && cur.id === msg.id) cur.pinned = !!msg.pinned;
          this.postConversations();
          break;
        }
        case "regenerate":
          await this.regenerate();
          break;
        case "searchFiles":
          await this.searchFiles(msg.query || "");
          break;
        case "addPathAttachment":
          for (const p of (msg.paths || []) as string[]) {
            const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p);
            this.post({
              type: "attached",
              path: p,
              name: p.split(/[\\/]/).pop(),
              isImage,
              src: isImage ? this.webviewSrc(p) : undefined,
            });
          }
          break;
        case "gitCommit":
          await this.commitFlow();
          break;
        case "orchestrate":
          await this.launchOrchestrator(msg.goal);
          break;
        case "toggleAutoFix": {
          const cfg = vscode.workspace.getConfiguration("agentIde");
          const next = !cfg.get<boolean>("autoFixDiagnostics", false);
          await cfg.update("autoFixDiagnostics", next, vscode.ConfigurationTarget.Global);
          this.postAutoFix();
          break;
        }
        case "toggleSuperTools": {
          const cfg = vscode.workspace.getConfiguration("agentIde");
          const next = !cfg.get<boolean>("superTools", false);
          await cfg.update("superTools", next, vscode.ConfigurationTarget.Global);
          this.postSuperTools();
          this.postSettings();
          break;
        }
        case "setSetting": {
          if (AgentViewProvider.TOGGLE_KEYS.includes(msg.key)) {
            await vscode.workspace
              .getConfiguration("agentIde")
              .update(msg.key, !!msg.value, vscode.ConfigurationTarget.Global);
          }
          // Re-sync the panel + the quick toggles in the composer.
          this.postSettings();
          this.postAutoFix();
          this.postSuperTools();
          this.postContext();
          break;
        }
        case "setContextOpt": {
          const map: Record<string, string> = {
            enabled: "includeEditorContext",
            tabs: "contextOpenTabs",
            problems: "contextProblems",
          };
          const key = map[msg.key as string];
          if (key) {
            await vscode.workspace
              .getConfiguration("agentIde")
              .update(key, !!msg.value, vscode.ConfigurationTarget.Global);
          }
          this.postContext();
          break;
        }
      }
    };
    view.webview.onDidReceiveMessage((m) => void this.handleMessage?.(m));

    this.review.onDidChangeReviews(() => {
      if (this.current) {
        this.current.changes = this.review.list();
        this.conversations.save(this.current);
      }
      this.postChanges();
    });

    this.modelChoice =
      vscode.workspace.getConfiguration("agentIde").get<string>("model") || "default";
    this.postModel();
    this.postConversations();
    this.postCheckpoints();
  }

  private post(message: unknown) {
    this.view?.webview.postMessage(message);
    // Mirror the active chat's stream + UI chrome to relay subscribers (web app).
    const t = (message as any)?.type;
    if (this.hub && HUB_MIRROR_TYPES.has(t)) {
      const cid = this.hubChatId ?? this.current?.id;
      if (cid) this.hub.emit(cid, message);
    }
  }

  /** Convert a local file path to a webview-safe URI (for inline <img> display). */
  private webviewSrc(p: string): string | undefined {
    try {
      return this.view?.webview.asWebviewUri(vscode.Uri.file(p)).toString();
    } catch {
      return undefined;
    }
  }

  newChat() {
    this.review.clearAll();
    this.current = undefined;    this.post({ type: "clear" });
    this.post({ type: "contextUsage", info: null });
    this.postModel();
    this.postMode();
    this.postChanges();
    this.postConversations();
    this.postCheckpoints();
  }

  private async openConversation(id: string) {
    // If this chat is currently running in the background, reattach to the LIVE
    // object (it holds the in-flight messages not yet saved to the store), so
    // returning shows everything the agent did while you were away — and keeps
    // streaming into the now-visible chat.
    const live = this.runs.get(id)?.conv;
    const conv = live ?? this.conversations.get(id);
    if (!conv) return;
    this.review.clearAll();
    this.current = live ?? (JSON.parse(JSON.stringify(conv)) as Conversation);
    if (conv.model) this.modelChoice = conv.model;
    if (conv.mode) this.modeChoice = conv.mode;
    this.post({ type: "loadConversation", title: conv.title, messages: conv.messages });
    this.post({ type: "contextUsage", info: conv.context ?? null });
    this.postModel();
    this.postMode();
    this.postConversations();
    this.postCheckpoints();
    // After postConversations (which sets the active id in the webview) so the
    // composer correctly shows Stop when entering a chat that's still running.
    this.post({ type: "runState", convId: id, running: this.runs.has(id) });
    await this.review.rehydrate(conv.changes || []);
    this.flushPending(id);
  }

  /** Re-emit any approval/question prompts that belong to a chat, so a gate
   *  raised by a background run appears when you switch back into that chat. */
  private flushPending(convId: string) {
    for (const [id, p] of this.pendingApprovals) {
      if (p.convId === convId) {
        this.post({ type: "approval", id, toolName: p.toolName, input: p.input });
      }
    }
    for (const [id, p] of this.pendingQuestions) {
      if (p.convId === convId) {
        this.post({ type: "question", id, questions: p.questions });
      }
    }
  }

  branch() {
    if (!this.current) return;
    const src = this.current;
    const fork: Conversation = {
      id: "conv" + Date.now().toString(36),
      title: (src.title || "chat") + " ⑂",
      time: Date.now(),
      model: src.model || this.modelChoice,
      messages: JSON.parse(JSON.stringify(src.messages)),
      forkFrom: src.sessionId, // fork from the source session on the next message
    };
    this.current = fork;    this.conversations.save(fork);
    this.post({ type: "loadConversation", title: fork.title, messages: fork.messages });
    this.post({
      type: "info",
      text: src.sessionId
        ? "⑂ Branched — your next message continues from here in a separate chat"
        : "⑂ Branched (new chat)",
    });
    this.postModel();
    this.postConversations();
    this.postCheckpoints();
  }

  /** Ask the user to choose, IN the UI (panel + web), and await their pick.
   *  Returns the chosen option's value, or undefined if cancelled. */
  private askConfirm(
    title: string,
    options: { label: string; detail?: string; value: string }[]
  ): Promise<string | undefined> {
    const id = `c${this.confirmSeq++}`;
    const convId = this.current?.id ?? "";
    const msg = { type: "confirm", id, title, options };
    return new Promise((resolve) => {
      this.pendingConfirms.set(id, { resolve, convId });
      this.post(msg); // panel
      this.hub?.emit(convId, msg); // web clients on this chat
    });
  }

  /**
   * Trim a conversation back to before its userIndex-th user message: rewrite
   * the model's session memory (truncated copy as a new id), cut the stored
   * transcript, and reload the view. Shared by rewind + checkpoint restore.
   */
  private async truncateConversation(conv: Conversation, userIndex: number, draft = "") {
    let uc = -1;
    let cut = conv.messages.length;
    for (let i = 0; i < conv.messages.length; i++) {
      if (conv.messages[i].kind === "user") {
        uc++;
        if (uc === userIndex) {
          cut = i;
          break;
        }
      }
    }
    // Rewrite the model's memory: truncated copy of the session as a new id.
    let retiredId: string | undefined;
    if (conv.sessionId) {
      const oldId = conv.sessionId;
      const newId = truncateSession(conv.sessionId, userIndex);
      if (newId) {
        conv.sessionId = newId;
        await this.addOwnedSession(newId);
        retiredId = oldId; // clean up after the new id is persisted
      }
    }
    conv.messages = conv.messages.slice(0, cut);
    await this.conversations.save(conv);
    await this.retireSession(retiredId);
    this.post({ type: "loadConversation", messages: conv.messages, draft });
  }

  /** Roll the conversation back to before the userIndex-th user message. */
  private async rewind(userIndex: number) {
    const conv = this.current;
    if (!conv) return;

    // Find the position of that user message in the transcript (for the draft).
    let uc = -1;
    let cut = conv.messages.length;
    for (let i = 0; i < conv.messages.length; i++) {
      if (conv.messages[i].kind === "user") {
        uc++;
        if (uc === userIndex) {
          cut = i;
          break;
        }
      }
    }
    const dropped = conv.messages.slice(cut);
    const droppedUser = dropped.find((m) => m.kind === "user");
    const draft = droppedUser?.text || "";

    // Always confirm. If the dropped turn changed files, also offer to revert
    // them. Locate the checkpoint by the id tagged on the user message — robust
    // even for turns with attachments (label-text matching used to miss those).
    const cp = droppedUser?.cpId
      ? this.checkpoints.list(conv.id).find((c) => c.id === droppedUser.cpId)
      : undefined;
    const options = cp
      ? [
          { label: "↩ Rewind — keep file changes", detail: "Roll back the chat only", value: "keep" },
          {
            label: "↩ Rewind + revert files",
            detail: `Also restore ${cp.files.length} file(s) to before this message`,
            value: "revert",
          },
        ]
      : [
          {
            label: "↩ Rewind to here",
            detail: "Roll the conversation back to before this message",
            value: "keep",
          },
        ];
    const choice = await this.askConfirm("Roll the conversation back to this point?", options);
    if (!choice) return; // cancelled

    if (choice === "revert" && cp) await this.checkpoints.restore(cp.id);
    await this.truncateConversation(conv, userIndex, draft);
    this.post({ type: "info", text: "↩ Rolled back — reformulate and send" });
    this.postCheckpoints();
  }

  /**
   * Cline-style three-way checkpoint restore: Files (revert the workspace,
   * keep the chat), Chat (trim the conversation, keep files), or Both.
   */
  private async restoreCheckpoint3(id: string) {
    const conv = this.current;
    // Locate the turn this checkpoint belongs to (user message tagged cpId) —
    // needed to offer the chat-trim options.
    let userOrdinal = -1;
    if (conv) {
      let uc = -1;
      for (const m of conv.messages) {
        if (m.kind === "user") {
          uc++;
          if (m.cpId === id) {
            userOrdinal = uc;
            break;
          }
        }
      }
    }
    const canTrim = !!conv && userOrdinal >= 0;
    const cp = conv ? this.checkpoints.list(conv.id).find((c) => c.id === id) : undefined;
    const canDeep = !!(this.shadow && cp?.shadowSha);
    const options = [
      {
        label: "⤺ Restore files",
        detail: "Revert the files the agent edited; keep the chat",
        value: "files",
      },
      ...(canDeep
        ? [
            {
              label: "⤺ Restore workspace (deep)",
              detail: "Whole workspace back to turn start — includes command side effects",
              value: "deep",
            },
          ]
        : []),
      ...(canTrim
        ? [
            {
              label: "⤺ Restore chat",
              detail: "Trim the conversation back to this point; keep the files",
              value: "task",
            },
            {
              label: "⤺ Restore files + chat",
              detail: "Full reset to this checkpoint",
              value: "both",
            },
          ]
        : []),
    ];
    const choice = await this.askConfirm("Restore this checkpoint?", options);
    if (!choice) return; // cancelled

    if (choice === "deep" && this.shadow && cp?.shadowSha) {
      const res = await this.shadow.restore(cp.shadowSha);
      await this.refreshReviewsAfterRestore();
      if (res.ok) {
        this.post({ type: "info", text: "⤺ Workspace restored to turn start (deep)" });
      } else {
        this.post({ type: "error", message: `Deep restore failed: ${res.error}` });
      }
    }
    if (choice === "files" || choice === "both") {
      const res = await this.checkpoints.restore(id);
      await this.refreshReviewsAfterRestore();
      this.post({ type: "restored", id, count: res.restored, failed: res.failed });
      if (res.failed) {
        this.post({
          type: "error",
          message: `Restore incomplete: ${res.failed} file(s) could not be written — ${res.errors[0] ?? "unknown error"}`,
        });
      }
    }
    if ((choice === "task" || choice === "both") && conv && userOrdinal >= 0) {
      await this.truncateConversation(conv, userOrdinal);
      this.post({ type: "info", text: "⤺ Chat trimmed to the checkpoint" });
    }
    this.postCheckpoints();
  }

  private postModel() {
    this.post({
      type: "model",
      model: this.current?.model || this.modelChoice,
      options: this.dynamicModels?.length ? this.dynamicModels : MODEL_OPTIONS,
    });
  }

  private postMode() {
    this.post({
      type: "mode",
      mode: this.current?.mode || this.modeChoice,
      options: MODE_OPTIONS,
    });
  }

  private postAutoFix() {
    const on = vscode.workspace
      .getConfiguration("agentIde")
      .get<boolean>("autoFixDiagnostics", false);
    this.post({ type: "autofix", on });
  }

  private postSuperTools() {
    const on = vscode.workspace.getConfiguration("agentIde").get<boolean>("superTools", false);
    this.post({ type: "supertools", on });
  }

  private static readonly TOGGLE_KEYS = [
    "includeEditorContext",
    "contextOpenTabs",
    "contextProblems",
    "autoFixDiagnostics",
    "showStatusBar",
    "superTools",
    "toolsEyes",
    "toolsHands",
    "toolsMemory",
    "toolsScale",
  ];

  private postSettings() {
    const cfg = vscode.workspace.getConfiguration("agentIde");
    const defaults: Record<string, boolean> = {
      includeEditorContext: true,
      showStatusBar: true,
      toolsEyes: true,
      toolsHands: true,
      toolsMemory: true,
      toolsScale: true,
    };
    const values: Record<string, boolean> = {};
    for (const k of AgentViewProvider.TOGGLE_KEYS) {
      values[k] = cfg.get<boolean>(k, defaults[k] ?? false);
    }
    this.post({ type: "settings", values });
  }

  private postContext() {
    const cfg = vscode.workspace.getConfiguration("agentIde");
    this.post({
      type: "context",
      opts: {
        enabled: cfg.get<boolean>("includeEditorContext", true),
        tabs: cfg.get<boolean>("contextOpenTabs", false),
        problems: cfg.get<boolean>("contextProblems", false),
      },
    });
  }

  /** Path to the Claude binary bundled inside the extension (no separate CLI). */
  private bundledClaudePath(): string | undefined {
    const bin = process.platform === "win32" ? "claude.exe" : "claude";
    const p = path.join(
      this.extensionUri.fsPath,
      "node_modules",
      "@anthropic-ai",
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      bin
    );
    try {
      return fs.existsSync(p) ? p : undefined;
    } catch {
      return undefined;
    }
  }

  /** True if the user has some Claude credentials (subscription or API key). */
  private isAuthed(): boolean {
    const cfg = vscode.workspace.getConfiguration("agentIde");
    return hasClaudeCredentials(cfg.get<string>("apiKey"));
  }

  /** Save a pasted image (data URL) to .agent-ide/clip and return its path. */
  private async saveClipImage(dataUrl: string): Promise<string | undefined> {
    const m = /^data:image\/(\w+);base64,(.+)$/s.exec(dataUrl || "");
    if (!m) return undefined;
    const ext = m[1].toLowerCase().replace("jpeg", "jpg");
    const data = Buffer.from(m[2], "base64");
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    const dir = vscode.Uri.joinPath(folder.uri, ".agent-ide", "clip");
    await vscode.workspace.fs.createDirectory(dir);
    const fileUri = vscode.Uri.joinPath(dir, `paste-${Date.now()}.${ext}`);
    await vscode.workspace.fs.writeFile(fileUri, data);
    return fileUri.fsPath;
  }

  /** Save an uploaded file (any base64 data URL) from a remote client to
   *  .agent-ide/clip, keeping the original name where possible. */
  private async saveUpload(name: string, dataUrl: string): Promise<string | undefined> {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || "");
    if (!m) return undefined;
    const data = Buffer.from(m[2], "base64");
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    const dir = vscode.Uri.joinPath(folder.uri, ".agent-ide", "clip");
    await vscode.workspace.fs.createDirectory(dir);
    // Sanitize the client-supplied name; fall back to a mime-derived extension.
    let safe = (name || "").replace(/[^\w.\-]+/g, "_").replace(/^_+/, "").slice(-60);
    if (!safe || !safe.includes(".")) {
      const ext = (m[1].split("/")[1] || "bin").replace("jpeg", "jpg");
      safe = `${safe || "upload"}.${ext}`;
    }
    const fileUri = vscode.Uri.joinPath(dir, `up-${Date.now()}-${safe}`);
    await vscode.workspace.fs.writeFile(fileUri, data);
    return fileUri.fsPath;
  }

  private postChanges() {
    const live = this.review.list();
    const items = live.length ? live : this.current?.changes || [];
    this.post({ type: "changes", items });
  }

  private postConversations() {
    this.post({
      type: "conversations",
      items: this.conversations.list().map((c) => ({
        id: c.id,
        title: c.title,
        time: c.time,
        pinned: !!c.pinned,
        preview: this.previewOf(c),
      })),
      activeId: this.current?.id,
    });
    // Persist which conversation is active so it survives a window reload.
    void this.state.update("activeConversationId", this.current?.id);
    // Keep the relay's folder/chat list fresh for remote viewers.
    this.hub?.publishPresence();
  }

  /** First user line of a conversation — used as a search/subtitle snippet. */
  private previewOf(c: Conversation): string {
    const u = c.messages.find((m) => m.kind === "user");
    return (u?.text || "").replace(/\s+/g, " ").slice(0, 90);
  }

  // ---- session-file lifecycle ------------------------------------------------
  // ~/.claude/projects is SHARED with the Claude CLI, so we GC only session
  // files we created ourselves (this conversation's SDK sessions + rewind/
  // regenerate truncation copies) and only once nothing references them.
  private ownedSessions(): Set<string> {
    return new Set(this.state.get<string[]>("ownedSessions", []));
  }
  private async addOwnedSession(id?: string) {
    if (!id) return;
    const owned = this.ownedSessions();
    if (owned.has(id)) return;
    owned.add(id);
    await this.state.update("ownedSessions", [...owned]);
  }
  /** Delete an old session file once it's unreferenced — but only if we own it. */
  private async retireSession(oldId?: string) {
    if (!oldId) return;
    const owned = this.ownedSessions();
    if (!owned.has(oldId)) return; // not ours — never touch it
    if (this.current?.sessionId === oldId || this.current?.forkFrom === oldId) return;
    const stillUsed = this.conversations
      .list()
      .some((c) => c.sessionId === oldId || c.forkFrom === oldId);
    if (stillUsed) return;
    deleteSessionFile(oldId);
    owned.delete(oldId);
    await this.state.update("ownedSessions", [...owned]);
  }

  /** Push a code-context block (from "Add selection to chat") into the composer. */
  insertContext(ctx: {
    rel: string;
    lang: string;
    startLine: number;
    endLine: number;
    text: string;
  }) {
    this.post({ type: "insertContext", ...ctx });
  }

  /** Fuzzy file search for the @-mention popup in the composer. */
  private async searchFiles(query: string) {
    const q = query.trim().replace(/[^\w.\-/\\ ]/g, "");
    const include = q ? `**/*${q.replace(/\s+/g, "*")}*` : "**/*";
    const uris = await vscode.workspace.findFiles(
      include,
      "**/{node_modules,.git,dist,out,.agent-ide,.next,build}/**",
      30
    );
    const items = uris.map((u) => ({
      path: u.fsPath,
      rel: vscode.workspace.asRelativePath(u),
      name: u.path.split("/").pop() || u.fsPath,
    }));
    this.post({ type: "fileResults", items });
  }

  /** Re-run the most recent user message (drops the old answer first). */
  private async regenerate() {
    const conv = this.current;
    if (!conv || this.runs.has(conv.id)) return;
    let lastOrdinal = -1;
    for (const m of conv.messages) if (m.kind === "user") lastOrdinal++;
    if (lastOrdinal < 0) return;

    let uc = -1;
    let cut = -1;
    let draft = "";
    for (let i = 0; i < conv.messages.length; i++) {
      if (conv.messages[i].kind === "user") {
        uc++;
        if (uc === lastOrdinal) {
          cut = i;
          draft = conv.messages[i].text;
          break;
        }
      }
    }
    if (cut < 0) return;
    const text = draft.split("\n📎")[0]; // strip the attachment label

    let retiredId: string | undefined;
    if (conv.sessionId) {
      const oldId = conv.sessionId;
      const newId = truncateSession(conv.sessionId, lastOrdinal);
      if (newId) {
        conv.sessionId = newId;
        await this.addOwnedSession(newId);
        retiredId = oldId;
      }
    }
    conv.messages = conv.messages.slice(0, cut);    await this.conversations.save(conv);
    await this.retireSession(retiredId);
    this.post({ type: "loadConversation", messages: conv.messages });
    this.onPrompt(text, []);
  }

  private postCheckpoints() {
    const items = this.current
      ? this.checkpoints.list(this.current.id).map((c) => ({
          id: c.id,
          label: c.label,
          time: c.time,
          count: c.files.length,
        }))
      : [];
    this.post({ type: "checkpoints", items });
  }

  // ---- transcript recording --------------------------------------------------

  // ---- run -------------------------------------------------------------------

  /**
   * Render a finished command into a real VS Code terminal via a Pseudoterminal.
   * It's display-only (no live shell) — we print the prompt + command + captured
   * output with ANSI styling. The tab can be dragged into its own editor group
   * or a separate window like any native terminal.
   */
  private openInTerminal(
    title: string,
    command: string,
    output: string,
    isError: boolean,
    durationMs?: number
  ) {
    const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
    const dur = durationMs !== undefined ? ` \x1b[2m(${(durationMs / 1000).toFixed(1)}s)\x1b[0m` : "";
    const writeEmitter = new vscode.EventEmitter<string>();
    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open: () => {
        // bright-green "$" prompt, dim command echo, then the captured output.
        writeEmitter.fire("\x1b[1;32m$\x1b[0m " + crlf(command) + "\r\n\r\n");
        if (output.trim()) {
          writeEmitter.fire(crlf(output.replace(/\s+$/, "")) + "\r\n");
        } else {
          writeEmitter.fire("\x1b[2m(no output)\x1b[0m\r\n");
        }
        const tag = isError
          ? "\r\n\x1b[31m● command failed\x1b[0m" + dur + "\r\n"
          : "\r\n\x1b[32m● done\x1b[0m" + dur + "\r\n";
        writeEmitter.fire(tag);
        writeEmitter.fire("\x1b[2m(read-only view of an agent command — close to dismiss)\x1b[0m\r\n");
      },
      close: () => {},
      // Read-only: swallow keystrokes so it doesn't look like a live shell.
      handleInput: () => {},
    };
    const name = "🖥 " + title.replace(/\s+/g, " ").slice(0, 32);
    const term = vscode.window.createTerminal({ name, pty });
    term.show(false);
  }

  private resolvePath(cwd: string, input: Record<string, unknown>): string | undefined {
    const fp = (input.file_path ?? input.path) as string | undefined;
    if (!fp) return undefined;
    return path.isAbsolute(fp) ? fp : path.join(cwd, fp);
  }

  private onPrompt(
    text: string,
    attachments?: string[],
    auto = false,
    origin: "local" | "remote" | "auto" = "local"
  ) {
    text = text || "";
    const atts = attachments || [];
    if (!text.trim() && atts.length === 0) return;
    // One run PER CHAT. Other chats may run in parallel, but a chat can't start
    // a second concurrent agent on top of its own in-flight run.
    if (this.current && this.runs.has(this.current.id)) {
      this.post({
        type: "notice",
        message: "This chat is already running — wait for the reply or press Stop.",
      });
      return;
    }
    // A fresh user message ends any in-flight auto-fix cycle for THIS chat —
    // and refills the watchdog auto-resume budget.
    if (!auto && this.current) {
      this.autoFixRound.delete(this.current.id);
      this.testRan.delete(this.current.id);
      this.autoResumeCount.delete(this.current.id);
    }
    if (!this.isAuthed()) {
      this.post({ type: "auth", ok: false });
      this.post({
        type: "error",
        message: "Not logged in to Claude. Click “Log in” above (runs claude login), then reload.",
      });
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: "error", message: "Open a folder first — the agent needs a workspace." });
      return;
    }
    const cwd = folder.uri.fsPath;

    const cfg = vscode.workspace.getConfiguration("agentIde");
    const apiKey = cfg.get<string>("apiKey") || undefined;
    const baseUrl = cfg.get<string>("baseUrl") || undefined;
    // MCP: workspace .mcp.json / .cursor/mcp.json merged over the setting.
    const mergedMcp = this.mcp.servers();
    const mcpServers = Object.keys(mergedMcp).length ? mergedMcp : undefined;

    if (!this.current) {
      this.current = {
        id: "conv" + Date.now().toString(36),
        title: text.slice(0, 60),
        time: Date.now(),
        model: this.modelChoice,
        messages: [],
      };
    }
    if (!this.current.model) this.current.model = this.modelChoice;
    if (!this.current.mode) this.current.mode = this.modeChoice;
    const model = this.current.model;
    const mode = this.current.mode;

    // Auto-include "what the user is looking at" (active file, selection, open
    // tabs, current problems) so requests like "fix this" need no explanation.
    // Skipped on auto-fix turns, which already carry their own diagnostics list.
    // What goes into the auto-context is user-controlled from the toolbar.
    // Active file + selection is the base; open tabs and workspace problems are
    // opt-in (default off) because they pull in unrelated work.
    let preamble = "";
    if (!auto && cfg.get<boolean>("includeEditorContext", true)) {
      const ctx = gatherEditorContext({
        includeTabs: cfg.get<boolean>("contextOpenTabs", false),
        includeDiagnostics: cfg.get<boolean>("contextProblems", false),
      });
      if (ctx) preamble = ctx + "\n\n---\n\n";
    }

    // Project rules: inject once per session (the session history carries them
    // on later turns; resumed/forked sessions already have them). CLAUDE.md is
    // excluded inside injectionBlock() — the CLI auto-loads it natively.
    if (!this.current.sessionId && !this.current.forkFrom) {
      const rulesBlock = this.rules.injectionBlock();
      if (rulesBlock) preamble = rulesBlock + "\n\n" + preamble;
    }

    // The agent reads attachments itself via the Read tool (works for images too).
    let finalPrompt = preamble + text;
    if (atts.length) {
      finalPrompt +=
        (text ? "\n\n" : "") +
        "Attached files — use the Read tool to view them (images included):\n" +
        atts.map((p) => `- ${p}`).join("\n");
    }
    const attLabel = atts.length
      ? `\n📎 ${atts.map((p) => p.split(/[\\/]/).pop()).join(", ")}`
      : "";

    // This run belongs to the chat that's current right now. Capture it so the
    // run streams into / saves against THIS conversation even if the user
    // switches chats while it runs (parallel chats each have their own run).
    const runConv = this.current!;
    const userText = auto ? text.split("\n")[0].slice(0, 80) : text + attLabel;
    runConv.messages.push({ kind: "user", text: userText });
    // Echo the user message to the views that did NOT render it locally, so it
    // shows on every device (the originating view already drew its own bubble).
    const echoOrigin = auto ? "auto" : origin;
    const userEcho = { type: "user", text: userText };
    if (echoOrigin !== "local") this.post(userEcho); // local panel
    if (echoOrigin !== "remote") this.hub?.emit(runConv.id, userEcho); // web clients
    this.checkpoints.beginTurn(runConv.id, text || "(attachment)");
    const lastMsg = runConv.messages[runConv.messages.length - 1];
    if (lastMsg && lastMsg.kind === "user") lastMsg.cpId = this.checkpoints.currentId(runConv.id);
    // Deep snapshot (shadow git) in parallel with the run — catches files a
    // Bash/PowerShell command mutates, which per-file snapshots can't see.
    if (this.shadow && cfg.get<boolean>("shadowGit", true)) {
      const cpId = this.checkpoints.currentId(runConv.id);
      if (cpId) {
        void this.shadow
          .snapshot(text.slice(0, 80) || "turn")
          .then((sha) => (sha ? this.checkpoints.setShadowSha(cpId, sha) : undefined))
          .catch(() => {});
      }
    }
    this.usage.setModel(model);
    this.usage.setRunning(true);
    // `rules`: what the agent is relying on this turn (Cursor-style visibility).
    this.post({ type: "started", model, rules: this.rules.activeNames() });
    // Tell the UI which chat is busy → spinner on its tab even from elsewhere.
    this.post({ type: "runState", convId: runConv.id, running: true });

    // ---- reliability: stall watchdog + auto-continue state (per run) ----
    // touch() marks liveness; the watchdog interrupts a run that streams
    // nothing for stallTimeoutSec, and finishRun auto-resumes it (bounded).
    let lastActivity = Date.now();
    const touch = () => (lastActivity = Date.now());
    let stalled = false;
    let transientMidstream = false;
    const TRANSIENT_MIDSTREAM =
      /overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504|522|529)\b|ECONNRESET|ETIMEDOUT|EPIPE|fetch failed|socket hang up|terminated|aborted/i;

    // Per-run streaming state lives in this closure, so two runs in different
    // chats never write into each other.
    let runAssistant: ConvMsg | undefined;
    const pushTo = (kind: ConvMsg["kind"], t: string) =>
      runConv.messages.push({ kind, text: t });
    const addAsst = (t: string) => {
      if (!runAssistant) {
        runAssistant = { kind: "assistant", text: "" };
        runConv.messages.push(runAssistant);
      }
      runAssistant.text += t;
    };
    const endAsst = () => {
      runAssistant = undefined;
    };
    // Render to the panel only while THIS run's chat is the visible one.
    const live = (m: unknown) => {
      if (this.current === runConv) this.post(m);
    };

    const resume = this.current.sessionId || this.current.forkFrom;
    const forkSession = !this.current.sessionId && !!this.current.forkFrom;

    const enableSuperTools = cfg.get<boolean>("superTools", false);
    const superModules = {
      eyes: cfg.get<boolean>("toolsEyes", true),
      hands: cfg.get<boolean>("toolsHands", true),
      memory: cfg.get<boolean>("toolsMemory", true),
      scale: cfg.get<boolean>("toolsScale", true),
    };

    let handle: ReturnType<typeof runAgent>;
    try {
      handle = runAgent(
      {
        prompt: finalPrompt,
        cwd,
        model,
        apiKey,
        baseUrl,
        resume,
        forkSession,
        mode,
        // Reliably surface the model's reasoning (summarized) so the "thinking"
        // stream isn't left to model-specific defaults.
        thinking: { type: "adaptive", display: "summarized" },
        mcpServers,
        enableSuperTools,
        superDev: this.devServer,
        superModules,
        superNotify: (t: string) => this.post({ type: "info", text: t }),
        subagentModel: cfg.get<string>("subagentModel") || undefined,
        onLaunchOrchestrator: (goal: string) => this.launchOrchestrator(goal),
      },
      {
        onText: (t) => {
          touch();
          addAsst(t);
          live({ type: "text", text: t });
        },
        onRetry: (attempt, max, delayMs, reason) => {
          touch();
          live({
            type: "info",
            text: `⟳ Transient error — retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${
              attempt + 1
            }/${max}): ${reason.slice(0, 100)}`,
          });
        },
        onThinking: (t) => {
          touch();
          endAsst();
          if (t.trim()) pushTo("thinking", t);
          live({ type: "thinking", text: t });
        },
        onToolUse: (name, input, id) => {
          touch();
          endAsst();
          // Persist structured tool data so a reloaded chat rebuilds the rich
          // terminal/tool card (with output), not a flat "🔧 Bash {json}" line.
          const msg: ConvMsg = {
            kind: "tool",
            text: `🔧 ${name} ${JSON.stringify(input).slice(0, 200)}`,
            tool: { name, input },
          };
          runConv.messages.push(msg);
          this.toolMsgs.set(id, msg);
          this.toolStartTimes.set(id, Date.now());
          live({ type: "tool", id, name, input });
        },
        onToolResult: (id, content, isError) => {
          touch();
          const clipped = content.slice(0, 4000);
          const start = this.toolStartTimes.get(id);
          const durationMs = start ? Date.now() - start : undefined;
          this.toolStartTimes.delete(id);
          const msg = this.toolMsgs.get(id);
          if (msg?.tool) {
            msg.tool.result = clipped;
            msg.tool.isError = isError;
            msg.tool.durationMs = durationMs;
          }
          // Notify when a long shell command finishes and the panel isn't the
          // focused chat — so background builds/tests surface a toast (Hermes-style).
          const isTerm = msg?.tool && /^(Bash|PowerShell|Shell)$/i.test(msg.tool.name);
          if (
            isTerm &&
            durationMs !== undefined &&
            durationMs >= 15000 &&
            (this.current !== runConv || !vscode.window.state.focused)
          ) {
            const secs = (durationMs / 1000).toFixed(1);
            const label = isError ? "❌ Command failed" : "✅ Command finished";
            vscode.window.showInformationMessage(`${label} (${secs}s) — ${runConv.title || "chat"}`);
          }
          live({ type: "toolResult", id, content: clipped, isError, durationMs });
        },
        onResult: (_summary, costUsd, usage) => {
          // Don't store the full result text — it duplicates the streamed
          // assistant message (showed up as a green dupe on reload).
          endAsst();
          pushTo("status", "✓ done");
          this.usage.addTurn(costUsd);
          live({ type: "result", costUsd, usage });
        },
        onError: (message) => {
          endAsst();
          // Mid-stream transient failure (agent.ts can't retry once output
          // streamed) → flag for the bounded auto-continue in finishRun.
          if (TRANSIENT_MIDSTREAM.test(message)) transientMidstream = true;
          pushTo("error", message);
          live({ type: "error", message });
        },
        onUsageLimits: (info) => {
          // Account-wide (not chat-specific) → post regardless of active chat.
          this.lastUsageLimits = info;
          this.post({ type: "usageLimits", info });
        },
        onContext: (info) => {
          // Per-chat: save on the owning conversation, render only if it's shown.
          runConv.context = info;
          live({ type: "contextUsage", info });
        },
        onSession: (sid) => {
          if (!runConv.sessionId) {
            runConv.sessionId = sid;
            runConv.forkFrom = undefined;
          }
          // Track it so rewind/regenerate can later GC superseded copies.
          void this.addOwnedSession(sid);
        },
        onInit: (info) => {
          if (info.slashCommands?.length) {
            this.slashCommands = info.slashCommands;
            this.state.update("slashCommands", info.slashCommands);
            this.post({ type: "slashCommands", items: info.slashCommands });
          }
        },
        onSystem: (subtype, data) => {
          this.post({ type: "system", subtype, data });
        },
        onModels: (models) => {
          const opts = models
            .map((m: any) => {
              const value = m.value ?? m.model ?? m.id;
              const label = m.displayName ?? m.display_name ?? m.name ?? value;
              return value
                ? { value: String(value), label: String(label), title: m.description }
                : null;
            })
            .filter(Boolean) as { value: string; label: string }[];
          if (opts.length) {
            this.dynamicModels = opts;
            this.postModel();
          }
        },
        prepareEdit: async (_toolName, input) => {
          const abs = this.resolvePath(cwd, input);
          if (abs) await this.review.prepareEdit(abs, runConv.id);
          return true;
        },
        requestApproval: (toolName, input) => {
          const id = `a${this.approvalSeq++}`;
          return new Promise<boolean>((resolve) => {
            // Tag with the owning chat so a background run's gate shows in the
            // right chat (and re-appears when you switch back to it).
            this.pendingApprovals.set(id, { resolve, convId: runConv.id, toolName, input });
            if (this.current === runConv) {
              this.post({ type: "approval", id, toolName, input });
            }
          });
        },
        askQuestion: (input) => {
          const id = `q${this.questionSeq++}`;
          const questions = (input as any).questions || [];
          return new Promise<string>((resolve) => {
            this.pendingQuestions.set(id, { resolve, convId: runConv.id, questions });
            if (this.current === runConv) {
              this.post({ type: "question", id, questions });
            }
          });
        },
      }
    );
    } catch (e) {
      // A synchronous throw here (bad config, SDK spawn failure) would otherwise
      // leave the UI wedged: we already posted "started"/running:true above, but
      // `runs` never got this entry, so nothing flips it back. Roll the UI state
      // back and free the chat so the user can retry.
      log.error("runAgent failed to start", e);
      this.usage.setRunning(this.runs.size > 0);
      this.post({ type: "runState", convId: runConv.id, running: false });
      if (this.current === runConv) {
        this.post({ type: "error", message: `Failed to start: ${String((e as Error)?.message ?? e)}` });
        this.post({ type: "idle" });
      }
      return;
    }

    this.runs.set(runConv.id, { handle, conv: runConv });

    // Stall watchdog: a run that streams NOTHING for stallTimeoutSec is wedged
    // (hung MCP server, dead pipe, lost stream) — interrupt it so the chat
    // frees up, then finishRun auto-resumes it (bounded). approval waits also
    // produce no events, so keep the default generous.
    const stallMs = Math.max(60, cfg.get<number>("stallTimeoutSec", 300)) * 1000;
    const waitingOnUser = () => {
      for (const p of this.pendingApprovals.values()) if (p.convId === runConv.id) return true;
      for (const p of this.pendingQuestions.values()) if (p.convId === runConv.id) return true;
      for (const p of this.pendingConfirms.values()) if (p.convId === runConv.id) return true;
      return false;
    };
    const watchdog = setInterval(() => {
      // A pending approval/question/confirm is the USER thinking, not a hang.
      if (waitingOnUser()) {
        touch();
        return;
      }
      if (Date.now() - lastActivity <= stallMs) return;
      stalled = true;
      log.warn(`watchdog: run for "${runConv.title}" silent ${stallMs / 1000}s — interrupting`);
      this.post({
        type: "info",
        text: `⚕ Watchdog: no activity for ${Math.round(stallMs / 1000)}s — interrupting the stuck run…`,
      });
      clearInterval(watchdog);
      try {
        handle.interrupt();
      } catch {
        /* finishRun still runs via done.then */
      }
    }, 15_000);
    // Cleanup MUST run whether the run resolves OR rejects — otherwise a thrown
    // setup error would leave a ghost entry in `runs`, wedging the chat as
    // permanently "busy" (Send never flips to Stop, new sends get blocked).
    const finishRun = async () => {
      if (!this.runs.has(runConv.id)) return; // already cleaned
      clearInterval(watchdog);
      this.runs.delete(runConv.id);
      this.post({ type: "runState", convId: runConv.id, running: false });
      this.usage.setRunning(this.runs.size > 0);
      if (this.current === runConv) this.post({ type: "idle" });
      try {
        await this.conversations.save(runConv);
        await this.checkpoints.commitTurn(runConv.id);
      } catch (e) {
        log.error("finishRun save/commit failed", e);
      }
      this.postConversations();
      this.postCheckpoints();
      // Auto-continue (bounded): a stalled/aborted turn resumes itself instead
      // of dying in a wedged chat. Uses the session id, so the model picks up
      // exactly where it stopped. Manual prompts reset the budget.
      if (
        (stalled || transientMidstream) &&
        cfg.get<boolean>("autoResume", true) &&
        runConv.sessionId &&
        this.current === runConv &&
        !this.runs.has(runConv.id)
      ) {
        const n = (this.autoResumeCount.get(runConv.id) ?? 0) + 1;
        if (n <= 2) {
          this.autoResumeCount.set(runConv.id, n);
          this.post({
            type: "info",
            text: stalled
              ? `⚕ Auto-resume after stall (${n}/2)…`
              : `⚕ Auto-resume after transient failure (${n}/2)…`,
          });
          this.onPrompt(
            "The previous turn was interrupted mid-way. Continue exactly where you left off. If everything was actually finished, just summarize the final state and stop.",
            [],
            true
          );
          return; // the resume run handles auto-compact / auto-fix itself
        }
      }
      // Auto-compact (Claude-Code-style): when the chat crosses the context
      // threshold, summarize it automatically instead of waiting for the
      // window to overflow mid-task. Runs only for the visible chat, only
      // between turns, and never stacks with an active run.
      const pct = runConv.context?.pct ?? 0;
      const autoCompact = vscode.workspace
        .getConfiguration("agentIde")
        .get<boolean>("autoCompact", true);
      if (autoCompact && pct >= 85 && this.current === runConv && !this.runs.has(runConv.id)) {
        this.post({
          type: "info",
          text: `🗜 Context at ${Math.round(pct)}% — auto-compacting…`,
        });
        this.onPrompt("/compact");
        return; // compaction is itself a run; auto-fix waits for a real turn
      }
      // Diagnostics / test auto-fix loop (no-op unless enabled in settings).
      void this.maybeAutoFix(runConv);
    };
    handle.done.then(
      () => finishRun(),
      (e) => {
        log.error("agent run rejected", e);
        if (this.current === runConv) this.post({ type: "error", message: String(e?.message ?? e) });
        return finishRun();
      }
    );
  }

  // ---- auto-fix loop ---------------------------------------------------------

  /**
   * After a turn that edited files: read the editor's diagnostics for those
   * files and, if there are errors (or a configured test command fails), send a
   * follow-up fix prompt automatically. Bounded to a few rounds so it converges.
   */
  private async maybeAutoFix(runConv: Conversation) {
    const cfg = vscode.workspace.getConfiguration("agentIde");
    if (!cfg.get<boolean>("autoFixDiagnostics", false)) return;
    // Only auto-fix the chat you're actually viewing, and only if it's idle.
    if (this.current !== runConv || this.runs.has(runConv.id)) return;

    const MAX = 3;
    const round = this.autoFixRound.get(runConv.id) ?? 0;
    if (round >= MAX) {
      this.autoFixRound.delete(runConv.id);
      return;
    }

    const changed = this.review.list().map((i) => i.path);
    if (!changed.length) return;

    // Give the language servers a moment to re-lint the edited files.
    await new Promise((r) => setTimeout(r, 1600));
    if (this.current !== runConv || this.runs.has(runConv.id)) return;

    const errors = diagnosticsFor(changed).filter((d) => d.severity === "error");
    if (errors.length) {
      const next = round + 1;
      this.autoFixRound.set(runConv.id, next);
      const list = errors
        .slice(0, 30)
        .map((d) => `- ${d.rel}:${d.line}:${d.col} ${d.message}`)
        .join("\n");
      this.post({
        type: "info",
        text: `🩺 ${errors.length} error(s) after edits — auto-fixing (round ${next}/${MAX})…`,
      });
      this.onPrompt(
        `The edits introduced these problems reported by the editor's language servers. Fix them, then stop:\n\n${list}`,
        [],
        true
      );
      return;
    }

    // Diagnostics are clean — optionally run the test command once.
    const testCmd = (cfg.get<string>("testCommand") || "").trim();
    if (testCmd && !this.testRan.has(runConv.id)) {
      this.testRan.add(runConv.id);
      const res = await this.runTestCommand(testCmd);
      if (this.current !== runConv || this.runs.has(runConv.id)) return;
      if (res && res.code !== 0) {
        const next = (this.autoFixRound.get(runConv.id) ?? 0) + 1;
        this.autoFixRound.set(runConv.id, next);
        this.post({
          type: "info",
          text: `🧪 Tests failed — auto-fixing (round ${next}/${MAX})…`,
        });
        const out = (res.output || "").slice(-6000);
        this.onPrompt(
          `The test command \`${testCmd}\` failed (exit ${res.code}). Output:\n\n\`\`\`\n${out}\n\`\`\`\n\nFix the cause, then stop.`,
          [],
          true
        );
        return;
      }
      this.post({ type: "info", text: "🧪 Tests passed." });
    }

    this.autoFixRound.delete(runConv.id);
  }

  /** Run a shell test/build command in the workspace; resolve its code+output. */
  private runTestCommand(cmd: string): Promise<{ code: number; output: string } | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return Promise.resolve(undefined);
    const cwd = folder.uri.fsPath;
    this.post({ type: "info", text: `🧪 Running: ${cmd}` });
    const isWin = process.platform === "win32";
    const shell = isWin ? "powershell.exe" : "/bin/sh";
    const args = isWin ? ["-NoProfile", "-Command", cmd] : ["-c", cmd];
    return new Promise((resolve) => {
      execFile(
        shell,
        args,
        { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 180000 },
        (err: any, stdout, stderr) => {
          const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
          resolve({ code, output: (stdout || "") + (stderr || "") });
        }
      );
    });
  }

  // ---- git -------------------------------------------------------------------

  /** Open the standalone Orchestrator window (background). Goal optional — the
   *  window shows a goal field + Start when none is given, so it's always
   *  closeable and needs no separate modal. */
  launchOrchestrator(goalArg?: string) {
    if (!this.isAuthed()) {
      this.post({ type: "auth", ok: false });
      vscode.window.showWarningMessage("Log in to Claude first (click “Log in” in the Agent panel).");
      return;
    }
    const cfg = vscode.workspace.getConfiguration("agentIde");
    const model = this.current?.model || this.modelChoice || cfg.get<string>("model") || "default";
    new OrchestratorPanel(
      this.devServer,
      { model, maxRounds: 3, maxWorkers: 4 },
      (goalArg || "").trim() || undefined
    );
  }

  /** Stage everything, generate a commit message via the agent, confirm, commit. */
  async commitFlow() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showInformationMessage("Open a folder first.");
      return;
    }
    const cwd = folder.uri.fsPath;
    if (!(await git.isRepo(cwd))) {
      vscode.window.showInformationMessage("This folder isn't a git repository.");
      return;
    }
    const st = await git.status(cwd);
    if (st.clean) {
      vscode.window.showInformationMessage("Nothing to commit — working tree is clean.");
      return;
    }
    await git.stageAll(cwd);
    const diff = await git.diff(cwd, true);

    let suggested = "";
    try {
      suggested = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Writing commit message…" },
        () => this.generateCommitMessage(cwd, diff)
      );
    } catch {
      /* fall back to manual entry */
    }

    const message = await vscode.window.showInputBox({
      prompt: `Commit on ${st.branch}`,
      value: suggested.trim() || "Update",
      ignoreFocusOut: true,
    });
    if (!message) return;
    try {
      await git.commit(cwd, message);
      vscode.window.showInformationMessage(`✓ Committed on ${st.branch}.`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Commit failed: ${e?.message || e}`);
    }
  }

  /** One-shot, read-only agent run that returns just a commit message. */
  private generateCommitMessage(cwd: string, diff: string): Promise<string> {
    const cfg = vscode.workspace.getConfiguration("agentIde");
    const apiKey = cfg.get<string>("apiKey") || undefined;
    const baseUrl = cfg.get<string>("baseUrl") || undefined;
    const prompt =
      "Write a concise git commit message for the following staged diff. Use an " +
      "imperative subject under 72 chars; add a short body only if it helps. " +
      "Output ONLY the commit message, no backticks or commentary.\n\n" +
      diff.slice(0, 12000);
    return new Promise<string>((resolve, reject) => {
      let text = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const noop = () => {};
      runAgent(
        { prompt, cwd, model: this.modelChoice || "default", apiKey, baseUrl, mode: "ask" },
        {
          onText: (t) => (text += t),
          onThinking: noop,
          onToolUse: noop,
          onToolResult: noop,
          onResult: () => finish(() => resolve(text.trim())),
          onError: (m) => finish(() => reject(new Error(m))),
          onSession: noop,
          onInit: noop,
          onSystem: noop,
          onModels: noop,
          requestApproval: async () => false,
          askQuestion: async () => "",
          prepareEdit: async () => false,
        }
      );
      // Safety net so the progress UI never hangs forever.
      setTimeout(() => finish(() => resolve(text.trim())), 30000);
    });
  }

  private html(webview: vscode.Webview): string {
    // Per-render cache-buster: webview resources are cached by URL, so without
    // this a rebuilt main.js/style.css (same URL) keeps serving the stale copy
    // even after a window reload. A fresh token each render forces a refetch.
    const bust = crypto.randomBytes(8).toString("hex");
    const scriptUri =
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"))
        .toString() + `?v=${bust}`;
    const styleUri =
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "style.css"))
        .toString() + `?v=${bust}`;
    // Assistant avatar (media/avatar.png). The webview swaps it in for the
    // name/logo; if the file is missing the <img> error handler falls back.
    const avatarUri =
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "avatar.png"))
        .toString() + `?v=${bust}`;
    // Cryptographically random nonce (not time-derived) so the CSP can't be
    // weakened by guessing a predictable value.
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Agent</title>
</head>
<body data-avatar="${avatarUri}">
  <div id="bar">
    <button id="newBtn" class="icon-btn primary" title="New chat" aria-label="New chat">＋</button>
    <button id="branchBtn" class="icon-btn" title="Branch this chat into a separate one" aria-label="Branch this chat into a separate one">⑂</button>
    <span class="bar-title">${vscode.workspace.getConfiguration("agentIde").get<string>("assistantName", "Kari")}</span>
    <span class="bar-spacer"></span>
    <div id="limits" class="limits hidden" aria-label="Plan usage remaining"></div>
    <button id="autofixBtn" class="toggle-btn" title="Auto-fix errors after edits (off)" aria-label="Auto-fix errors after edits" aria-pressed="false">🩺</button>
    <button id="superBtn" class="toggle-btn" title="Super tools: dev server, browser eyes, memory, subagents (off)" aria-label="Super tools" aria-pressed="false">🧰</button>
    <button id="orchBtn" class="toggle-btn" title="Orchestrate in a background window (uses the input as the goal)" aria-label="Orchestrate in a background window">🧭</button>
    <button id="remoteBtn" class="toggle-btn" title="Remote: relay + tunnel + Telegram bot (access this chat from your phone)" aria-label="Toggle remote access" aria-pressed="false">🛰</button>
    <div id="ctx-wrap">
      <button id="ctxBtn" class="toggle-btn" title="What context is sent to the agent" aria-label="Context sent to the agent" aria-haspopup="true">📑</button>
      <div id="ctx-menu" role="menu"></div>
    </div>
    <span id="ctx-pill" class="ctx-pill hidden" title="Context used last turn"></span>
    <button id="gitBtn" class="icon-btn" title="Commit changes (generates a message)" aria-label="Commit changes">⎇</button>
    <div id="settings-wrap">
      <button id="settingsBtn" class="icon-btn" title="Settings & modules" aria-label="Settings and modules" aria-haspopup="true">⚙</button>
      <div id="settings-menu" role="menu"></div>
    </div>
    <button id="chatsBtn" class="icon-btn" title="All chats in this project" aria-label="All chats in this project" aria-haspopup="true">☰</button>
  </div>
  <div id="auth-banner" class="hidden" role="alert"></div>
  <div id="tabs" role="tablist" aria-label="Chats"></div>
  <div id="chats" class="hidden"></div>
  <div id="log" role="log" aria-live="polite" aria-label="Conversation" aria-atomic="false"></div>
  <button id="scrollBtn" class="hidden" title="Jump to latest" aria-label="Jump to latest message">↓</button>
  <div id="changes-bar" class="hidden">
    <button id="changes-badge">✎ Changes</button>
    <div id="changes-pop"></div>
  </div>
  <div id="composer">
    <div id="slash" class="hidden"></div>
    <div id="queue" class="hidden"></div>
    <div id="attachments" class="hidden"></div>
    <div id="ctxbar" class="ctxbar hidden">
      <div class="ctxbar-track"><div class="ctxbar-fill"></div></div>
      <span class="ctxbar-text"></span>
      <button id="compactBtn" class="ctxbar-compact hidden" title="Summarize the chat to free up context" aria-label="Compact the chat to free up context">Compact</button>
    </div>
    <div id="input-card">
      <textarea id="input" rows="1" placeholder="Ask the agent…   ⏎ send · ⇧⏎ newline · / commands · Ctrl+V image"></textarea>
      <div id="toolbar">
        <div id="mode-wrap">
          <button id="modeBtn" class="mode-btn" title="Mode" aria-label="Agent mode" aria-haspopup="true">Agent ▾</button>
          <div id="mode-menu"></div>
        </div>
        <div id="model-wrap">
          <button id="modelBtn" class="mode-btn" title="Model" aria-label="Model" aria-haspopup="true">Default ▾</button>
          <div id="model-menu"></div>
        </div>
        <button id="attachBtn" class="icon-btn" title="Attach file" aria-label="Attach file">📎</button>
        <div id="rules-wrap">
          <button id="rulesBtn" class="mode-btn rules-btn" title="Project rules the agent follows" aria-label="Project rules" aria-haspopup="true"></button>
          <div id="rules-menu"></div>
        </div>
        <span class="toolbar-spacer"></span>
        <button id="send" title="Send (Enter)" aria-label="Send message">Send</button>
        <button id="stop" class="hidden" aria-label="Stop the agent">Stop</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
