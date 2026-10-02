// Integration tests for relay/hub.mjs: spawn the real hub on a free loopback
// port and talk to it over HTTP + WebSocket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HUB = fileURLToPath(new URL("../relay/hub.mjs", import.meta.url));
const TOKEN = "test-token-0123456789";

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

async function startHub() {
  const port = await freePort();
  const cp = spawn(process.execPath, [HUB], {
    env: { ...process.env, RELAY_TOKEN: TOKEN, PORT: String(port), RELAY_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hub did not start")), 5000);
    cp.stdout.on("data", (d) => {
      if (String(d).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    cp.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`hub exited early (${code})`));
    });
  });
  return { port, cp };
}

/** GET with the path sent verbatim (no client-side normalisation). */
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
  });
}

function open(port, query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}&${query}`);
    ws.msgs = [];
    ws.on("message", (raw) => ws.msgs.push(JSON.parse(String(raw))));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function waitFor(ws, pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = ws.msgs.find(pred);
    if (m) return m;
    await delay(20);
  }
  throw new Error("timed out waiting for a relay message");
}

test("hub: a malformed URL escape is a 400, not a crash", { timeout: 15000 }, async () => {
  const { port, cp } = await startHub();
  try {
    assert.equal(await get(port, "/%"), 400);
    assert.equal(await get(port, "/%E0%A4%A"), 400);
    assert.equal(await get(port, "/healthz"), 200, "the relay must still be up");
  } finally {
    cp.kill();
  }
});

test("hub: static files are confined to public/", { timeout: 15000 }, async () => {
  const { port, cp } = await startHub();
  try {
    assert.equal(await get(port, "/%2e%2e/validate.mjs"), 403);
    assert.equal(await get(port, "/%2e%2e/public-other/x.js"), 403, "a sibling dir sharing the prefix is outside too");
  } finally {
    cp.kill();
  }
});

test("hub: a node reconnecting under the same id keeps its presence when the stale socket closes", { timeout: 15000 }, async () => {
  const { port, cp } = await startHub();
  const sockets = [];
  try {
    const stale = await open(port, "role=node&id=n1");
    sockets.push(stale);
    const client = await open(port, "role=client&id=c1");
    sockets.push(client);
    const fresh = await open(port, "role=node&id=n1");
    sockets.push(fresh);

    // The superseded socket can't overwrite the live node's presence…
    stale.send(JSON.stringify({ t: "presence", workspace: "stale", chats: [] }));
    fresh.send(JSON.stringify({ t: "presence", workspace: "fresh", chats: [] }));
    await waitFor(client, (m) => m.t === "presence" && m.workspace === "fresh");
    assert.ok(!client.msgs.some((m) => m.t === "presence" && m.workspace === "stale"));

    // …and closing it must not delete the entry the new socket owns.
    stale.close();
    await delay(200);
    assert.ok(!client.msgs.some((m) => m.t === "nodeGone"), "no nodeGone for a node that is still connected");

    client.msgs.length = 0;
    client.send(JSON.stringify({ t: "list" }));
    const list = await waitFor(client, (m) => m.t === "nodes");
    assert.deepEqual(list.nodes.map((n) => n.nodeId), ["n1"]);

    // Routing still reaches the live socket.
    client.send(JSON.stringify({ t: "toNode", nodeId: "n1", msg: { type: "ping" } }));
    const routed = await waitFor(fresh, (m) => m.t === "fromClient");
    assert.deepEqual(routed.msg, { type: "ping" });
  } finally {
    for (const s of sockets) s.terminate();
    cp.kill();
  }
});
