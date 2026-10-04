// End-to-end test of every browser tool against a real Chromium.
//
// The unpacked extension (dist-browser/extension) is loaded into headless
// Chromium; its side panel page is opened as a background tab in the same
// window as a fixture page (so "current window / active tab" means the same
// thing it does for the real side panel), and each tool is invoked exactly the
// way shim.js / the built-in agent do it: window.AgentBrowserTools.run(name, args).
// Results are checked against the page itself through a separate CDP session,
// not only against the tool's own report.
//
// Run: npm run test:e2e   (builds first; set CHROME_PATH if Chromium isn't found)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, extensionIdFromKey, findChromium } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const EXT_DIR = join(root, "dist-browser", "extension");
const skip = !findChromium()
  ? "no Chromium found (set CHROME_PATH)"
  : !existsSync(join(EXT_DIR, "manifest.json"))
    ? "extension not built (npm run build && npm run build:browser)"
    : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fixture server ─────────────────────────────────────────────────────────
// Pages are served on http://localhost:PORT; the iframe comes from
// http://127.0.0.1:PORT so it is cross-origin (and an out-of-process frame).

const SAMPLE_TEXT = "test resource content — ".repeat(4);
const uaLog = []; // User-Agent (and client-hint platform) header of every page request
const watchState = { price: "€ 20" }; // what /watch.html shows (the watcher test changes it)
let server, PORT, BASE, FRAME_ORIGIN;

function fixture(name) {
  return readFileSync(join(here, "fixtures", name), "utf8")
    .replace("{{FRAME_ORIGIN}}", FRAME_ORIGIN)
    .replace("{{PAYLOAD}}", Buffer.from(SAMPLE_TEXT).toString("base64"));
}

function startServer() {
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    uaLog.push({ path: url.pathname, ua: req.headers["user-agent"] || "", chPlatform: req.headers["sec-ch-ua-platform"] || "", chUa: req.headers["sec-ch-ua"] || "" });
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    if (url.pathname === "/" || url.pathname === "/main.html") {
      // ?extra=1: an extra control first in the document, so every ref number differs from a plain load.
      const extra = url.searchParams.has("extra") ? '<button id="extra0">Extra one</button> <a href="/page2.html">Extra two</a>\n' : "";
      return html(fixture("main.html").replace("<h1>", extra + "<h1>"));
    }
    if (url.pathname === "/page2.html") return html(fixture("page2.html"));
    if (url.pathname === "/device.html") {
      // The first script of the document records what it sees — only an override in place before any page script can change it.
      return html(`<!doctype html><html><head><meta charset="utf-8"><title>Device</title><script>window.__early = { threads: navigator.hardwareConcurrency, ua: navigator.userAgent, lang: navigator.language, width: screen.width, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };</script></head><body><p id="d">device page</p></body></html>`);
    }
    if (url.pathname === "/api/items") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ items: [{ id: 1, name: "lamp" }, { id: 2, name: "chair" }, { id: 3, name: "desk" }], query: url.searchParams.get("q") }));
    }
    if (url.pathname === "/watch.html") {
      return html(`<!doctype html><title>Watch</title><p id="price">${watchState.price}</p><p id="noise">Served at ${Date.now()}</p>`);
    }
    if (url.pathname === "/frame.html") return html(fixture("frame.html"));
    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      return html(`<!doctype html><title>Search</title><p id="r">Results for ${q.replace(/[<&]/g, "")}</p>`);
    }
    if (url.pathname === "/file.txt") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="file.txt"' });
      return res.end("downloaded file body");
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () => {
      PORT = server.address().port;
      BASE = `http://localhost:${PORT}`;
      FRAME_ORIGIN = `http://127.0.0.1:${PORT}`;
      r();
    })
  );
}

// ── Browser + panel harness ────────────────────────────────────────────────

let browser, cdp, extId, panel, workDir, downloadDir;
let mainTarget, mainTabId, panelTabId;
const pageSessions = new Map(); // targetId -> sessionId
const panelErrors = []; // uncaught exceptions / unhandled rejections in the panel
const exercised = new Set();

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
function inPanel(expr, timeout = 60000) {
  return Promise.race([
    cdp.evaluate(panel, expr),
    sleep(timeout).then(() => {
      throw new Error(`panel evaluation timed out: ${expr.slice(0, 80)}`);
    }),
  ]);
}

/** Call a tool like shim.js does. → { ok, text, content, error } */
async function call(name, args = {}, timeout = 60000) {
  exercised.add(name);
  const r = await inPanel(
    `AgentBrowserTools.run(${JSON.stringify(name)}, ${JSON.stringify(args)}).then(
      (c) => ({ ok: true, content: c }),
      (e) => ({ ok: false, error: String((e && e.message) || e) }))`,
    timeout
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

/** Evaluate in a page target (the oracle — independent of the tools). */
async function inPage(targetId, expr) {
  let s = pageSessions.get(targetId);
  if (!s) {
    s = await cdp.attach(targetId);
    pageSessions.set(targetId, s);
  }
  return cdp.evaluate(s, expr);
}
const inMain = (expr) => inPage(mainTarget, expr);

/** Ref number of the first read_page line matching `re`. */
function refOf(snapshot, re) {
  const line = snapshot.split("\n").find((l) => /^\[\d+\]/.test(l) && re.test(l));
  assert.ok(line, `no element matching ${re} in snapshot:\n${snapshot.slice(0, 3000)}`);
  return Number(/^\[(\d+)\]/.exec(line)[1]);
}

/** Put the main tab back on a fresh main.html and make it the agent's tab. */
async function resetMain(path = "/main.html") {
  await inPanel(
    `chrome.tabs.update(${mainTabId}, { url: ${JSON.stringify(BASE + path)}, active: true }).then(() => true)`
  );
  await waitUntil(
    () => inPanel(`chrome.tabs.get(${mainTabId}).then((t) => t.status === "complete" && t.url.includes(${JSON.stringify(path)}))`),
    15000,
    "main tab load"
  );
  await ok("browser_switch_tab", { tabId: mainTabId });
}

async function read() {
  return ok("browser_read_page", {});
}

function downloaded(name) {
  return waitUntil(
    () => {
      const f = readdirSync(downloadDir).find((n) => n === name);
      if (!f) return false;
      const p = join(downloadDir, f);
      return statSync(p).size > 0 ? p : false;
    },
    15000,
    `download ${name}`
  );
}

// Tiny 2x2 PNG (red) for the image converter.
const PNG_2x2 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII=";

before(async () => {
  if (skip) return;
  await startServer();
  workDir = mkdtempSync(join(tmpdir(), "agent-browser-e2e-"));
  downloadDir = join(workDir, "downloads");
  browser = await launch({ extensionDir: EXT_DIR, userDataDir: join(workDir, "profile"), downloadDir });
  cdp = browser.cdp;
  extId = extensionIdFromKey(JSON.parse(readFileSync(join(EXT_DIR, "manifest.json"), "utf8")).key);

  // "Allow in Incognito" (needed by the private-window / profile tools), the
  // same switch a user flips at chrome://extensions. It reloads the extension.
  const { targetId: extPage } = await cdp.send("Target.createTarget", { url: "chrome://extensions" });
  const s = await cdp.attach(extPage);
  await waitUntil(() => cdp.evaluate(s, "!!(window.chrome && chrome.developerPrivate)"), 10000, "chrome://extensions");
  // Without developer mode the reload disables a --load-extension extension.
  await cdp.evaluate(s, "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })");
  await cdp.evaluate(s, `chrome.developerPrivate.updateExtensionConfiguration({ extensionId: "${extId}", incognitoAccess: true })`);
  await waitUntil(
    () => cdp.evaluate(s, `chrome.developerPrivate.getExtensionInfo("${extId}").then((i) => i.state === "ENABLED" && i.incognitoAccess.isActive)`),
    10000,
    "extension re-enabled with incognito access"
  );
  await cdp.send("Target.closeTarget", { targetId: extPage });

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
  await waitUntil(() => cdp.evaluate(panel, "typeof AgentBrowserTools === 'object' && typeof AgentConverter === 'object'"), 10000, "panel scripts");

  ({ targetId: mainTarget } = await cdp.send("Target.createTarget", { url: `${BASE}/main.html` }));
  await waitUntil(() => inMain("document.readyState === 'complete'"), 10000, "main page");
  mainTabId = await inPanel(`chrome.tabs.query({ url: "${BASE}/*" }).then((t) => t[0].id)`);
  panelTabId = await inPanel(`chrome.tabs.getCurrent().then((t) => t.id)`);
  await ok("browser_switch_tab", { tabId: mainTabId });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ── Reading ────────────────────────────────────────────────────────────────

test("browser_read_page: outline, refs, form state, shadow DOM, cross-origin iframe, page text", { skip }, async () => {
  await resetMain();
  await inMain(`document.getElementById("pw").value = "hunter2"`);
  const s = await read();
  assert.match(s, new RegExp(`^URL: ${BASE}/main.html`));
  assert.match(s, /Title: Fixture Main/);
  assert.match(s, /Outline:\n# Fixture Main/);
  assert.match(s, /\] button "Increment"/);
  assert.match(s, /\] input:text "Search query" placeholder="Type here"/);
  assert.match(s, /\] select "Color" selected="Red" options: Red \| Green \| Blue/);
  assert.match(s, /\] input:password "Password" value=\(hidden\)/);
  assert.doesNotMatch(s, /hunter2/, "password value must never reach the model");
  assert.match(s, /\] input:checkbox "Agree" unchecked/);
  assert.match(s, /\] file input "Attachment"/);
  assert.match(s, /\] editable "Rich editor"/);
  assert.match(s, /\] link "Go to page two" → \/page2\.html/);
  assert.match(s, /\] button "Shadow button"/, "open shadow roots are walked");
  assert.match(s, /\] button "Frame button" ⧉ frame 127\.0\.0\.1/, "cross-origin iframe elements are listed");
  assert.match(s, /--- iframe 127\.0\.0\.1:\d+ ---\nFrame button Frame clicks: 0/);
  assert.match(s, /Page text:\nFixture Main\n\nidle/);
  assert.doesNotMatch(s, /Secret item/, "hover-only menu is hidden until hovered");
});

