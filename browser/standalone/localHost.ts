import Anthropic from "@anthropic-ai/sdk";
import type { ConvMsg } from "../../src/conversations";
import {
  ASK_TOOL,
  Effort,
  Mode,
  ModelTraits,
  ToolDef,
  ToolOutput,
  TurnCallbacks,
  compactHistory,
  describeError,
  modelTraits,
  runTurn,
  wellFormed,
} from "./engine";
import { runTurnBridge } from "./bridgeAgent";
import { ConvStore, KV, StoredConversation } from "./store";

/**
 * The panel's "host" when the agent runs inside the extension itself: it
 * answers the same messages the native host does (src/webview protocol), so the
 * unmodified chat UI works, but the agent loop is engine.ts talking straight to
 * the Claude API with the user's key — no local process, nothing to install.
 */

export interface Settings {
  apiKey?: string;
  baseUrl?: string;
  workspaceId?: string;
  effort?: Effort;
  /** apiKey is a free-trial token for the operator's gateway, not the user's own key. */
  trial?: boolean;
  /** How that gateway takes requests: the Messages API (trial-server), or its /v1/agent bridge. */
  trialTransport?: "messages" | "agent";
}

export interface LocalHostDeps {
  post(msg: unknown): void;
  kv: KV;
  loadSettings(): Promise<Settings>;
  createClient(s: Settings): Anthropic;
  tools: ToolDef[];
  system: string;
  runTool(name: string, input: Record<string, unknown>): Promise<ToolOutput>;
  /** Human words for what a tool call would act on (the element behind a ref), shown on approval cards. */
  describeCall?(name: string, input: Record<string, unknown>): string | undefined;
  openSettings(): void;
  /** Free trial: forget a token the gateway rejected — the user signs in again from the settings. */
  forgetTrialToken?(): void | Promise<void>;
  /** Identifies the tool set + system prompt; a chat saved under another build has its old thinking blocks dropped. */
  promptId?: string;
  /** This build can run the agent through the local helper (Claude subscription); false = key or trial only. */
  helper?: boolean;
}

const DEFAULT_MODEL = "claude-opus-5-5";
const PREFS_KEY = "agentLocalPrefs";

const MODE_OPTIONS: Array<{ value: Mode; label: string; title: string }> = [
  { value: "agent", label: "Agent", title: "Browses and acts on pages itself — asks before risky steps" },
  { value: "careful", label: "Careful", title: "Asks your approval before every click, typing or navigation" },
  { value: "ask", label: "Ask", title: "Read-only — reads pages and answers, never clicks or types" },
];

// Shown until the Models API answers (or when it can't be reached).
const FALLBACK_MODELS = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5", title: "Most capable everyday model" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", title: "Faster and cheaper" },
  { value: "claude-fable-5-1", label: "Claude Fable 5.1", title: "Most capable, highest cost" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", title: "Fastest, lowest cost" },
];

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// The API refuses images over 5 MB (base64) and bounds a whole request at 32 MB; a chat that stored such a
// message would fail on every later turn, so anything that can't be sent is refused here.
const MAX_IMAGE_BYTES = 3_500_000;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_TEXT_CHARS = 100_000;
const TOOL_RESULT_CLIP = 4000;
const SAVE_DEBOUNCE_MS = 800;
const FLUSH_MS = 40;
// A prompt waits this long at most for the model list, and a failed or empty list isn't asked for again for a while.
const MODELS_WAIT_MS = 4000;
const MODELS_RETRY_MS = 5 * 60_000;
const COMPACT_MARK = "🗜 Context compacted";

interface Attachment {
  name: string;
  mime: string;
  data: string; // base64
  size: number;
}

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function parseDataUrl(dataUrl: unknown): { mime: string; data: string } | null {
  const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.+-]+)*;base64,([A-Za-z0-9+/=\s]+)$/.exec(typeof dataUrl === "string" ? dataUrl : "");
  return m ? { mime: m[1] || "application/octet-stream", data: m[2].replace(/\s+/g, "") } : null;
}

function isTexty(mime: string, name: string): boolean {
  return /^text\//.test(mime) || /(json|xml|yaml|csv|javascript|markdown)/.test(mime) || /\.(txt|md|csv|json|xml|ya?ml|log|html?|css|js|ts|py)$/i.test(name);
}

/** A saved chat can end mid-turn (panel closed while a tool ran): close open tool calls so the API accepts it. */
export function repairHistory(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return;
  const open = last.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!open.length) return;
  messages.push({
    role: "user",
    content: open.map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, is_error: true, content: "Interrupted — the panel was closed before this finished." })),
  });
}

/** Remove thinking blocks from earlier assistant turns (used once when a saved chat meets a different prompt/tool set). */
export function stripThinking(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const kept = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    if (kept.length !== m.content.length) m.content = kept.length ? kept : [{ type: "text", text: "(continued)" }];
  }
}

/**
 * The API refused the request's content (an oversized image, a bad block) rather than the key, model, billing or
 * context size: only then is the just-sent message at fault and worth taking back out of the history.
 */
