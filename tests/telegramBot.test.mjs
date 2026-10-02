// The in-extension Telegram bot (browser/extension/telegram.js) against a fake
// Bot API. It only touches fetch, window events and window.AgentRemote, so it
// runs in a vm context with stand-ins for those.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const TELEGRAM_JS = fileURLToPath(new URL("../browser/extension/telegram.js", import.meta.url));
const OWNER = 42;
// Objects made inside the vm have another realm's prototypes; compare as data.
const plain = (x) => JSON.parse(JSON.stringify(x));

function fakeTelegram() {
  const calls = [];
  const queue = [];
  let waiter = null;
  let nextMessageId = 100;
  const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
  async function fetchImpl(url, init) {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body || "{}");
    calls.push({ method, body });
    switch (method) {
      case "getMe":
        return ok({ username: "testbot" });
      case "getUpdates":
        if (body.offset === -1) return ok([{ update_id: 5 }]); // backlog from before the panel opened
        if (queue.length) return ok(queue.splice(0));
        return new Promise((resolve, reject) => {
          waiter = () => {
            waiter = null;
            resolve(ok(queue.splice(0)));
          };
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      case "sendMessage":
        return ok({ message_id: nextMessageId++ });
      default:
        return ok(true);
    }
  }
  return {
    calls,
    fetch: fetchImpl,
    push(update) {
      queue.push(update);
      if (waiter) waiter();
    },
  };
}

function fakeRemote() {
  const rec = { st: { activeChatId: null, chats: [], running: {} }, toHost: [], local: [], ups: [], fails: [] };
  const api = {
    toHost: (m) => rec.toHost.push(plain(m)),
    local: (m) => rec.local.push(plain(m)),
    state: () => rec.st,
    up: (message, panelText) => rec.ups.push([message, panelText]),
    status: () => {},
    fail: (m) => rec.fails.push(m),
  };
  return { rec, api };
}

function loadBot(fetchImpl, remote) {
  const window = new EventTarget();
  window.AgentRemote = remote;
  const context = vm.createContext({ window, fetch: fetchImpl, setTimeout, clearTimeout, console, AbortController });
  vm.runInContext(fs.readFileSync(TELEGRAM_JS, "utf8"), context);
  return window;
}

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await delay(10);
  }
  throw new Error("timed out");
}

const fromOwner = (update_id, text) => ({ update_id, message: { from: { id: OWNER }, chat: { id: OWNER, type: "private" }, text } });
const panel = (win, data) => win.dispatchEvent(new MessageEvent("message", { data }));
const BOT = { botToken: "123456:" + "a".repeat(30), userId: String(OWNER) };

test("telegram bot: skips the backlog, serves only the owner, streams the reply into one message", { timeout: 15000 }, async () => {
  const tg = fakeTelegram();
  const { rec, api } = fakeRemote();
  const win = loadBot(tg.fetch, api);
  win.AgentTelegram.start(BOT);
  try {
    await waitFor(() => rec.ups.length);
    assert.equal(rec.ups[0][0], "Telegram bot @testbot");
    await waitFor(() => tg.calls.some((c) => c.method === "getUpdates" && c.body.offset === 6));

    tg.push({ update_id: 6, message: { from: { id: 7 }, chat: { id: 7 }, text: "stranger's order" } });
    tg.push(fromOwner(7, "find flights"));
    await waitFor(() => rec.toHost.some((m) => m.type === "prompt"));
    assert.deepEqual(rec.toHost.filter((m) => m.type === "prompt").map((m) => m.text), ["find flights"]);
    assert.deepEqual(rec.local, [{ type: "user", text: "find flights" }], "the panel shows who asked");

    panel(win, { type: "text", text: "Hello " });
    panel(win, { type: "text", text: "world" });
    const progress = await waitFor(() => tg.calls.find((c) => c.method === "sendMessage" && c.body.text.startsWith("Hello world")));
    assert.match(progress.body.text, /working/);
    panel(win, { type: "result" });
    const final = await waitFor(() => tg.calls.find((c) => c.method === "editMessageText" && c.body.text === "Hello world"));
    assert.equal(final.body.message_id, 100, "the live message becomes the final answer");
    assert.equal(final.body.chat_id, String(OWNER));
  } finally {
    win.AgentTelegram.stop();
  }
});

test("telegram bot: /chats lists chats; approvals and question options are buttons", { timeout: 15000 }, async () => {
  const tg = fakeTelegram();
  const { rec, api } = fakeRemote();
  const win = loadBot(tg.fetch, api);
  win.AgentTelegram.start(BOT);
  try {
    await waitFor(() => tg.calls.some((c) => c.method === "getUpdates" && c.body.offset === 6));
    rec.st.chats = [{ id: "c1", title: "Flights" }];
    rec.st.activeChatId = "c1";

    tg.push(fromOwner(6, "/chats"));
    const list = await waitFor(() => tg.calls.find((c) => c.method === "sendMessage" && c.body.text === "Pick a chat:"));
    assert.deepEqual(list.body.reply_markup.inline_keyboard, [[{ text: "• Flights", callback_data: "c:c1" }]]);

    tg.push(fromOwner(7, "buy the ticket"));
    await waitFor(() => rec.toHost.some((m) => m.type === "prompt"));

    panel(win, { type: "approval", id: "a1", toolName: "mcp__browser__browser_click", input: { ref: 3 } });
    const card = await waitFor(() => tg.calls.find((c) => c.method === "sendMessage" && c.body.text.startsWith("🔐 Allow: click")));
    assert.deepEqual(card.body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["a:1:a1", "a:0:a1"]);
    tg.push({ update_id: 8, callback_query: { id: "cb1", from: { id: OWNER }, data: "a:1:a1", message: { message_id: 1 } } });
    await waitFor(() => rec.toHost.some((m) => m.type === "approvalResponse"));
    assert.deepEqual(rec.toHost.find((m) => m.type === "approvalResponse"), { type: "approvalResponse", id: "a1", approved: true });

    panel(win, {
      type: "question",
      id: "q1",
      questions: [{ question: "Which seat?", header: "Seat", options: [{ label: "Window" }, { label: "Aisle" }] }],
    });
    await waitFor(() => tg.calls.find((c) => c.method === "sendMessage" && c.body.text.startsWith("❓ Which seat?")));
    tg.push({ update_id: 9, callback_query: { id: "cb2", from: { id: OWNER }, data: "q:1:q1", message: { message_id: 2 } } });
    await waitFor(() => rec.toHost.some((m) => m.type === "questionResponse"));
    assert.deepEqual(rec.toHost.find((m) => m.type === "questionResponse"), { type: "questionResponse", id: "q1", answer: "Seat: Aisle" });

    // A stranger's button press does nothing.
    tg.push({ update_id: 10, callback_query: { id: "cb3", from: { id: 7 }, data: "a:1:a2", message: { message_id: 3 } } });
    await delay(100);
    assert.ok(!rec.toHost.some((m) => m.id === "a2"));
  } finally {
    win.AgentTelegram.stop();
  }
});
