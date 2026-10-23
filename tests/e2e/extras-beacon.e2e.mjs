// The Beacon brand's extras (checks + uptime) in a real headless Chromium: the beacon build
// (dist-browser/brands/beacon/extension) is loaded, its side panel page opened as a tab, and the tools
// are invoked the way shim.js / the built-in agent do it: window.AgentBrowserTools.run(name, args).
// A local fixture server serves a page with good, broken, redirecting, external-looking and slow links,
// and a /status endpoint whose code the test flips (200 → 503 → 200) under an uptime monitor that the
// service worker checks (AgentAutomation.requestRun pokes it, like the base watcher e2e).
//
// Run: node browser/build.mjs --brand beacon && node --test tests/e2e/extras-beacon.e2e.mjs
// (set CHROME_PATH if Chromium isn't found; skips cleanly without a build or a browser).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, findChromium } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const EXT_DIR = join(root, "dist-browser", "brands", "beacon", "extension");
const skip = !findChromium()
  ? "no Chromium found (set CHROME_PATH)"
  : !existsSync(join(EXT_DIR, "manifest.json"))
    ? "Beacon not built (node browser/build.mjs --brand beacon)"
    : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fixture server ─────────────────────────────────────────────────────────
// The page is served on http://localhost:PORT; the "external" link points at http://127.0.0.1:PORT —
// another origin on the same machine. DEAD is a port nothing listens on.

const statusState = { code: 200 };
const requests = []; // { method, path } of every request
let server, PORT, BASE, EXT, DEAD;

function linksPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Links</title></head><body>
<h1>Fixture Links</h1>
<nav><a href="/nav-ok.html">Nav link</a></nav>
<main>
<p><a href="/ok.html">Good page</a> <a href="/ok.html#section">Good page again</a></p>
<p><a href="/missing">Old docs</a></p>
<p><a href="/redirect">Moved page</a></p>
<p><a href="/head405">No HEAD here</a></p>
<p><a href="${EXT}/ext.html">Partner site</a></p>
<p><a href="/slow">Slow report</a></p>
<p><a href="${DEAD}/">Dead host</a></p>
<p><a href="mailto:someone@example.com">Mail</a> <a href="javascript:void(0)">Script</a></p>
</main>
<footer><a href="/footer-ok.html">Footer link</a> <a href="/missing">Old docs (footer)</a></footer>
</body></html>`;
}

/** A port nothing listens on: open a TCP server, note its port, close it. */
function closedPort() {
  return new Promise((resolve) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const dead = await closedPort();
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: url.pathname });
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    switch (url.pathname) {
      case "/links.html": return html(linksPage());
      case "/ok.html": case "/nav-ok.html": case "/footer-ok.html": case "/ext.html": return html("<!doctype html><title>OK</title><p>ok</p>");
      case "/redirect": res.writeHead(302, { location: "/ok.html" }); return res.end();
      case "/head405":
        if (req.method === "HEAD") { res.writeHead(405, { allow: "GET" }); return res.end(); }
        return html("<!doctype html><title>GET only</title><p>get</p>");
      case "/slow": setTimeout(() => html("<!doctype html><title>Slow</title><p>slow</p>"), 1200); return;
      case "/status":
        res.writeHead(statusState.code, { "content-type": "text/plain" });
        return res.end("status " + statusState.code);
      default:
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    }
  });
  await new Promise((r) =>
    server.listen(0, "127.0.0.1", () => {
      PORT = server.address().port;
      BASE = `http://localhost:${PORT}`;
      EXT = `http://127.0.0.1:${PORT}`;
      DEAD = `http://127.0.0.1:${dead}`;
      r();
    })
  );
}

// ── Browser + panel harness ────────────────────────────────────────────────

let browser, cdp, extId, panel, workDir, pageTarget, pageTabId;
const panelErrors = [];