export function rejectedContent(e: unknown): boolean {
  if (!(e instanceof Anthropic.APIError)) return false;
  if (e.status === 413 || e.status === 422) return true;
  const body = (e.error as { error?: { type?: string; message?: string } } | undefined)?.error;
  return e.status === 400 && body?.type === "invalid_request_error" && /^messages\b/.test(body.message ?? "");
}

/** A prompt from the user, as opposed to the tool results a turn hands back under the same role. */
function isPrompt(m: Anthropic.MessageParam): boolean {
  return m.role === "user" && !(Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
}

/** The user's words without the "📎 files" label the transcript shows under them. */
function promptText(m: ConvMsg): string {
  return m.text.split("\n📎")[0];
}

export class LocalHost {
  private store: ConvStore;
  private current?: StoredConversation;
  private runs = new Map<string, AbortController>();
  private approvals = new Map<string, { resolve: (ok: boolean) => void; convId: string; card: unknown }>();
  private questions = new Map<string, { resolve: (answer: string) => void; convId: string; card: unknown }>();
  private confirms = new Map<string, { resolve: (value: string | undefined) => void; convId: string; card: unknown }>();
  /** Chats being started (between the click and the run being registered): closes the async gap a double-send slips through. */
  private starting = new Set<string>();
  /** Chats deleted while running — their final save must not bring them back. */
  private deleted = new Set<string>();
  /** Chats the user switched away from and back to mid-run: their tool cards are rebuilt from storage, so reload once at the end. */
  private reopened = new Set<string>();
  /** The live object of every chat that has a run: reopening it must attach to THIS object, not a stored copy. */
  private running = new Map<string, StoredConversation>();
  private attachments = new Map<string, Attachment>();
  private models: Anthropic.ModelInfo[] = [];
  private modelsPending?: Promise<void>;
  /** When the Models API last failed or listed nothing; a gateway without /v1/models isn't asked again on every prompt. */
  private modelsFailedAt = 0;
  private prefs: { model: string; mode: Mode; activeId?: string } = { model: DEFAULT_MODEL, mode: "agent" };
  private seq = 0;
  private ready: Promise<void>;
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private d: LocalHostDeps) {
    this.store = new ConvStore(d.kv);
    this.ready = this.init();
  }

  private async init() {
    await this.store.load();
    const got = (await this.d.kv.get([PREFS_KEY]))[PREFS_KEY] as Partial<typeof this.prefs> | undefined;
    if (got) {
      if (typeof got.model === "string" && got.model) this.prefs.model = got.model;
      if (MODE_OPTIONS.some((o) => o.value === got.mode)) this.prefs.mode = got.mode as Mode;
      if (typeof got.activeId === "string") this.prefs.activeId = got.activeId;
    }
  }

  private post(m: unknown) {
    this.d.post(m);
  }

  private savePrefs() {
    return this.d.kv.set({ [PREFS_KEY]: { ...this.prefs, activeId: this.current?.id } });
  }

  /** Entry point for every message from the panel. Never throws. */
  async handle(msg: any): Promise<void> {
    try {
      await this.ready;
      await this.dispatch(msg);
    } catch (e) {
      this.post({ type: "error", message: describeError(e).message });
      this.post({ type: "idle" });
    }
  }

  private async dispatch(msg: any) {
    switch (msg?.type) {
      case "ready":
        return this.onReady();
      case "prompt":
        return this.onPrompt(String(msg.text ?? ""), Array.isArray(msg.attachments) ? msg.attachments.map(String) : []);
      case "compact":
        return this.compact();
      case "regenerate":
        return this.regenerate();
      case "rewind":
        return Number.isInteger(msg.userIndex) && msg.userIndex >= 0 ? this.rewind(msg.userIndex) : undefined;
      case "interrupt":
        return this.interrupt();
      case "confirmResponse": {
        const p = this.confirms.get(msg.id);
        if (p) {
          this.confirms.delete(msg.id);
          p.resolve(typeof msg.value === "string" ? msg.value : undefined);
          this.post({ type: "confirmResolved", id: msg.id });
        }
        return;
      }
      case "approvalResponse": {
        const p = this.approvals.get(msg.id);
        if (p) {
          this.approvals.delete(msg.id);
          p.resolve(msg.approved === true);
          this.post({ type: "approvalResolved", id: msg.id, approved: msg.approved === true });
        }
        return;
      }
      case "questionResponse": {
        const p = this.questions.get(msg.id);
        if (p) {
          this.questions.delete(msg.id);
          const answer = msg.answer || "(no answer)";
          p.resolve(answer);
          this.post({ type: "questionResolved", id: msg.id, answer });
        }
        return;
      }
      case "newChat":
        this.current = undefined;
        this.post({ type: "clear" });
        this.postModel();
        this.postMode();
        this.post({ type: "contextUsage", info: null });
        this.postConversations();
        return;
      case "listConversations":
        return this.postConversations();
      case "openConversation":
        return this.openConversation(String(msg.id));
      case "deleteConversation": {
        const id = String(msg.id);
        this.deleted.add(id);
        const t = this.saveTimers.get(id);
        if (t) (clearTimeout(t), this.saveTimers.delete(id));
        this.abort(id);
        if (this.current?.id === id) {
          this.current = undefined;
          this.post({ type: "clear" });
        }
        await this.store.remove(id);
        this.postConversations();
        return;
      }
      case "renameConversation": {
        const title = String(msg.title ?? "").slice(0, 200);
        await this.store.patch(String(msg.id), { title, renamed: true });
        const cur = this.current;
        if (cur && cur.id === msg.id) cur.title = title;
        return this.postConversations();
      }
      case "pinConversation":
        await this.store.patch(String(msg.id), { pinned: !!msg.pinned });
        const pinned = this.current;
        if (pinned && pinned.id === msg.id) pinned.pinned = !!msg.pinned;
        return this.postConversations();
      case "setModel":
        this.prefs.model = String(msg.model);
        if (this.current) this.current.model = this.prefs.model;
        return void (await this.savePrefs());
      case "setMode":
        if (MODE_OPTIONS.some((o) => o.value === msg.mode)) {
          this.prefs.mode = msg.mode;
          if (this.current) this.current.mode = msg.mode;
          await this.savePrefs();
        }
        return;
      case "pasteImage":
      case "uploadAttachment":
        return this.addAttachment(msg.name, msg.dataUrl);
      case "login":
        return this.d.openSettings();
      case "recheckAuth":
        this.modelsFailedAt = 0; // the settings may have changed: the next prompt asks the endpoint again
        return this.postAuth();
      // Editor-only messages (diffs, git, remote…) have no controls in the panel.
    }
  }

  // ---- state → panel -------------------------------------------------------

  /** Settings, or the reason they can't be had (the free trial registers on first use and can be unavailable). */
  private async safeSettings(): Promise<{ s?: Settings; error?: string }> {
    try {
      return { s: await this.d.loadSettings() };
    } catch (e) {
      return { error: describeError(e).message };
    }
  }

  private async postAuth() {
    const { s, error } = await this.safeSettings();
    const ok = !!s?.apiKey;
    this.post({
      type: "auth",
      ok,
      text: error ? `⚠ ${error}` : `⚠ Choose how to run the agent — add an Anthropic API key${this.d.helper === false ? " or use the free trial" : " (or use the free trial / your Claude subscription)"}:`,
      loginLabel: "Open settings",
      recheckLabel: "I've done it",
    });
    return ok;
  }

  private async onReady() {
    await this.store.refresh();
    if (!this.current && this.prefs.activeId) {
      const last = await this.store.get(this.prefs.activeId);
      if (last) this.current = last;
    }
    if (this.current) this.settleStaleTools(this.current);
    const hasKey = await this.postAuth();
    if (hasKey && (await this.safeSettings()).s?.trial) {
      this.post({ type: "info", text: "Free trial: your requests go through the trial service to Claude, within a small daily allowance. Add your own API key in the settings (🌐) for unlimited use." });
    }
    this.post({ type: "identity", name: "Tali" });
    this.postModel();
    this.postMode();
    this.post({ type: "settings", values: {} });
    this.post({ type: "rules", items: [] });
    this.post({ type: "slashCommands", items: ["compact"] });
    this.postConversations();
    if (this.current) {
      this.post(this.loadMsg(this.current));
    }
    this.post({ type: "contextUsage", info: this.current?.context ?? null });
    for (const id of this.runs.keys()) this.post({ type: "runState", convId: id, running: true });
    if (hasKey) void this.refreshModels();
  }

  private modelOptions() {
    if (!this.models.length) return FALLBACK_MODELS;
    return this.models.slice(0, 12).map((m) => ({
      value: m.id,
      label: m.display_name || m.id,
      title: m.max_input_tokens ? `${Math.round(m.max_input_tokens / 1000).toLocaleString("en-US")}K context` : undefined,
    }));
  }

  private postModel() {
    this.post({ type: "model", model: this.current?.model || this.prefs.model, options: this.modelOptions() });
  }

  /** The transcript for the panel — a snapshot: the panel renders it over several frames while a run may still be appending to it. */
  private loadMsg(conv: StoredConversation, draft?: string) {
    // convId lets the relay mirror route it: it's posted before "conversations" updates activeId.
    return { type: "loadConversation", convId: conv.id, title: conv.title, messages: conv.messages.slice(), draft };
  }

  private postMode() {
    this.post({ type: "mode", mode: this.current?.mode || this.prefs.mode, options: MODE_OPTIONS });
  }

  private postConversations() {
    this.post({
      type: "conversations",
      items: this.store.list().map(({ id, title, time, pinned, preview }) => ({ id, title, time, pinned, preview })),
      activeId: this.current?.id,
    });
    void this.savePrefs();
  }

  /** One Models API request at a time, and none for a while after one failed or came back empty. */
  private refreshModels(): Promise<void> {
    if (this.modelsPending) return this.modelsPending;
    if (this.modelsFailedAt && Date.now() - this.modelsFailedAt < MODELS_RETRY_MS) return Promise.resolve();
    return (this.modelsPending = this.fetchModels().finally(() => (this.modelsPending = undefined)));
  }

  private async fetchModels() {
    try {
      const { s: st } = await this.safeSettings();
      if (!st?.apiKey) return;
      const client = this.d.createClient(st);
      const found: Anthropic.ModelInfo[] = [];
      for await (const m of client.models.list({ limit: 100 })) {
        if (/^claude-/.test(m.id)) found.push(m);
        if (found.length >= 40) break;
      }
      this.modelsFailedAt = found.length ? 0 : Date.now();
      if (found.length) {
        this.models = found;
        // The endpoint may offer fewer models than the default (the free trial does): move to one it has.
        const ids = found.map((m) => m.id);
        if (!ids.includes(this.prefs.model)) this.prefs.model = ids[0];
        if (this.current?.model && !ids.includes(this.current.model)) this.current.model = ids[0];
        this.postModel();
      }
    } catch (e) {
      this.modelsFailedAt = Date.now();
      // Not fatal: the fallback list works. A rejected key is reported on the first run.
      if (e instanceof Anthropic.AuthenticationError) this.post({ type: "auth", ok: false, text: "⚠ The API key was rejected. Check it in the settings:", loginLabel: "Open settings", recheckLabel: "I've fixed it" });
    }
  }

  /** Before a run: the model list, unless it is known, was recently found missing, or takes too long (then it counts as missing). */
  private async awaitModels() {
    if (this.models.length) return;
    const done = await Promise.race([this.refreshModels().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), MODELS_WAIT_MS))]);
    if (!done) this.modelsFailedAt = Date.now();
  }

  /** A model the current endpoint actually offers (only known once its list has loaded). */
  private resolveModel(model: string): string {
    return this.models.length && !this.models.some((m) => m.id === model) ? this.models[0].id : model;
  }

  /** A chat saved mid-run (panel closed) has tool cards without results; close them so they don't spin forever. */
  private settleStaleTools(conv: StoredConversation) {
    if (this.runs.has(conv.id)) return;
    for (const m of conv.messages) {
      if (m.kind === "tool" && m.tool && m.tool.result === undefined) Object.assign(m.tool, { result: "Interrupted — the panel was closed before this finished.", isError: true });
    }
  }

  private async openConversation(id: string) {
    await this.store.refresh();
    const conv = this.running.get(id) ?? (await this.store.get(id));
    if (!conv) return;
    this.current = conv;
    this.settleStaleTools(conv);
    this.post(this.loadMsg(conv));
    this.postModel();
    this.postMode();
    this.post({ type: "contextUsage", info: conv.context ?? null });
    this.postConversations();
    // A run may be going on in this chat: show Stop, and bring back the approval/question it is waiting on.
    if (this.runs.has(id)) {
      this.reopened.add(id);
      this.post({ type: "runState", convId: id, running: true });
      for (const p of this.approvals.values()) if (p.convId === id) this.post(p.card);
      for (const p of this.questions.values()) if (p.convId === id) this.post(p.card);
    }
    for (const p of this.confirms.values()) if (p.convId === id) this.post(p.card);
  }

  // ---- attachments ---------------------------------------------------------

  private addAttachment(name: unknown, dataUrl: unknown) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return;
    const size = Math.floor((parsed.data.length * 3) / 4);
    const limit = IMAGE_MIMES.includes(parsed.mime) ? MAX_IMAGE_BYTES : parsed.mime === "application/pdf" ? MAX_DOCUMENT_BYTES : MAX_ATTACHMENT_BYTES;
    if (size > limit) {
      this.post({ type: "notice", message: `That file is too large for the model (${(size / 1048576).toFixed(1)} MB; the limit for this kind of file is ${(limit / 1048576).toFixed(1)} MB).` });
      return;
    }
    const base = String(typeof name === "string" && name ? name : parsed.mime.startsWith("image/") ? "pasted.png" : "file")
      .replace(/[\\/]/g, "_")
      .slice(0, 120);
    const id = `att${Date.now().toString(36)}${++this.seq}`;
    this.attachments.set(id, { name: base, mime: parsed.mime, data: parsed.data, size });
    const isImage = parsed.mime.startsWith("image/");
    this.post({ type: "attached", path: id, name: base, isImage, src: isImage ? dataUrl : undefined });
  }

  private userContent(text: string, ids: string[]): { content: Anthropic.ContentBlockParam[]; label: string } {
    const blocks: Anthropic.ContentBlockParam[] = [];
    const listed: string[] = [];
    const names: string[] = [];
    for (const id of ids) {
      const a = this.attachments.get(id);
      if (!a) continue;
      names.push(a.name);
      listed.push(`- ${id} (${a.name})`);
      if (IMAGE_MIMES.includes(a.mime)) {
        blocks.push({ type: "image", source: { type: "base64", media_type: a.mime as "image/png", data: a.data } });
      } else if (a.mime === "application/pdf") {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } });
      } else if (isTexty(a.mime, a.name)) {
        const body = atob(a.data);
        const decoded = new TextDecoder().decode(Uint8Array.from(body, (c) => c.charCodeAt(0)));
        const clipped = decoded.length > MAX_INLINE_TEXT_CHARS;
        blocks.push({ type: "text", text: wellFormed(`Attached file "${a.name}":\n\`\`\`\n${clipped ? decoded.slice(0, MAX_INLINE_TEXT_CHARS) + "\n… (truncated)" : decoded}\n\`\`\``) });
      }
    }
    let prompt = text;
    if (listed.length) {
      prompt += (prompt ? "\n\n" : "") + "Attached files (ids for browser_upload_file):\n" + listed.join("\n");
    }
    blocks.push({ type: "text", text: prompt || "(attachment)" });
    return { content: blocks, label: names.length ? `\n📎 ${names.join(", ")}` : "" };
  }

  // ---- running -------------------------------------------------------------

  private abort(convId: string) {
    this.runs.get(convId)?.abort();
    // A run parked on an approval or question would never see the abort.
    for (const [id, p] of this.approvals) {
      if (p.convId === convId) {
        this.approvals.delete(id);
        p.resolve(false);
        this.post({ type: "approvalResolved", id, approved: false });
      }
    }
    for (const [id, p] of this.questions) {
      if (p.convId === convId) {
        this.questions.delete(id);
        p.resolve("(cancelled)");
        this.post({ type: "questionResolved", id, answer: "(cancelled)" });
      }
    }
    for (const [id, p] of this.confirms) {
      if (p.convId === convId) {
        this.confirms.delete(id);
        p.resolve(undefined);
        this.post({ type: "confirmResolved", id });
      }
    }
  }

  /** Ask the user to choose, in the chat itself (the shared UI's confirm card); undefined when cancelled. */
  private askConfirm(conv: StoredConversation, title: string, options: Array<{ label: string; detail?: string; value: string }>): Promise<string | undefined> {
    const id = `c${++this.seq}`;
    const card = { type: "confirm", id, title, options };
    return new Promise((resolve) => {
      this.confirms.set(id, { resolve, convId: conv.id, card });
      if (this.current === conv) this.post(card);
    });
  }

  private interrupt() {
    if (this.current) this.abort(this.current.id);
  }

  private scheduleSave(conv: StoredConversation) {
    if (this.saveTimers.has(conv.id)) return;
    this.saveTimers.set(
      conv.id,
      setTimeout(() => {
        this.saveTimers.delete(conv.id);
        void this.store.save(conv).catch(() => {});
      }, SAVE_DEBOUNCE_MS)
    );
  }

  private async saveNow(conv: StoredConversation) {
    const t = this.saveTimers.get(conv.id);
    if (t) {
      clearTimeout(t);
      this.saveTimers.delete(conv.id);
    }
    await this.store.save(conv);
  }

  private contextInfo(conv: StoredConversation, traits: ModelTraits, u: Anthropic.Usage) {
    const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const model = conv.model || this.prefs.model;
    const max = traits.maxInput ?? (/haiku/.test(model) ? 200_000 : 1_000_000);
    return { used, max, pct: (used / max) * 100, model };
  }

  private traitsFor(model: string): ModelTraits {
    return modelTraits(model, this.models.find((m) => m.id === model));
  }

  private async onPrompt(text: string, attachmentIds: string[]) {
    if (!text.trim() && !attachmentIds.length) return;
    if (text.trim() === "/compact") return this.compact();
    const run = await this.beginRun();
    if (!run) return;

    if (!this.current) {
      this.current = {
        id: "conv" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: text.slice(0, 60) || "Attachment",
        time: Date.now(),
        messages: [],
        apiMessages: [],
      };
      // Saved and announced now, so the panel knows which chat is active during the very first turn
      // (its queue and tab strip key on that) and the chat survives a panel closed mid-run.
      await this.store.save(this.current);
      this.postConversations();
    }
    const conv = this.current;
    const apiMessages = this.prepareHistory(conv);
    const { content, label } = this.userContent(text, attachmentIds);
    apiMessages.push({ role: "user", content });
    conv.messages.push({ kind: "user", text: text + label });
    await this.runTurn(conv, run.settings, text, run.unlock);
  }

  /**
   * Take the current chat (or the one about to be created) for a run: the gate is checked and taken in one synchronous
   * step, because everything after it awaits and a second message (the UI's queue sends the next one the moment a run
   * ends) must not slip into that gap and start a second run on the same history. Null when the chat is busy or the
   * settings have no key — the user has been told.
   */
  private async beginRun(): Promise<{ settings: Settings; unlock: () => void } | null> {
    const gate = this.current?.id ?? "__new__";
    if (this.starting.has(gate) || (this.current && this.runs.has(this.current.id))) {
      this.post({ type: "notice", message: "This chat is already running — wait for the reply or press Stop." });
      return null;
    }
    this.starting.add(gate);
    const unlock = () => this.starting.delete(gate);
    const { s: settings, error } = await this.safeSettings();
    if (!settings?.apiKey) {
      unlock();
      await this.postAuth();
      this.post({ type: "error", message: error || "Choose how to run the agent in the settings first (🌐 button)." });
      this.post({ type: "idle" });
      return null;
    }
    await this.awaitModels();
    return { settings, unlock };
  }

  /** The API history, made valid for the next request. */
  private prepareHistory(conv: StoredConversation): Anthropic.MessageParam[] {
    const apiMessages = (conv.apiMessages ||= []) as Anthropic.MessageParam[];
    repairHistory(apiMessages);
    // A chat saved by another build (or before builds were stamped) replays against a different tool set/system
    // prompt; models that keep their reasoning across turns refuse thinking blocks whose prefix changed, so drop them once.
    if (conv.promptId !== this.d.promptId && apiMessages.length) stripThinking(apiMessages);
    conv.promptId = this.d.promptId;
    return apiMessages;
  }

  /** The transcript position of the n-th user message, or -1. */
  private userMessageAt(conv: StoredConversation, n: number): number {
    let seen = -1;
    return conv.messages.findIndex((m) => m.kind === "user" && ++seen === n);
  }

  /**
   * The API message behind the user bubble at `cut`. Both histories hold the same prompts after the last compaction
   * (the summary stands in for everything before it), so the n-th prompt from the end is the same one on both sides.
   * -1 when the point lies behind a compaction, or the two sides disagree.
   */
  private apiIndexOf(conv: StoredConversation, apiMessages: Anthropic.MessageParam[], cut: number): number {
    if (conv.messages.slice(cut).some((m) => m.kind === "status" && m.text === COMPACT_MARK)) return -1;
    let n = conv.messages.slice(cut + 1).filter((m) => m.kind === "user").length;
    for (let i = apiMessages.length - 1; i >= 0; i--) if (isPrompt(apiMessages[i]) && n-- === 0) return i;
    return -1;
  }

  /** "↻ Retry" under an answer: drop everything after the last user message and run it again. */
  private async regenerate() {
    const conv = this.current;
    if (!conv) return;
    if (this.runs.has(conv.id) || this.starting.has(conv.id)) return void this.post({ type: "notice", message: "This chat is running — wait for it to finish first." });
    let cut = -1;
    conv.messages.forEach((m, i) => m.kind === "user" && (cut = i));
    if (cut < 0) return void this.post({ type: "notice", message: "Nothing to retry yet." });
    const apiMessages = (conv.apiMessages ||= []) as Anthropic.MessageParam[];
    const apiCut = this.apiIndexOf(conv, apiMessages, cut);
    if (apiCut < 0) return void this.post({ type: "notice", message: "The chat was compacted after this message, so it can't be run again — send it anew." });
    const run = await this.beginRun();
    if (!run) return;
    conv.messages.length = cut + 1;
    apiMessages.length = apiCut + 1;
    this.prepareHistory(conv);
    this.post(this.loadMsg(conv));
    await this.runTurn(conv, run.settings, promptText(conv.messages[cut]), run.unlock);
  }

  /** "↩" on a user message: roll the chat back to before it and put its words back in the composer. */
  private async rewind(userIndex: number) {
    const conv = this.current;
    if (!conv) return;
    const busy = () => this.runs.has(conv.id) || this.starting.has(conv.id);
    if (busy()) return void this.post({ type: "notice", message: "This chat is running — wait for it to finish first." });
    const cut = this.userMessageAt(conv, userIndex);
    if (cut < 0) return;
    const apiMessages = (conv.apiMessages ||= []) as Anthropic.MessageParam[];
    const apiCut = this.apiIndexOf(conv, apiMessages, cut);
    if (apiCut < 0) return void this.post({ type: "notice", message: "The chat was compacted after this point — what came before it is gone. Start a new chat instead." });
    const choice = await this.askConfirm(conv, "Roll the conversation back to this point?", [{ label: "↩ Rewind to here", detail: "Roll the conversation back to before this message", value: "keep" }]);
    if (!choice) return;
    if (busy()) return void this.post({ type: "notice", message: "This chat started running meanwhile — nothing was rolled back." });
    const draft = promptText(conv.messages[cut]);
    conv.messages.length = cut;
    apiMessages.length = apiCut;
    conv.context = undefined;
    conv.time = Date.now();
    await this.saveNow(conv);
    if (this.current === conv) {
      this.post(this.loadMsg(conv, draft));
      this.post({ type: "contextUsage", info: null });
      this.post({ type: "info", text: "↩ Rolled back — reformulate and send" });
    }
    this.postConversations();
  }

  /** One turn for the user message already at the end of both histories; `text` goes back to the composer if the API refuses it. */
  private async runTurn(conv: StoredConversation, settings: Settings, text: string, unlock: () => void) {
    const apiMessages = conv.apiMessages as Anthropic.MessageParam[];
    conv.model = this.resolveModel(conv.model || this.prefs.model);
    const mode: Mode = MODE_OPTIONS.some((o) => o.value === conv.mode) ? (conv.mode as Mode) : this.prefs.mode;
    // The shared Conversation type predates "careful"; the value round-trips fine.
    conv.mode = mode as StoredConversation["mode"];
    conv.time = Date.now();
    const model = conv.model;
    const traits = this.traitsFor(model);
    const historyBefore = apiMessages.length - 1;
    const bubbleAt = conv.messages.length - 1;
    let draft: string | undefined;

    const ctrl = new AbortController();
    this.runs.set(conv.id, ctrl);
    this.running.set(conv.id, conv);
    unlock();
    this.post({ type: "started", model });
    this.post({ type: "runState", convId: conv.id, running: true });

    const live = (m: unknown) => {
      if (this.current === conv) this.post(m);
    };

    // Streamed text/thinking is batched (a re-render per token is wasteful) and
    // merged into one stored message per block, not one per delta.
    let pending: { kind: "text" | "thinking"; text: string } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let openMsg: ConvMsg | undefined;
    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!pending) return;
      const { kind, text: t } = pending;
      pending = null;
      const stored = kind === "text" ? "assistant" : "thinking";
      if (!openMsg || openMsg.kind !== stored) {
        openMsg = { kind: stored, text: "" };
        conv.messages.push(openMsg);
      }
      openMsg.text += t;
      live({ type: kind, text: t });
    };
    const stream = (kind: "text" | "thinking", delta: string) => {
      if (pending && pending.kind !== kind) flush();
      pending = pending ? { kind, text: pending.text + delta } : { kind, text: delta };
      timer ||= setTimeout(flush, FLUSH_MS);
    };

    const toolMsgs = new Map<string, ConvMsg>();
    let lastUsage: Anthropic.Usage | undefined;
    const cb: TurnCallbacks = {
      text: (d) => stream("text", d),
      thinking: (d) => stream("thinking", d),
      toolUse: (id, name, input) => {
        flush();
        openMsg = undefined;
        const msg: ConvMsg = { kind: "tool", text: `🔧 ${name}`, tool: { name, input } };
        conv.messages.push(msg);
        toolMsgs.set(id, msg);
        live({ type: "tool", id, name, input });
      },
      toolResult: (id, result, isError, durationMs) => {
        const clipped = result.slice(0, TOOL_RESULT_CLIP);
        const msg = toolMsgs.get(id);
        toolMsgs.delete(id);
        if (msg?.tool) Object.assign(msg.tool, { result: clipped, isError, durationMs });
        live({ type: "toolResult", id, content: clipped, isError, durationMs });
      },
      usage: (u) => {
        lastUsage = u;
        const info = this.contextInfo(conv, traits, u);
        conv.context = info;
        live({ type: "contextUsage", info });
      },
      approve: (name, input) => {
        flush();
        const id = `a${++this.seq}`;
        // Refs alone ("click [7]") tell the user nothing — say what element that is.
        const element = this.d.describeCall?.(name, input);
        const card = { type: "approval", id, toolName: name, input: element ? { ...input, element } : input };
        return new Promise<boolean>((resolve) => {
          this.approvals.set(id, { resolve, convId: conv.id, card });
          live(card);
        });
      },
      ask: (input) => {
        flush();
        const id = `q${++this.seq}`;
        const card = { type: "question", id, questions: (input as { questions?: unknown }).questions || [] };
        return new Promise<string>((resolve) => {
          this.questions.set(id, { resolve, convId: conv.id, card });
          live(card);
        });
      },
      info: (t) => live({ type: "info", text: t }),
      checkpoint: () => this.scheduleSave(conv),
    };

    const fail = (message: string) => {
      flush();
      openMsg = undefined;
      conv.messages.push({ kind: "error", text: message });
      live({ type: "error", message });
    };

    try {
      // The free trial takes the path its gateway named at sign-in: trial-server speaks the Messages API (the local
      // loop below, same as an own key); a gateway that runs the agent loop itself takes /v1/agent and bridges
      // the tool calls back to this panel (bridgeAgent.ts).
      const allTools = [...this.d.tools, ASK_TOOL];
      const modeGetter = () => (MODE_OPTIONS.some((o) => o.value === conv.mode) ? (conv.mode as Mode) : mode);

      let result;
      if (settings.trial && settings.baseUrl && settings.trialTransport === "agent") {
        // A gateway that runs the agent loop itself: tools are bridged to this panel over SSE
        result = await runTurnBridge({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey!,
          model,
          system: this.d.system,
          tools: allTools,
          messages: apiMessages,
          signal: ctrl.signal,
          runTool: (name, input) => this.runTool(name, input),
          cb,
          mode: modeGetter,
          maxTokens: 8192,
        });
      } else {
        // Messages API with the local tool loop: the user's key, or a trial token with trial-server
        const client = this.d.createClient(settings);
        result = await runTurn({
          client,
          model,
          traits,
          effort: settings.effort || "medium",
          system: this.d.system,
          tools: allTools,
          messages: apiMessages,
          mode: modeGetter,
          signal: ctrl.signal,
          runTool: (name, input) => this.runTool(name, input),
          cb,
        });
      }

      flush();
      if (result.aborted) {
        conv.messages.push({ kind: "status", text: "■ stopped" });
        live({ type: "info", text: "Stopped." });
      } else if (result.refusal) {
        const why = result.refusal.explanation || (result.refusal.category ? `category: ${result.refusal.category}` : "");
        fail(`Claude declined to continue with this request${why ? ` (${why})` : ""}.`);
      } else if (result.truncated) {
        fail(result.truncated);
      } else {
        conv.messages.push({ kind: "status", text: "✓ done" });
        live({ type: "result", usage: lastUsage });
      }
    } catch (e) {
      // The API refused this very message (oversized image, bad content…) before answering: take it back out of both
      // histories, or the same 400 would come back on every later turn and the chat would be dead. The words go back
      // to the composer (or, when the user is looking at another chat, into the error) rather than vanishing.
      const rolledBack = rejectedContent(e) && apiMessages.length === historyBefore + 1;
      if (rolledBack) {
        apiMessages.length = historyBefore;
        if (conv.messages[bubbleAt]?.kind === "user") conv.messages.splice(bubbleAt, 1);
        draft = text;
      }
      const d = describeError(e);
      fail(rolledBack ? `${d.message}\n\nThe message was taken out of the chat${this.current === conv ? " and put back in the composer." : `: ${text}`}` : d.message);
      if (d.authFailed) {
        if (settings.trial) await this.d.forgetTrialToken?.(); // the next message asks the user to sign in again
        else this.post({ type: "auth", ok: false, text: "⚠ The API key was rejected. Check it in the settings:", loginLabel: "Open settings", recheckLabel: "I've fixed it" });
      }
    } finally {
      unlock();
      flush();
      this.abort(conv.id);
      this.runs.delete(conv.id);
      this.running.delete(conv.id);
      this.post({ type: "runState", convId: conv.id, running: false });
      const deleted = this.deleted.has(conv.id);
      if (this.current === conv && !deleted) {
        // Switched away and back mid-run: the cards were rebuilt from storage without live ids, so show the finished chat
        // afresh. A refused message is reloaded too: its bubble is gone and its text goes to the composer.
        if (this.reopened.delete(conv.id) || draft !== undefined) this.post(this.loadMsg(conv, draft));
        this.post({ type: "idle" });
      }
      this.reopened.delete(conv.id);
      if (!deleted) {
        try {
          await this.saveNow(conv);
        } catch (e) {
          this.post({ type: "notice", message: `Couldn't save this chat: ${describeError(e).message}` });
        }
      }
      this.postConversations();
    }
  }

  /** Browser tools run in the panel; uploads resolve the user's attachments first. */
  private async runTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    if (name === "browser_upload_file") {
      const a = typeof input.path === "string" ? this.attachments.get(input.path) : undefined;
      if (!a) {
        return { content: [{ type: "text", text: "That is not one of the user's attached files (attachments are only kept while the panel stays open — ask the user to attach it again)." }], isError: true };
      }
      return this.d.runTool(name, { ref: input.ref, name: a.name, data: a.data });
    }
    return this.d.runTool(name, input);
  }

  private async compact() {
    const conv = this.current;
    const apiMessages = conv?.apiMessages as Anthropic.MessageParam[] | undefined;
    if (!conv || !apiMessages?.length) {
      this.post({ type: "notice", message: "Nothing to compact yet." });
      return;
    }
    if (this.runs.has(conv.id)) {
      this.post({ type: "notice", message: "This chat is running — wait for it to finish first." });
      return;
    }
    const { s: settings } = await this.safeSettings();
    if (!settings?.apiKey) return void (await this.postAuth());

    repairHistory(apiMessages);
    const ctrl = new AbortController();
    this.runs.set(conv.id, ctrl);
    this.running.set(conv.id, conv);
    // Same rule as a run: only the chat on screen hears about it.
    const live = (m: unknown) => {
      if (this.current === conv) this.post(m);
    };
    live({ type: "started", model: conv.model });
    this.post({ type: "runState", convId: conv.id, running: true });
    try {
      const model = conv.model || this.prefs.model;
      const summary = await compactHistory({
        client: this.d.createClient(settings),
        model,
        traits: this.traitsFor(model),
        effort: settings.effort || "medium",
        system: this.d.system,
        tools: [...this.d.tools, ASK_TOOL],
        messages: apiMessages,
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) throw new Error("aborted");
      // Replace the whole history: nothing earlier stays to be replayed with stale thinking.
      apiMessages.splice(0, apiMessages.length,
        { role: "user", content: `Summary of our conversation so far (context was compacted):\n\n${summary}` },
        { role: "assistant", content: "Understood — I have the context and will continue from here." }
      );
      conv.context = undefined;
      conv.messages.push({ kind: "status", text: COMPACT_MARK });
      live({ type: "system", subtype: "compact_boundary", data: {} });
      live({ type: "contextUsage", info: null });
      if (!this.deleted.has(conv.id)) await this.saveNow(conv);
    } catch (e) {
      if (ctrl.signal.aborted || e instanceof Anthropic.APIUserAbortError) live({ type: "info", text: "Stopped — nothing was changed." });
      else live({ type: "error", message: describeError(e).message });
    } finally {
      this.runs.delete(conv.id);
      this.running.delete(conv.id);
      this.post({ type: "runState", convId: conv.id, running: false });
      live({ type: "idle" });
      this.postConversations();
    }
  }
}
