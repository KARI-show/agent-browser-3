// End-to-end: remote access of the browser extension, in a real Chromium with
// the built extension loaded — the three modes, independent of VS Code:
//   relay   the panel joins a relay hub (relay/hub.mjs) as a node
//   bot     the panel is a Telegram bot (Bot API faked via CDP Fetch interception)
//   helper  the native host (dist-browser/host) runs the relay itself
// A fake Anthropic API on localhost answers the model calls, so a prompt sent
// from the "phone" really runs and its reply streams back.
//
// Run: npm run test:e2e   (builds first; set CHROME_PATH if Chromium isn't found)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { extensionIdFromKey, findChromium, launch } from "./cdp.mjs";

const BRAND = JSON.parse(readFileSync(new URL("../../browser/brands/tali.json", import.meta.url), "utf8"));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT_DIR = join(root, "dist-browser", "extension");
const HOST_DIR = join(root, "dist-browser", "host");
const skip = !findChromium()
  ? "no Chromium found (set CHROME_PATH)"
  : !existsSync(join(EXT_DIR, "manifest.json")) || !existsSync(join(HOST_DIR, "host.js"))
    ? "build first: npm run build && npm run build:browser"
    : false;

const CHAT = "conv-e2e";
const OWNER = "4242";
const REPLY = "Hello from the fake model.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser, cdp, panel, workDir, model, extId;
let linkedNodeModules = false;
const children = [];

async function waitUntil(fn, ms = 15000, what = "condition") {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ""}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

const inPanel = (expr) => cdp.evaluate(panel, expr);
// The settings (chrome.storage.local) plus the "on in this browser session" flag 🛰 toggles (chrome.storage.session).
const setRemote = (cfg, on) =>
  inPanel(`chrome.storage.local.set({ agentRemote: ${JSON.stringify(cfg)} }).then(() => chrome.storage.session.set({ agentRemoteOn: ${!!on} })).then(() => true)`);
const logText = () => inPanel(`document.getElementById("log").innerText`);
const remoteStatus = () => inPanel(`chrome.storage.session.get("agentRemoteStatus").then((o) => o.agentRemoteStatus || {})`);

