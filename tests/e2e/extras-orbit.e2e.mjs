// Orbit's extra features (clips, sessions) in a real Chromium: the built brand
// (dist-browser/brands/orbit/extension) is loaded headless, its side panel page opened as a tab in
// the same window as a fixture page, text selected in the page through CDP, and the tools invoked
// the way shim.js / the built-in agent do it — window.AgentBrowserTools.run(name, args) — with the
// results checked against chrome.tabs / chrome.windows / chrome.storage from the panel, not only
// against the tools' own reports. The 🧩 panel's tabs and the quick commands are checked too.
//
// Run: node browser/build.mjs --brand orbit && node --test tests/e2e/extras-orbit.e2e.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, findChromium } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const EXT_DIR = join(root, "dist-browser", "brands", "orbit", "extension");
const skip = !findChromium()
  ? "no Chromium found (set CHROME_PATH)"
  : !existsSync(join(EXT_DIR, "manifest.json"))
    ? "orbit not built (node browser/build.mjs --brand orbit)"
    : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FACT = "Berlin has 3.7 million inhabitants (2024).";

// ── Fixture server: two pages ──────────────────────────────────────────────

let server, PORT, BASE;
function startServer() {
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const html = (body) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
    if (url.pathname === "/facts.html") return html(`<!doctype html><html><head><meta charset="utf-8"><title>Berlin facts</title></head><body><h1>Berlin</h1><p id="fact">${FACT}</p><p>Capital of Germany.</p></body></html>`);
    if (url.pathname === "/notes.html") return html(`<!doctype html><html><head><meta charset="utf-8"><title>Notes page</title></head><body><h1>Notes</h1><p id="q">The quick brown fox jumps over the lazy dog.</p></body></html>`);
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => { PORT = server.address().port; BASE = `http://localhost:${PORT}`; r(); }));
}

// ── Browser + panel harness ────────────────────────────────────────────────

let browser, cdp, extId, panel, workDir;
let mainTarget, mainSession, mainTabId, mainWindowId;
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
function inPanel(expr, timeout = 30000) {
  return Promise.race([cdp.evaluate(panel, expr), sleep(timeout).then(() => { throw new Error(`panel evaluation timed out: ${expr.slice(0, 80)}`); })]);
}
const inMain = (expr) => cdp.evaluate(mainSession, expr);

