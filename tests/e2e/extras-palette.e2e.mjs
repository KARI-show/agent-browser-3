// End-to-end test of the Palette brand's extras (styles + palette) against a real Chromium: the built
// brand (dist-browser/brands/palette/extension) is loaded, its side panel opened as a background tab,
// and a fixture page with known colours, fonts, a low-contrast paragraph, a heading and a call-to-action
// link is the tab the agent works on. The tools run exactly as shim.js / the built-in agent run them
// (window.AgentBrowserTools.run) and the page is checked through a separate CDP session — computed
// styles, the <style data-agent-styles> element, and what survives a reload with the panel doing nothing
// (the content script, extras-styles.cs.js, registered by the styles module).
//
// Run: node browser/build.mjs --brand palette && node --test tests/e2e/extras-palette.e2e.mjs
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
const EXT_DIR = join(root, "dist-browser", "brands", "palette", "extension");
const skip = !findChromium()
  ? "no Chromium found (set CHROME_PATH)"
  : !existsSync(join(EXT_DIR, "manifest.json")) || !existsSync(join(EXT_DIR, "extras-styles.cs.js"))
    ? "palette not built (npm run build && node browser/build.mjs --brand palette)"
    : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fixture page ───────────────────────────────────────────────────────────

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Palette Fixture</title>
<meta name="theme-color" content="#c2410c">
<style>
  :root { --brand: #c2410c; --bg: #ffffff; --gap: 16px; }
  body { margin: 0; font-family: Georgia, serif; background: #ffffff; color: #222222; }
  main { padding: 24px; max-width: 720px; }
  h1 { font-family: Arial, sans-serif; font-size: 32px; color: #112233; }
  p { font-size: 16px; line-height: 24px; margin: 16px 0; }
  p.low { color: #999999; }
  .card { background: #f4f4f4; border: 1px solid #dddddd; padding: 16px; border-radius: 8px; }
  a.cta { display: inline-block; background: #c2410c; color: #ffffff; padding: 8px 16px; border-radius: 4px; text-decoration: none; }
</style></head><body>
<main>
<h1 id="title">Palette Fixture</h1>
<p id="good">Readable paragraph in dark grey on white.</p>
<p id="low" class="low">Low-contrast fine print nobody can read.</p>
<div class="card"><p id="cardp">Card text</p><a id="cta" class="cta" href="#go">Call to action</a></div>
<button id="btn">A button</button>
<img id="pic" alt="dot" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAIAAAP8AAAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==">
</main></body></html>`;

let server, BASE;
function startServer() {
  server = createServer((req, res) => {
    res.writeHead(req.url.startsWith("/page.html") ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url.startsWith("/page.html") ? PAGE : "not found");
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
    try { last = await fn(); } catch (_) { last = null; } // a navigating page throws mid-way
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

/** Call a tool like shim.js does. → { ok, text, error } */
async function call(name, args = {}) {
  const r = await inPanel(`AgentBrowserTools.run(${JSON.stringify(name)}, ${JSON.stringify(args)}).then(
    (c) => ({ ok: true, content: c }),
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
const computed = (id, prop) => inPage(`getComputedStyle(document.getElementById(${JSON.stringify(id)})).getPropertyValue(${JSON.stringify(prop)})`);
/** The agent's style element in the page: { present, last, text } (the panel knows nothing about this). */
const agentStyle = () => inPage(`(() => { const el = document.querySelector("style[data-agent-styles]"); return { present: !!el, inHead: !!el && el.parentNode === document.head, last: !!el && document.head.lastElementChild === el, text: el ? el.textContent : "" }; })()`);
const stored = () => inPanel(`chrome.storage.local.get("agentSiteStyles").then((s) => s.agentSiteStyles || {})`);
/** Reload the fixture through the tool and wait for the new document — the panel does nothing else. */
async function reload() {
  await inPage(`window.__beforeReload = true`);
  await ok("browser_navigate", { action: "reload" });
  await waitUntil(() => inPage(`document.readyState === "complete" && !window.__beforeReload && !!document.getElementById("title")`), 15000, "the reloaded fixture");
}

before(async () => {
  if (skip) return;
  await startServer();
  workDir = mkdtempSync(join(tmpdir(), "palette-extras-e2e-"));
  browser = await launch({ extensionDir: EXT_DIR, userDataDir: join(workDir, "profile"), downloadDir: join(workDir, "downloads") });
  cdp = browser.cdp;
  // The brand has no manifest key: read the id off the service worker.
  const sw = await cdp.waitForTarget((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"), 15000);
  const extId = new URL(sw.url).host;
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
  await waitUntil(() => inPanel("document.readyState === 'complete' && typeof AgentBrowserTools === 'object' && typeof AgentExtras === 'object' && typeof AGENT_BRAND === 'object' && !!window.AgentLocal && !!window.AgentAutomationsPanel"), 15000, "panel scripts");
  // The styles module registers its content script when the panel loads; the fixture is opened after that.
  assert.equal(await inPanel("AgentExtras.styles.ready"), true, "the content script registered");
  const { targetId } = await cdp.send("Target.createTarget", { url: `${BASE}/page.html` });
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

test("palette's panel has the 🎨 Styles and 🧪 Palette tabs, the Design commands, seventeen tools registered and declared, and the content script registered", { skip }, async () => {
  const seen = await inPanel(`({
    brand: AGENT_BRAND.id,
    tabs: AgentExtras.tabs.map((t) => [t.id, t.label, t.storageKeys]),
    labels: [...document.querySelectorAll("#automations-panel .prof-tab")].map((b) => b.textContent),
    commands: AgentExtras.commands.map((c) => [c.group, c.name, !!c.partial]),
    registered: AgentBrowserTools.names.filter((n) => /^browser_(style|palette)_/.test(n)).sort(),
    declared: AgentLocal.toolNames.filter((n) => /^browser_(style|palette)_/.test(n)).sort(),
    extraObjects: [typeof AgentExtras.styles, typeof AgentExtras.palette],
    refTarget: typeof AgentBrowserTools.helpers.refTarget,
  })`);
  assert.equal(seen.brand, "palette");
  // Other extras of the brand (skills) add their own tabs and commands after these; check ours and their order.
  assert.deepEqual(seen.tabs.filter((t) => ["styles", "palette"].includes(t[0])), [["styles", "🎨 Styles", ["agentSiteStyles"]], ["palette", "🧪 Palette", ["agentSiteStyles"]]]);
  const ownLabels = ["🧩 Recipes", "👁 Watchers", "🧠 Memory", "🎨 Styles", "🧪 Palette"];
  assert.deepEqual(seen.labels.filter((l) => ownLabels.includes(l)), ownLabels, "the built-in tabs of the brand's features, then the extras'");
  const ownCommands = [
    ["Design", "Make this page easier to read", false], ["Design", "Hide the distractions on this page", false], ["Design", "Show this site's style overrides", false],
    ["Design", "What colours and fonts does this page use?", false], ["Design", "Check this page's contrast", false], ["Design", "Dark theme for this site", false],
  ];
  assert.deepEqual(seen.commands.filter((c) => ownCommands.some((o) => o[1] === c[1])), ownCommands);
  const tools = ["browser_palette_contrast", "browser_palette_extract", "browser_palette_from_image", "browser_palette_harmony", "browser_palette_recolor", "browser_palette_theme", "browser_palette_tokens", "browser_style_apply", "browser_style_export", "browser_style_font", "browser_style_import", "browser_style_inspect", "browser_style_list", "browser_style_preset", "browser_style_remove", "browser_style_toggle", "browser_style_tokens"];
  assert.deepEqual(seen.registered, tools);
  assert.deepEqual(seen.declared, tools, "the built-in agent declares the same tools");
  assert.deepEqual(seen.extraObjects, ["object", "object"]);
  assert.equal(seen.refTarget, "function");
  const scripts = await inPanel(`chrome.scripting.getRegisteredContentScripts({ ids: ["extras-styles"] })`);
  assert.equal(scripts.length, 1);
  assert.deepEqual(scripts[0].js, ["extras-styles.cs.js"]);
  assert.equal(scripts[0].runAt, "document_start");
  assert.equal(scripts[0].persistAcrossSessions, true);
  assert.deepEqual(scripts[0].matches, ["http://*/*", "https://*/*"]);
  // The content script ran on the fixture (nothing saved yet → no element; its global is in the ISOLATED world, not the page's).
  assert.deepEqual(await agentStyle(), { present: false, inHead: false, last: false, text: "" });
  assert.equal(await inPage("typeof AgentSiteStyles"), "undefined", "the page's own world does not see the content script");
});

// ── Styles ─────────────────────────────────────────────────────────────────

test("browser_style_inspect: a ref from browser_read_page and a selector give the element's identity, box, type, background and matched rules", { skip }, async () => {
  const snap = await ok("browser_read_page", {});
  const cta = refOf(snap, /link "Call to action"/);
  const byRef = await ok("browser_style_inspect", { ref: cta });
  assert.match(byRef, /^<a#cta\.cta> "Call to action" — selector: #cta\n/);
  assert.match(byRef, /\nBox: \d+×\d+ px at \(\d+, \d+\); margin 0 0 0 0; padding 8 16 8 16; border none; radius 4\n/);
  assert.match(byRef, /\nType: Georgia, serif 16px \/ normal, weight 400, color rgb\(255, 255, 255\) \(#ffffff\)\n/);
  assert.match(byRef, /\nBackground: rgb\(194, 65, 12\) \(#c2410c\)\n/);
  assert.match(byRef, /\nLayout: display inline-block, position static\n/);
  assert.match(byRef, /\nMatched rules \(1, from 1 stylesheet\):\n  a\.cta  \(inline <style>, \d+ declarations\)\n/);
  assert.match(byRef, /An override for it starts with: #cta \{ … \}/);

  const h1 = await ok("browser_style_inspect", { selector: "main h1" });
  assert.match(h1, /^<h1#title> "Palette Fixture" — selector: #title\n/);
  assert.match(h1, /\nType: Arial, sans-serif 32px \/ normal, weight 700, color rgb\(17, 34, 51\) \(#112233\)\n/);
  assert.match(h1, /\nBackground: rgba\(0, 0, 0, 0\) \(transparent\)\n/);
  assert.match(h1, /\nLayout: display block, position static\n/);
  assert.match(h1, /\n  h1  \(inline <style>, 3 declarations\)\n/);

  await assert.rejects(Promise.reject(new Error(await fails("browser_style_inspect", { selector: "h9" }))), /No element matches "h9" on this page/);
  await assert.rejects(Promise.reject(new Error(await fails("browser_style_inspect", { selector: "h1[" }))), /is not a valid CSS selector/);
  await assert.rejects(Promise.reject(new Error(await fails("browser_style_inspect", { ref: 999 }))), /No element \[999\] — call browser_read_page first/);
});

test("browser_style_apply: a rule is applied at once as the last <style> in <head>, saved for the host, survives a reload through the content script alone, stays last when the page adds styles, and browser_style_remove undoes it", { skip }, async () => {
  assert.equal(await computed("title", "color"), "rgb(17, 34, 51)");
  // Broken CSS is refused with the parser's reason and nothing is saved.
  assert.match(await fails("browser_style_apply", { name: "bad", css: "h1 { color: rgb(1, 2, 3) " }), /The CSS was refused: Missing '}' — 1 block is not closed\. Nothing was saved\./);
  assert.match(await fails("browser_style_apply", { name: "bad", css: "h1 { color: }" }), /'color:' was dropped by the parser — unknown property or invalid value/);
  assert.match(await fails("browser_style_apply", { name: "bad", css: "h1 { colour: red }" }), /'colour: red' was dropped by the parser/);
  assert.match(await fails("browser_style_apply", { name: "bad", css: "@import url(x.css);" }), /@import is not allowed/);
  assert.deepEqual(await stored(), {});

  const out = await ok("browser_style_apply", { name: "test heading", css: "h1 { color: rgb(1, 2, 3) }" });
  assert.match(out, /^Saved override 'test heading' for localhost \(26 B, 1 rule\)\. Applied in the current tab; the site keeps it on every visit until it is removed/);
  assert.equal(await computed("title", "color"), "rgb(1, 2, 3)", "the page shows the override");
  let st = await agentStyle();
  assert.deepEqual([st.present, st.inHead, st.last], [true, true, true]);
  assert.equal(st.text, "/* localhost · test heading */\nh1 { color: rgb(1, 2, 3) }");
  const saved = await stored();
  assert.deepEqual(Object.keys(saved), ["localhost"]);
  assert.equal(saved.localhost["test heading"].css, "h1 { color: rgb(1, 2, 3) }");
  assert.equal(saved.localhost["test heading"].enabled, true);

  // The page adds a stylesheet later: the content script keeps ours last, so the override still wins.
  await inPage(`document.head.appendChild(Object.assign(document.createElement("style"), { textContent: "h1 { color: rgb(9, 9, 9) }" })), true`);
  await waitUntil(async () => (await agentStyle()).last, 5000, "the agent's style back at the end of <head>");
  assert.equal(await computed("title", "color"), "rgb(1, 2, 3)", "a later site stylesheet of equal specificity does not beat the override");

  // Reload: the panel does nothing — the content script restores it at document_start.
  await reload();
  assert.equal(await computed("title", "color"), "rgb(1, 2, 3)", "still applied after a reload");
  st = await agentStyle();
  assert.deepEqual([st.present, st.inHead, st.last], [true, true, true], "restored by the content script");

  // Pause from the tools: the page updates at once; resume brings it back.
  assert.match(await ok("browser_style_remove", { name: "test heading", enabled: false }), /^Paused override 'test heading' on localhost/);
  assert.equal(await computed("title", "color"), "rgb(17, 34, 51)");
  assert.match(await ok("browser_style_list", {}), /localhost \(1\):\n  - test heading — 26 B, paused, saved just now\n      h1 \{ color: rgb\(1, 2, 3\) \}/);
  await ok("browser_style_remove", { name: "test heading", enabled: true });
  assert.equal(await computed("title", "color"), "rgb(1, 2, 3)");

  // Remove: gone from the page, from storage, and still gone after a reload.
  assert.equal(await ok("browser_style_remove", { name: "test heading" }), "Removed override 'test heading' from localhost (none left there). The current tab is updated.");
  assert.equal(await computed("title", "color"), "rgb(17, 34, 51)");
  assert.equal((await agentStyle()).present, false);
  assert.deepEqual(await stored(), {});
  await reload();
  assert.equal(await computed("title", "color"), "rgb(17, 34, 51)");
  assert.equal((await agentStyle()).present, false);
  assert.equal(await ok("browser_style_list", {}), "No style overrides saved yet. browser_style_apply adds one for the current site (the site keeps it until it is removed).");
});

// ── Palette ────────────────────────────────────────────────────────────────

test("browser_palette_extract reports the fixture's colours, fonts, type scale, spacing, theme-color and :root variables; as=css gives the variables", { skip }, async () => {
  const report = await ok("browser_palette_extract", {});
  assert.match(report, /^Palette of localhost \(\d+ of \d+ elements sampled\):\n/);
  assert.match(report, /\nText colours:\n  #222222  ×2  \(#good, #cardp\)\n/, "the body text colour, used by the two paragraphs with ids");
  assert.match(report, /  #112233  ×1  \(#title\)/);
  assert.match(report, /  #999999  ×1  \(#low\)/);
  assert.match(report, /\nBackgrounds:\n  #ffffff  ×1  \(body\)\n/);
  assert.match(report, /  #f4f4f4  ×1  \(div\.card\)/);
  assert.match(report, /  #c2410c  ×1\n/, "the call to action's background counts, but a link is not a surface to map");
  assert.match(report, /\nBorders:\n  #dddddd  ×1/);
  assert.match(report, /\nFonts:\n  Georgia — 4 text elements; 16px\/400 ×4/);
  assert.match(report, /  Arial — \d+ text elements?; .*32px\/700 ×1/);
  assert.match(report, /  Type scale: .*16, 32 px/);
  assert.match(report, /\nSpacing \(margins\/paddings rounded to 4px\): .*16px ×\d+/);
  assert.match(report, /\nBody: #ffffff background, #222222 text; links #ffffff; buttons #000000 on #efefef; theme-color #c2410c\n/);
  assert.match(report, /\nCSS variables on :root: --brand: #c2410c, --bg: #ffffff$/m, "--gap is not a colour");
  assert.match(report, /\n\nAs CSS variables:\n:root \{\n  --c1: #222222; \/\* text, ×2 \*\//);
  const css = await ok("browser_palette_extract", { as: "css" });
  assert.match(css, /^:root \{\n  --c1: #222222;/);
  assert.match(css, /  --theme-color: #c2410c;\n  --font-1: Georgia, serif;\n  --font-2: Arial, sans-serif;\n/);
  const json = JSON.parse(await ok("browser_palette_extract", { as: "json" }));
  assert.equal(json.themeColor, "#c2410c");
  assert.deepEqual(json.vars.map((v) => v.name), ["--brand", "--bg"]);
  assert.deepEqual(json.fonts.slice(0, 2).map((f) => f.family), ["Georgia", "Arial"]);
});

test("browser_palette_contrast flags the low-contrast paragraph with its ratio, colours and selector, and not the readable one", { skip }, async () => {
  const out = await ok("browser_palette_contrast", {});
  assert.match(out, /^Contrast on localhost \(WCAG 2 AA; \d+ text styles across \d+ text elements\): 1 fail, \d+ pass/);
  assert.match(out, /\n  1\. 2\.85:1 \(needs 4\.5\)  #999999 on #ffffff, 16px\/400 — #low  "Low-contrast fine print nobody can read\."\n/);
  assert.doesNotMatch(out, /Readable paragraph/);
  assert.doesNotMatch(out, /Palette Fixture/);
  assert.match(out, /Fix: a browser_style_apply rule on the selector, e\.g\. `#low \{ color: #[0-9a-f]{6}; \}`/);
  // The suggested fix passes once applied.
  const fix = /`#low \{ color: (#[0-9a-f]{6}); \}`/.exec(out)[1];
  await ok("browser_style_apply", { name: "fine print contrast", css: "#low { color: " + fix + " }" });
  assert.match(await ok("browser_palette_contrast", {}), /every style passes AA/);
  assert.match(await ok("browser_palette_contrast", { level: "AAA", selector: "main" }), /WCAG 2 AAA/);
  await ok("browser_style_remove", { name: "fine print contrast" });
  assert.equal(await computed("low", "color"), "rgb(153, 153, 153)");
});

test("browser_palette_theme dark: body goes dark, images are untouched, the theme persists across a reload, shows up as a style override, and mode=off removes it", { skip }, async () => {
  assert.equal(await computed("pic", "filter"), "none");
  const out = await ok("browser_palette_theme", { mode: "dark" });
  assert.match(out, /^Saved the dark theme as override 'theme:dark' for localhost \(\d\.\d KB\); applied in the current tab\. The site keeps it until browser_style_remove or mode=off\.\nMapping:\n  page: #ffffff \/ #222222 → #121212 \/ #e6e6e6\n/);
  assert.match(out, /\n  variable --bg: #ffffff → #121212\n/);
  assert.match(out, /\n  background: #f4f4f4 → #[0-9a-f]{6}  \(div\.card\)\n/);
  assert.match(out, /\n  text: #112233 → #[0-9a-f]{6}  \(#title\)\n/);
  const dark = async () => {
    const bg = await inPage(`getComputedStyle(document.body).backgroundColor`);
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    return { bg, lum: (r + g + b) / 3 };
  };
  let d = await dark();
  assert.equal(d.bg, "rgb(18, 18, 18)", "body background is the dark surface");
  assert.equal(await inPage(`getComputedStyle(document.body).color`), "rgb(230, 230, 230)");
  assert.equal(await inPage(`getComputedStyle(document.documentElement).colorScheme`), "dark");
  assert.equal(await computed("pic", "filter"), "none", "no invert filter on images");
  assert.equal(await computed("cta", "background-color"), "rgb(194, 65, 12)", "the saturated brand background of the call to action is kept");
  const cardBg = await inPage(`getComputedStyle(document.querySelector(".card")).backgroundColor`);
  assert.ok(cardBg.match(/\d+/g).map(Number).every((v) => v < 60), `the card went dark: ${cardBg}`);
  const titleColor = await computed("title", "color");
  assert.notEqual(titleColor, "rgb(17, 34, 51)");
  assert.ok(titleColor.match(/\d+/g).map(Number).reduce((a, b) => a + b, 0) / 3 > 100, `the heading went light: ${titleColor}`);
  const saved = await stored();
  assert.deepEqual(Object.keys(saved.localhost), ["theme:dark"]);
  assert.match(await ok("browser_style_list", { site: "localhost" }), /^localhost \(1\):\n  - theme:dark — \d\.\d KB, on, saved just now/);

  // Persists with the panel idle: the content script restores it on reload.
  await reload();
  d = await dark();
  assert.equal(d.bg, "rgb(18, 18, 18)", "still dark after a reload");
  assert.equal(await computed("pic", "filter"), "none");

  // Preview of another theme does not save; sepia replaces dark; off removes the theme and the page is light again.
  await ok("browser_palette_theme", { mode: "sepia", preview: true });
  assert.equal(await inPage(`getComputedStyle(document.body).backgroundColor`), "rgb(244, 236, 216)", "the preview shows");
  assert.deepEqual(Object.keys((await stored()).localhost), ["theme:dark"], "a preview saves nothing");
  assert.match(await ok("browser_palette_theme", { mode: "sepia" }), /^Saved the sepia theme as override 'theme:sepia' for localhost \(\d\.\d KB\), replacing theme:dark/);
  assert.deepEqual(Object.keys((await stored()).localhost), ["theme:sepia"]);
  assert.equal(await inPage(`document.querySelector("style[data-agent-styles-preview]")`), null, "the preview element is cleared when a theme is saved");
  assert.equal(await ok("browser_palette_theme", { mode: "off" }), "Removed the theme of localhost (theme:sepia); the current tab is back to the site's own colours.");
  assert.equal(await inPage(`getComputedStyle(document.body).backgroundColor`), "rgb(255, 255, 255)");
  assert.equal(await computed("title", "color"), "rgb(17, 34, 51)");
  assert.deepEqual(await stored(), {});
  await reload();
  assert.equal(await inPage(`getComputedStyle(document.body).backgroundColor`), "rgb(255, 255, 255)");
});

// ── The 🧩 panel's tabs, rendered for real ────────────────────────────────

test("the 🎨 Styles and 🧪 Palette tabs render in the 🧩 panel: overrides with their buttons, swatches from the page, the theme buttons", { skip }, async () => {
  await ok("browser_style_apply", { name: "wider article", css: "main { max-width: 60ch }" });
  await inPanel(`AgentAutomationsPanel.show("styles"), true`);
  const styles = await waitUntil(() => inPanel(`(() => { const t = document.querySelector("#automations-panel .cmd-list").innerText; return /wider article/.test(t) ? t : ""; })()`), 10000, "the Styles tab");
  for (const n of ["New override", "localhost", "wider article", "main { max-width: 60ch }", "24 B · on · just now", "🧹 Reset this site"]) assert.ok(styles.includes(n), `${n} in the tab`);
  const titles = await inPanel(`[...document.querySelectorAll("#automations-panel .cmd-list .prof-btn")].map((b) => b.title)`);
  for (const t of ["Pause", "Edit", "Delete"]) assert.ok(titles.includes(t), `${t} button`);
  // Pause from the panel reaches the page.
  await inPanel(`[...document.querySelectorAll("#automations-panel .prof-btn")].find((b) => b.title === "Pause").click(), true`);
  await waitUntil(() => inPage(`getComputedStyle(document.querySelector("main")).maxWidth === "720px"`), 5000, "the override paused in the page");
  const status = await waitUntil(() => inPanel(`document.querySelector("#automations-panel .prof-status").textContent`), 5000, "a status line");
  assert.equal(status, "Paused 'wider article'.");

  await inPanel(`AgentAutomationsPanel.show("palette"), true`);
  const pal = await waitUntil(() => inPanel(`(() => { const t = document.querySelector("#automations-panel .cmd-list").innerText; return /Palette of localhost/.test(t) ? t : ""; })()`), 10000, "the Palette tab");
  // Group titles are rendered upper-case by the panel's CSS, so compare case-insensitively.
  for (const n of ["🎨 Extract", "🔍 Check contrast", "📋 Copy as CSS variables", "Theme for localhost", "🌙 Dark", "📜 Sepia", "◐ High contrast", "✕ Off"]) assert.ok(pal.toLowerCase().includes(n.toLowerCase()), `${n} in the tab`);
  await inPanel(`[...document.querySelectorAll("#automations-panel .prof-btn")].find((b) => b.textContent === "🎨 Extract").click(), true`);
  const swatches = await waitUntil(() => inPanel(`(() => { const s = [...document.querySelectorAll("#automations-panel .pal-swatch")].map((n) => n.style.backgroundColor); return s.length ? s : null; })()`), 10000, "swatches");
  for (const c of ["rgb(34, 34, 34)", "rgb(17, 34, 51)", "rgb(153, 153, 153)", "rgb(255, 255, 255)", "rgb(244, 244, 244)", "rgb(194, 65, 12)", "rgb(221, 221, 221)"]) assert.ok(swatches.includes(c), `${c} swatch`);
  const text = await inPanel(`document.querySelector("#automations-panel .cmd-list").innerText`);
  assert.match(text, /Text colours/i);
  assert.match(text, /#222222 ×2\n#good, #cardp/);
  assert.match(text, /Georgia/);
  assert.match(text, /Type scale: /);
  assert.match(text, /theme-color #c2410c/);
  await inPanel(`[...document.querySelectorAll("#automations-panel .prof-btn")].find((b) => b.textContent === "🔍 Check contrast").click(), true`);
  const contrast = await waitUntil(() => inPanel(`(() => { const t = document.querySelector("#automations-panel .cmd-list").innerText; return /Contrast \\(WCAG 2 AA\\)/i.test(t) ? t : ""; })()`), 10000, "the contrast list");
  assert.match(contrast, /Contrast \(WCAG 2 AA\): 1 failing style/i);
  assert.match(contrast, /2\.85:1 \(needs 4\.5\) · 16px\/400 · #low/);
  // The theme buttons go through the same storage; the Styles tab lists the theme.
  await inPanel(`[...document.querySelectorAll("#automations-panel .prof-btn")].find((b) => b.textContent === "🌙 Dark").click(), true`);
  await waitUntil(() => inPage(`getComputedStyle(document.body).backgroundColor === "rgb(18, 18, 18)"`), 10000, "the dark theme from the panel");
  assert.deepEqual(Object.keys((await stored()).localhost).sort(), ["theme:dark", "wider article"]);
  await inPanel(`AgentAutomationsPanel.show("styles"), true`);
  const again = await waitUntil(() => inPanel(`(() => { const t = document.querySelector("#automations-panel .cmd-list").innerText; return /theme:dark/.test(t) ? t : ""; })()`), 10000, "the theme in the Styles tab");
  assert.match(again, /theme:dark/);
  await inPanel(`AgentAutomationsPanel.hide(), true`);
  await ok("browser_style_remove", { all: true });
  assert.deepEqual(await stored(), {});
  assert.equal(await inPage(`getComputedStyle(document.body).backgroundColor`), "rgb(255, 255, 255)");
  assert.deepEqual(panelErrors, [], "no uncaught errors in the panel");
});
