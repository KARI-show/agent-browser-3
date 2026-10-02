import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { HubClient, STREAM_FLUSH_MS } from "../src/hub";

test("HubClient merges streamed text/thinking pieces and keeps event order", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const got: any[] = [];
  wss.on("connection", (ws) => ws.on("message", (raw) => got.push(JSON.parse(String(raw)))));

  const hub = new HubClient(
    { relayUrl: `ws://127.0.0.1:${port}`, token: "t", nodeId: "n1", nodeName: "test" },
    { onClientMessage: () => {}, presence: () => ({ workspace: null, chats: [] }) }
  );
  hub.connect();
  try {
    for (let i = 0; i < 200 && !hub.connected; i++) await delay(10);
    assert.ok(hub.connected, "connected to the fake relay");

    // Token-sized pieces, as the SDK streams thinking with partial messages.
    for (let i = 0; i < 200; i++) hub.emit("c1", { type: "thinking", text: `t${i} ` });
    hub.emit("c1", { type: "tool", id: "x", name: "Read", input: {} });
    for (let i = 0; i < 50; i++) hub.emit("c1", { type: "text", text: "w" });
    await delay(STREAM_FLUSH_MS * 4);

    const events = got.filter((m) => m.t === "event").map((m) => m.ev);
    // 250 pieces → 3 relay messages: far under the relay's per-socket rate limit.
    assert.deepEqual(events.map((e) => e.type), ["thinking", "tool", "text"]);
    assert.equal(events[0].text, Array.from({ length: 200 }, (_, i) => `t${i} `).join(""));
    assert.equal(events[1].name, "Read", "non-stream events pass through unchanged");
    assert.equal(events[2].text, "w".repeat(50));
  } finally {
    hub.dispose();
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
});