/** A fake Anthropic Messages API: lists one model, streams one short reply. */
function startFakeModel() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method === "GET" && req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: [{ type: "model", id: "claude-opus-5-5", display_name: "Opus (fake)", created_at: "2026-01-01T00:00:00Z" }],
          has_more: false, first_id: "claude-opus-5-5", last_id: "claude-opus-5-5",
        }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
          ev("message_start", { message: { id: "msg_e2e", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          for (const piece of ["Hello ", "from the ", "fake model."]) ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
          ev("content_block_stop", { index: 0 });
          ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } });
          ev("message_stop", {});
          res.end();
        });
        return;
      }
      res.writeHead(404).end();
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function startHub(token) {
  const port = await freePort();
  const cp = spawn(process.execPath, [join(root, "relay", "hub.mjs")], {
    env: { ...process.env, RELAY_TOKEN: token, PORT: String(port), RELAY_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(cp);
  await waitUntil(() => portOpen(port), 5000, "relay hub");
  return { port, cp };
}

/** A relay client — what the phone's web app is. */
function phone(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.msgs = [];
    ws.on("message", (raw) => ws.msgs.push(JSON.parse(String(raw))));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}
const sendJ = (ws, o) => ws.send(JSON.stringify(o));
const browserNode = (ws) => {
  for (const m of ws.msgs) {
    const list = m.t === "nodes" ? m.nodes : m.t === "presence" ? [m] : [];
    const n = list.find((x) => String(x.nodeId).startsWith("ext-") && (x.chats || []).some((c) => c.id === CHAT));
    if (n) return n;
  }
};
const chatEvents = (ws) => ws.msgs.filter((m) => m.t === "event" && m.chatId === CHAT).map((m) => m.ev);

before(async () => {
  if (skip) return;
  workDir = mkdtempSync(join(tmpdir(), "agent-browser-remote-e2e-"));
  const profile = join(workDir, "profile");
  extId = extensionIdFromKey(JSON.parse(readFileSync(join(EXT_DIR, "manifest.json"), "utf8")).key);
  model = await startFakeModel();

  // Native host for helper mode, registered in this test profile (Chromium reads
  // <user-data-dir>/NativeMessagingHosts). Deps borrowed from the repo when the
  // build has none; cloudflared is a stand-in that fails at once (no tunnel here).
  if (!existsSync(join(HOST_DIR, "node_modules"))) {
    symlinkSync(join(root, "node_modules"), join(HOST_DIR, "node_modules"), "dir");
    linkedNodeModules = true;
  }
  const hostHome = join(workDir, "host-home");
  mkdirSync(join(hostHome, "bin"), { recursive: true });
  writeFileSync(join(hostHome, "bin", "cloudflared"), "#!/bin/sh\necho 'no tunnel in tests' >&2\nexit 1\n");
  chmodSync(join(hostHome, "bin", "cloudflared"), 0o755);
  const launcher = join(workDir, "agent-browser-host.sh");
  writeFileSync(launcher, `#!/bin/sh\nAGENT_BROWSER_HOME="${hostHome}" exec "${process.execPath}" "${join(HOST_DIR, "host.js")}" "$@"\n`);
  chmodSync(launcher, 0o755);
  mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
  writeFileSync(
    join(profile, "NativeMessagingHosts", "com.kari.agent_browser.json"),
    JSON.stringify({ name: "com.kari.agent_browser", description: "e2e", path: launcher, type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] })
  );

  browser = await launch({ extensionDir: EXT_DIR, userDataDir: profile, downloadDir: join(workDir, "downloads") });
  cdp = browser.cdp;

  // Seed storage from an extension page before the panel opens: the built-in
  // agent pointed at the fake API, and one saved chat that opens as the current one.
  const { targetId: optTarget } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/options.html` });
  const opt = await cdp.attach(optTarget);
  await waitUntil(() => cdp.evaluate(opt, "!!(window.chrome && chrome.storage)"), 10000, "options page");
  const now = Date.now();
  const seed = {
    agentApi: { mode: "api", apiKey: "sk-ant-e2e", baseUrl: `http://127.0.0.1:${model.address().port}` },
    agentConvIndex: [{ id: CHAT, time: now, pinned: false, title: "E2E chat", preview: "hi" }],
    [`agentConv:${CHAT}`]: {
      id: CHAT, title: "E2E chat", time: now,
      messages: [{ kind: "user", text: "hi" }, { kind: "assistant", text: "an earlier answer" }],
      apiMessages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "an earlier answer" }] }],
    },
    agentLocalPrefs: { activeId: CHAT, model: "claude-opus-5-5", mode: "agent" },
  };
  await cdp.evaluate(opt, `chrome.storage.local.set(${JSON.stringify(seed)}).then(() => true)`);
  await cdp.send("Target.closeTarget", { targetId: optTarget });

  const { targetId: panelTarget } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/sidepanel.html` });
  panel = await cdp.attach(panelTarget);
  await cdp.send("Runtime.enable", {}, panel);
  await waitUntil(() => inPanel("typeof AgentRemote === 'object' && typeof AgentTelegram === 'object'"), 10000, "panel scripts");
  await waitUntil(async () => (await logText()).includes("an earlier answer"), 10000, "the seeded chat to open");
});

after(async () => {
  for (const cp of children) if (cp.exitCode === null) cp.kill();
  if (browser) await browser.close();
  if (model) model.close();
  if (linkedNodeModules) rmSync(join(HOST_DIR, "node_modules"), { force: true });
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("🛰 is visible in the side panel", { skip }, async () => {
  assert.notEqual(await inPanel(`getComputedStyle(document.getElementById("remoteBtn")).display`), "none");
});

// Not remote as such, but the same panel: shim.js turns dropped files into uploads (the shared UI
// only knows file:// paths from an editor) and marks the backend on <body> for the stylesheet.
test("panel: a dropped file becomes an attachment; the backend is marked on the body", { skip, timeout: 30000 }, async () => {
  assert.equal(await inPanel(`document.body.classList.contains("backend-local")`), true, "the seeded API key selects the built-in backend");
  assert.notEqual(await inPanel(`getComputedStyle(document.querySelector(".msg-actions .msg-act:last-child")).display`), "none", "Retry stays on the built-in backend");
  await inPanel(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
    document.getElementById("log").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  const chips = await waitUntil(async () => {
    const t = await inPanel(`document.getElementById("attachments").innerText`);
    return /notes\.txt/.test(t) ? t : false;
  }, 10000, "the attachment chip");
  assert.match(chips, /notes\.txt/);
  // Leave the composer as the other tests expect it.
  await inPanel(`document.querySelectorAll("#attachments .attach-x").forEach((x) => x.click()), true`);
});

test("relay mode: the phone sees the chats, opens one and runs a prompt that streams back", { skip, timeout: 60000 }, async () => {
  const token = "relay-e2e-token-0123456789";
  const hub = await startHub(token);
  const cfg = { mode: "relay", autostart: false, relayUrl: `ws://127.0.0.1:${hub.port}`, relayToken: token };
  await setRemote(cfg, true);
  const ws = await phone(`ws://127.0.0.1:${hub.port}/?token=${token}&role=client&id=phone1`);
  try {
    let node = browserNode(ws);
    if (!node) {
      sendJ(ws, { t: "list" });
      node = await waitUntil(() => browserNode(ws) || (sendJ(ws, { t: "list" }), false), 15000, "the browser node with its chats");
    }
    assert.equal(node.name, BRAND.shortName, "the node is named after the brand");

    sendJ(ws, { t: "subscribe", channel: `${node.nodeId}:${CHAT}` });
    sendJ(ws, { t: "toNode", nodeId: node.nodeId, msg: { type: "ready", chatId: CHAT } });
    const loaded = await waitUntil(() => chatEvents(ws).find((e) => e.type === "loadConversation"), 10000, "loadConversation");
    assert.ok(loaded.messages.some((m) => m.text === "an earlier answer"));

    sendJ(ws, { t: "toNode", nodeId: node.nodeId, msg: { type: "prompt", chatId: CHAT, text: "hello from the phone" } });
    await waitUntil(() => chatEvents(ws).some((e) => e.type === "result" || e.type === "idle"), 30000, "the run to finish");
    const evs = chatEvents(ws);
    assert.ok(evs.some((e) => e.type === "started"), "started is mirrored");
    assert.equal(evs.filter((e) => e.type === "text").map((e) => e.text).join(""), REPLY, "the reply streams to the phone");
    assert.ok(!evs.some((e) => e.type === "error"), `no error: ${JSON.stringify(evs.filter((e) => e.type === "error"))}`);
    const log = await logText();
    assert.ok(log.includes("hello from the phone") && log.includes(REPLY), "the panel shows the phone's prompt and the reply");

    // A prompt for a chat the panel doesn't show is refused, not misrouted.
    sendJ(ws, { t: "toNode", nodeId: node.nodeId, msg: { type: "prompt", chatId: "other-chat", text: "wrong chat" } });
    await waitUntil(() => ws.msgs.find((m) => m.t === "fromNode" && m.msg.type === "error" && /isn't open/.test(m.msg.message)), 5000, "refusal");
    assert.ok(!(await logText()).includes("wrong chat"));

    // Opening a chat that no longer exists (a stale link) gets an answer, not silence.
    sendJ(ws, { t: "toNode", nodeId: node.nodeId, msg: { type: "ready", chatId: "deleted-chat" } });
    await waitUntil(() => ws.msgs.find((m) => m.t === "fromNode" && m.msg.type === "error" && /no longer exists/.test(m.msg.message)), 5000, "missing-chat answer");

    // "+" on the phone: a fresh chat in the panel, and the phone's view is cleared too. Its next message
    // creates a chat whose channel it never subscribed to, so the node streams that chat to it directly.
    sendJ(ws, { t: "toNode", nodeId: node.nodeId, msg: { type: "newChat", chatId: CHAT } });
    await waitUntil(() => ws.msgs.find((m) => m.t === "fromNode" && m.msg.type === "clear"), 5000, "clear for the phone");
    await waitUntil(async () => !(await logText()).includes("an earlier answer"), 5000, "the panel to show a fresh chat");
    const direct = (from) => ws.msgs.slice(from).filter((m) => m.t === "fromNode").map((m) => m.msg);
    const sent = ws.msgs.length;
    sendJ(ws, { t: "toNode", nodeId: node.nodeId, msg: { type: "prompt", chatId: CHAT, text: "first in a new chat" } });
    await waitUntil(() => direct(sent).some((e) => e.type === "result" || e.type === "idle"), 30000, "the new chat's run to finish");
    assert.equal(direct(sent).filter((e) => e.type === "text").map((e) => e.text).join(""), REPLY, "the fresh chat streams to the phone that started it");
    const fresh = direct(sent).find((e) => e.type === "conversations" && e.activeId && e.activeId !== CHAT);
    assert.ok(fresh, "the phone learns the new chat's id from the list");
    assert.ok((await logText()).includes("first in a new chat"), "the panel shows the phone's prompt");
    // Delete that chat from the phone (by id — any chat) and go back to the seeded one.
    const ran = ws.msgs.length;
    sendJ(ws, { t: "toNode", nodeId: node.nodeId, msg: { type: "deleteConversation", chatId: CHAT, id: fresh.activeId } });
    await waitUntil(() => direct(ran).some((e) => e.type === "conversations" && Array.isArray(e.items) && !e.items.some((c) => c.id === fresh.activeId)), 5000, "the chat to be deleted");
    sendJ(ws, { t: "toNode", nodeId: node.nodeId, msg: { type: "ready", chatId: CHAT } });
    await waitUntil(async () => (await logText()).includes("an earlier answer"), 5000, "the chat to be back");

    const status = await remoteStatus();
    assert.equal(status.state, "on");
    assert.match(status.link, new RegExp(`/app\\?token=${token}&node=${node.nodeId}&chat=${CHAT}$`), "the settings page gets the open chat's link");
    await setRemote(cfg, false);
    await waitUntil(() => ws.msgs.some((m) => m.t === "nodeGone" && m.nodeId === node.nodeId), 5000, "the node to leave");
  } finally {
    ws.terminate();
    hub.cp.kill();
  }
});

