// End-to-end: the free trial's email sign-in, in a real Chromium with the built extension loaded.
// A real trial-server runs in this process (codes captured instead of mailed) in front of a fake
// Anthropic API; the extension is rebuilt with AGENT_TRIAL_URL pointing at it. The user signs in on
// the settings page, then a prompt from the side panel goes through the gateway and its reply streams back.
//
// Run: npm run test:e2e   (builds first; set CHROME_PATH if Chromium isn't found)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { extensionIdFromKey, findChromium, launch } from "./cdp.mjs";
import { loadConfig } from "../../trial-server/config.mjs";
import { createHandler } from "../../trial-server/handler.mjs";
import { serve } from "../../trial-server/server.mjs";
import { MemoryStore } from "../../trial-server/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILT = join(root, "dist-browser", "extension");
const skip = !findChromium() ? "no Chromium found (set CHROME_PATH)" : !existsSync(join(BUILT, "manifest.json")) ? "build first: npm run build && npm run build:browser" : false;

const EMAIL = "tester@example.com";
const REPLY = "Hello through the trial gateway.";
const OPERATOR_KEY = "sk-ant-e2e-operator";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser, cdp, workDir, extId, upstream, gateway, store;
const mail = new Map(); // address -> last code
const upstreamSeen = [];

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

/** The fake Anthropic API behind the gateway: one model, one short streamed reply. */
function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      upstreamSeen.push({ url: req.url, key: req.headers["x-api-key"] });
      if (req.method === "GET" && req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ data: [{ type: "model", id: "claude-haiku-4-5", display_name: "Haiku (fake)", created_at: "2026-01-01T00:00:00Z" }], has_more: false }));
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: REPLY } });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } });
        ev("message_stop", {});
        res.end();
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