test("browser_read_page: maxChars budgets the page text", { skip }, async () => {
  const s = await ok("browser_read_page", { maxChars: 500 });
  assert.match(s, /… \(truncated — scroll or use browser_find\)/);
});

test("browser_find: elements and text across shadow DOM and frames", { skip }, async () => {
  const hit = await ok("browser_find", { query: "shadow button" });
  assert.match(hit, /Matching elements:\n\[\d+\] button "Shadow button"/);
  const frame = await ok("browser_find", { query: "frame clicks" });
  assert.match(frame, /Matching page text:\nFrame button Frame clicks: 0/);
  const none = await ok("browser_find", { query: "zzz-no-such-text" });
  assert.match(none, /^Nothing on the page matches/);
  assert.match(await fails("browser_find", { query: "" }), /query is required/);
});

test("browser_screenshot: JPEG of the visible tab + caption", { skip }, async () => {
  const r = await call("browser_screenshot", {});
  assert.ok(r.ok, r.error);
  const [img, caption] = r.content;
  assert.equal(img.type, "image");
  assert.equal(img.mimeType, "image/jpeg");
  const bytes = Buffer.from(img.data, "base64");
  assert.equal(bytes.readUInt16BE(0), 0xffd8, "JPEG magic");
  assert.ok(bytes.length > 2000, "not an empty image");
  assert.match(caption.text, new RegExp(`Fixture Main — ${BASE}/main.html`));
});

test("browser_tabs: lists the window's tabs and stars the current one", { skip }, async () => {
  const t = await ok("browser_tabs", {});
  assert.match(t, new RegExp(`^\\* ${mainTabId}  Fixture Main — ${BASE}/main.html$`, "m"));
  assert.match(t, new RegExp(`^  ${panelTabId}  `, "m"));
});

