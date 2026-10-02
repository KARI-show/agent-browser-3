import Anthropic from "@anthropic-ai/sdk";
import defs from "toolDefs.json";
import { describeError, Effort, ToolOutput, ToolPart } from "./engine";
import { LocalHost, Settings } from "./localHost";
import { KV } from "./store";

/**
 * Bundled into the extension as agentLocal.js and loaded by the side panel and
 * the options page. Exposes `window.AgentLocal`: which backend runs the agent,
 * the built-in agent itself, and the settings-page helpers (key test, trial
 * status).
 *
 * Three ways to run the agent, chosen in the settings:
 *  - "trial"        free trial through the operator's gateway (trial-server/): no key, limited
 *  - "api"          the user's own Anthropic API key, straight from the extension
 *  - "subscription" the local host with the user's own Claude Code sign-in (no built-in agent)
 */

declare const chrome: any; // extension APIs (no @types/chrome dependency)
declare const __TRIAL_URL__: string; // build-time: AGENT_TRIAL_URL, "" when no gateway is configured

const SETTINGS_KEY = "agentApi";
const TRIAL_KEY = "agentTrial";
const TOOL_TIMEOUT_MS = 60_000;
const TRIAL_URL = (typeof __TRIAL_URL__ === "string" ? __TRIAL_URL__ : "").replace(/\/+$/, "");

type Mode = "trial" | "api" | "subscription";

const kv: KV = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** https anywhere, or plain http only to this machine — an http:// address would send the key in the clear. */
export function validBaseUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function stored(): Promise<Record<string, unknown>> {
  return ((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {}) as Record<string, unknown>;
}

/** The mode in force: the user's choice, else their key if they set one, else the free trial if this build has one, else the host. */
function resolveMode(s: Record<string, unknown>): Mode {
  if (s.mode === "trial" && TRIAL_URL) return "trial";
  if (s.mode === "api" || s.mode === "subscription") return s.mode;
  if (str(s.apiKey)) return "api";
  return TRIAL_URL ? "trial" : "subscription";
}

async function registerTrial(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${TRIAL_URL}/register`, { method: "POST", headers: { "x-register-secret": "" } });
  } catch {
    throw new Error("Couldn't reach the free-trial service. Check your connection, or add your own API key in the settings.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.token !== "string") {
    throw new Error(body?.error?.message || `The free trial isn't available right now (${res.status}). Add your own API key in the settings.`);
  }
  await chrome.storage.local.set({ [TRIAL_KEY]: { token: body.token, url: TRIAL_URL } });
  return body.token;
}

/** What the built-in agent talks to: the trial gateway with this install's token, or the API with the user's key. */
async function loadSettings(): Promise<Settings> {
  const s = await stored();
  const effort = EFFORTS.includes(s.effort as Effort) ? (s.effort as Effort) : undefined;
  if (resolveMode(s) === "trial") {
    let t = ((await chrome.storage.local.get(TRIAL_KEY))[TRIAL_KEY] || {}) as { token?: string; url?: string };
    // A token from another gateway (a different build) is useless here.
    if (!t.token || t.url !== TRIAL_URL) t = { token: await registerTrial(), url: TRIAL_URL };
    return { apiKey: t.token, baseUrl: TRIAL_URL, effort, trial: true };
  }
  const baseUrl = str(s.baseUrl);
  return {
    apiKey: str(s.apiKey),
    baseUrl: baseUrl && validBaseUrl(baseUrl) ? baseUrl : undefined, // an unsafe address is ignored, never sent a key
    workspaceId: str(s.workspaceId),
    effort,
  };
}

function createClient(s: Settings): Anthropic {
  // The key lives in this browser profile's extension storage and is only ever
  // sent to the API host below, from the extension's own pages.
  return new Anthropic({
    apiKey: s.apiKey,
    baseURL: s.baseUrl,
    dangerouslyAllowBrowser: true,
    maxRetries: 3,
    ...(s.workspaceId ? { defaultHeaders: { "anthropic-workspace-id": s.workspaceId } } : {}),
  });
}