/** Call a tool like shim.js does. → { ok, text, error } */
async function call(name, args = {}) {
  const r = await inPanel(`AgentBrowserTools.run(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((c) => ({ ok: true, content: c }), (e) => ({ ok: false, error: String((e && e.message) || e) }))`);
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
/** A tab of this window has finished loading `path`. */
function loaded(tabId, path) {
  return waitUntil(() => inPanel(`chrome.tabs.get(${tabId}).then((t) => t.status === "complete" && t.url.includes(${JSON.stringify(path)}) && !!t.title)`), 15000, `${path} in tab ${tabId}`);
}

before(async () => {
  if (skip) return;
  await startServer();
  workDir = mkdtempSync(join(tmpdir(), "orbit-extras-e2e-"));
  browser = await launch({ extensionDir: EXT_DIR, userDataDir: join(workDir, "profile"), downloadDir: join(workDir, "downloads") });
  cdp = browser.cdp;
  // The brand has no manifest key, so its id comes off the service worker's URL (as brands.e2e.mjs does).
  const sw = await cdp.waitForTarget((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"), 15000);
  extId = new URL(sw.url).host;
  // Panel first (it becomes a background tab), then the page the agent works on — both in the one window.
  const { targetId: panelTarget } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/sidepanel.html` });
  panel = await cdp.attach(panelTarget);
  cdp.on((m) => {
    if (m.sessionId === panel && m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      panelErrors.push((d.exception && d.exception.description) || d.text);
    }
  });
  await cdp.send("Runtime.enable", {}, panel);
  await waitUntil(() => inPanel("document.readyState === 'complete' && typeof AgentBrowserTools === 'object' && typeof AGENT_BRAND === 'object' && typeof AgentExtras === 'object' && !!window.AgentAutomationsPanel"), 15000, "panel scripts");
  ({ targetId: mainTarget } = await cdp.send("Target.createTarget", { url: `${BASE}/facts.html` }));
  mainSession = await cdp.attach(mainTarget);
  await waitUntil(() => inMain("document.readyState === 'complete'"), 10000, "fixture page");
  const main = await inPanel(`chrome.tabs.query({ url: "${BASE}/*" }).then((t) => ({ id: t[0].id, windowId: t[0].windowId }))`);
  mainTabId = main.id;
  mainWindowId = main.windowId;
  await ok("browser_switch_tab", { tabId: mainTabId });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ── The panel ──────────────────────────────────────────────────────────────

test("orbit: the 🧩 panel has the Clips and Sessions tabs, the quick commands are there, every declared extra tool is registered", { skip }, async () => {
  const seen = await inPanel(`({
    brand: AGENT_BRAND.id,
    features: [AGENT_BRAND.has("clips"), AGENT_BRAND.has("sessions"), AGENT_BRAND.has("rewrite")],
    extraTabs: AgentExtras.tabs.map((t) => [t.id, t.label, t.storageKeys]),
    panelTabs: [...document.querySelectorAll("#automations-panel .prof-tab")].map((b) => [b.dataset.tab, b.textContent]),
    commands: AgentExtras.commands.map((c) => [c.group, c.name, !!c.partial]),
    registered: AgentBrowserTools.names.filter((n) => /^browser_(clip|session)_/.test(n)).sort(),
    declared: (window.AgentLocal ? window.AgentLocal.toolNames : []).filter((n) => /^browser_(clip|session)_/.test(n)).sort(),
    helpers: [typeof AgentExtras.clips.toMarkdown, typeof AgentExtras.sessions.restorableTabs],
  })`);
  assert.equal(seen.brand, "orbit");
  assert.deepEqual(seen.features, [true, true, false]);
  assert.deepEqual(seen.extraTabs, [["clips", "📎 Clips", ["agentClips"]], ["sessions", "🗂 Sessions", ["agentSessions"]]]);
  assert.deepEqual(seen.panelTabs.slice(-2), [["clips", "📎 Clips"], ["sessions", "🗂 Sessions"]], "the extras' tabs come after the built-in ones");
  assert.deepEqual(seen.commands, [
    ["Research", "Clip the selection", false],
    ["Research", "Clip the key facts of this page", false],
    ["Research", "Export my clips as Markdown", false],
    ["Research", "Search my clips", true],
    ["Research", "Cite this page", false],
    ["Tabs", "Save this window's tabs as a session", true],
    ["Tabs", "Restore a session", true],
    ["Tabs", "Close the duplicates in this window", false],
    ["Tabs", "Add this tab to a session", true],
  ]);
  const expected = ["browser_clip_cite", "browser_clip_delete", "browser_clip_export", "browser_clip_list", "browser_clip_save", "browser_clip_search", "browser_clip_update", "browser_session_add", "browser_session_delete", "browser_session_list", "browser_session_restore", "browser_session_save", "browser_session_tidy"];
  assert.deepEqual(seen.registered, expected);
  assert.deepEqual(seen.declared, expected, "the built-in agent is offered exactly the registered extra tools");
  assert.deepEqual(seen.helpers, ["function", "function"]);
});

// ── Clips ──────────────────────────────────────────────────────────────────

test("clips: text selected in the page → browser_clip_save → list → Markdown export; the 📎 tab shows it", { skip }, async () => {
  assert.equal(await fails("browser_clip_save", {}), "Nothing is selected on the page — select the passage first, or pass text.");
  // Select the fact in the page (what a user does with the mouse), through CDP.
  const selected = await inMain(`(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById("fact")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()`);
  assert.equal(selected, FACT);
  const saved = await ok("browser_clip_save", { note: "population" });
  assert.match(saved, new RegExp(`^Saved clip (clp_[a-z0-9]{6}) from localhost \\(${FACT.length} chars\\): "${FACT.replace(/[.()]/g, "\\$&")}"\n  note: population\n  source: Berlin facts — ${BASE}/facts.html$`));
  const id = /clp_[a-z0-9]{6}/.exec(saved)[0];

  // A second clip, from another page, as text the model read (the selection is gone after navigation).
  await inPanel(`chrome.tabs.update(${mainTabId}, { url: ${JSON.stringify(BASE + "/notes.html")} }).then(() => true)`);
  await loaded(mainTabId, "/notes.html");
  assert.match(await fails("browser_clip_save", {}), /Nothing is selected/);
  await ok("browser_clip_save", { text: "The quick brown fox jumps over the lazy dog." });

  const list = await ok("browser_clip_list", {});
  assert.match(list, new RegExp(`^Clips \\(2 on 1 site\\):\nlocalhost \\(2\\):\n  clp_[a-z0-9]{6}  "The quick brown fox jumps over the lazy dog\\."  —  Notes page · just now\n  ${id}  "${FACT.replace(/[.()]/g, "\\$&")}"  —  Berlin facts · just now\n    note: population$`));
  const md = await ok("browser_clip_export", {});
  assert.equal(
    md.replace(/\d{4}-\d{2}-\d{2}/g, "DATE"),
    `# Clips (2)\n\n## localhost\n\n> The quick brown fox jumps over the lazy dog.\n>\n> — [Notes page](${BASE}/notes.html) · DATE\n\n> ${FACT}\n>\n> — [Berlin facts](${BASE}/facts.html) · DATE\n\nNote: population\n`
  );
  // The store holds the same two, newest first.
  const stored = await inPanel(`chrome.storage.local.get("agentClips").then((s) => s.agentClips.map((c) => [c.host, c.title, c.note]))`);
  assert.deepEqual(stored, [["localhost", "Notes page", ""], ["localhost", "Berlin facts", "population"]]);

  // The 📎 tab renders the clips in the real panel DOM.
  await inPanel(`AgentAutomationsPanel.show("clips"); true`);
  const ui = await waitUntil(() => inPanel(`(() => {
    const titles = [...document.querySelectorAll("#automations-panel .cmd-group-title")].map((n) => n.textContent);
    const notes = [...document.querySelectorAll("#automations-panel .cmd-name.note")].map((n) => n.textContent);
    return titles.length ? { titles, notes, copy: !!document.querySelector("#automations-panel button[title='Copy every clip as a Markdown document']") } : null;
  })()`), 10000, "the clips tab");
  assert.deepEqual(ui, { titles: ["localhost (2)"], notes: ["The quick brown fox jumps over the lazy dog.", FACT], copy: true });
  await inPanel(`AgentAutomationsPanel.hide(); true`);

  assert.equal(await ok("browser_clip_delete", { id }), `Deleted clip ${id} (localhost). 1 clip left.`);
  assert.match(await ok("browser_clip_list", {}), /^Clips \(1 on 1 site\):/);
  assert.match(await fails("browser_clip_delete", { id }), new RegExp(`No clip with id ${id}`));
  assert.equal(await ok("browser_clip_delete", { host: "*" }), "Deleted all 1 clips.");
  assert.equal(await ok("browser_clip_export", {}), "No clips yet — nothing to export.");
});

// ── Sessions ───────────────────────────────────────────────────────────────

test("sessions: this window's tabs → browser_session_save → restore into a new window and into this one", { skip }, async () => {
  // Three site tabs in the panel's window: the main tab plus a pinned one and another; the panel and about:blank are left out.
  await inPanel(`chrome.tabs.update(${mainTabId}, { url: ${JSON.stringify(BASE + "/facts.html")} }).then(() => true)`);
  const pinnedId = await inPanel(`chrome.tabs.create({ windowId: ${mainWindowId}, url: ${JSON.stringify(BASE + "/notes.html")}, pinned: true, active: false }).then((t) => t.id)`);
  const thirdId = await inPanel(`chrome.tabs.create({ windowId: ${mainWindowId}, url: ${JSON.stringify(BASE + "/facts.html?second=1")}, active: false }).then((t) => t.id)`);
  await loaded(mainTabId, "/facts.html");
  await loaded(pinnedId, "/notes.html");
  await loaded(thirdId, "/facts.html?second=1");
  await ok("browser_switch_tab", { tabId: mainTabId });
  const before = await inPanel(`chrome.tabs.query({ windowId: ${mainWindowId} }).then((t) => t.length)`);

  assert.match(await fails("browser_session_save", {}), /name is required/);
  const saved = await ok("browser_session_save", { name: "E2E research" });
  // A pinned tab comes first in a window; the main tab is the active one.
  assert.equal(saved, `Saved session 'E2E research' (id: ${/ses_[a-z0-9]{6}/.exec(saved)[0]}) — 3 tabs:\n  1. 📌 Notes page — ${BASE}/notes.html\n  2. Berlin facts — ${BASE}/facts.html  (active)\n  3. Berlin facts — ${BASE}/facts.html?second=1`);
  const id = /ses_[a-z0-9]{6}/.exec(saved)[0];
  assert.match(await ok("browser_session_list", {}), new RegExp(`^Sessions \\(1\\):\n  ${id}  E2E research  \\|  3 tabs  \\|  saved just now\n    Notes page; Berlin facts; Berlin facts$`));

  // Into a new window: the tabs exist there, pinned and active as saved.
  const restored = await ok("browser_session_restore", { name: "e2e research" });
  const m = /^Restored session 'E2E research': 3 tabs in new window (\d+) \(1 pinned\)\.\n/.exec(restored);
  assert.ok(m, restored);
  const newWin = Number(m[1]);
  assert.notEqual(newWin, mainWindowId);
  const tabs = await waitUntil(() => inPanel(`chrome.tabs.query({ windowId: ${newWin} }).then((t) => t.every((x) => x.status === "complete" && x.url) ? t.map((x) => [x.url, x.pinned, x.active]) : null)`), 15000, "the restored window's tabs");
  assert.deepEqual(tabs, [[`${BASE}/notes.html`, true, false], [`${BASE}/facts.html`, false, true], [`${BASE}/facts.html?second=1`, false, false]]);
  assert.ok((await inPanel("chrome.windows.getAll().then((w) => w.map((x) => x.id))")).includes(newWin));
  // The agent works in the restored window now; browser_tabs lists its tabs.
  assert.match(await ok("browser_tabs", {}), new RegExp(`^\\* \\d+  Berlin facts — ${BASE}/facts.html$`, "m"));
  await inPanel(`chrome.windows.remove(${newWin}).then(() => true)`);

  // Into the current window: the tabs are added there.
  await ok("browser_switch_tab", { tabId: mainTabId });
  const here = await ok("browser_session_restore", { id, where: "current" });
  assert.match(here, new RegExp(`^Restored session 'E2E research': 3 tabs in window ${mainWindowId} \\(1 pinned\\)\\.`));
  const after = await waitUntil(() => inPanel(`chrome.tabs.query({ windowId: ${mainWindowId} }).then((t) => t.length === ${before + 3} ? t.map((x) => [x.url || x.pendingUrl, x.pinned]) : null)`), 15000, "the added tabs");
  assert.equal(after.filter((t) => t[0] === `${BASE}/notes.html` && t[1]).length, 2, "the restored notes tab is pinned like the original");

  assert.match(await fails("browser_session_restore", { name: "nope" }), /No session named 'nope'\. Saved: 'E2E research'\./);
  assert.equal(await ok("browser_session_delete", { id }), "Deleted session 'E2E research' (3 tabs).");
  assert.equal(await ok("browser_session_list", {}), "No sessions saved yet. browser_session_save keeps this window's tabs under a name.");
  assert.deepEqual(await inPanel(`chrome.storage.local.get("agentSessions").then((s) => s.agentSessions)`), []);
});

test("orbit: the panel page threw nothing while the extras ran", { skip }, () => {
  assert.deepEqual(panelErrors, []);
});