test("browser_extract_table: rows and cells", { skip }, async () => {
  const t = await ok("browser_extract_table", {});
  assert.equal(t, "Table (3 rows):\nName | Age\nAnn | 31\nBob | 42");
  assert.equal(await ok("browser_extract_table", { selector: "#t" }), t);
  assert.match(await fails("browser_extract_table", { selector: "#nope" }), /No table found matching #nope/);
});

// ── Clicking ───────────────────────────────────────────────────────────────

test("browser_click: plain button changes the page", { skip }, async () => {
  await resetMain();
  const s = await read();
  const out = await ok("browser_click", { ref: refOf(s, /button "Increment"/) });
  assert.match(out, /^Clicked \[\d+\]\. Now at: Fixture Main/);
  assert.equal(await inMain("count.textContent"), "1");
});

test("browser_click: covered element is refused, force=true clicks through", { skip }, async () => {
  const s = await read();
  const ref = refOf(s, /button "Covered button"/);
  assert.match(await fails("browser_click", { ref }), /is covered by div#overlay "overlay"/);
  assert.equal(await inMain("coveredstatus.textContent"), "");
  await ok("browser_click", { ref, force: true });
  assert.equal(await inMain("coveredstatus.textContent"), "covered-clicked");
});

test("browser_click: double=true fires dblclick", { skip }, async () => {
  const s = await read();
  await ok("browser_click", { ref: refOf(s, /button "Double me"/), double: true });
  assert.equal(await inMain("dblstatus.textContent"), "double-clicked");
});

test("browser_click: button inside a shadow root", { skip }, async () => {
  const s = await read();
  const out = await ok("browser_click", { ref: refOf(s, /button "Shadow button"/) });
  assert.doesNotMatch(out, /no visible reaction/);
  assert.equal(await inMain(`document.querySelector("shadow-box").shadowRoot.getElementById("sc").textContent`), "1");
});

test("browser_click: button inside a cross-origin iframe", { skip }, async () => {
  const s = await read();
  await ok("browser_click", { ref: refOf(s, /button "Frame button" ⧉ frame/) });
  assert.match(await read(), /--- iframe 127\.0\.0\.1:\d+ ---\nFrame button Frame clicks: 1/);
});

test("browser_click: refs from a replaced document are reported stale", { skip }, async () => {
  await resetMain();
  const s = await read();
  await resetMain("/page2.html");
  assert.match(await fails("browser_click", { ref: refOf(s, /button "Increment"/) }), /That element is gone — the page changed/);
  assert.match(await fails("browser_click", { ref: 9999 }), /No element \[9999\]/);
});

// Regression: pageClick's injected promise settles ~510 ms after the click, so
// when the navigation commits first, its executeScript never settles; act()
// now races the call against a navigation signal and returns instead of hanging
// to the host's 60 s tool timeout.
test("browser_click: a link that navigates quickly returns", { skip }, async () => {
  await resetMain();
  const s = await read();
  const r = await call("browser_click", { ref: refOf(s, /link "Go to page two"/) }, 15000).catch(() => null);
  assert.equal(await inMain("document.title"), "Page Two", "the click itself worked");
  assert.ok(r, "browser_click did not return within 15 s");
  assert.match(r.text, /page changed.*Now at: Page Two/s);
});

// Regression: the synthetic el.click() opens the tab, but target=_blank implies
// noopener so it carries no openerTabId; browser_click now spots the new tab by
// diffing tab ids before the real-mouse retry, so it opens exactly once and
// follows it.
test("browser_click: target=_blank opens one tab and follows it", { skip }, async () => {
  await resetMain();
  const s = await read();
  const countBlank = () => inPanel(`chrome.tabs.query({ url: "${BASE}/page2.html?blank=1" }).then((t) => t.map((x) => x.id))`);
  try {
    const out = await ok("browser_click", { ref: refOf(s, /link "Open in new tab"/) });
    assert.equal((await countBlank()).length, 1, "exactly one new tab");
    assert.match(out, /opened a new tab, now working there\. Now at: Page Two — .*blank=1/);
  } finally {
    await inPanel(`chrome.tabs.remove(${JSON.stringify(await countBlank())}).then(() => true)`);
  }
});

// ── Typing & forms ─────────────────────────────────────────────────────────

test("browser_type: replace, append, textarea, contenteditable, password", { skip }, async () => {
  await resetMain();
  const s = await read();
  const q = refOf(s, /"Search query"/);
  assert.equal(await ok("browser_type", { ref: q, text: "hello" }), `Typed into [${q}].`);
  assert.equal(await inMain("q.value"), "hello");
  await ok("browser_type", { ref: q, text: " world", clear: false });
  assert.equal(await inMain("q.value"), "hello world");
  await ok("browser_type", { ref: q, text: "replaced" });
  assert.equal(await inMain("q.value"), "replaced");

  await ok("browser_type", { ref: refOf(s, /textarea "Bio"/), text: "line one\nline two" });
  assert.equal(await inMain("bio.value"), "line one\nline two");

  await ok("browser_type", { ref: refOf(s, /editable "Rich editor"/), text: "rich text" });
  assert.equal(await inMain("editor.innerText.trim()"), "rich text");

  await ok("browser_type", { ref: refOf(s, /input:password/), text: "s3cret" });
  assert.equal(await inMain("pw.value"), "s3cret");
});

test("browser_type: wrong targets are refused", { skip }, async () => {
  const s = await read();
  assert.match(await fails("browser_type", { ref: refOf(s, /button "Increment"/), text: "x" }), /is not a text field/);
  assert.match(await fails("browser_type", { ref: refOf(s, /file input/), text: "x" }), /is a file input — use browser_upload_file/);
});

test("browser_type: submit=true submits the form", { skip }, async () => {
  const s = await read();
  const out = await ok("browser_type", { ref: refOf(s, /"Search query"/), text: "kittens", submit: true });
  assert.match(out, /and pressed Enter\. Now at: Search — .*\/search\?q=kittens/);
  assert.equal(await inMain("r.textContent"), "Results for kittens");
});

test("browser_select: by visible text and by value; bad option and non-select refused", { skip }, async () => {
  await resetMain();
  const s = await read();
  const color = refOf(s, /select "Color"/);
  assert.equal(await ok("browser_select", { ref: color, option: "Green" }), `Selected "Green" in [${color}].`);
  assert.equal(await inMain("color.value"), "g");
  await ok("browser_select", { ref: color, option: "b" });
  assert.equal(await inMain("color.value"), "b");
  assert.match(await fails("browser_select", { ref: color, option: "Purple" }), /No option matching "Purple" \(options: Red \| Green \| Blue\)/);
  assert.match(await fails("browser_select", { ref: refOf(s, /"Search query"/), option: "x" }), /is not a <select>/);
});

test("browser_fill_form: array and object forms; unknown refs reported", { skip }, async () => {
  await resetMain();
  const s = await read();
  const q = refOf(s, /"Search query"/);
  const email = refOf(s, /input:email/);
  const color = refOf(s, /select "Color"/);
  const agree = refOf(s, /input:checkbox "Agree"/);
  const out = await ok("browser_fill_form", {
    fields: [{ ref: q, value: "alpha" }, { ref: email, value: "a@b.co" }, { ref: color, value: "Green" }, { ref: agree, value: true }, { ref: 999, value: "x" }],
  });
  assert.equal(
    out,
    `Form fill results:\n[${q}]: ok\n[${email}]: ok\n[${color}]: selected "Green"\n[${agree}]: checked\n[999]: no such ref — call browser_read_page first`
  );
  assert.equal(await inMain("q.value"), "alpha");
  assert.equal(await inMain("email.value"), "a@b.co");
  assert.equal(await inMain("color.value + '|' + agree.checked"), "g|true");
  await ok("browser_fill_form", { fields: { [q]: "beta", [email]: "c@d.co", [color]: "b", [agree]: "no" } });
  assert.equal(await inMain("q.value + '|' + email.value + '|' + color.value + '|' + agree.checked"), "beta|c@d.co|b|false");
  assert.match(await ok("browser_fill_form", { fields: { [color]: "Purple" } }), /FAIL No option matching "Purple"/);
  assert.match(await fails("browser_fill_form", {}), /fields is required/);
});

test("browser_press_key: characters, Backspace, Enter submits, clipboard refused", { skip }, async () => {
  await resetMain();
  const s = await read();
  const q = refOf(s, /"Search query"/);
  await ok("browser_click", { ref: q });
  await ok("browser_press_key", { key: "a" });
  await ok("browser_press_key", { key: "b" });
  assert.equal(await inMain("q.value"), "ab");
  await ok("browser_press_key", { key: "Backspace" });
  assert.equal(await inMain("q.value"), "a");
  await ok("browser_press_key", { key: "Control+A" });
  await ok("browser_press_key", { key: "Delete" });
  assert.equal(await inMain("q.value"), "");
  assert.match(await fails("browser_press_key", { key: "Control+V" }), /Clipboard shortcuts/);
  assert.match(await fails("browser_press_key", { key: "F13" }), /Unsupported key: F13/);
  await ok("browser_type", { ref: q, text: "via-enter" });
  const out = await ok("browser_press_key", { key: "Enter" });
  assert.match(out, /^Pressed Enter\. Now at: Search/);
});

test("browser_upload_file: puts the bytes into a file input", { skip }, async () => {
  await resetMain();
  const s = await read();
  const up = refOf(s, /file input "Attachment"/);
  const out = await ok("browser_upload_file", { ref: up, name: "hello.txt", data: Buffer.from("hi there").toString("base64") });
  assert.equal(out, `Attached "hello.txt" to [${up}].`);
  const got = await waitUntil(() => inMain("window.__upload"), 3000, "change event");
  assert.deepEqual(got, { name: "hello.txt", type: "text/plain", size: 8, text: "hi there" });
  assert.match(
    await fails("browser_upload_file", { ref: refOf(s, /"Search query"/), name: "a.txt", data: "" }),
    /is not a file input/
  );
});

// ── Pointer ────────────────────────────────────────────────────────────────

test("browser_hover: real pointer opens a CSS :hover menu", { skip }, async () => {
  await resetMain();
  const s = await read();
  const out = await ok("browser_hover", { ref: refOf(s, /button "Menu"/) });
  assert.match(out, /^Hovering over \[\d+\]/);
  assert.equal(await inMain(`getComputedStyle(document.querySelector("#menu .sub")).display`), "block");
  assert.match(await read(), /link "Secret item"/);
});

test("browser_drag: onto a drop zone by text and by ref", { skip }, async () => {
  await resetMain();
  let s = await read();
  const out = await ok("browser_drag", { fromRef: refOf(s, /"Drag me"/), toText: "Drop zone" });
  assert.match(out, /Dragged \[\d+\] onto "Drop zone"/);
  assert.deepEqual(await inMain("window.__drops"), ["drop"]);
  s = await read();
  await ok("browser_drag", { fromRef: refOf(s, /"Drag me"/), toRef: refOf(s, /"Zone B"/) });
  assert.deepEqual(await inMain("window.__drops"), ["drop", "zone-b"]);
  assert.match(await fails("browser_drag", { fromRef: refOf(s, /"Drag me"/) }), /Give toRef, or toText/);
});

test("browser_scroll: down, bottom, top, element into view", { skip }, async () => {
  await resetMain();
  const down = await ok("browser_scroll", { direction: "down" });
  // Not an exact match: the "started debugging" bar coming and going resizes
  // the viewport, and scroll anchoring then nudges scrollY by a few pixels.
  assert.match(down, /^Scrolled — y=[1-9]\d* of \d+\.$/);
  assert.ok((await inMain("scrollY")) > 0, "scrolled down");
  await ok("browser_scroll", { direction: "bottom" });
  assert.equal(await inMain("Math.round(scrollY) === document.documentElement.scrollHeight - innerHeight"), true);
  await ok("browser_scroll", { direction: "up" });
  await ok("browser_scroll", { direction: "top" });
  assert.equal(await inMain("scrollY"), 0);
  const s = await read();
  await ok("browser_scroll", { ref: refOf(s, /button "Load later"/) });
  assert.equal(await inMain(`(() => { const r = later.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`), true);
});

// ── Waiting ────────────────────────────────────────────────────────────────

test("browser_wait: sleeps and reports the page", { skip }, async () => {
  await resetMain();
  const t0 = Date.now();
  assert.match(await ok("browser_wait", { seconds: 0.5 }), /^Now at: Fixture Main/);
  assert.ok(Date.now() - t0 >= 500);
});

test("browser_wait_for: text appears, text disappears, URL, timeout", { skip }, async () => {
  await resetMain();
  const s = await read();
  assert.match(await fails("browser_wait_for", {}), /Give text, textGone or urlContains/);
  await ok("browser_click", { ref: refOf(s, /button "Load later"/) });
  assert.match(await ok("browser_wait_for", { text: "Loaded later", timeoutSeconds: 5 }), /^Condition met\./);
  assert.match(await ok("browser_wait_for", { textGone: "Loading…", timeoutSeconds: 5 }), /^Condition met\./);
  assert.match(await ok("browser_wait_for", { urlContains: "main.html" }), /^Condition met\./);
  assert.match(await ok("browser_wait_for", { text: "Frame clicks" }), /^Condition met\./, "any frame counts");
  const t0 = Date.now();
  assert.match(await ok("browser_wait_for", { text: "never-appears", timeoutSeconds: 1 }), /^Timed out/);
  assert.ok(Date.now() - t0 < 4000);
});

// ── Navigation & tabs ──────────────────────────────────────────────────────

test("browser_navigate: url, back, forward, reload; non-web schemes refused", { skip }, async () => {
  await resetMain();
  assert.match(await ok("browser_navigate", { url: `${BASE}/page2.html` }), /^Now at: Page Two/);
  assert.match(await ok("browser_navigate", { action: "back" }), /^Now at: Fixture Main/);
  assert.match(await ok("browser_navigate", { action: "forward" }), /^Now at: Page Two/);
  await inMain("window.__marker = 1");
  assert.match(await ok("browser_navigate", { action: "reload" }), /^Now at: Page Two/);
  assert.equal(await inMain("window.__marker"), undefined, "page really reloaded");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", `chrome-extension://${extId}/options.html`, "data:text/html,hi"]) {
    assert.match(await fails("browser_navigate", { url }), /Only http\(s\) addresses can be opened/, url);
  }
  assert.match(await fails("browser_navigate", {}), /url is required/);
});

test("browser_new_tab / browser_switch_tab / browser_close_tab", { skip }, async () => {
  await resetMain();
  assert.match(await ok("browser_new_tab", { url: `${BASE}/page2.html` }), /^Now at: Page Two/);
  const tabs = await ok("browser_tabs", {});
  const newId = Number(/^\* (\d+)  Page Two/m.exec(tabs)[1]);
  assert.notEqual(newId, mainTabId);

  assert.match(await ok("browser_switch_tab", { tabId: mainTabId }), /^Now at: Fixture Main/);
  assert.match(await ok("browser_tabs", {}), new RegExp(`^\\* ${mainTabId} `, "m"));
  assert.match(await fails("browser_switch_tab", { tabId: panelTabId }), /extension's own page/);

  assert.match(await ok("browser_close_tab", { tabId: newId }), new RegExp(`^Closed tab ${newId}\\. Now at: Fixture Main`));
  assert.doesNotMatch(await ok("browser_tabs", {}), new RegExp(`${newId}  `));

  await ok("browser_new_tab", { url: `${BASE}/page2.html` });
  const out = await ok("browser_close_tab", {});
  assert.match(out, /^Closed tab \d+\. Now at: /, "closing the current tab falls back to the active one");
  assert.match(await fails("browser_new_tab", { url: "file:///etc/passwd" }), /Only http\(s\)/);
});

// ── JavaScript ─────────────────────────────────────────────────────────────

test("browser_run_js: values, promises, errors, page world", { skip }, async () => {
  await resetMain();
  assert.equal(await ok("browser_run_js", { code: "1 + 1" }), "2");
  assert.equal(await ok("browser_run_js", { code: "document.title" }), "Fixture Main");
  assert.equal(await ok("browser_run_js", { code: "Promise.resolve({ a: [1, 2] })" }), '{\n  "a": [\n    1,\n    2\n  ]\n}');
  assert.equal(await ok("browser_run_js", { code: "typeof loadLater" }), "function", "runs in the page's MAIN world");
  assert.match(await fails("browser_run_js", { code: "throw new Error('boom')" }), /boom/);
  assert.match(await fails("browser_run_js", { code: "Promise.reject(new Error('nope'))" }), /Rejected: nope/);
});

// ── Cookies ────────────────────────────────────────────────────────────────

test("browser_cookies_set / get / delete on the current page", { skip }, async () => {
  await resetMain();
  assert.match(await ok("browser_cookies_set", { name: "test", value: "hello123" }), /^Cookie set: test=hello123 on localhost$/);
  assert.match(await inMain("document.cookie"), /(^|; )test=hello123/);

  await ok("browser_cookies_set", { name: "secretish", value: "v", httpOnly: true, maxAgeSec: 3600 });
  assert.doesNotMatch(await inMain("document.cookie"), /secretish/, "httpOnly is really httpOnly");

  const all = await ok("browser_cookies_get", {});
  assert.match(all, /^Cookies \(\d+\):/);
  assert.match(all, /^test=hello123 \| domain=localhost \| path=\/.* \| session$/m);
  assert.match(all, /^secretish=v \| .*httpOnly.* \| expires=/m);
  const one = await ok("browser_cookies_get", { name: "test" });
  assert.match(one, /^Cookies \(1\):\ntest=hello123/);

  assert.equal(await ok("browser_cookies_delete", { name: "test" }), "Deleted cookie: test");
  assert.doesNotMatch(await inMain("document.cookie"), /test=/);
  assert.match(await ok("browser_cookies_get", { name: "test" }), /^No cookies found/);
});

test("browser_cookies_export / import round-trip", { skip }, async () => {
  await resetMain();
  await inMain(`document.cookie = "roundtrip=42; path=/"`);
  const exported = JSON.parse(await ok("browser_cookies_export", {}));
  const rt = exported.find((c) => c.name === "roundtrip");
  assert.deepEqual(
    { name: rt.name, value: rt.value, domain: rt.domain, path: rt.path },
    { name: "roundtrip", value: "42", domain: "localhost", path: "/" }
  );

  // The TESTING.md example: a cookie for another site entirely.
  assert.equal(
    await ok("browser_cookies_import", { cookies: [{ name: "imported", value: "yes", domain: ".example.com", path: "/" }] }),
    "Imported 1 of 1 cookies."
  );
  assert.match(await ok("browser_cookies_get", { url: "http://example.com/" }), /imported=yes \| domain=\.example\.com/);
  // String form is accepted too.
  await ok("browser_cookies_import", { cookies: JSON.stringify([{ name: "fromstring", value: "1", domain: "localhost", path: "/" }]) });
  assert.match(await inMain("document.cookie"), /fromstring=1/);
  assert.match(await fails("browser_cookies_import", {}), /cookies array is required/);
});

test("browser_cookies_clear: host-only cookies of the current page", { skip }, async () => {
  await resetMain();
  await inMain(`document.cookie = "c1=1; path=/"; document.cookie = "c2=2; path=/"`);
  assert.match(await ok("browser_cookies_clear", {}), /^Cleared \d+ cookies\.$/);
  assert.equal(await inMain("document.cookie"), "");
});

test("browser_cookies_clear: domain cookies (leading-dot domain)", { skip }, async () => {
  await ok("browser_cookies_import", { cookies: [{ name: "dom1", value: "a", domain: ".example.com", path: "/" }] });
  assert.match(await ok("browser_cookies_get", { url: "http://example.com/" }), /dom1=a/);
  await ok("browser_cookies_clear", { url: "http://example.com/" });
  assert.match(await ok("browser_cookies_get", { url: "http://example.com/" }), /^No cookies found/, "domain cookies must actually be removed");
});

// ── User-Agent ─────────────────────────────────────────────────────────────

const FAKE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AgentE2E/1.0";

test("browser_get_useragent / browser_set_useragent: page and request headers", { skip }, async () => {
  await resetMain();
  const before = await ok("browser_get_useragent", {});
  assert.match(before, /^User-Agent: Mozilla\/5\.0 .*\nPlatform: .*\nLanguage: .*\nLanguages: /);

  const out = await ok("browser_set_useragent", { userAgent: FAKE_UA, platform: "iPhone", language: "de-DE" });
  assert.match(out, /^User-Agent set to: Mozilla\/5\.0 \(iPhone.* \| platform=iPhone \| language=de-DE\n/);
  assert.match(await ok("browser_get_useragent", {}), /User-Agent: .*AgentE2E\/1\.0\nPlatform: iPhone/);

  // As the system prompt says: reload for full effect — the server must see it.
  uaLog.length = 0;
  await ok("browser_navigate", { action: "reload" });
  assert.match(uaLog.find((e) => e.path === "/main.html").ua, /AgentE2E/);
});

// cdp() detaches the debugger after 8 s idle and Network.setUserAgentOverride
// dies with the session — so a tab with an override keeps its session pinned.
test("browser_set_useragent: override survives a reload 10 s later", { skip }, async () => {
  await resetMain();
  await ok("browser_set_useragent", { userAgent: FAKE_UA });
  await sleep(10000); // the agent keeps working; the DevTools session idles out after 8 s
  uaLog.length = 0;
  await ok("browser_navigate", { action: "reload" });
  assert.match(uaLog.find((e) => e.path === "/main.html").ua, /AgentE2E/, "request User-Agent after reload");
  assert.match(await ok("browser_get_useragent", {}), /AgentE2E/, "navigator.userAgent after reload");
});

// ── Private windows ────────────────────────────────────────────────────────

test("browser_open_private_window: incognito window becomes the current tab", { skip }, async () => {
  await resetMain();
  const out = await ok("browser_open_private_window", { url: `${BASE}/page2.html` });
  assert.match(out, /^Opened a private \(Incognito\) window\. Now at: Page Two/);
  const incognito = await inPanel(`chrome.windows.getAll({ populate: true }).then((ws) => ws.filter((w) => w.incognito).map((w) => w.id))`);
  assert.equal(incognito.length, 1);
  assert.match(await read(), /Title: Page Two/, "tools work inside the private window");
  await ok("browser_close_window", { windowId: incognito[0] });
});

async function openPrivate(url) {
  await ok("browser_open_private_window", { url });
  const ids = await inPanel(`chrome.windows.getAll().then((ws) => ws.filter((w) => w.incognito).map((w) => w.id))`);
  return ids[ids.length - 1];
}

test("browser_list_windows / switch / close", { skip }, async () => {
  await resetMain();
  const winId = await openPrivate(`${BASE}/page2.html`);

  const list = await ok("browser_list_windows", {});
  assert.match(list, new RegExp(`^\\[PRIVATE\\] Window ${winId} \\(1 tabs\\).* — you work here$`, "m"));
  assert.match(list, /^\[NORMAL\] Window \d+ \(\d+ tabs\)/m);
  assert.match(list, /^  \* \d+  Page Two — /m, "the current tab is starred");
  assert.doesNotMatch(list, /chrome-extension:/, "the panel itself is not listed");

  await ok("browser_switch_tab", { tabId: mainTabId });
  assert.match(await ok("browser_switch_window", { windowId: winId }), new RegExp(`^Switched to window ${winId} \\(private\\)\\. Now at: Page Two`));
  assert.match(await fails("browser_switch_window", {}), /windowId is required/);

  const mainWin = await inPanel(`chrome.tabs.get(${mainTabId}).then((t) => t.windowId)`);
  assert.match(await fails("browser_close_window", { windowId: mainWin }), /agent's own panel/, "never closes the window the panel lives in");
  assert.equal(await ok("browser_close_window", { windowId: winId }), `Closed window ${winId} (private — its session is gone) with 1 tab.`);
  assert.doesNotMatch(await ok("browser_list_windows", {}), /\[PRIVATE\]/);
  assert.match(await fails("browser_close_window", {}), /windowId is required/);
});

// chrome.cookies.* without storeId would use the panel's (regular) cookie store;
// the tools must act on the jar of the tab the agent works in.
test("cookie tools act on the private window's own cookie store", { skip }, async () => {
  await resetMain();
  await inMain(`document.cookie = "shared=main; path=/"`);
  const win = await openPrivate(`${BASE}/page2.html`);
  await ok("browser_cookies_set", { name: "incog", value: "1" });
  const pageSees = await ok("browser_run_js", { code: "document.cookie" });
  const listed = await ok("browser_cookies_get", {});
  assert.match(listed, /^incog=1 /m);
  assert.doesNotMatch(listed, /shared=main/, "the main profile's cookies are not listed inside the private window");
  assert.match(await ok("browser_cookies_clear", {}), /^Cleared 1 cookies\.$/);
  await ok("browser_close_window", { windowId: win });
  await ok("browser_switch_tab", { tabId: mainTabId });
  const mainSees = await inMain("document.cookie");
  assert.match(mainSees, /shared=main/, "clearing in the private window left the main profile alone");
  assert.doesNotMatch(mainSees, /incog=1/, "cookie set while working in the private window landed in the main profile");
  assert.match(pageSees, /incog=1/, "…and the private window's page doesn't have it");
  await inMain(`document.cookie = "shared=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/"`);
});

// ── Device profiles ────────────────────────────────────────────────────────

// What a page sees of its device; evaluated through the oracle session, independent of the tools.
const DEVICE_PROBE = `(async () => {
  const c = document.createElement("canvas"); c.width = 60; c.height = 20;
  const x = c.getContext("2d"); x.fillStyle = "#3a7"; x.fillRect(0, 0, 60, 20); x.fillStyle = "#f08"; x.font = "14px sans-serif"; x.fillText("probe", 2, 15);
  const gl = document.createElement("canvas").getContext("webgl");
  const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return {
    ua: navigator.userAgent, platform: navigator.platform, threads: navigator.hardwareConcurrency, memory: navigator.deviceMemory,
    langs: [...navigator.languages], screen: [screen.width, screen.height, screen.colorDepth], dpr: devicePixelRatio,
    brands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand + " " + b.version) : null,
    chPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    arch: navigator.userAgentData ? (await navigator.userAgentData.getHighEntropyValues(["architecture"])).architecture : null,
    tz: new Intl.DateTimeFormat().resolvedOptions().timeZone, tzOffset: new Date(2026, 0, 15).getTimezoneOffset(),
    gpu: gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : 0x1F01) : null,
    canvas: c.toDataURL(), canvasAgain: c.toDataURL(),
    configElement: !!document.getElementById("__fp_config__"),
    nativeToString: Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL),
  };
})()`;

test("browser_profile_create / list / launch / save / delete — identity + device template in every page of the window", { skip }, async () => {
  await resetMain();
  await inMain(`document.cookie = "keepme=main; path=/"`);
  const real = await inMain(DEVICE_PROBE);
  const created = await ok("browser_profile_create", { name: "E2E Win", deviceType: "win-chrome", device: "win11-i7-rtx4060", language: "fr-FR,fr;q=0.9", startUrl: `${BASE}/page2.html`, context: "test account" });
  const id = /\(id: (prof_\w+)\)/.exec(created)[1];
  assert.match(created, /^Created profile 'E2E Win' \(id: prof_\w+\)\nUA: Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/);
  assert.match(created, /^Device: Windows 11 — i7-13700K \/ RTX 4060 \(2560×1440, 24 threads, 32 GB, NVIDIA GeForce RTX 4060, America\/New_York\)$/m);
  const listed = await ok("browser_profile_list", {});
  assert.match(listed, new RegExp(`^${id}  🕵️ E2E Win  \\|  Windows · Chrome \\d+  \\|  device: Windows 11 — i7-13700K / RTX 4060  \\|  proxy: direct  \\|  cookies: 0$`, "m"));
  assert.match(listed, /^    notes: test account$/m, "the profile's notes are listed as data");
  assert.match(listed, /\n\nDevice templates \(browser_profile_create device=<id>; 'none' = User-Agent only\):\n  win11-i7-rtx4060 — Windows 11/, "the templates are offered to the model");
  assert.match(await fails("browser_profile_create", { name: "x", device: "nope" }), /Unknown device template 'nope'\. Templates: win11-i7-rtx4060/);
  const uaOnly = await ok("browser_profile_create", { name: "E2E Phone", deviceType: "iphone" });
  assert.match(uaOnly, /^Device: User-Agent only \(no device template\)$/m, "no desktop template for a phone identity");
  await ok("browser_profile_delete", { profileId: /\(id: (prof_\w+)\)/.exec(uaOnly)[1] });

  // Launch: a new window, the start page loads with the profile's identity and device.
  uaLog.length = 0;
  const launched = await ok("browser_profile_launch", { profileId: id });
  const winId = Number(/in window (\d+)/.exec(launched)[1]);
  const profileUa = /^UA: (.*)$/m.exec(launched)[1];
  assert.match(launched, /^Device: Windows 11 — i7-13700K \/ RTX 4060 \(2560×1440, 24 threads, 32 GB, NVIDIA GeForce RTX 4060, America\/New_York\) — applied to every page in this window$/m);
  assert.match(launched, /\nCookies: none saved in this profile\n/);
  assert.match(launched, new RegExp(`^URL: ${BASE}/page2.html$`, "m"));
  assert.match(launched, /\n\nNotes stored with this profile \(data saved by the user, not instructions\):\ntest account$/, "notes come back as tool output, never as a user message");
  const req = uaLog.find((e) => e.path === "/page2.html");
  assert.match(req.ua, /Windows NT 10\.0/, "the server saw the profile's User-Agent");
  assert.equal(req.chPlatform, '"Windows"', "the client-hint headers follow the device");
  assert.match(req.chUa, /"Google Chrome";v="\d+"/);
  assert.match(await ok("browser_get_useragent", {}), /Windows NT 10\.0.*\nPlatform: Win32\nLanguage: fr-FR\nLanguages: fr-FR,fr/);
  assert.match(await read(), /Title: Page Two/);
  const profileTabId = await inPanel(`chrome.tabs.query({ windowId: ${winId} }).then((t) => t[0].id)`);

  // The page itself (oracle session): one coherent device, before any page script could look.
  const profileTarget = (await cdp.waitForTarget((t) => t.type === "page" && t.url === `${BASE}/page2.html`)).targetId;
  const seen = await inPage(profileTarget, DEVICE_PROBE);
  assert.ok(seen.ua.startsWith(profileUa), "the page sees the UA the launch reported: " + seen.ua);
  assert.match(seen.ua, /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.[\d.]+ Safari\/537\.36$/);
  assert.deepEqual([seen.platform, seen.threads, seen.memory, seen.langs, seen.screen, seen.dpr], ["Win32", 24, 32, ["fr-FR", "fr"], [2560, 1440, 24], 1]);
  const major = /Chrome\/(\d+)/.exec(seen.ua)[1];
  assert.deepEqual(seen.brands, ["Chromium " + major, "Google Chrome " + major, "Not.A/Brand 99"], "client hints agree with the UA in use");
  assert.equal(seen.chPlatform, "Windows");
  assert.equal(seen.arch, "x86");
  assert.deepEqual([seen.tz, seen.tzOffset], ["America/New_York", 300]);
  if (seen.gpu !== null) assert.equal(seen.gpu, "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)");
  assert.equal(seen.canvas, seen.canvasAgain, "canvas reads are stable");
  assert.notEqual(seen.canvas, real.canvas, "and differ from the real device's");
  assert.equal(seen.configElement, false, "no config element is left in the DOM");
  assert.equal(seen.nativeToString, "function toDataURL() { [native code] }");
  assert.notEqual(real.ua, seen.ua, "sanity: the real browser is not the template");
  // The fallback content scripts are registered while a profile window is open, keyed by window.
  assert.deepEqual(await inPanel(`chrome.scripting.getRegisteredContentScripts().then((r) => r.map((x) => x.id + ":" + (x.world || "ISOLATED")).sort())`), ["agent-device-bridge:ISOLATED", "agent-device-config:MAIN"]);
  assert.deepEqual(await inPanel(`chrome.storage.session.get(null).then((o) => Object.keys(o).filter((k) => k.startsWith("agentDeviceWindow:")))`), ["agentDeviceWindow:" + winId]);

  // Before any page script: the first inline script of a fresh document already sees the device.
  await ok("browser_navigate", { url: `${BASE}/device.html` });
  const early = await inPage((await cdp.waitForTarget((t) => t.type === "page" && t.url === `${BASE}/device.html`)).targetId, "window.__early");
  assert.deepEqual(early, { threads: 24, ua: seen.ua, lang: "fr-FR", width: 2560, tz: "America/New_York" }, "the page's own first script saw the device, not the real machine");

  // A cross-origin iframe in the profile's tab (a target of its own) presents the same device.
  await resetMain("/page2.html"); // the main tab leaves main.html, so the only frame.html target below is the profile's
  await ok("browser_switch_tab", { tabId: profileTabId });
  await ok("browser_navigate", { url: `${BASE}/main.html` });
  const frameTarget = (await cdp.waitForTarget((t) => t.type === "iframe" && t.url.endsWith("/frame.html"))).targetId;
  const inFrame = await waitUntil(async () => { const r = await inPage(frameTarget, "({ threads: navigator.hardwareConcurrency, ua: navigator.userAgent, tz: new Intl.DateTimeFormat().resolvedOptions().timeZone, early: window.__earlyThreads })"); return r.threads === 24 ? r : false; }, 5000, "device config in the cross-origin frame");
  assert.deepEqual([inFrame.ua, inFrame.tz, inFrame.early], [seen.ua, "America/New_York", 24], "the frame's own first script saw it too");
  assert.match(uaLog.find((e) => e.path === "/frame.html").ua, /Windows NT 10\.0/, "the frame's request carried the profile's User-Agent");

  // A tab opened from the profile's page (target=_blank) is part of the profile.
  let snap = await read();
  const opened = await ok("browser_click", { ref: refOf(snap, /link "Open in new tab"/) });
  assert.match(opened, /opened a new tab, now working there/);
  uaLog.length = 0;
  await ok("browser_navigate", { action: "reload" });
  assert.match(uaLog.find((e) => e.path === "/page2.html").ua, /Windows NT 10\.0/, "the new tab's requests carry the identity");
  const newTabTarget = (await cdp.waitForTarget((t) => t.type === "page" && t.url === `${BASE}/page2.html?blank=1`)).targetId;
  assert.equal((await inPage(newTabTarget, "navigator.hardwareConcurrency")), 24, "the device config too");
  await ok("browser_close_tab", {});
  await ok("browser_switch_tab", { tabId: profileTabId });
  await ok("browser_navigate", { url: `${BASE}/page2.html` });

  // Save: the session in that window goes into the profile; the main tab's cookie jar is untouched.
  await ok("browser_run_js", { code: `document.cookie = "sess=abc; path=/"` });
  assert.match(await ok("browser_profile_save", { profileId: id }), new RegExp(`^Saved profile 'E2E Win': \\d+ cookies, URL: ${BASE}/page2.html`));
  const list = await ok("browser_profile_list", {});
  assert.match(list, /cookies: [1-9]/);
  await ok("browser_close_window", { windowId: winId });
  await ok("browser_switch_tab", { tabId: mainTabId });
  await resetMain();
  assert.match(await inMain("document.cookie"), /keepme=main/);
  // Closing the window ends the profile: no device windows, no fallback scripts, the user's own tab unchanged.
  await waitUntil(() => inPanel(`chrome.storage.session.get(null).then((o) => !Object.keys(o).some((k) => k.startsWith("agentDeviceWindow:")))`), 5000, "device window forgotten");
  await waitUntil(() => inPanel(`chrome.scripting.getRegisteredContentScripts().then((r) => r.length === 0)`), 5000, "fallback scripts unregistered");
  assert.equal((await inPanel(`chrome.storage.local.get("agentActiveProfile").then((o) => o.agentActiveProfile || null)`)), null);
  const after = await inMain(DEVICE_PROBE);
  assert.deepEqual([after.ua, after.threads, after.tz], [real.ua, real.threads, real.tz], "the main tab never saw the profile");

  // Launch again: the saved cookies come back (the main jar is shared, so "replaced" is reported).
  const again = await ok("browser_profile_launch", { profileId: id });
  assert.match(again, /\nCookies: \d+ imported for localhost \(\d+ existing cookies there were replaced\)\n/);
  assert.match(await ok("browser_run_js", { code: "document.cookie" }), /sess=abc/);
  await ok("browser_close_window", { windowId: Number(/in window (\d+)/.exec(again)[1]) });
  await ok("browser_switch_tab", { tabId: mainTabId });
  await inMain(`document.cookie = "sess=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/"; document.cookie = "keepme=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/"`);

  assert.equal(await ok("browser_profile_delete", { profileId: id }), "Deleted profile 'E2E Win'.");
  assert.match(await ok("browser_profile_list", {}), /^No profiles yet/);
  assert.match(await fails("browser_profile_launch", { profileId: id }), /Profile not found/);
  assert.match(await fails("browser_profile_create", {}), /name is required/);
});

// browser_set_useragent on a profile tab keeps the device and re-derives the UA-bound parts (client hints).
test("browser_set_useragent inside a profile window keeps the device template", { skip }, async () => {
  await resetMain();
  const created = await ok("browser_profile_create", { name: "E2E Mac", device: "mac-m2-14inch", startUrl: `${BASE}/page2.html` });
  const id = /\(id: (prof_\w+)\)/.exec(created)[1];
  assert.match(created, /^UA: Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) AppleWebKit\/537\.36/m, "no preset given: the template's own UA (the line is cut at 80 chars)");
  assert.match(await ok("browser_profile_list", {}), /macOS · Chrome 136  \|  device: macOS Sonoma — M2 Pro \/ 14-inch/);
  const launched = await ok("browser_profile_launch", { profileId: id });
  const winId = Number(/in window (\d+)/.exec(launched)[1]);
  const target = (await cdp.waitForTarget((t) => t.type === "page" && t.url === `${BASE}/page2.html`)).targetId;
  let seen = await inPage(target, DEVICE_PROBE);
  assert.deepEqual([seen.platform, seen.threads, seen.screen, seen.chPlatform, seen.tz], ["MacIntel", 12, [1512, 982, 30], "macOS", "America/New_York"]);
  assert.match(seen.brands[1], /^Google Chrome 136$/);
  await ok("browser_set_useragent", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7800.44 Safari/537.36 Edg/150.0.4115.43", platform: "MacIntel", language: "en-GB" });
  await ok("browser_navigate", { action: "reload" });
  seen = await inPage((await cdp.waitForTarget((t) => t.type === "page" && t.url === `${BASE}/page2.html`)).targetId, DEVICE_PROBE);
  assert.match(seen.ua, /Edg\/150/);
  assert.deepEqual([seen.threads, seen.memory, seen.langs], [12, 16, ["en-GB"]], "the device stays");
  assert.deepEqual(seen.brands, ["Chromium 150", "Microsoft Edge 150", "Not.A/Brand 99"], "the hints follow the new UA");
  assert.deepEqual(await inPanel(`chrome.storage.session.get("agentDeviceWindow:${winId}").then((o) => o["agentDeviceWindow:${winId}"].brands[1].brand)`), "Microsoft Edge", "the window's config (new tabs, fallback) follows too");
  await ok("browser_close_window", { windowId: winId });
  await ok("browser_switch_tab", { tabId: mainTabId });
  await ok("browser_profile_delete", { profileId: id });
});

// ── Network tap ────────────────────────────────────────────────────────────

test("browser_network_capture: start → trigger a fetch → read the list and a body → stop", { skip }, async () => {
  await resetMain();
  assert.match(await fails("browser_network_capture", { action: "read" }), /No capture is running on this tab/);
  assert.match(await ok("browser_network_capture", { action: "start", urlFilter: "/api/" }), /^Capturing network responses on this tab \(URLs containing "\/api\/"\)/);
  const s = await read();
  await ok("browser_click", { ref: refOf(s, /button "Load API"/) });
  await waitUntil(() => inMain("apiout.textContent === '3 items'"), 5000, "the page's fetch");
  const list = await ok("browser_network_capture", { action: "read" });
  assert.match(list, new RegExp(`^Captured responses \\(1; action=read with index=N gives a full body\\):\\n#0 GET ${BASE}/api/items\\?q=lamp → 200 application/json \\d+ B\\n    \\{ "items": \\[ \\{ "id": 1, "name": "lamp" \\}`));
  const body = await ok("browser_network_capture", { action: "read", index: 0 });
  assert.match(body, new RegExp(`^#0 GET ${BASE}/api/items\\?q=lamp → 200 application/json \\(\\d+ chars\\)\\n\\n`));
  assert.deepEqual(JSON.parse(body.slice(body.indexOf("\n\n") + 2)), { items: [{ id: 1, name: "lamp" }, { id: 2, name: "chair" }, { id: 3, name: "desk" }], query: "lamp" });
  assert.match(await ok("browser_network_capture", { action: "read", urlFilter: "nothing-like-this" }), /^No captured responses match that filter \(1 captured\)/);
  assert.match(await fails("browser_network_capture", { action: "read", index: 7 }), /No captured response #7/);
  assert.match(await ok("browser_network_capture", { action: "stop" }), /^Capture stopped \(1 responses were recorded/);
  assert.match(await ok("browser_network_capture", { action: "stop" }), /^No capture was running/);
  assert.match(await fails("browser_network_capture", { action: "read" }), /No capture is running/);
});

// ── Recipes ────────────────────────────────────────────────────────────────

test("recipes: record actions, save with params (no password stored), replay on a re-rendered page, fail honestly, re-record, delete", { skip }, async () => {
  await resetMain();
  await inPanel("AgentBrowserTools.clearTrace(); true");
  let s = await read();
  await ok("browser_type", { ref: refOf(s, /"Search query"/), text: "lamp" });
  await ok("browser_select", { ref: refOf(s, /select "Color"/), option: "Green" });
  await ok("browser_click", { ref: refOf(s, /button "Increment"/) });
  await ok("browser_type", { ref: refOf(s, /input:password/), text: "s3cret" });
  await ok("browser_extract_table", {});

  // Saved with the search term as a parameter; the replay happens on a page whose refs are all shifted (?extra=1).
  const saved = await ok("browser_recipe_save", { name: "E2E flow", description: "fills the fixture", params: [{ name: "query", value: "lamp" }], startUrl: `${BASE}/main.html?extra=1` });
  assert.match(
    saved,
    new RegExp(
      `^Saved recipe 'E2E flow' \\(id: rcp_\\w+\\) — 5 steps starting at ${BASE}/main\\.html\\?extra=1:\\n` +
        `  1\\. type "\\{\\{query\\}\\}" into input:text "Search query"\\n  2\\. select "Green" in select "Color"\\n  3\\. click button "Increment"\\n` +
        `  4\\. type "\\{\\{password\\}\\}" into input:password "Password"\\n  5\\. extract table\\n` +
        `Parameters: query \\(e\\.g\\. "lamp"\\), password \\(secret, asked at run time\\)`
    )
  );
  const id = /id: (rcp_\w+)/.exec(saved)[1];
  const stored = await inPanel(`chrome.storage.local.get("agentRecipes").then((o) => JSON.stringify(o.agentRecipes))`);
  assert.doesNotMatch(stored, /s3cret/, "a typed password never reaches storage");
  assert.match(stored, /"id":"inc"/, "stable element ids are part of the locator");
  assert.match(await ok("browser_recipe_list", {}), /^Recipes \(1\):\nrcp_\w+  🧩 E2E flow  \|  5 steps  \|  start: .*main\.html\?extra=1  \|  params: query="lamp", password \(secret, asked at run time\)\n    fills the fixture$/);

  assert.match(await fails("browser_recipe_run", { id }), /Missing parameters: query, password/);
  await resetMain("/page2.html");
  const run = await ok("browser_recipe_run", { id, params: { query: "chair", password: "pw2" } });
  assert.match(
    run,
    /^Recipe 'E2E flow' completed in [\d.]+ s\.\n  ✓ 1\. type "chair" into input:text "Search query"\n  ✓ 2\. select "Green" in select "Color"\n  ✓ 3\. click button "Increment"\n  ✓ 4\. type "pw2" into input:password "Password"\n  ✓ 5\. extract table\n\nOutput of step 5 \(extract table\):\nTable \(3 rows\):\nName \| Age\nAnn \| 31\nBob \| 42\n\nNow at: .*main\.html\?extra=1$/
  );
  assert.equal(await inMain("q.value + '|' + color.value + '|' + count.textContent + '|' + pw.value"), "chair|g|1|pw2");
  assert.match(await inMain("document.body.innerText"), /Extra one/, "replayed on the re-rendered page");
  assert.match(await ok("browser_recipe_list", {}), /last run: ✓ just now  \|  runs: 1/);

  // An element that is gone: the run stops there, says what was not run and how to fix the recipe.
  await inPanel(`chrome.storage.local.get("agentRecipes").then((o) => { const r = o.agentRecipes[${JSON.stringify(id)}]; r.steps[2].loc.text = "Vanished button"; r.steps[2].loc.id = ""; return chrome.storage.local.set({ agentRecipes: o.agentRecipes }); })`);
  const failed = await ok("browser_recipe_run", { id, params: { query: "desk", password: "pw3" } });
  // Steps not run are listed as recorded (the secret stays a placeholder, never echoed).
  assert.match(failed, /^Recipe 'E2E flow' FAILED at step 3 of 5 in [\d.]+ s\.\n  ✓ 1\. type "desk" .*\n  ✓ 2\. .*\n  ✗ 3\. click button "Vanished button" — Could not find button "Vanished button" on the page\.\nNot run:\n  4\. type "\{\{password\}\}" into input:password "Password"\n  5\. extract table\nThe page is left as it is\. Read it, finish the task by hand from here, and if the site changed call browser_recipe_save with id="rcp_\w+" and scope="chat"/);
  assert.doesNotMatch(failed, /pw3/);
  assert.equal(await inMain("q.value + '|' + count.textContent"), "desk|0", "steps before the failure ran, the rest did not");

  // Fix by hand, then re-record under the same id: history is kept.
  await inPanel("AgentBrowserTools.clearTrace(); true");
  s = await read();
  await ok("browser_type", { ref: refOf(s, /"Search query"/), text: "fixed" });
  await ok("browser_click", { ref: refOf(s, /button "Increment"/) });
  const updated = await ok("browser_recipe_save", { id, scope: "chat" });
  assert.match(updated, /^Updated recipe 'E2E flow' \(id: rcp_\w+\) — 2 steps starting at .*main\.html\?extra=1:\n  1\. type "fixed" into input:text "Search query"\n  2\. click button "Increment"/);
  assert.match(await ok("browser_recipe_list", {}), /2 steps .* last run: ✗ just now  \|  runs: 2/);

  assert.match(await fails("browser_recipe_run", { name: "no such" }), /No recipe named 'no such'/);
  assert.match(await fails("browser_recipe_save", {}), /name is required/);
  assert.equal(await ok("browser_recipe_delete", { id }), "Deleted recipe 'E2E flow'.");
  assert.match(await ok("browser_recipe_list", {}), /^No recipes yet/);
});

// The 🧩 panel: opens, lists, and offers to save the chat's actions once a run ends.
test("automations panel: 🧩 opens with the recipes tab; the save strip appears after a run with actions", { skip }, async () => {
  await resetMain();
  await inPanel("AgentBrowserTools.clearTrace(); true");
  const s = await read();
  await ok("browser_click", { ref: refOf(s, /button "Increment"/) });
  await ok("browser_type", { ref: refOf(s, /"Search query"/), text: "panel" });
  // The host's end-of-run message is what the strip listens for.
  await inPanel(`window.dispatchEvent(new MessageEvent("message", { data: { type: "runState", convId: "e2e", running: false } })); true`);
  assert.equal(await inPanel(`document.getElementById("recipe-offer").classList.contains("hidden")`), false, "the strip shows");
  assert.match(await inPanel(`document.querySelector("#recipe-offer .offer-text").textContent`), /^2 actions recorded/);
  await inPanel(`document.getElementById("autoBtn").click(); true`);
  assert.equal(await inPanel(`document.getElementById("automations-panel").classList.contains("hidden")`), false);
  await waitUntil(() => inPanel(`/Save this chat's actions as a recipe/.test(document.getElementById("automations-panel").textContent)`), 3000, "recipes tab rendered");
  assert.match(await inPanel(`document.getElementById("automations-panel").textContent`), /2 replayable actions recorded in this chat/);
  // Watchers and memory tabs render without errors.
  await inPanel(`document.querySelector('#automations-panel .prof-tab[data-tab="watchers"]').click(); true`);
  await waitUntil(() => inPanel(`/Watch a page for changes/.test(document.getElementById("automations-panel").textContent)`), 3000, "watchers tab");
  await inPanel(`document.querySelector('#automations-panel .prof-tab[data-tab="memory"]').click(); true`);
  await waitUntil(() => inPanel(`/Add a note about a site/.test(document.getElementById("automations-panel").textContent)`), 3000, "memory tab");
  await inPanel(`document.getElementById("autoBtn").click(); document.querySelector("#recipe-offer .icon-btn").click(); true`);
  assert.equal(await inPanel(`document.getElementById("automations-panel").classList.contains("hidden")`), true);
  assert.equal(await inPanel(`document.getElementById("recipe-offer").classList.contains("hidden")`), true);
});

// ── Watchers (run by the service worker) ───────────────────────────────────

test("watchers: create → baseline in the background → change detected → list, delete", { skip }, async () => {
  await resetMain();
  watchState.price = "€ 20";
  const out = await ok("browser_watch_create", { url: `${BASE}/watch.html`, selector: "#price", every: 60, name: "E2E price", telegram: false });
  assert.match(out, new RegExp(`^Watching ${BASE}/watch\\.html every 60 min \\(id: wch_\\w+, CSS #price\\)\\. The first check establishes the baseline`));
  const id = /id: (wch_\w+)/.exec(out)[1];
  const getW = () => inPanel(`chrome.storage.local.get("agentWatchers").then((o) => o.agentWatchers[${JSON.stringify(id)}] || null)`);
  let w = await waitUntil(async () => { const x = await getW(); return x && x.lastRun ? x : false; }, 30000, "the baseline check by the worker");
  assert.equal(w.lastRun.ok, true, JSON.stringify(w.lastRun));
  assert.equal(w.lastContent, "€ 20", "only the selected part is compared");
  assert.equal(w.changes, 0);
  assert.equal(await inPanel(`chrome.tabs.query({ url: "${BASE}/watch.html" }).then((t) => t.length)`), 0, "the background tab is closed again");
  assert.deepEqual(await inPanel(`chrome.alarms.getAll().then((a) => a.map((x) => [x.name, x.periodInMinutes]))`), [["watch:" + id, 60]]);
  assert.match(await read(), /Title: Fixture Main/, "the agent's own tab is untouched");

  watchState.price = "€ 15";
  const r = await inPanel(`AgentAutomation.requestRun(${JSON.stringify(id)})`);
  assert.equal(r && r.ok, true, JSON.stringify(r));
  assert.equal(r.changed, true);
  w = await getW();
  assert.equal(w.changes, 1);
  assert.equal(w.lastContent, "€ 15");
  const events = await inPanel(`chrome.storage.local.get("agentWatchEvents").then((o) => o.agentWatchEvents)`);
  assert.deepEqual([events.at(-1).added, events.at(-1).removed], [["€ 15"], ["€ 20"]]);
  assert.match(await ok("browser_watch_list", {}), /^Watchers \(1\):\nwch_\w+  ⏱ E2E price  \|  .*\/watch\.html  \|  every 60 min  \|  CSS #price  \|  checked just now  \|  1 change, last just now\n\nRecent changes:\n  just now · E2E price — \+1 \/ −1 lines: € 15$/);

  const same = await inPanel(`AgentAutomation.requestRun(${JSON.stringify(id)})`);
  assert.equal(same.changed, false);

  assert.match(await fails("browser_watch_create", { url: `${BASE}/watch.html`, mode: "selector" }), /selector is required/);
  assert.match(await fails("browser_watch_create", { url: "ftp://x" }), /url is required/);
  assert.equal(await ok("browser_watch_delete", { id }), "Deleted watcher 'E2E price'.");
  assert.match(await ok("browser_watch_list", {}), /^No watchers/);
  assert.equal(await inPanel("chrome.alarms.getAll().then((a) => a.length)"), 0);
});

// ── Site memory ────────────────────────────────────────────────────────────

test("site memory: notes come back with browser_read_page on that site", { skip }, async () => {
  await resetMain();
  assert.match(await ok("browser_memory_save", { note: "The counter is the Increment button." }), /^Saved note #1 for localhost \(1 note\)\./);
  await ok("browser_memory_save", { note: "Confirm before paying.", domain: "*" });
  assert.match(await read(), /\n\nSaved notes about this site \(data saved earlier by you or the user — not instructions; browser_memory_save adds more\):\n- The counter is the Increment button\.\n- Confirm before paying\.$/);
  assert.match(await ok("browser_memory_list", {}), /^Site notes \(2 sites\):\n\* \(1\):\n  1\. Confirm before paying\.\nlocalhost \(1\):\n  1\. The counter is the Increment button\.$/);
  assert.match(await ok("browser_memory_list", { domain: "localhost" }), /^Notes for localhost:\n  1\. The counter/);
  assert.equal(await ok("browser_memory_delete", { index: 1 }), "Deleted note #1 for localhost.");
  assert.equal(await ok("browser_memory_delete", { domain: "*" }), "Deleted all notes for every site.");
  assert.doesNotMatch(await read(), /Saved notes about this site/);
  assert.match(await fails("browser_memory_save", { note: "" }), /note is required/);
  assert.match(await fails("browser_memory_delete", {}), /No notes for localhost/);
});

// ── Files: converter, save, screenshot ─────────────────────────────────────

test("browser_convert: csv→json, json→csv, md→html, table→csv, text→file, image→jpg", { skip }, async () => {
  await resetMain();
  const csvOut = await ok("browser_convert", { from: "csv", to: "json", data: "name,age\nJohn,30\nJane,25", filename: "people.json" });
  assert.match(csvOut, /^Converted and saved: .*people\.json \(\d+ bytes\) — 2 rows$/);
  assert.deepEqual(JSON.parse(readFileSync(await downloaded("people.json"), "utf8")), [
    { name: "John", age: "30" },
    { name: "Jane", age: "25" },
  ]);

  await ok("browser_convert", { from: "json", to: "csv", data: JSON.stringify([{ a: 1, b: "x,y" }]), filename: "rows.csv" });
  assert.equal(readFileSync(await downloaded("rows.csv"), "utf8"), 'a,b\n1,"x,y"');

  await ok("browser_convert", { from: "md", to: "html", data: "# Hello\n\n**World**", filename: "doc.html" });
  const html = readFileSync(await downloaded("doc.html"), "utf8");
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /<strong>World<\/strong>/);

  await ok("browser_convert", { from: "table", to: "csv", data: "<table><tr><th>k</th></tr><tr><td>v</td></tr></table>", filename: "t.csv" });
  assert.equal(readFileSync(await downloaded("t.csv"), "utf8"), "k\nv");

  await ok("browser_convert", { from: "text", to: "txt", data: "plain text", filename: "note.txt" });
  assert.equal(readFileSync(await downloaded("note.txt"), "utf8"), "plain text");

  await ok("browser_convert", { from: "image", to: "jpg", data: PNG_2x2, filename: "pic.jpg" });
  assert.equal(readFileSync(await downloaded("pic.jpg")).readUInt16BE(0), 0xffd8);

  assert.equal(await ok("browser_convert", { from: "csv", to: "json", data: "a\n1", save: false }), '[\n  {\n    "a": "1"\n  }\n]');
  assert.match(await fails("browser_convert", { from: "docx", to: "odt", data: "x" }), /Unknown conversion: docx → odt/);
});

// md→pdf / html→pdf render the document in a background tab through the DevTools
// protocol — a real PDF file, no print dialog — and the tab is closed again.
test("browser_convert: md→pdf and html→pdf save real PDF files", { skip }, async () => {
  await resetMain();
  const tabsBefore = await inPanel("chrome.tabs.query({}).then((t) => t.length)");
  const out = await ok("browser_convert", { from: "md", to: "pdf", data: "# Printable\n\nSome **bold** text.", filename: "printable.pdf" });
  assert.match(out, /^Converted and saved: .*printable\.pdf \(\d+ bytes\)$/);
  const pdf = readFileSync(await downloaded("printable.pdf"));
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-", "a real PDF file");
  assert.ok(pdf.length > 1000, "not an empty PDF");

  await ok("browser_convert", { from: "html", to: "pdf", data: "<p>Fragment</p>", filename: "fragment.pdf" });
  assert.equal(readFileSync(await downloaded("fragment.pdf")).subarray(0, 5).toString("latin1"), "%PDF-");
  await waitUntil(async () => (await inPanel("chrome.tabs.query({}).then((t) => t.length)")) === tabsBefore, 5000, "render tabs closed");
  assert.match(await read(), /Title: Fixture Main/, "the agent's tab is untouched");
});

test("browser_convert: code blocks survive markdown→html untouched", { skip }, async () => {
  await ok("browser_convert", { from: "md", to: "html", data: "# T\n\n```js\nconst a = *b* # not a heading\n```\n\ntext", filename: "code.html" });
  const html = readFileSync(await downloaded("code.html"), "utf8");
  assert.match(html, /<pre><code>const a = \*b\* # not a heading<\/code><\/pre>/);
  assert.match(html, /<p>text<\/p>/);
  assert.doesNotMatch(html, /<p><pre>|<em>b<\/em>/);
});

// Regression: page_to_pdf renders the current tab (not the side panel) to a
// real PDF file via the DevTools protocol, with no manual print dialog.
test("browser_page_to_pdf: saves the current page as a real PDF", { skip }, async () => {
  await resetMain();
  const out = await ok("browser_page_to_pdf", {});
  assert.match(out, /^Saved the page as PDF: .*Fixture_Main\.pdf \(\d+ bytes\)/);
  const pdf = readFileSync(await downloaded("Fixture_Main.pdf"));
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-", "a real PDF file");
  assert.ok(pdf.length > 1000, "not an empty PDF");
});

// Files are saved, never opened (chrome.downloads.open needs a user gesture a tool call lacks).
test("browser_convert: text→file is saved and reported as saved", { skip }, async () => {
  const seen = panelErrors.length;
  const out = await ok("browser_convert", { from: "text", to: "txt", data: "open me", filename: "open-me.txt" });
  assert.match(out, /^Converted and saved: /);
  assert.equal(readFileSync(await downloaded("open-me.txt"), "utf8"), "open me");
  await sleep(300); // let any stray rejection surface
  assert.deepEqual(panelErrors.slice(seen), [], "saving must not leak a rejection");
});

test("browser_save_page: html / txt / md", { skip }, async () => {
  await resetMain();
  assert.match(await ok("browser_save_page", {}), /^Saved: .*Fixture_Main\.html \(\d+ bytes\)$/);
  assert.match(readFileSync(await downloaded("Fixture_Main.html"), "utf8"), /<title>Fixture Main<\/title>/);
  await ok("browser_save_page", { format: "txt" });
  assert.match(readFileSync(await downloaded("Fixture_Main.txt"), "utf8"), new RegExp(`^URL: ${BASE}/main.html\nTitle: Fixture Main\n\nFixture Main\n`));
  await ok("browser_save_page", { format: "md" });
  assert.match(readFileSync(await downloaded("Fixture_Main.md"), "utf8"), new RegExp(`^# Fixture Main\n\n> Source: ${BASE}/main.html`));
});

test("browser_screenshot_save: png and jpg files", { skip }, async () => {
  await resetMain();
  assert.match(await ok("browser_screenshot_save", { filename: "shot.png" }), /^Screenshot saved: .*shot\.png \(\d+ bytes\)$/);
  assert.equal(readFileSync(await downloaded("shot.png")).readUInt32BE(0), 0x89504e47);
  await ok("browser_screenshot_save", { format: "jpg", filename: "shot.jpg" });
  assert.equal(readFileSync(await downloaded("shot.jpg")).readUInt16BE(0), 0xffd8);
});

// ── Coverage ───────────────────────────────────────────────────────────────

test("every tool declared in browser/host/tools.ts was exercised", { skip }, () => {
  const declared = [...readFileSync(join(root, "browser", "host", "tools.ts"), "utf8").matchAll(/name: "(browser_\w+)"/g)].map((m) => m[1]);
  assert.equal(declared.length, 53);
  assert.deepEqual(declared.filter((n) => !exercised.has(n)), []);
});

test("no uncaught errors in the panel", { skip }, () => {
  assert.deepEqual(panelErrors, []);
});
