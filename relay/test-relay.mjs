// End-to-end proof of relay/hub.mjs without VS Code or Telegram:
// spawn the relay, connect a fake NODE (announces a folder + chat) and a fake
// CLIENT (the "phone"), then exercise the full loop —
//   presence  → client sees the node's folder + chats
//   routing   → client sends a prompt; the owning node receives it
//   fan-out   → node streams events; the subscribed client receives them live
// Also checks the auth gate rejects a bad token.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 8791;
const TOKEN = "test-secret";
const URL = `ws://127.0.0.1:${PORT}`;

const relay = spawn(process.execPath, ["relay/hub.mjs"], {
  env: { ...process.env, PORT: String(PORT), RELAY_TOKEN: TOKEN },
  stdio: "ignore",
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (ws) => new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
const conn = (role, id, name) =>
  new WebSocket(`${URL}/?token=${TOKEN}&role=${role}&id=${id}&name=${encodeURIComponent(name)}`);
const sendJ = (ws, o) => ws.send(JSON.stringify(o));

const results = {};
try {
  await wait(400); // let the relay bind

  // ── HTTP: relay serves the web app over the same port ──
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/app`);
    const html = await r.text();
    results["http: serves app.html"] =
      r.status === 200 && html.includes('id="log"') && html.includes("main.js");
    const js = await fetch(`http://127.0.0.1:${PORT}/hub-shim.js`);
    results["http: serves the WS shim"] =
      js.status === 200 && (await js.text()).includes("acquireVsCodeApi");
  } catch (e) {
    results["http: serves app.html"] = false;
  }

  // ── auth gate ──
  const bad = new WebSocket(`${URL}/?token=WRONG&role=client&id=x`);
  results["auth: bad token rejected"] = await new Promise((res) => {
    bad.on("close", (code) => res(code === 4001));
    bad.on("error", () => res(true)); // closed before open also counts
    setTimeout(() => res(false), 1500);
  });

  // ── node announces a folder + chat ──
  const node = conn("node", "node1", "dedic-1");
  await open(node);
  const incomingPrompts = [];
  node.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "fromClient" && m.msg?.t === "prompt") {
      incomingPrompts.push(m.msg);
      // Simulate the agent run: stream a couple of text deltas + a result.
      sendJ(node, { t: "event", chatId: m.msg.chatId, ev: { type: "text", text: "Hel" } });
      sendJ(node, { t: "event", chatId: m.msg.chatId, ev: { type: "text", text: "lo!" } });
      sendJ(node, { t: "event", chatId: m.msg.chatId, ev: { type: "result", costUsd: 0 } });
    }
  });
  sendJ(node, {
    t: "presence",
    workspace: { id: "ws1", name: "my-project", path: "/srv/my-project" },
    chats: [{ id: "c1", title: "Refactor auth" }],
  });

  // ── client (phone) connects, reads the world ──
  const client = conn("client", "phone", "iPhone");
  const events = [];
  let nodesSnapshot = null;
  client.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "nodes") nodesSnapshot = m.nodes;
    if (m.t === "presence") nodesSnapshot = [{ nodeId: m.nodeId, ...m }];
    if (m.t === "event") events.push(m.ev);
  });
  await open(client);
  await wait(300); // receive presence snapshot + the node's presence broadcast

  results["presence: client sees the folder"] =
    !!nodesSnapshot && nodesSnapshot.some((n) => n.workspace?.name === "my-project");
  results["presence: client sees the chat"] =
    !!nodesSnapshot && nodesSnapshot.some((n) => (n.chats || []).some((c) => c.title === "Refactor auth"));

  // ── client subscribes to the chat and sends a prompt ──
  sendJ(client, { t: "subscribe", channel: "node1:c1" });
  await wait(100);
  sendJ(client, { t: "toNode", nodeId: "node1", msg: { t: "prompt", chatId: "c1", text: "hi from phone" } });
  await wait(400);

  results["routing: node received the prompt"] =
    incomingPrompts.length === 1 && incomingPrompts[0].text === "hi from phone";
  const streamed = events.filter((e) => e.type === "text").map((e) => e.text).join("");
  results["fan-out: client got the live stream"] = streamed === "Hello!";
  results["fan-out: client got the result event"] = events.some((e) => e.type === "result");

  node.close();
  client.close();
} finally {
  await wait(150);
  relay.kill();
}

console.log("\n================ RELAY E2E ================");
let allPass = true;
for (const [k, v] of Object.entries(results)) {
  console.log(`  ${v ? "✅" : "❌"} ${k}`);
  allPass = allPass && v;
}
console.log(`\nALL PASS: ${allPass}`);
process.exit(allPass ? 0 : 1);