test("bot mode: a Telegram message from the owner runs in the panel and the reply comes back", { skip, timeout: 60000 }, async () => {
  // Fake Bot API: intercept the panel's requests to api.telegram.org.
  const sent = [];
  const polls = [];
  let messageId = 500;
  const fulfill = (requestId, result) =>
    cdp.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify({ ok: true, result })).toString("base64"),
    }, panel).catch(() => {}); // the panel may have aborted it meanwhile
  const off = cdp.on((m) => {
    if (m.sessionId !== panel || m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const method = request.url.split("/").pop();
    const body = request.postData ? JSON.parse(request.postData) : {};
    if (method === "getMe") return fulfill(requestId, { id: 1, is_bot: true, username: "e2e_bot" });
    if (method === "getUpdates") {
      if (body.offset === -1) return fulfill(requestId, []);
      return polls.push(requestId); // long poll: held until the test delivers updates
    }
    if (method === "sendMessage") {
      sent.push({ method, body });
      return fulfill(requestId, { message_id: messageId++ });
    }
    if (method === "editMessageText") sent.push({ method, body });
    return fulfill(requestId, true);
  });
  const deliver = async (updates) => {
    await waitUntil(() => polls.length, 15000, "the bot to poll");
    await fulfill(polls.shift(), updates);
  };

  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.telegram.org/*" }] }, panel);
  const cfg = { mode: "bot", autostart: false, botToken: "123456:" + "a".repeat(30), userId: OWNER };
  try {
    await setRemote(cfg, true);
    await waitUntil(async () => (await remoteStatus()).state === "on", 15000, "the bot to come up");
    assert.match((await remoteStatus()).message, /@e2e_bot/);

    await deliver([
      { update_id: 1, message: { message_id: 1, from: { id: 7 }, chat: { id: 7, type: "private" }, text: "stranger's order" } },
      { update_id: 2, message: { message_id: 2, from: { id: Number(OWNER) }, chat: { id: Number(OWNER), type: "private" }, text: "task from telegram" } },
    ]);
    await waitUntil(
      () => sent.find((s) => (s.method === "sendMessage" || s.method === "editMessageText") && s.body.text === REPLY),
      30000,
      "the reply in Telegram"
    );
    const log = await logText();
    assert.ok(log.includes("task from telegram"), "the owner's task shows in the panel");
    assert.ok(!log.includes("stranger's order"), "a stranger's message is ignored");

    await deliver([{ update_id: 3, message: { message_id: 3, from: { id: Number(OWNER) }, chat: { id: Number(OWNER), type: "private" }, text: "/chats" } }]);
    const list = await waitUntil(() => sent.find((s) => s.body.text === "Pick a chat:"), 10000, "/chats");
    assert.deepEqual(list.body.reply_markup.inline_keyboard[0][0], { text: "• E2E chat", callback_data: `c:${CHAT}` });
  } finally {
    off();
    await setRemote(cfg, false);
    await cdp.send("Fetch.disable", {}, panel).catch(() => {});
  }
});

test("helper mode: 🛰 starts the local relay through the native host; the phone joins with the posted link", { skip, timeout: 90000 }, async () => {
  await setRemote({ mode: "helper", autostart: false }, false);
  await inPanel(`document.getElementById("remoteBtn").click(), true`);
  const text = await waitUntil(async () => {
    const t = await logText();
    return /\/app\?token=/.test(t) ? t : false;
  }, 60000, "the share link in the panel");
  assert.match(text, /public tunnel didn't come up/, "the missing tunnel is reported, the relay still works");
  const [link, port, token, nodeId, chat] = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/app\?token=([0-9a-f]+)&node=([^&\s]+)&chat=(\S+)/);
  assert.equal(chat, CHAT);
  assert.equal((await remoteStatus()).link, link, "the same link is kept for the settings page");
  assert.equal(await inPanel(`chrome.storage.session.get("agentRemoteOn").then((o) => o.agentRemoteOn)`), true, "🛰 sets the session flag, not the settings");

  const page = await fetch(`http://127.0.0.1:${port}/app`).then((r) => r.text());
  assert.match(page, /Content-Security-Policy/, "the helper serves the web app");

  const ws = await phone(`ws://127.0.0.1:${port}/?token=${token}&role=client&id=phone2`);
  try {
    await waitUntil(() => browserNode(ws) || (sendJ(ws, { t: "list" }), false), 10000, "the browser node on the helper's relay");
    sendJ(ws, { t: "subscribe", channel: `${nodeId}:${CHAT}` });
    sendJ(ws, { t: "toNode", nodeId, msg: { type: "ready", chatId: CHAT } });
    await waitUntil(() => chatEvents(ws).find((e) => e.type === "loadConversation"), 10000, "loadConversation via the helper's relay");
  } finally {
    ws.terminate();
  }

  // 🛰 again: the panel lets go of the host, which takes the relay down with it.
  await inPanel(`document.getElementById("remoteBtn").click(), true`);
  await waitUntil(async () => !(await portOpen(Number(port))), 10000, "the helper's relay to stop");
  assert.equal((await remoteStatus()).state, "off");
});
