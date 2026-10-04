// Telegram bot — runs on the user's machine, connects to the local relay as a
// client, and gives a navigation UI: active folders → their chats → "Open chat"
// (Telegram Mini App) on the current public tunnel URL. The plugin publishes
// presence, so folders/chats are discovered automatically — the user configures
// nothing in the bot. Only the whitelisted Telegram user id is served.
//
// env: BOT_TOKEN, TG_USER_ID, RELAY_URL (ws://127.0.0.1:8790), RELAY_TOKEN,
//      PUBLIC_URL (https://xxxx.trycloudflare.com),
//      TELEGRAM_API (tests only: a stand-in for https://api.telegram.org)
import { WebSocket } from "ws";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TG_USER_ID = String(process.env.TG_USER_ID || "");
const RELAY_URL = (process.env.RELAY_URL || "ws://127.0.0.1:8790").replace(/\/+$/, "");
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
// Wording for who runs the bot: VS Code's Remote (default) or the browser helper.
const APP_NAME = process.env.BOT_APP_NAME || "Agent IDE";
const EMPTY_HINT = process.env.BOT_EMPTY_HINT || "No active folders. Open a chat in the IDE and run “Agent IDE: Remote”.";
if (!BOT_TOKEN || !TG_USER_ID) {
  console.error("bot: need BOT_TOKEN and TG_USER_ID");
  process.exit(1);
}
const API = `${(process.env.TELEGRAM_API || "https://api.telegram.org").replace(/\/+$/, "")}/bot${BOT_TOKEN}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "bot", ...a);

// ── relay client: keep a live view of nodes/folders/chats ──
let nodes = []; // [{ nodeId, name, workspace:{name,path}, chats:[{id,title}] }]
function upsert(n) {
  nodes = nodes.filter((x) => x.nodeId !== n.nodeId);
  nodes.push(n);
}
function connectRelay() {
  const ws = new WebSocket(
    `${RELAY_URL}/?token=${encodeURIComponent(RELAY_TOKEN)}&role=client&id=tgbot&name=tg-bot`
  );
  ws.on("open", () => ws.send(JSON.stringify({ t: "list" })));
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === "nodes") nodes = m.nodes || [];
    else if (m.t === "presence") upsert({ nodeId: m.nodeId, name: m.name, workspace: m.workspace, chats: m.chats || [] });
    else if (m.t === "nodeGone") nodes = nodes.filter((x) => x.nodeId !== m.nodeId);
  });
  ws.on("close", () => setTimeout(connectRelay, 2000));
  ws.on("error", () => { try { ws.close(); } catch {} });
}

// ── Telegram helpers ──
async function tg(method, body) {
  try {
    const r = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    log("tg error", method, e?.message);
    return null;
  }
}
const authed = (from) => String(from?.id) === TG_USER_ID;

function foldersKeyboard() {
  if (!nodes.length) return { text: EMPTY_HINT, reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "home" }]] } };
  const rows = nodes.map((n) => [
    { text: "📂 " + (n.workspace?.name || n.name || n.nodeId), callback_data: "f:" + n.nodeId },
  ]);
  rows.push([{ text: "🔄 Refresh", callback_data: "home" }]);
  return { text: "Active folders:", reply_markup: { inline_keyboard: rows } };
}
function chatsKeyboard(nodeId) {
  const n = nodes.find((x) => x.nodeId === nodeId);
  if (!n) return { text: "Folder went offline.", reply_markup: { inline_keyboard: [[{ text: "⬅ Folders", callback_data: "home" }]] } };
  const rows = (n.chats || []).map((c) => [
    { text: "💬 " + (c.title || c.id), callback_data: "o:" + nodeId + ":" + c.id },
  ]);
  rows.push([{ text: "⬅ Folders", callback_data: "home" }]);
  return { text: `📂 ${n.workspace?.name || n.name}\nChats:`, reply_markup: { inline_keyboard: rows } };
}
function openKeyboard(nodeId, chatId) {
  const n = nodes.find((x) => x.nodeId === nodeId);
  const c = n?.chats?.find((x) => x.id === chatId);
  const url = `${PUBLIC_URL}/app?token=${encodeURIComponent(RELAY_TOKEN)}&node=${encodeURIComponent(nodeId)}&chat=${encodeURIComponent(chatId)}`;
  const kb = [];
  if (PUBLIC_URL) kb.push([{ text: "🚀 Open chat", web_app: { url } }]);
  kb.push([{ text: "⬅ Chats", callback_data: "f:" + nodeId }, { text: "📂 Folders", callback_data: "home" }]);
  return { text: `💬 ${c?.title || chatId}\nOpen the live chat:`, reply_markup: { inline_keyboard: kb } };
}

// ── update loop ──
let offset = 0;
async function poll() {
  // Make sure long-polling can run: drop any webhook, validate the token.
  await tg("deleteWebhook", { drop_pending_updates: false });
  const me = await tg("getMe");
  if (!me?.ok) {
    // Nothing would ever work from here. Quit with the reason, so whoever started the bot (the
    // browser helper, a shell) sees it — not a process that stays up and never answers.
    console.error(
      me
        ? `bot: Telegram rejected the bot token (${me.description || `error ${me.error_code}`}) — check BOT_TOKEN`
        : "bot: can't reach api.telegram.org — check the network"
    );
    process.exit(1);
  }
  log(`@${me.result.username} online; whitelist id ${TG_USER_ID}`);
  // Greet the owner so it's obvious the bot is alive (works only after the user
  // has pressed Start at least once; ignore the 403 otherwise).
  const k = foldersKeyboard();
  await tg("sendMessage", {
    chat_id: TG_USER_ID,
    text: `🤖 ${APP_NAME} connected.\n` + k.text,
    reply_markup: k.reply_markup,
  });
  // drop backlog
  const init = await tg("getUpdates", { timeout: 0, offset: -1 });
  if (init?.result?.length) offset = init.result[init.result.length - 1].update_id + 1;
  for (;;) {
    const j = await tg("getUpdates", { timeout: 50, offset });
    if (!j || j.ok === false) {
      // 409 = another getUpdates/webhook is active; back off and retry.
      log("getUpdates error:", JSON.stringify(j?.description ?? j));
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const u of j.result || []) {
      offset = u.update_id + 1;
      // Fire-and-forget, but never unhandled: one odd update must not kill the bot.
      handle(u).catch((e) => log("update error:", e?.message ?? e));
    }
  }
}
async function handle(u) {
  if (u.message) {
    if (!authed(u.message.from)) return;
    const k = foldersKeyboard();
    await tg("sendMessage", { chat_id: u.message.chat.id, text: k.text, reply_markup: k.reply_markup });
  } else if (u.callback_query) {
    const cq = u.callback_query;
    if (!authed(cq.from)) return tg("answerCallbackQuery", { callback_query_id: cq.id });
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    let k;
    const d = cq.data || "home";
    if (d === "home") k = foldersKeyboard();
    else if (d.startsWith("f:")) k = chatsKeyboard(d.slice(2));
    else if (d.startsWith("o:")) {
      const rest = d.slice(2);
      const i = rest.indexOf(":");
      k = openKeyboard(rest.slice(0, i), rest.slice(i + 1));
    }
    if (k && cq.message) {
      // cq.message is absent for callbacks on inline-mode messages.
      await tg("editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: k.text,
        reply_markup: k.reply_markup,
      });
    }
  }
}

log(`starting (relay ${RELAY_URL}, public ${PUBLIC_URL || "—"})`);
connectRelay();
poll().catch((e) => {
  log("fatal:", e?.message ?? e);
  process.exit(1);
});
