import { WebSocket } from "ws";
import { log } from "./log";

/**
 * Outbound WebSocket client to the sync relay. The extension is a "node": it
 * announces its open workspace + chats (presence), mirrors a chat's live stream
 * to subscribers, and receives messages from web clients (the mini-app / phone)
 * routed by the relay. The relay never sees files — only presence + events.
 */
export interface HubOptions {
  relayUrl: string; // ws://host:port  (no trailing slash needed)
  token: string; // shared secret = the only auth
  nodeId: string; // stable per machine
  nodeName: string; // human label (hostname / folder)
}

export interface HubHandlers {
  /** A web client (phone/mini-app) sent a webview-protocol message. */
  onClientMessage: (clientId: string, msg: any) => void;
  /** Current presence snapshot to publish. */
  presence: () => { workspace: unknown; chats: unknown[] };
  /** Connection up/down (for UI hints). */
  onState?: (connected: boolean) => void;
}

const RETRY_MIN_MS = 2500;
const RETRY_MAX_MS = 30_000;
/** How often merged text/thinking pieces go out (≤10 msg/s while streaming). */
export const STREAM_FLUSH_MS = 100;

export class HubClient {
  private ws?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private retryDelay = RETRY_MIN_MS;
  private pendingStream?: { chatId: string; type: "text" | "thinking"; text: string };
  private streamTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly opts: HubOptions,
    private readonly handlers: HubHandlers
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    this.closed = false;
    let base = this.opts.relayUrl.replace(/\/+$/, "");
    // Security: the token rides in the URL, so a plaintext ws:// link to a
    // remote relay leaks it to every hop. Upgrade non-local ws:// to wss://
    // (localhost/LAN dev stays plain — the tunnel handles TLS in that setup).
    const host = (() => {
      try {
        return new URL(base.replace(/^ws/, "http")).hostname;
      } catch {
        return "";
      }
    })();
    const isLocal =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" || // URL.hostname keeps the brackets for IPv6
      /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host);
    if (base.startsWith("ws://") && !isLocal) {
      log.warn(`hub: upgrading plaintext ws:// to wss:// for remote relay ${host}`);
      base = "wss://" + base.slice("ws://".length);
    }
    const url =
      `${base}/?token=${encodeURIComponent(this.opts.token)}` +
      `&role=node&id=${encodeURIComponent(this.opts.nodeId)}` +
      `&name=${encodeURIComponent(this.opts.nodeName)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      log.error("hub: connect failed", e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      log.info("hub: connected to relay");
      this.retryDelay = RETRY_MIN_MS;
      this.publishPresence();
      this.handlers.onState?.(true);
    });
    ws.on("message", (raw) => {
      let m: any;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.t === "fromClient" && m.msg) {
        this.handlers.onClientMessage(m.clientId, m.msg);
      }
    });
    ws.on("close", (code) => {
      // A socket we already replaced (dispose() + connect()) must not schedule
      // a second reconnect — that would leave two live sockets for one node.
      if (this.ws !== ws) return;
      this.handlers.onState?.(false);
      if (code === 4001) {
        // The relay rejected the token; retrying can't fix it.
        log.error("hub: relay rejected the token — check agentIde.relayToken (must match RELAY_TOKEN)");
        return;
      }
      this.scheduleReconnect();
    });
    ws.on("error", (e) => {
      log.warn("hub: socket error " + (e as any)?.message);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  private scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.timer);
    // Capped exponential backoff: a relay that's down for an hour shouldn't get
    // a reconnect every 2.5 s from every node. Reset on a successful open.
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  /** Announce the open workspace + chat list to all viewers. */
  publishPresence() {
    if (!this.connected) return;
    const p = this.handlers.presence();
    this.raw({ t: "presence", workspace: p.workspace, chats: p.chats });
  }

  /** Push a live stream event for a chat to its subscribers. */
  emit(chatId: string, ev: unknown) {
    if (!chatId) return;
    // Streamed text/thinking arrives token by token (thinking uses partial
    // messages); the relay drops a node sending more than ~40 messages/s. Merge
    // consecutive pieces of the same kind; any other event flushes them first,
    // so subscribers still see everything in order.
    const e = ev as { type?: unknown; text?: unknown } | null;
    if (e && (e.type === "text" || e.type === "thinking") && typeof e.text === "string" && Object.keys(e).length === 2) {
      const type = e.type as "text" | "thinking";
      const text = e.text as string;
      const p = this.pendingStream;
      if (p && p.chatId === chatId && p.type === type) p.text += text;
      else {
        this.flushStream();
        this.pendingStream = { chatId, type, text };
      }
      if (!this.streamTimer) this.streamTimer = setTimeout(() => this.flushStream(), STREAM_FLUSH_MS);
      return;
    }
    this.flushStream();
    this.raw({ t: "event", chatId, ev });
  }

  private flushStream() {
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    const p = this.pendingStream;
    if (!p) return;
    this.pendingStream = undefined;
    this.raw({ t: "event", chatId: p.chatId, ev: { type: p.type, text: p.text } });
  }

  private raw(o: unknown) {
    if (!this.connected) return;
    try {
      this.ws!.send(JSON.stringify(o));
    } catch (e) {
      log.warn("hub: send failed");
    }
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    this.pendingStream = undefined;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