async function waitUntil(fn, timeout = 10000, what = "condition") {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function inPanel(expr, timeout = 60000) {
  return Promise.race([
    cdp.evaluate(panel, expr),
    sleep(timeout).then(() => { throw new Error(`panel evaluation timed out: ${expr.slice(0, 80)}`); }),
  ]);
}

/** Call a tool like shim.js does. → { ok, text, error } */
async function call(name, args = {}) {
  const r = await inPanel(
    `AgentBrowserTools.run(${JSON.stringify(name)}, ${JSON.stringify(args)}).then(
      (c) => ({ ok: true, content: c }),
      (e) => ({ ok: false, error: String((e && e.message) || e) }))`
  );
  r.text = r.ok ? r.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : "";
  return r;
}
async function ok(name, args) {
  const r = await call(name, args);
  assert.ok(r.ok, `${name} failed: ${r.error}`);
  return r.text;
}
async function fails(name, args) {
  const r = await call(name, args);
  assert.ok(!r.ok, `${name} should have failed but returned: ${r.text}`);
  return r.error;
}
const panelText = () => inPanel(`document.getElementById("automations-panel").textContent`);
/** Open the 🧩 panel (idempotent) and pick one of its tabs. */
async function openPanelTab(tab) {
  await inPanel(`if (document.getElementById("automations-panel").classList.contains("hidden")) document.getElementById("autoBtn").click(); true`);
  assert.equal(await inPanel(`document.getElementById("automations-panel").classList.contains("hidden")`), false);
  await inPanel(`document.querySelector('#automations-panel .prof-tab[data-tab="${tab}"]').click(); true`);
}
const closePanel = () => inPanel(`document.getElementById("automations-panel").classList.add("hidden"); true`);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

before(async () => {
  if (skip) return;
  await startServer();
  workDir = mkdtempSync(join(tmpdir(), "beacon-extras-e2e-"));
  browser = await launch({ extensionDir: EXT_DIR, userDataDir: join(workDir, "profile"), downloadDir: join(workDir, "downloads") });
  cdp = browser.cdp;
  // A brand without a manifest key gets its id from the path: read it off the service worker.
  const sw = await cdp.waitForTarget((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"), 15000);
  extId = new URL(sw.url).host;
  // Panel first (it becomes a background tab), then the page the agent works on.
  const { targetId: panelTarget } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/sidepanel.html` });
  panel = await cdp.attach(panelTarget);
  cdp.on((m) => {
    if (m.sessionId === panel && m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      panelErrors.push((d.exception && d.exception.description) || d.text);
    }
  });
  await cdp.send("Runtime.enable", {}, panel);
  await waitUntil(() => cdp.evaluate(panel, "document.readyState === 'complete' && typeof AgentBrowserTools === 'object' && typeof AgentExtras === 'object' && typeof AgentAutomation === 'object'"), 15000, "panel scripts");
  ({ targetId: pageTarget } = await cdp.send("Target.createTarget", { url: `${BASE}/links.html` }));
  await waitUntil(() => inPanel(`chrome.tabs.query({ url: "${BASE}/*" }).then((t) => t.length && t[0].status === "complete")`), 15000, "links page");
  pageTabId = await inPanel(`chrome.tabs.query({ url: "${BASE}/*" }).then((t) => t[0].id)`);
  await ok("browser_switch_tab", { tabId: pageTabId });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ── Registration ───────────────────────────────────────────────────────────

test("beacon: the checks and uptime extras are built in — tabs, tools, quick commands; the prompt section reaches the built-in agent", { skip }, async () => {
  const seen = await inPanel(`({
    brand: AGENT_BRAND.id,
    features: [AGENT_BRAND.has("checks"), AGENT_BRAND.has("uptime"), AGENT_BRAND.has("watchers"), AGENT_BRAND.has("cookies")],
    tabs: AgentExtras.tabs.map((t) => [t.id, t.label]),
    commands: AgentExtras.commands.map((c) => [c.group, c.name, !!c.partial]),
    registered: AgentBrowserTools.names.filter((n) => /^browser_(check|uptime)_/.test(n)).sort(),
    declared: window.AgentLocal ? window.AgentLocal.toolNames.filter((n) => /^browser_(check|uptime)_/.test(n)).sort() : null,
    permissions: chrome.runtime.getManifest().permissions,
    helpers: [typeof AgentExtras.checks.filterLinks, typeof AgentExtras.uptime.sparkline],
  })`);
  assert.equal(seen.brand, "beacon");
  assert.deepEqual(seen.features, [true, true, true, false]);
  assert.deepEqual(seen.tabs, [["checks", "🔗 Checks"], ["uptime", "⏱ Uptime"]]);
  assert.deepEqual(seen.commands, [
    ["Monitoring", "Find broken links on this page", false],
    ["Monitoring", "Check this URL's status", true],
    ["Monitoring", "Check the links in the footer and navigation only", false],
    ["Monitoring", "Monitor this site's uptime", false],
    ["Monitoring", "Show my uptime monitors", false],
  ]);
  assert.deepEqual(seen.registered, ["browser_check_links", "browser_check_url", "browser_uptime_add", "browser_uptime_delete", "browser_uptime_list"]);
  assert.deepEqual(seen.declared, seen.registered, "the built-in agent is told about exactly the registered extra tools");
  assert.ok(seen.permissions.includes("alarms") && seen.permissions.includes("notifications"), "uptime rides on the watchers' permissions");
  assert.ok(!seen.permissions.includes("cookies") && !seen.permissions.includes("downloads"), "nothing beyond them");
  assert.deepEqual(seen.helpers, ["function", "function"]);
});

// ── Checks ─────────────────────────────────────────────────────────────────

test("browser_check_url: status, redirect, HEAD→GET fallback, 404 and a dead host, one line each", { skip }, async () => {
  const one = await ok("browser_check_url", { url: `${BASE}/ok.html` });
  assert.match(one, new RegExp(`^✓ 200  ${escapeRe(BASE)}/ok\\.html  —  \\d+ ms, text/html(, \\d+ B)?$`));
  requests.length = 0;
  const out = await ok("browser_check_url", { urls: [`${BASE}/ok.html`, `${BASE}/redirect`, `${BASE}/head405`, `${BASE}/missing`, `${DEAD}/`] });
  const lines = out.split("\n");
  assert.equal(lines[0], "Checked 5 addresses: 2 ok, 1 redirected, 2 broken.");
  assert.match(lines[1], new RegExp(`^✓ 200  ${escapeRe(BASE)}/ok\\.html  —  \\d+ ms, text/html`));
  assert.match(lines[2], new RegExp(`^↪ 200  ${escapeRe(BASE)}/redirect → ${escapeRe(BASE)}/ok\\.html  —  \\d+ ms, text/html`));
  assert.match(lines[3], new RegExp(`^✓ 200  ${escapeRe(BASE)}/head405  —  \\d+ ms, text/html`));
  assert.match(lines[4], new RegExp(`^✗ 404  ${escapeRe(BASE)}/missing  —  \\d+ ms, text/plain`));
  assert.match(lines[5], new RegExp(`^✗ down: Failed to fetch  ${escapeRe(DEAD)}/  —  \\d+ ms$`));
  assert.deepEqual(requests.filter((r) => r.path === "/head405").map((r) => r.method), ["HEAD", "GET"], "405 on HEAD → GET");
  assert.deepEqual(requests.filter((r) => r.path === "/ok.html").map((r) => r.method), ["HEAD", "HEAD"], "the redirect was followed with HEAD, no body fetched");
  assert.match(await fails("browser_check_url", {}), /url is required/);
  assert.match(await fails("browser_check_url", { url: "ftp://files.example/" }), /Not an http\(s\) address/);
});

test("browser_check_links: the fixture page — broken first, redirect, slowest; sameOriginOnly and selector; the result is stored", { skip }, async () => {
  requests.length = 0;
  const out = await ok("browser_check_links", {});
  const head = out.split("\n")[0];
  assert.equal(head, `Checked 9 links on "Fixture Links" (${BASE}/links.html): 6 ok, 1 redirected, 2 broken.`);
  assert.match(out, new RegExp(`\nBroken:\n  ✗ 404  "Old docs" → ${escapeRe(BASE)}/missing  \\(\\d+ ms\\)\n  ✗ down: Failed to fetch  "Dead host" → ${escapeRe(DEAD)}/\nRedirected:\n  ↪ "Moved page" ${escapeRe(BASE)}/redirect → ${escapeRe(BASE)}/ok\\.html  \\(200\\)\nSlowest:\n  \\d{4} ms  ${escapeRe(BASE)}/slow\n`));
  assert.equal(requests.filter((r) => r.path === "/ok.html").length, 2, "the duplicate (#section) link is checked once; the redirect lands on it once more");
  assert.equal(requests.filter((r) => r.path === "/missing").length, 1, "the footer's duplicate of a broken link is not re-checked");
  assert.equal(requests.filter((r) => r.path === "/ext.html").length, 1, "the external-looking host is checked by default");
  const stored = await inPanel(`chrome.storage.local.get("agentLinkCheck").then((o) => o.agentLinkCheck)`);
  assert.equal(stored.url, `${BASE}/links.html`);
  assert.equal(stored.title, "Fixture Links");
  assert.deepEqual(stored.counts, { ok: 6, redirected: 1, broken: 2 });
  assert.equal(stored.checked, 9);
  assert.deepEqual(stored.leftOut, { external: 0, over: 0, other: 0 });
  assert.deepEqual(stored.results.map((r) => r.text), ["Nav link", "Good page", "Old docs", "Moved page", "No HEAD here", "Partner site", "Slow report", "Dead host", "Footer link"]);
  assert.equal(stored.results.find((r) => r.text === "Moved page").finalUrl, `${BASE}/ok.html`);
  assert.equal(stored.results.find((r) => r.text === "Dead host").error, "Failed to fetch");
  // Only the site's own links.
  requests.length = 0;
  const same = await ok("browser_check_links", { sameOriginOnly: true });
  assert.equal(same.split("\n")[0], `Checked 7 links on "Fixture Links" (${BASE}/links.html): 5 ok, 1 redirected, 1 broken. Left out: 2 external (sameOriginOnly).`, "the partner site and the dead host are other origins");
  assert.equal(requests.filter((r) => r.path === "/ext.html").length, 0);
  assert.ok(requests.every((r) => r.path !== "/ext.html"), "no request left the page's origin");
  // A part of the page.
  const part = await ok("browser_check_links", { selector: "footer, nav" });
  assert.equal(part.split("\n")[0], `Checked 3 links on "Fixture Links" (${BASE}/links.html) within footer, nav: 2 ok, 0 redirected, 1 broken.`);
  assert.match(part, /Broken:\n  ✗ 404  "Old docs \(footer\)"/);
  assert.match(await fails("browser_check_links", { selector: "aside.nothing" }), /Nothing on the page matches aside\.nothing/);
});

test("🧩 panel: the 🔗 Checks tab shows the last result (broken first, Open) and runs a check from the tab", { skip }, async () => {
  await openPanelTab("checks");
  const tabs = await inPanel(`[...document.querySelectorAll("#automations-panel .prof-tab")].map((b) => b.dataset.tab)`);
  assert.deepEqual(tabs, ["recipes", "watchers", "memory", "checks", "uptime"]);
  await waitUntil(async () => /Check the links on this page/.test(await panelText()), 5000, "checks tab");
  const txt = await panelText();
  assert.match(txt, /Check a URL…/);
  assert.match(txt, /Last check · just now/);
  assert.match(txt, /Fixture Links/);
  assert.match(txt, /3 links · 2 ok · 0 redirected · 1 broken · within footer, nav/, "the last stored result (the selector run)");
  const names = await inPanel(`[...document.querySelectorAll("#automations-panel .cmd-item .cmd-name")].map((n) => n.textContent)`);
  assert.deepEqual(names, ["Check the links on this page", "Fixture Links", "Old docs (footer)", "Nav link", "Footer link"], "the broken link first");
  assert.equal(await inPanel(`document.querySelectorAll("#automations-panel .prof-btn[title='Open the link in a new tab']").length`), 3);
  // Run the page check from the tab: the live list, then the stored result with 9 links.
  await inPanel(`document.querySelector("#automations-panel .cmd-item").click(); true`);
  await waitUntil(async () => /9 links · 6 ok · 1 redirected · 2 broken/.test(await panelText()), 30000, "the link check from the tab");
  const status = await inPanel(`document.querySelector("#automations-panel .prof-status").textContent`);
  assert.equal(status, "✗ 2 broken links of 9.");
  // Open the first broken link from the list.
  const tabsBefore = await inPanel(`chrome.tabs.query({}).then((t) => t.length)`);
  await inPanel(`document.querySelector("#automations-panel .prof-btn[title='Open the link in a new tab']").click(); true`);
  await waitUntil(async () => (await inPanel(`chrome.tabs.query({}).then((t) => t.length)`)) === tabsBefore + 1, 5000, "the Open button's tab");
  const opened = await inPanel(`chrome.tabs.query({ url: "${BASE}/missing" }).then((t) => t.map((x) => x.id))`);
  assert.equal(opened.length, 1);
  await inPanel(`chrome.tabs.remove(${opened[0]}).then(() => true)`);
  await ok("browser_switch_tab", { tabId: pageTabId });
  // "Check a URL…" from the field.
  await inPanel(`const i = document.querySelector("#automations-panel input[aria-label='Address to check']"); i.value = "${BASE}/missing"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true`);
  await waitUntil(async () => /^✗ HTTP 404$/.test(await inPanel(`document.querySelector("#automations-panel .prof-status").textContent`)), 10000, "the single URL check");
  assert.match(await panelText(), new RegExp(`✗ 404  ${escapeRe(BASE)}/missing  —  \\d+ ms, text/plain`));
  await closePanel();
});

// ── Uptime ─────────────────────────────────────────────────────────────────

let monitorId;

test("browser_uptime_add: a status watcher the worker checks without a tab; 200 → 503 → 200 flips show up as events and in the history", { skip }, async () => {
  statusState.code = 200;
  requests.length = 0;
  const out = await ok("browser_uptime_add", { url: `${BASE}/status`, name: "E2E status", every: 5, telegram: false });
  assert.match(out, new RegExp(`^Monitoring ${escapeRe(BASE)}/status every 5 min \\(id: wch_\\w+\\), expecting HTTP 200\\. The first check sets the baseline; after that every flip \\(e\\.g\\. 200 → 503 and back\\) is reported with a system notification\\. It runs in the background`));
  monitorId = /id: (wch_\w+)/.exec(out)[1];
  const getW = () => inPanel(`chrome.storage.local.get("agentWatchers").then((o) => o.agentWatchers[${JSON.stringify(monitorId)}] || null)`);
  let w = await waitUntil(async () => { const x = await getW(); return x && x.lastRun ? x : false; }, 30000, "the baseline check by the worker");
  assert.equal(w.lastRun.ok, true, JSON.stringify(w.lastRun));
  assert.equal(w.mode, "status");
  assert.equal(w.expect, 200);
  assert.equal(w.lastContent, "HTTP 200");
  assert.equal(w.changes, 0);
  assert.equal(w.history.length, 1);
  assert.deepEqual([w.history[0].code, w.history[0].ok, w.history[0].ms >= 0], [200, true, true]);
  assert.equal(await inPanel(`chrome.tabs.query({ url: "${BASE}/status*" }).then((t) => t.length)`), 0, "no tab is opened for a status check");
  assert.deepEqual(requests.filter((r) => r.path === "/status").map((r) => r.method), ["HEAD"], "one HEAD request from the service worker");
  assert.deepEqual(await inPanel(`chrome.alarms.getAll().then((a) => a.map((x) => [x.name, x.periodInMinutes]))`), [["watch:" + monitorId, 5]]);
  assert.match(await ok("browser_watch_list", {}), new RegExp(`^Watchers \\(1\\):\nwch_\\w+  ⏱ E2E status  \\|  ${escapeRe(BASE)}/status  \\|  every 5 min  \\|  HTTP status \\(expect 200\\)  \\|  checked just now$`), "the base watcher list describes it too");

  // Down.
  statusState.code = 503;
  let r = await inPanel(`AgentAutomation.requestRun(${JSON.stringify(monitorId)})`);
  assert.equal(r && r.ok, true, JSON.stringify(r));
  assert.equal(r.changed, true);
  assert.equal(r.status, "HTTP 503");
  w = await getW();
  assert.equal(w.changes, 1);
  assert.equal(w.lastContent, "HTTP 503");
  assert.deepEqual(w.history.map((e) => [e.code, e.ok]), [[200, true], [503, false]]);
  let events = await inPanel(`chrome.storage.local.get("agentWatchEvents").then((o) => o.agentWatchEvents)`);
  assert.deepEqual([events.at(-1).added, events.at(-1).removed, events.at(-1).name], [["HTTP 503"], ["HTTP 200"], "E2E status"]);

  // Still down: no new event, the history grows.
  r = await inPanel(`AgentAutomation.requestRun(${JSON.stringify(monitorId)})`);
  assert.equal(r.changed, false);
  assert.equal((await getW()).history.length, 3);

  // Back up.
  statusState.code = 200;
  r = await inPanel(`AgentAutomation.requestRun(${JSON.stringify(monitorId)})`);
  assert.equal(r.changed, true);
  assert.equal(r.status, "HTTP 200");
  w = await getW();
  assert.equal(w.changes, 2);
  assert.equal(w.errors, 0, "an answering server is never a check error");
  events = await inPanel(`chrome.storage.local.get("agentWatchEvents").then((o) => o.agentWatchEvents)`);
  assert.equal(events.length, 2);
  assert.deepEqual([events.at(-1).added, events.at(-1).removed], [["HTTP 200"], ["HTTP 503"]]);
  assert.equal(w.history.length, 4);
});

test("browser_uptime_list shows the flip and the history; delete stops the monitor", { skip }, async () => {
  const list = await ok("browser_uptime_list", {});
  assert.match(list, new RegExp(`^Uptime monitors \\(1\\):\n${monitorId}  🟢 UP  E2E status  \\|  ${escapeRe(BASE)}/status  \\|  every 5 min  \\|  expects 200  \\|  last: HTTP 200 in \\d+ ms, just now  \\|  history: 50% up, 4 checks, 2 failures, avg \\d+ ms  [▁▂▃▄▅▆▇]××[▁▂▃▄▅▆▇]  \\|  since just now$`));
  assert.match(await fails("browser_uptime_delete", { name: "nope" }), /No uptime monitor named 'nope'/);
  assert.equal(await ok("browser_uptime_delete", { name: "e2e status" }), "Deleted uptime monitor 'E2E status'.");
  assert.match(await ok("browser_uptime_list", {}), /^No uptime monitors\./);
  assert.match(await ok("browser_watch_list", {}), /^No watchers/);
  assert.equal(await inPanel("chrome.alarms.getAll().then((a) => a.length)"), 0);
});

test("🧩 panel: the ⏱ Uptime tab — add form prefilled with the current tab, the monitor with its dot, sparkline and Check now", { skip }, async () => {
  statusState.code = 200;
  await openPanelTab("uptime");
  await waitUntil(async () => /Monitor a site's uptime/.test(await panelText()), 5000, "uptime tab");
  assert.match(await panelText(), /No uptime monitors yet\./);
  // The add form: URL from the current tab, every 5, expected 200.
  await inPanel(`document.querySelector("#automations-panel .cmd-item").click(); true`);
  await waitUntil(async () => /New uptime monitor/.test(await panelText()), 5000, "the add form");
  const form = await inPanel(`[...document.querySelectorAll("#automations-panel .ed-wrap input")].map((i) => [i.type, i.value])`);
  assert.deepEqual(form, [["text", `${BASE}/links.html`], ["text", ""], ["number", "5"], ["number", "200"], ["checkbox", "on"]]);
  await inPanel(`const ins = [...document.querySelectorAll("#automations-panel .ed-wrap input")]; ins[0].value = "${BASE}/status"; ins[1].value = "Panel monitor"; ins[2].value = "1"; true`);
  await inPanel(`[...document.querySelectorAll("#automations-panel .ed-wrap button")].find((b) => b.textContent.includes("Start monitoring")).click(); true`);
  await waitUntil(async () => /Panel monitor/.test(await panelText()) && !/New uptime monitor/.test(await panelText()), 10000, "the list after adding");
  const id = await inPanel(`chrome.storage.local.get("agentWatchers").then((o) => Object.keys(o.agentWatchers)[0])`);
  await waitUntil(() => inPanel(`chrome.storage.local.get("agentWatchers").then((o) => !!o.agentWatchers[${JSON.stringify(id)}].lastRun)`), 30000, "the baseline by the worker");
  await waitUntil(async () => /🟢/.test(await panelText()), 10000, "the tab re-rendered with the baseline");
  let txt = await panelText();
  assert.match(txt, /localhost · every 1 min · expects 200/);
  assert.match(txt, /last: HTTP 200 in \d+ ms, just now/);
  assert.match(txt, /▇  100% up · 1 check/);
  // Check now while the endpoint is down.
  statusState.code = 503;
  await inPanel(`document.querySelector("#automations-panel .prof-btn[title='Check now']").click(); true`);
  await waitUntil(async () => /🔴/.test(await panelText()), 15000, "the red dot");
  txt = await panelText();
  assert.match(txt, /last: HTTP 503 in \d+ ms, just now/);
  assert.match(txt, /▇×  50% up · 2 checks/);
  assert.equal(await inPanel(`document.querySelector("#automations-panel .prof-status").textContent`), "✗ HTTP 503 — changed since the last check.");
  // Pause, then delete (confirm is auto-accepted in headless Chromium).
  await inPanel(`document.querySelector("#automations-panel .prof-btn[title='Pause']").click(); true`);
  await waitUntil(async () => /· paused/.test(await panelText()), 5000, "paused");
  assert.equal(await inPanel("chrome.alarms.getAll().then((a) => a.length)"), 0);
  await inPanel(`window.confirm = () => true; document.querySelector("#automations-panel .prof-btn[title='Delete']").click(); true`);
  await waitUntil(async () => /No uptime monitors yet\./.test(await panelText()), 5000, "deleted");
  assert.deepEqual(await inPanel(`chrome.storage.local.get("agentWatchers").then((o) => o.agentWatchers)`), {});
  await closePanel();
  statusState.code = 200;
});

test("no uncaught errors in the panel", { skip }, () => {
  assert.deepEqual(panelErrors, []);
});
