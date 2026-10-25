// End-to-end test of the Stencil brand's extras (elements + overlay) against a real Chromium: the built
// brand (dist-browser/brands/stencil/extension) is loaded, its side panel opened as a background tab, and
// a fixture page with a header, two boxes of known geometry, a paragraph and a sidebar is the tab the agent
// works on. The tools run exactly as shim.js / the built-in agent run them (window.AgentBrowserTools.run);
// the page is checked through a separate CDP session, not through the tools' own reports — including that
// the saved edits come back after a reload with the panel doing nothing (the content script).
//
// Run: node browser/build.mjs --brand stencil && node --test tests/e2e/extras-stencil.e2e.mjs
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
const EXT_DIR = join(root, "dist-browser", "brands", "stencil", "extension");
const skip = !findChromium()
  ? "no Chromium found (set CHROME_PATH)"
  : !existsSync(join(EXT_DIR, "manifest.json"))
    ? "stencil not built (npm run build && node browser/build.mjs --brand stencil)"
    : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fixture page ───────────────────────────────────────────────────────────

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Stencil Fixture</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  header { height: 80px; background: #eef; }
  h1 { margin: 0; padding: 20px; font-size: 24px; }
  main { position: relative; height: 320px; }
  #box-a { position: absolute; left: 100px; top: 100px; width: 200px; height: 100px; background: #cde; }
  #box-b { position: absolute; left: 340px; top: 100px; width: 150px; height: 100px; background: #edc; }
  aside { width: 200px; background: #fed; }
</style></head><body>
<header><h1 id="title">Welcome to the fixture</h1></header>
<main><div id="box-a">A</div><div id="box-b">B</div></main>
<p>An introductory paragraph with <a href="/more">a link</a>.</p>
<aside id="sidebar"><h2>Sidebar</h2><ul><li>One</li><li>Two</li></ul></aside>
<script>window.__ran = false; window.__clicked = false;</script>
</body></html>`;

let server, BASE;
function startServer() {
  server = createServer((req, res) => {
    const fixture = req.url.startsWith("/fixture.html");
    res.writeHead(fixture || req.url.startsWith("/more") ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(fixture ? PAGE : req.url.startsWith("/more") ? "<!doctype html><title>More</title><p>more</p>" : "not found");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => { BASE = `http://localhost:${server.address().port}`; r(); }));
}

// ── Browser + panel harness ────────────────────────────────────────────────

let browser, cdp, panel, page, pageTabId, workDir;
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
/** Evaluate in the side panel page (where the tools live). */
function inPanel(expr, timeout = 30000) {
  return Promise.race([cdp.evaluate(panel, expr), sleep(timeout).then(() => { throw new Error(`panel evaluation timed out: ${expr.slice(0, 80)}`); })]);
}
/** Evaluate in the fixture page (the oracle — independent of the tools). */
const inPage = (expr) => cdp.evaluate(page, expr);

/** Call a tool like shim.js does. → { ok, text, content, error } */
async function call(name, args = {}) {
  const r = await inPanel(`AgentBrowserTools.run(${JSON.stringify(name)}, ${JSON.stringify(args)}).then(
    (c) => ({ ok: true, content: c.map((p) => (p.type === "image" ? { type: "image", bytes: p.data.length, mimeType: p.mimeType } : p)) }),
    (e) => ({ ok: false, error: String((e && e.message) || e) }))`);
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
/** Ref number of the first read_page line matching `re`. */
function refOf(snapshot, re) {
  const line = snapshot.split("\n").find((l) => /^\[\d+\]/.test(l) && re.test(l));
  assert.ok(line, `no element matching ${re} in snapshot:\n${snapshot.slice(0, 3000)}`);
  return Number(/^\[(\d+)\]/.exec(line)[1]);
}
const STATE = `({
  added: [...document.querySelectorAll("[data-agent-element]")].map((e) => [e.getAttribute("data-agent-element"), e.localName, e.textContent.replace(/\\s+/g, " ").trim(), getComputedStyle(e).position]),
  h1: document.getElementById("title").textContent,
  sidebar: getComputedStyle(document.getElementById("sidebar")).display,
  sidebarHidden: document.getElementById("sidebar").hidden,
  sidebarAria: document.getElementById("sidebar").getAttribute("aria-hidden"),
  hideStyle: (document.querySelector("style[data-agent-hide]") || {}).textContent || null,
  cssStyles: [...document.querySelectorAll("style[data-agent-css]")].map((s) => s.textContent),
  ran: window.__ran, clicked: window.__clicked,
})`;
const reload = async () => {
  await ok("browser_navigate", { action: "reload" });
  await waitUntil(() => inPage("document.readyState === 'complete'"), 10000, "the reloaded page");
};

before(async () => {
  if (skip) return;
  await startServer();
  workDir = mkdtempSync(join(tmpdir(), "stencil-extras-e2e-"));
  browser = await launch({ extensionDir: EXT_DIR, userDataDir: join(workDir, "profile"), downloadDir: join(workDir, "downloads") });
  cdp = browser.cdp;
  // The brand has no manifest key: read the id off the service worker.
  const sw = await cdp.waitForTarget((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"), 15000);
  const extId = new URL(sw.url).host;
  // Panel first (it becomes a background tab and registers the content script), then the page the agent works on.
  const { targetId: panelTarget } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/sidepanel.html` });
  panel = await cdp.attach(panelTarget);
  cdp.on((m) => {
    if (m.sessionId === panel && m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      panelErrors.push((d.exception && d.exception.description) || d.text);
    }
  });
  await cdp.send("Runtime.enable", {}, panel);
  await waitUntil(() => inPanel("document.readyState === 'complete' && typeof AgentBrowserTools === 'object' && typeof AgentExtras === 'object' && typeof AGENT_BRAND === 'object' && !!window.AgentLocal"), 15000, "panel scripts");
  await waitUntil(() => inPanel(`chrome.scripting.getRegisteredContentScripts({ ids: ["extras-elements"] }).then((l) => l.length === 1)`), 10000, "the content script registration");
  const { targetId } = await cdp.send("Target.createTarget", { url: `${BASE}/fixture.html` });
  page = await cdp.attach(targetId);
  await waitUntil(() => inPage("document.readyState === 'complete'"), 10000, "fixture page");
  pageTabId = await inPanel(`chrome.tabs.query({ url: "${BASE}/*" }).then((t) => t[0].id)`);
  await ok("browser_switch_tab", { tabId: pageTabId });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ── The panel: tabs, quick commands, tools, the content script ─────────────

test("stencil's panel has the 🧱 Elements and 📐 Overlay tabs, the Design commands, nine tools registered and declared, and the content script registered", { skip }, async () => {
  const seen = await inPanel(`chrome.scripting.getRegisteredContentScripts().then((scripts) => ({
    brand: AGENT_BRAND.id,
    tabs: AgentExtras.tabs.map((t) => t.id),
    labels: [...document.querySelectorAll("#automations-panel .prof-tab")].map((b) => b.textContent),
    commands: AgentExtras.commands.map((c) => [c.group, c.name, !!c.partial]),
    registered: AgentBrowserTools.names.filter((n) => /^browser_(element|overlay)_/.test(n)),
    declared: AgentLocal.toolNames.filter((n) => /^browser_(element|overlay)_/.test(n)),
    autoBtn: !!document.getElementById("autoBtn"),
    extraObjects: [typeof AgentExtras.elements, typeof AgentExtras.overlay],
    refTarget: typeof AgentBrowserTools.helpers.refTarget,
    scripts: scripts.map((s) => ({ id: s.id, js: s.js, runAt: s.runAt, matches: s.matches, persistAcrossSessions: s.persistAcrossSessions })),
  }))`);
  assert.equal(seen.brand, "stencil");
  // Other extras of the brand (skills) add their own tabs and commands after these; check ours and their order.
  assert.deepEqual(seen.tabs.filter((t) => ["elements", "overlay"].includes(t)), ["elements", "overlay"]);
  const ownLabels = ["🧩 Recipes", "🧠 Memory", "🧱 Elements", "📐 Overlay"];
  assert.deepEqual(seen.labels.filter((l) => ownLabels.includes(l)), ownLabels, "the built-in tabs of the brand's features, then the extras'");
  const ownCommands = [
    ["Design", "Add a note to this page", true], ["Design", "Hide this element…", false], ["Design", "Replace the hero text with…", true], ["Design", "Show this site's edits", false],
    ["Design", "Show a 12-column grid", false], ["Design", "Measure the spacing between these two elements", true], ["Design", "Mark up this page for review", false],
  ];
  assert.deepEqual(seen.commands.filter((c) => ownCommands.some((o) => o[1] === c[1])), ownCommands);
  const tools = ["browser_element_add", "browser_element_edit", "browser_element_hide", "browser_element_list", "browser_element_forget", "browser_overlay_grid", "browser_overlay_measure", "browser_overlay_note", "browser_overlay_clear"];
  assert.deepEqual(seen.registered.sort(), tools.slice().sort());
  assert.deepEqual(seen.declared.sort(), tools.slice().sort(), "the built-in agent declares the same tools");
  assert.ok(seen.autoBtn, "the 🧩 button is there");
  assert.deepEqual(seen.extraObjects, ["object", "object"]);
  assert.equal(seen.refTarget, "function");
  assert.deepEqual(seen.scripts.filter((s) => s.id === "extras-elements"), [{ id: "extras-elements", js: ["extras-elements.cs.js"], runAt: "document_start", matches: ["http://*/*", "https://*/*"], persistAcrossSessions: true }]);
  const names = await inPanel(`(() => { document.getElementById("cmdBtn").click(); const out = [...document.querySelectorAll("#cmdList .cmd-item .cmd-name")].map((n) => n.textContent); document.getElementById("cmdClose").click(); return out; })()`);
  for (const n of ["Add a note to this page", "Show a 12-column grid", "Mark up this page for review"]) assert.ok(names.includes(n), `${n} in the ⚡ panel`);
});

// ── Elements ───────────────────────────────────────────────────────────────

let bannerId;

test("browser_element_add: a fixed banner lands in the page with its script and handler gone and its css scoped; nothing ran", { skip }, async () => {
  const out = await ok("browser_element_add", {
    html: '<div class="hello">Hello <b>there</b><script>window.__ran = true</script> <span id="sp" onclick="window.__clicked = true">x</span></div>',
    css: "& { background: #123; } .hello b { color: red }",
    position: "fixed", corner: "top", name: "Banner",
  });
  bannerId = /\((el_\w+)\)/.exec(out)[1];
  assert.equal(out, `Added "Banner" (${bannerId}) as a fixed top bar on localhost — it carries data-agent-element="${bannerId}". Dropped while sanitising: <script>, onclick. Saved for this site: it comes back on every load of this site until forgotten (browser_element_forget). Check it with browser_screenshot.`);
  const st = await inPage(STATE);
  assert.deepEqual(st.added, [[bannerId, "div", "Hello there x", "fixed"]]);
  assert.equal(await inPage(`document.querySelectorAll("[data-agent-element] script").length`), 0);
  assert.equal(await inPage(`document.getElementById("sp").hasAttribute("onclick")`), false);
  assert.equal(await inPage(`(() => { document.getElementById("sp").click(); return window.__clicked; })()`), false, "the handler is gone");
  assert.equal(st.ran, false, "the script never ran");
  assert.deepEqual(st.cssStyles, [`[data-agent-element="${bannerId}"] { background: #123; }\n[data-agent-element="${bannerId}"] .hello b { color: red; }`]);
  assert.equal(await inPage(`getComputedStyle(document.querySelector("[data-agent-element] b")).color`), "rgb(255, 0, 0)", "the scoped css applies");
  assert.equal(await inPage(`getComputedStyle(document.querySelector("[data-agent-element]")).backgroundColor`), "rgb(17, 34, 51)");
  assert.equal(await inPage(`getComputedStyle(document.querySelector("[data-agent-element]")).top`), "0px");
});

test("browser_element_edit by selector, browser_element_add after a ref, browser_element_hide the sidebar (mode remove); list and storage", { skip }, async () => {
  const snap = await ok("browser_read_page", {});
  const link = refOf(snap, /link "a link"/);
  const edit = await ok("browser_element_edit", { selector: "h1", text: "Hello, Stencil" });
  assert.match(edit, /^Edited h1 "Welcome to the fixture" \(#title\) on localhost: text → "Hello, Stencil"\. Saved as el_\w+: it comes back on every load/);
  const add = await ok("browser_element_add", { ref: link, html: '<em class="tag">new</em>', position: "after", name: "Tag" });
  assert.match(add, /^Added "Tag" \(el_\w+\) after a "a link" \(body > p > a\) on localhost/);
  const hide = await ok("browser_element_hide", { selector: "#sidebar", mode: "remove" });
  assert.match(hide, /^Hid aside "Sidebar One Two" \(#sidebar\) on localhost — removed from view and the accessibility tree\. Saved as el_\w+: it stays hidden/);
  const st = await inPage(STATE);
  assert.equal(st.h1, "Hello, Stencil");
  assert.equal(st.added.length, 2);
  assert.deepEqual(st.added[0].slice(1), ["em", "new", "static"]);
  assert.equal(await inPage(`document.querySelector("p > a").nextElementSibling.matches("em.tag[data-agent-element]")`), true);
  assert.equal(st.sidebar, "none");
  assert.equal(st.sidebarHidden, true);
  assert.equal(st.sidebarAria, "true");
  assert.equal(st.hideStyle, "#sidebar { display: none !important; }");
  const list = await ok("browser_element_list", {});
  assert.match(list, /^Saved edits for localhost \(4\)/);
  for (const l of ["Added (2):", "Edited (1):", "Hidden (1):", "Banner — fixed top · on · just now", "Tag — after body > p > a", 'h1 "Welcome to the fixture" — #title · text → "Hello, Stencil"', "#sidebar · removed from view and the accessibility tree"]) assert.ok(list.includes(l), `${l} in the list`);
  const stored = await inPanel(`chrome.storage.local.get("agentPageEdits").then((s) => s.agentPageEdits)`);
  assert.deepEqual(Object.keys(stored), ["localhost"]);
  assert.deepEqual(stored.localhost.map((r) => [r.kind, r.enabled]), [["add", true], ["edit", true], ["add", true], ["hide", true]]);
  assert.equal(stored.localhost[1].before.text, "Welcome to the fixture");
});

test("after a reload the content script alone brings the banner, the heading, the tag and the hidden sidebar back — once", { skip }, async () => {
  await reload();
  assert.equal(await inPage(`window.__ran`), false, "a fresh document");
  const st = await waitUntil(async () => { const s = await inPage(STATE); return s.added.length === 2 && s.h1 === "Hello, Stencil" && s.sidebar === "none" ? s : null; }, 10000, "the content script's work");
  assert.deepEqual(st.added.map((a) => a.slice(1)), [["em", "new", "static"], ["div", "Hello there x", "fixed"]]);
  assert.equal(st.hideStyle, "#sidebar { display: none !important; }");
  assert.equal(st.sidebarHidden, true);
  assert.equal(st.cssStyles.length, 1);
  assert.equal(st.ran, false, "the stored fragment's script is gone for good");
  await sleep(700); // a retry pass must not add a second copy
  const again = await inPage(STATE);
  assert.equal(again.added.length, 2);
  assert.equal(await inPage(`document.querySelectorAll("style[data-agent-hide]").length`), 1);
});

test("restore a hide, an edit for this visit only, forget all — and the page stays clean after another reload", { skip }, async () => {
  assert.match(await ok("browser_element_hide", { selector: "#sidebar", restore: true }), /^Restored 'aside "Sidebar One Two"' \(#sidebar, el_\w+\) on localhost — the hide is forgotten\.$/);
  let st = await inPage(STATE);
  assert.equal(st.sidebar, "block");
  assert.equal(st.sidebarHidden, false);
  assert.equal(st.sidebarAria, null);
  assert.equal(st.hideStyle, null);
  const once = await ok("browser_element_edit", { selector: "#box-a", style: "outline: 3px solid red", persist: false });
  assert.match(once, /This visit only \(persist=false\), nothing saved/);
  assert.equal(await inPage(`getComputedStyle(document.getElementById("box-a")).outlineStyle`), "solid");
  assert.equal((await inPanel(`chrome.storage.local.get("agentPageEdits").then((s) => s.agentPageEdits.localhost.length)`)), 3);
  assert.equal(await ok("browser_element_forget", { all: true }), "Forgot all 3 edits of localhost and undid them on the page.");
  st = await inPage(STATE);
  assert.deepEqual(st.added, []);
  assert.equal(st.h1, "Welcome to the fixture", "the edit is reverted from what it replaced");
  assert.deepEqual(st.cssStyles, []);
  assert.deepEqual(await inPanel(`chrome.storage.local.get("agentPageEdits").then((s) => s.agentPageEdits)`), {});
  assert.equal(await ok("browser_element_list", {}), "No saved edits for localhost. browser_element_add / _edit / _hide save theirs here.");
  await reload();
  await sleep(800);
  st = await inPage(STATE);
  assert.deepEqual([st.added, st.h1, st.sidebar, st.hideStyle, st.cssStyles], [[], "Welcome to the fixture", "block", null, []]);
  assert.match(await fails("browser_element_forget", { all: true }), /No saved edits for localhost/);
});

// ── Overlays ───────────────────────────────────────────────────────────────

test("overlays: a 12-column grid, the 40 px gap between the boxes, two notes, a screenshot with everything on, clear", { skip }, async () => {
  const grid = await ok("browser_overlay_grid", { columns: 12, gutter: 24, maxWidth: 1200 });
  assert.match(grid, /^Grid on: 12 columns, 24 px gutters, max width 1200 px, centred in a \d+ px viewport — columns [\d.]+ px wide at x = /);
  const g = await inPage(`({ cols: document.querySelectorAll("[data-agent-overlay] [data-agent-grid-col]").length, pe: getComputedStyle(document.querySelector("[data-agent-overlay]")).pointerEvents, z: getComputedStyle(document.querySelector("[data-agent-overlay]")).zIndex, firstLeft: document.querySelector("[data-agent-grid-col]").getBoundingClientRect().left, vw: innerWidth })`);
  assert.equal(g.cols, 12);
  assert.equal(g.pe, "none");
  assert.equal(g.z, "2147483646");
  const expectedLeft = Math.max(0, (g.vw - 1200) / 2);
  assert.ok(Math.abs(g.firstLeft - expectedLeft) <= 1, `the first column starts at ${g.firstLeft}, expected ${expectedLeft}`);
  assert.ok(grid.includes(`x = ${expectedLeft}`), `the report names x = ${expectedLeft}: ${grid}`);

  const m = await ok("browser_overlay_measure", { selector: "#box-a", selectorB: "#box-b" });
  const lines = m.split("\n");
  assert.equal(lines[0], 'A: div "A" — 200 × 100 px at (100, 180)');
  assert.equal(lines[1], 'B: div "B" — 150 × 100 px at (340, 180)');
  assert.equal(lines[2], "Horizontal: B is right of A, gap 40 px. Vertical: the boxes overlap by 100 px.");
  assert.equal(lines[3], "Offset of B from A (top-left corners): dx 240 px, dy 0 px.");
  assert.equal(lines[4], "Alignment: same top edge, same bottom edge, same vertical centre, same height.");
  const drawn = await inPage(`({ boxes: document.querySelectorAll("[data-agent-overlay-measure] [data-agent-box]").length, gaps: [...document.querySelectorAll("[data-agent-gap]")].map((g) => g.getBoundingClientRect().width), labels: [...document.querySelectorAll("[data-agent-overlay-measure] div")].map((d) => d.textContent).filter((t) => /^[\\d.]+ px$/.test(t)) })`);
  assert.equal(drawn.boxes, 2);
  assert.deepEqual(drawn.gaps.map(Math.round), [44], "the 40 px line plus its two 2 px end ticks");
  assert.deepEqual(drawn.labels, ["40 px"]);

  assert.match(await ok("browser_overlay_note", { selector: "#box-a", text: "Too close to B" }), /^Note #1 "Too close to B" placed at div "A"\. 1 note on the page\./);
  assert.match(await ok("browser_overlay_note", { x: 20, y: 30, text: "Header too tall" }), /^Note #2 "Header too tall" placed at \(20, 30\) of the viewport\. 2 notes on the page\./);
  assert.deepEqual(await inPage(`[...document.querySelectorAll("[data-agent-overlay] [data-agent-note]")].map((n) => [n.getAttribute("data-agent-note"), n.textContent])`), [["1", "1Too close to B"], ["2", "2Header too tall"]]);
  assert.equal(await ok("browser_overlay_note", { list: true }), "Review notes on the page (2):\n#1 Too close to B — at (112, 192)\n#2 Header too tall — at (20, 30)");

  // The screenshot works with everything drawn and leaves it there.
  const shot = await call("browser_screenshot", {});
  assert.ok(shot.ok, shot.error);
  assert.ok(shot.content.some((p) => p.type === "image" && p.mimeType === "image/jpeg" && p.bytes > 1000), "an image came back");
  assert.equal(await inPage(`document.querySelectorAll("[data-agent-overlay] [data-agent-note], [data-agent-grid-col], [data-agent-box]").length`), 16);

  assert.equal(await ok("browser_overlay_note", { remove: 1 }), "Removed note #1. 1 left: #2 Header too tall");
  assert.equal(await ok("browser_overlay_clear", { only: "grid" }), "Removed the grid overlay. Still on the page: measure, notes.");
  assert.equal(await inPage(`document.querySelectorAll("[data-agent-grid-col]").length + document.querySelectorAll("[data-agent-note]").length`), 1);
  assert.equal(await ok("browser_overlay_clear", {}), "Removed all overlays; the page is clean.");
  assert.equal(await inPage(`document.querySelector("[data-agent-overlay]")`), null);
  assert.match(await fails("browser_overlay_measure", { selector: "#nope" }), /Nothing on the page matches the selector "#nope"/);
});

// ── The 🧩 panel's tabs, rendered for real ────────────────────────────────

test("the 🧱 Elements and 📐 Overlay tabs render in the 🧩 panel", { skip }, async () => {
  await ok("browser_element_add", { html: "<p>Promo</p>", name: "Promo card", corner: "bottom-right" });
  await ok("browser_overlay_note", { selector: "#box-b", text: "Check this" });
  await inPanel(`AgentAutomationsPanel.show("elements"), true`);
  const elements = await waitUntil(() => inPanel(`(() => { const t = document.querySelector("#automations-panel .cmd-list").innerText; return /Promo card/.test(t) ? t : ""; })()`), 10000, "the Elements tab");
  // Group titles may be rendered upper-case by the skin (CSS text-transform shows in innerText): compare case-insensitively.
  const has = (text, n) => text.toLowerCase().includes(n.toLowerCase());
  for (const n of ["Quick add", "Added (1)", "Promo card", "fixed bottom-right", "1 edit on localhost", "🧹 Forget all for this site", "💬 Explain in chat"]) assert.ok(has(elements, n), `${n} in the tab`);
  // Its delete button undoes the add on the page.
  await inPanel(`[...document.querySelectorAll("#automations-panel .prof-btn")].find((b) => b.textContent === "🗑").click(), true`);
  await waitUntil(() => inPage(`document.querySelectorAll("[data-agent-element]").length === 0`), 5000, "the card gone");
  await waitUntil(() => inPanel(`chrome.storage.local.get("agentPageEdits").then((s) => Object.keys(s.agentPageEdits || {}).length === 0)`), 5000, "the record gone");
  await inPanel(`AgentAutomationsPanel.show("overlay"), true`);
  const overlay = await waitUntil(() => inPanel(`(() => { const t = document.querySelector("#automations-panel .cmd-list").innerText; return /Check this/.test(t) ? t : ""; })()`), 10000, "the Overlay tab");
  for (const n of ["Grid", "Columns", "▦ Grid on", "Grid off", "Notes", "#1", "Check this", "🧹 Clear all", "📸 Screenshot with overlays"]) assert.ok(has(overlay, n), `${n} in the tab`);
  await inPanel(`[...document.querySelectorAll("#automations-panel .prof-btn")].find((b) => b.textContent === "▦ Grid on").click(), true`);
  await waitUntil(() => inPage(`document.querySelectorAll("[data-agent-grid-col]").length === 12`), 5000, "the grid from the panel");
  await inPanel(`[...document.querySelectorAll("#automations-panel .prof-btn")].find((b) => b.textContent === "🧹 Clear all").click(), true`);
  await waitUntil(() => inPage(`!document.querySelector("[data-agent-overlay]")`), 5000, "the overlays cleared from the panel");
  await inPanel(`AgentAutomationsPanel.hide(), true`);
  assert.deepEqual(panelErrors, [], "no uncaught errors in the panel");
});