async function runTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const tools = (window as any).AgentBrowserTools;
  if (!tools) return { content: [{ type: "text", text: "Browser tools aren't available on this page." }], isError: true };
  let timer: ReturnType<typeof setTimeout>;
  try {
    const parts = (await Promise.race([
      tools.run(name, input),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${name} timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS))),
    ])) as ToolPart[];
    return { content: parts };
  } catch (e) {
    return { content: [{ type: "text", text: String((e as Error)?.message ?? e) }], isError: true };
  } finally {
    clearTimeout(timer!);
  }
}

// Identifies this build's system prompt + tools; a chat saved under another build has its old thinking dropped.
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
const PROMPT_ID = fnv(defs.system + JSON.stringify(defs.tools));

(window as any).AgentLocal = {
  SETTINGS_KEY,
  trialConfigured: !!TRIAL_URL,

  /** Which backend the panel should use: the built-in agent ("local") or the native host ("native"). */
  async backend(): Promise<"local" | "native"> {
    const s = await stored();
    const mode = resolveMode(s);
    if (mode === "subscription") return "native";
    if (mode === "api" && !str(s.apiKey)) return "native"; // chose "own key" but hasn't added one: fall back to the host / setup banner
    return "local";
  },

  /** Kept for callers that only care whether a key is saved. */
  async hasKey(): Promise<boolean> {
    return !!str((await stored()).apiKey);
  },

  create(post: (msg: unknown) => void) {
    const host = new LocalHost({
      post,
      kv,
      loadSettings,
      createClient,
      tools: defs.tools,
      system: defs.system,
      promptId: PROMPT_ID,
      runTool,
      describeCall: (name, input) => (window as any).AgentBrowserTools?.describe?.(name, input),
      openSettings: () => chrome.runtime.openOptionsPage(),
      forgetTrialToken: () => chrome.storage.local.remove(TRIAL_KEY),
    });
    return { handle: (msg: unknown) => void host.handle(msg) };
  },

  /** Settings page: does this key (and base URL / workspace) work? */
  async testKey(s: Settings): Promise<{ ok: boolean; message: string }> {
    if (!s.apiKey) return { ok: false, message: "Enter an API key first." };
    if (s.baseUrl && !validBaseUrl(s.baseUrl)) return { ok: false, message: "The API address must start with https:// (http:// is only allowed for localhost)." };
    try {
      const page = await createClient(s).models.list({ limit: 20 });
      const ids = page.data.map((m) => m.id);
      return { ok: true, message: `Key works — ${ids.length ? "models available: " + ids.slice(0, 4).join(", ") + (ids.length > 4 ? "…" : "") : "no models listed"}.` };
    } catch (e) {
      const raw = String((e as { message?: string })?.message ?? "");
      if (/not scoped to a workspace/i.test(raw)) {
        return { ok: false, message: "This key isn't tied to a workspace — enter the Workspace ID (wrkspc_…) below, or create a key inside a workspace in the Anthropic console." };
      }
      return { ok: false, message: describeError(e).message };
    }
  },

  /** Settings page: how much of the free trial is left (registers this install on first use). */
  async trialStatus(): Promise<{ ok: boolean; message: string }> {
    if (!TRIAL_URL) return { ok: false, message: "This build has no free-trial service configured." };
    try {
      const s = await loadSettings();
      const r = await fetch(`${TRIAL_URL}/status`, { headers: { "x-api-key": s.apiKey || "" } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, message: body?.error?.message || `The free trial answered ${r.status}.` };
      return { ok: true, message: `Free trial: about $${body.dailyLeftUsd.toFixed(2)} left today, $${body.totalLeftUsd.toFixed(2)} in total. Models: ${body.models.join(", ")}.` };
    } catch (e) {
      return { ok: false, message: String((e as Error)?.message ?? e) };
    }
  },
};