/** The built extension, copied, with agentLocal.js rebuilt for this gateway (same steps as browser/build.mjs). */
async function extensionFor(trialUrl) {
  const dir = join(workDir, "extension");
  cpSync(BUILT, dir, { recursive: true });
  const gen = join(workDir, "gen");
  await build({ entryPoints: [join(root, "browser", "gen-tooldefs.ts")], bundle: true, format: "cjs", platform: "node", outfile: join(gen, "gen-tooldefs.cjs"), logLevel: "warning" });
  writeFileSync(join(gen, "toolDefs.json"), JSON.stringify(createRequire(import.meta.url)(join(gen, "gen-tooldefs.cjs")).default));
  await build({
    entryPoints: [join(root, "browser", "standalone", "entry.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: join(dir, "agentLocal.js"),
    alias: { "toolDefs.json": join(gen, "toolDefs.json") },
    define: { __TRIAL_URL__: JSON.stringify(trialUrl) },
    logLevel: "warning",
  });
  return dir;
}

async function open(page) {
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/${page}` });
  const session = await cdp.attach(targetId);
  await waitUntil(() => cdp.evaluate(session, "document.readyState === 'complete' && !!window.AgentLocal"), 10000, page);
  return { session, targetId, eval: (expr) => cdp.evaluate(session, expr) };
}
const text = (p, id) => p.eval(`document.getElementById(${JSON.stringify(id)}).textContent`);
const type = (p, id, value) => p.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const click = (p, id) => p.eval(`(document.getElementById(${JSON.stringify(id)}).click(), true)`);

before(async () => {
  if (skip) return;
  workDir = mkdtempSync(join(tmpdir(), "agent-trial-e2e-"));
  extId = extensionIdFromKey(JSON.parse(readFileSync(join(BUILT, "manifest.json"), "utf8")).key);
  upstream = await startUpstream();
  const cfg = loadConfig({ ANTHROPIC_API_KEY: OPERATOR_KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, ALLOWED_ORIGINS: `chrome-extension://${extId}`, TRIAL_MODELS: "claude-haiku-4-5" });
  store = new MemoryStore();
  const handler = createHandler(cfg, store, { log: { info() {}, warn() {}, error() {} }, sendCode: async (to, code) => void mail.set(to, code) });
  gateway = await serve(handler, { port: 0, host: "127.0.0.1" });
  const ext = await extensionFor(`http://127.0.0.1:${gateway.address().port}`);
  browser = await launch({ extensionDir: ext, userDataDir: join(workDir, "profile"), downloadDir: join(workDir, "downloads") });
  cdp = browser.cdp;
});

after(async () => {
  if (browser) await browser.close();
  gateway?.closeAllConnections?.();
  gateway?.close();
  upstream?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("settings: sign in with a code from the email; a wrong code is refused first", { skip, timeout: 60000 }, async () => {
  const opt = await open("options.html");
  assert.equal(await opt.eval(`document.querySelector('input[name="mode"][value="trial"]').disabled`), false, "this build has a trial");
  await click(opt, "modeTrial");
  await waitUntil(() => opt.eval(`document.getElementById("trialFields").classList.contains("open")`), 5000, "the sign-in fields");
  assert.match(await text(opt, "trialStatus"), /Sign in with your email/);

  await type(opt, "trialEmail", "  Tester@Example.com ");
  await click(opt, "trialSend");
  await waitUntil(async () => /We sent a 6-digit code to tester@example\.com/.test(await text(opt, "trialResult")), 10000, "code sent");
  assert.equal(await opt.eval(`document.getElementById("trialCodeRow").hidden`), false);

  const wrong = mail.get(EMAIL) === "000000" ? "111111" : "000000";
  await type(opt, "trialCode", wrong);
  await click(opt, "trialVerify");
  await waitUntil(async () => /Wrong code — 4 attempts left/.test(await text(opt, "trialResult")), 10000, "wrong code refused");

  await type(opt, "trialCode", mail.get(EMAIL));
  await click(opt, "trialVerify");
  await waitUntil(async () => (await text(opt, "trialWho")) === EMAIL, 10000, "signed in");
  await waitUntil(async () => /left today/.test(await text(opt, "trialStatus")), 10000, "allowance shown");

  const saved = await opt.eval(`chrome.storage.local.get(["agentApi", "agentTrial"])`);
  assert.equal(saved.agentApi.mode, "trial", "signing in chooses the trial");
  assert.equal(saved.agentTrial.email, EMAIL);
  assert.equal(saved.agentTrial.transport, "messages");
  assert.match(saved.agentTrial.token, /^trl_/);
  assert.equal(store.users.size, 1, "one customer on the gateway");
  await cdp.send("Target.closeTarget", { targetId: opt.targetId });
});

test("panel: a prompt goes through the gateway with the trial token and the reply streams back", { skip, timeout: 60000 }, async () => {
  const panel = await open("sidepanel.html");
  await waitUntil(() => panel.eval(`!!document.getElementById("input")`), 10000, "panel input");
  await type(panel, "input", "hi");
  await click(panel, "send");
  await waitUntil(async () => (await panel.eval(`document.getElementById("log").innerText`)).includes(REPLY), 20000, "the reply");
  const forwarded = upstreamSeen.filter((r) => r.url.startsWith("/v1/messages"));
  assert.ok(forwarded.length >= 1);
  assert.ok(forwarded.every((r) => r.key === OPERATOR_KEY), "the operator key goes upstream, never the trial token");
  const user = [...store.users.values()][0];
  const day = new Date().toISOString().slice(0, 10);
  await waitUntil(async () => (await store.get(`usr:${user.id}:${day}`)) > 0, 5000, "spend counted under the customer");
  await cdp.send("Target.closeTarget", { targetId: panel.targetId });
});

test("a blocked customer is told so and signed out; unblocked, they sign in again and can sign out", { skip, timeout: 60000 }, async () => {
  const user = [...store.users.values()][0];
  await store.putUser(EMAIL, { ...user, blocked: true });
  const panel = await open("sidepanel.html");
  await waitUntil(() => panel.eval(`!!document.getElementById("input")`), 10000, "panel input");
  await type(panel, "input", "again");
  await click(panel, "send");
  const log = await waitUntil(async () => {
    const t = await panel.eval(`document.getElementById("log").innerText`);
    return /This free-trial account has been disabled/.test(t) && t;
  }, 20000, "the refusal");
  assert.doesNotMatch(log, /API key/, "the gateway's own words, not an API-key error");
  await waitUntil(async () => (await panel.eval(`chrome.storage.local.get("agentTrial")`)).agentTrial === undefined, 5000, "the dead token dropped");
  await cdp.send("Target.closeTarget", { targetId: panel.targetId });

  await store.putUser(EMAIL, { ...user, blocked: false });
  const opt = await open("options.html");
  await waitUntil(() => opt.eval(`!document.getElementById("trialEmailRow").hidden`), 10000, "the sign-in form");
  await type(opt, "trialEmail", EMAIL);
  await click(opt, "trialSend");
  await waitUntil(async () => /We sent/.test(await text(opt, "trialResult")), 10000, "code sent");
  await type(opt, "trialCode", mail.get(EMAIL));
  await click(opt, "trialVerify");
  await waitUntil(async () => (await text(opt, "trialWho")) === EMAIL, 10000, "signed in again");
  assert.equal(store.users.size, 1, "the same customer, not a new row");
  assert.equal([...store.users.values()][0].logins, 2);

  await click(opt, "trialSignOut");
  await waitUntil(() => opt.eval(`!document.getElementById("trialEmailRow").hidden`), 10000, "the sign-in form again");
  assert.equal((await opt.eval(`chrome.storage.local.get("agentTrial")`)).agentTrial, undefined, "the token is gone from this browser");
  await cdp.send("Target.closeTarget", { targetId: opt.targetId });
});
