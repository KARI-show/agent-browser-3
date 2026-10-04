// relay/bot.mjs (the relay's Telegram bot, run by VS Code's Remote and the browser helper) against
// a fake Bot API: it must quit with the reason when Telegram rejects the token — the helper reads
// that exit to tell the panel — and announce itself on stdout once getMe succeeds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const BOT = fileURLToPath(new URL("../relay/bot.mjs", import.meta.url));

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

/** Answers Bot API calls by method name; getUpdates is slowed down so the poll loop doesn't spin. */
function fakeTelegram(answers) {
  return new Promise((resolve) => {
    const calls = [];
    const srv = http.createServer((req, res) => {
      const method = req.url.split("/").pop();
      calls.push(method);
      req.resume();
      req.on("end", async () => {
        if (method === "getUpdates") await delay(200);
        const a = answers[method] || (method === "getUpdates" ? { ok: true, result: [] } : { ok: true, result: true });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(a));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

async function runBot(apiUrl) {
  // No relay is listening: the bot keeps retrying that connection, which must not stop it from
  // reporting on the token.
  const cp = spawn(process.execPath, [BOT], {
    env: { ...process.env, BOT_TOKEN: "123456:" + "a".repeat(30), TG_USER_ID: "42", RELAY_TOKEN: "t", RELAY_URL: `ws://127.0.0.1:${await freePort()}`, TELEGRAM_API: apiUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cp.out = "";
  cp.err = "";
  cp.stdout.on("data", (d) => (cp.out += d));
  cp.stderr.on("data", (d) => (cp.err += d));
  return cp;
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await delay(20);
  }
  throw new Error("timed out");
}

test("relay bot: a rejected token ends the process with the reason instead of leaving it idle", { timeout: 15000 }, async () => {
  const tg = await fakeTelegram({ getMe: { ok: false, error_code: 401, description: "Unauthorized" } });
  const cp = await runBot(tg.url);
  try {
    const code = await new Promise((resolve) => cp.on("exit", resolve));
    assert.equal(code, 1);
    assert.match(cp.err, /Telegram rejected the bot token \(Unauthorized\)/);
    assert.ok(!tg.calls.includes("sendMessage"), "nothing is sent with a bad token");
  } finally {
    if (cp.exitCode === null) cp.kill();
    tg.srv.close();
  }
});

test("relay bot: with a working token it reports itself online and greets the owner", { timeout: 15000 }, async () => {
  const tg = await fakeTelegram({ getMe: { ok: true, result: { username: "unit_bot" } } });
  const cp = await runBot(tg.url);
  try {
    await waitFor(() => / online;/.test(cp.out)); // the line browser/host/remote.ts takes as "started"
    assert.match(cp.out, /@unit_bot online/);
    await waitFor(() => tg.calls.includes("sendMessage"));
    assert.equal(cp.exitCode, null, "the bot keeps running");
    assert.ok(tg.calls.indexOf("deleteWebhook") < tg.calls.indexOf("getMe"), "the webhook is dropped before polling");
  } finally {
    cp.kill();
    tg.srv.close();
  }
});
