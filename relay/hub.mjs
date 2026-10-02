// Agent IDE sync relay — a tiny WebSocket hub.
//
// All your agent-ide instances ("nodes") and viewers ("clients") connect OUT to
// this one process (so no inbound ports on the dev machines). The hub does three
// things and nothing else — it never sees your files:
//   1. presence   — which workspaces ("folders") are open, on which nodes, with
//                   what chats; broadcast to clients.
//   2. routing    — a client message for a chat is forwarded to the node that
//                   owns it (by nodeId).
//   3. fan-out    — a node's stream events are pushed to every client subscribed
//                   to that chat → live mirror across devices.
//
// Auth: a single shared token (RELAY_TOKEN) gates every connection. One token =
// one account/room. Connections without the exact token are rejected.
//
// Run:  RELAY_TOKEN=your-secret PORT=8790 node relay/hub.mjs
//       (RELAY_HOST=127.0.0.1 to listen on loopback only; default: all interfaces)
import { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";
import {
  MAX_PAYLOAD,
  MAX_ID_LEN,
  MAX_SUBS,
  makeTokenChecker,
  isId,
  makeRateLimiter,
} from "./validate.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname, sep } from "node:path";

const PORT = Number(process.env.PORT || 8790);
// Empty = all interfaces (a relay on a VPS must be reachable). The extension's
// auto-spawned local relay sets 127.0.0.1 — only the tunnel needs to reach it.
const HOST = process.env.RELAY_HOST || undefined;
const TOKEN = process.env.RELAY_TOKEN || "";
if (!TOKEN) {
  console.error("Refusing to start without RELAY_TOKEN (it's your only auth).");
  process.exit(1);
}

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const tokenOk = makeTokenChecker(TOKEN);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// One room per token (v1 = one user). Maps keep latest state.
const nodes = new Map(); // nodeId -> { ws, presence }
const clients = new Map(); // clientId -> ws
const subs = new Map(); // ws -> Set<channel "nodeId:chatId">

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcastClients(obj) {
  for (const ws of clients.values()) send(ws, obj);
}
function presenceList() {
  return [...nodes.entries()].map(([nodeId, n]) => ({ nodeId, ...n.presence }));
}

// HTTP server: serves the web app (app.html + main.js + style.css) from public/.
const httpServer = createServer(async (req, res) => {
  let path;
  try {
    path = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch {
    // Malformed escape ("/%"): a throw here would be an unhandled rejection
    // and take the whole relay down — one unauthenticated request = DoS.
    res.writeHead(400).end("bad request");
    return;
  }
  // Cheap health probe used by the tunnel verifier.
  if (path === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (path === "/" || path === "/app") path = "/app.html";
  // Confine to public/ (no path traversal). Compare with the trailing
  // separator, or a sibling like "public-old/" would pass the prefix test.
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    // Never let the browser / Telegram in-app webview cache the app bundle —
    // otherwise a redeployed main.js/style.css keeps serving stale code and
    // fixes appear not to land. Always revalidate against the relay (which
    // reads fresh from disk per request).
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

// WebSocket shares the same port via HTTP upgrade. maxPayload caps a single
// frame at 1 MB — ws terminates oversized messages before we ever parse them.
const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });
httpServer.listen(PORT, HOST, () => log(`relay (http + ws) listening on ${HOST ?? ""}:${PORT}`));

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const token = url.searchParams.get("token") || "";
  const role = url.searchParams.get("role") || "client"; // "node" | "client"
  const id = url.searchParams.get("id") || randomBytes(6).toString("hex");
  const name = (url.searchParams.get("name") || id).slice(0, MAX_ID_LEN);

  if (!tokenOk(token)) {
    // role is unauthenticated input — quote + cap it so it can't forge log lines.
    log("rejected (bad token) role=" + JSON.stringify(role.slice(0, 16)));
    send(ws, { t: "error", message: "auth" });
    ws.close(4001, "auth");
    return;
  }
  if ((role !== "node" && role !== "client") || !isId(id)) {
    log("rejected (bad role/id)");
    ws.close(4002, "bad params");
    return;
  }

  // Per-socket rate limit: a runaway/malicious peer can't spin the hub's CPU
  // or spam every subscriber. Generous for real traffic, fatal for floods.
  const rateExceeded = makeRateLimiter();

  ws.alive = true;
  ws.on("pong", () => (ws.alive = true));
  subs.set(ws, new Set());

  // A reconnect under the same id supersedes the old socket (often still
  // half-open until the heartbeat reaps it). The old socket is NOT kicked:
  // several side panels can share one extension nodeId, and kicking would make
  // them evict each other in a reconnect loop. Ownership checks below keep the
  // stale socket from clobbering or deleting the newer entry instead.
  if (role === "node") {
    nodes.set(id, { ws, presence: { name, workspace: null, chats: [] } });
    log(`node+ ${name} (${id}) — ${nodes.size} node(s)`);
  } else {
    clients.set(id, ws);
    log(`client+ ${name} (${id}) — ${clients.size} client(s)`);
    // Hand the new client the current world.
    send(ws, { t: "nodes", nodes: presenceList() });
  }

  ws.on("message", (raw) => {
    if (rateExceeded()) {
      log(`rate limit — dropping ${role} ${id}`);
      ws.terminate();
      return;
    }
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!m || typeof m.t !== "string") return;
    switch (m.t) {
      // ── node publishes its open folder + chats ──
      case "presence": {
        const n = nodes.get(id);
        // clients can't publish presence; a superseded socket can't overwrite it
        if (!n || n.ws !== ws) break;
        n.presence = {
          name,
          workspace: typeof m.workspace === "string" ? m.workspace.slice(0, 300) : null,
          chats: Array.isArray(m.chats) ? m.chats.slice(0, 200) : [],
        };
        broadcastClients({ t: "presence", nodeId: id, ...n.presence });
        break;
      }
      // ── node streams a chat event → fan out to that chat's subscribers ──
      case "event": {
        if (role !== "node" || !isId(m.chatId)) break; // only nodes stream events
        const channel = `${id}:${m.chatId}`;
        for (const [ws2, set] of subs) {
          if (set.has(channel)) send(ws2, { t: "event", nodeId: id, chatId: m.chatId, ev: m.ev });
        }
        break;
      }
      // ── client asks for the current folder list ──
      case "list":
        send(ws, { t: "nodes", nodes: presenceList() });
        break;
      // ── client (un)subscribes to a chat channel "nodeId:chatId" ──
      case "subscribe": {
        const set = subs.get(ws);
        if (!set || !isId(m.channel, MAX_ID_LEN * 2 + 1)) break;
        if (set.size >= MAX_SUBS) break; // cap watched channels per socket
        set.add(m.channel);
        break;
      }
      case "unsubscribe":
        if (isId(m.channel, MAX_ID_LEN * 2 + 1)) subs.get(ws)?.delete(m.channel);
        break;
      // ── client → owning node (prompt, open-chat request, stop, …) ──
      case "toNode": {
        if (!isId(m.nodeId)) break;
        const target = nodes.get(m.nodeId);
        if (target) send(target.ws, { t: "fromClient", clientId: id, msg: m.msg });
        else send(ws, { t: "error", message: "node offline" });
        break;
      }
      // ── node → a specific client (e.g. chat history reply) ──
      case "toClient": {
        if (role !== "node" || !isId(m.clientId)) break; // only nodes reply to clients
        const target = clients.get(m.clientId);
        if (target) send(target, { t: "fromNode", nodeId: id, msg: m.msg });
        break;
      }
    }
  });

  ws.on("close", () => {
    subs.delete(ws);
    if (role === "node") {
      // Only drop the entry if it's still ours — a newer socket may own the id.
      if (nodes.get(id)?.ws !== ws) return;
      nodes.delete(id);
      broadcastClients({ t: "nodeGone", nodeId: id });
      log(`node- ${name} (${id}) — ${nodes.size} left`);
    } else {
      if (clients.get(id) !== ws) return;
      clients.delete(id);
      log(`client- ${name} (${id}) — ${clients.size} left`);
    }
  });
});

// Heartbeat: drop dead sockets so presence stays accurate.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.alive === false) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30000);
